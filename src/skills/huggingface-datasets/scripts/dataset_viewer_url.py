#!/usr/bin/env python3
"""Build one bounded public Hugging Face Dataset Viewer GET URL."""

from __future__ import annotations

import argparse
import json
import re
import urllib.parse


BASE_URL = "https://datasets-server.huggingface.co"
HUB_DATASET_API = "https://huggingface.co/api/datasets"
ENDPOINTS = frozenset(
    {
        "is-valid",
        "splits",
        "first-rows",
        "rows",
        "search",
        "filter",
        "parquet",
        "size",
        "statistics",
        "croissant",
    }
)
DATASET_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$"
)


def _text(value: str | None, name: str, *, required: bool = False) -> str | None:
    if value is None:
        if required:
            raise ValueError(f"{name} is required")
        return None
    if not value or len(value) > 500 or any(ord(char) < 32 for char in value):
        raise ValueError(f"{name} is invalid")
    return value


def build_url(args: argparse.Namespace) -> str:
    if args.endpoint not in ENDPOINTS:
        raise ValueError("endpoint is not a public read-only Dataset Viewer endpoint")
    if not DATASET_RE.fullmatch(args.dataset):
        raise ValueError("dataset must be namespace/repository with safe characters")

    dataset_path = "/".join(urllib.parse.quote(part, safe="") for part in args.dataset.split("/"))
    if args.endpoint == "croissant":
        return f"{HUB_DATASET_API}/{dataset_path}/croissant"

    params: dict[str, str] = {"dataset": args.dataset}
    needs_split = args.endpoint in {"first-rows", "rows", "search", "filter", "statistics"}
    if needs_split:
        params["config"] = _text(args.config, "config", required=True) or ""
        params["split"] = _text(args.split, "split", required=True) or ""

    if args.endpoint in {"rows", "search", "filter"}:
        if args.offset < 0:
            raise ValueError("offset must be non-negative")
        if not 1 <= args.length <= 100:
            raise ValueError("length must be between 1 and 100")
        params["offset"] = str(args.offset)
        params["length"] = str(args.length)
    if args.endpoint == "search":
        params["query"] = _text(args.query, "query", required=True) or ""
    if args.endpoint == "filter":
        params["where"] = _text(args.where, "where", required=True) or ""
        orderby = _text(args.orderby, "orderby")
        if orderby is not None:
            params["orderby"] = orderby

    return f"{BASE_URL}/{args.endpoint}?{urllib.parse.urlencode(params)}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True, choices=sorted(ENDPOINTS))
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--config")
    parser.add_argument("--split")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--length", type=int, default=100)
    parser.add_argument("--query")
    parser.add_argument("--where")
    parser.add_argument("--orderby")
    args = parser.parse_args()
    try:
        url = build_url(args)
        revision = _text(args.revision, "revision", required=True) or ""
        dataset_path = "/".join(urllib.parse.quote(part, safe="") for part in args.dataset.split("/"))
        revision_path = urllib.parse.quote(revision, safe="")
    except ValueError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
        return 1
    print(
        json.dumps(
            {
                "method": "GET",
                "url": url,
                "source": "hub-croissant" if args.endpoint == "croissant" else "dataset-viewer",
                "requested_revision": revision,
                "revision_url": f"{HUB_DATASET_API}/{dataset_path}/revision/{revision_path}",
                "revision_selectable": False,
            },
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
