#!/usr/bin/env python3
"""Lint an ADR-102 review report for tone, ownership, and actionability."""

from __future__ import annotations

import argparse
import re
from typing import Any

from _common import (
    ValidationError,
    error_exit,
    issue,
    read_markdown,
    write_json_report,
)

REPORT_HEADING = "# Review Report"
COMMENT_HEADING_RE = re.compile(
    r"^###\s+(?P<kind>Major|Minor)\s+finding(?:\s+(?P<id>[A-Za-z0-9._:-]+))?\s*$",
    re.IGNORECASE,
)
FIELD_RE = re.compile(
    r"^-\s*(?P<label>Location|Observation|Evidence or criterion|"
    r"Why it matters|Required action|Owner):\s*(?P<value>.*)$",
    re.IGNORECASE,
)
REQUIRED_FIELDS = {
    "location",
    "observation",
    "evidence or criterion",
    "why it matters",
    "required action",
    "owner",
}
PLACEHOLDER_RE = re.compile(
    r"^\s*(?:"
    r"\[(?:write|state|describe|identify|add|cite|section|figure|table|line|"
    r"explain|request|replace|if)\b[^\]]*\]"
    r"|TBD|TODO|<[^>]+>)\s*$",
    re.IGNORECASE,
)
UNRESOLVED_SCAFFOLD_RE = re.compile(
    r"\[(?:write|state|describe|identify|add|cite|explain|request|replace)\b",
    re.IGNORECASE,
)
ABUSIVE_RE = re.compile(
    r"\b(?:idiot(?:ic)?|incompetent|ridiculous|nonsense|garbage|lazy|sloppy|"
    r"clueless|amateurish|embarrassing|worthless)\b",
    re.IGNORECASE,
)
PERSONAL_ATTACK_RE = re.compile(
    r"\b(?:the\s+)?authors?\s+(?:do(?:es)?\s+not\s+understand|"
    r"failed\s+to\s+understand|are\s+unaware|are\s+careless|"
    r"are\s+dishonest)\b",
    re.IGNORECASE,
)
EDITORIAL_DECISION_RE = re.compile(
    r"\b(?:(?:i|we)\s+(?:recommend|would\s+recommend|have\s+decided|"
    r"decided)\s+(?:accept(?:ance)?|reject(?:ion)?)|"
    r"recommendation\s*:\s*(?:accept|reject|major\s+revision|"
    r"minor\s+revision))\b",
    re.IGNORECASE,
)
IMPERSONATION_RE = re.compile(
    r"\b(?:i\s+am\s+(?:the\s+)?(?:editor|assigned\s+reviewer)|"
    r"on\s+behalf\s+of\s+the\s+(?:journal|editor)|"
    r"we\s+have\s+made\s+the\s+editorial\s+decision)\b",
    re.IGNORECASE,
)
EXECUTION_CLAIM_RE = re.compile(
    r"\bi\s+(?:ran|performed|replicated|reproduced|verified|confirmed)\s+"
    r"(?:the|this|these)\s+(?:analysis|analyses|experiment|experiments|"
    r"results|dataset|data)\b",
    re.IGNORECASE,
)
def _content_value(value: str) -> bool:
    text = value.strip()
    return bool(text) and not PLACEHOLDER_RE.fullmatch(text)


def _comment_blocks(lines: list[str]) -> list[dict[str, Any]]:
    starts: list[tuple[int, re.Match[str]]] = []
    for index, line in enumerate(lines):
        match = COMMENT_HEADING_RE.match(line.strip())
        if match:
            starts.append((index, match))
    blocks: list[dict[str, Any]] = []
    for position, (start, match) in enumerate(starts):
        end = starts[position + 1][0] if position + 1 < len(starts) else len(lines)
        for candidate in range(start + 1, end):
            if lines[candidate].startswith("# ") or lines[candidate].startswith("## "):
                end = candidate
                break
        blocks.append(
            {
                "start": start,
                "end": end,
                "kind": match.group("kind").lower(),
                "id": match.group("id")
                or f"{match.group('kind')[0].upper()}-line-{start + 1}",
            }
        )
    return blocks


def lint(markdown: str) -> dict[str, Any]:
    lines = markdown.splitlines()
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    report_headings = [
        index for index, line in enumerate(lines) if line.strip() == REPORT_HEADING
    ]
    if len(report_headings) != 1:
        errors.append(issue("REVIEW_REPORT_HEADING_REQUIRED_ONCE", "document"))

    for line_number, line in enumerate(lines, start=1):
        subject = f"line:{line_number}"
        if ABUSIVE_RE.search(line):
            errors.append(issue("ABUSIVE_OR_DISMISSIVE_LANGUAGE", subject))
        if PERSONAL_ATTACK_RE.search(line):
            errors.append(issue("PERSONAL_ATTACK", subject))
        if EDITORIAL_DECISION_RE.search(line):
            errors.append(issue("EDITORIAL_DECISION_LANGUAGE", subject))
        if IMPERSONATION_RE.search(line):
            errors.append(issue("ROLE_IMPERSONATION_LANGUAGE", subject))
        if EXECUTION_CLAIM_RE.search(line):
            warnings.append(issue("EXECUTION_CLAIM_REQUIRES_PROVENANCE", subject))
        if UNRESOLVED_SCAFFOLD_RE.search(line):
            errors.append(issue("UNRESOLVED_SCAFFOLD_PLACEHOLDER", subject))
    blocks = _comment_blocks(lines)
    if not blocks:
        warnings.append(issue("NO_STRUCTURED_FINDINGS_FOUND", "document"))
    finding_summaries: list[dict[str, Any]] = []
    for block in blocks:
        fields: dict[str, tuple[str, int]] = {}
        for index in range(block["start"] + 1, block["end"]):
            match = FIELD_RE.match(lines[index].strip())
            if match:
                fields[match.group("label").lower()] = (
                    match.group("value"),
                    index + 1,
                )
        missing_fields = sorted(REQUIRED_FIELDS - set(fields))
        empty_fields = sorted(
            label for label, (value, _) in fields.items() if not _content_value(value)
        )
        for label in missing_fields:
            errors.append(
                issue(
                    "ACTIONABILITY_FIELD_MISSING",
                    f"{block['id']}:{label.replace(' ', '_')}",
                )
            )
        for label in empty_fields:
            errors.append(
                issue(
                    "ACTIONABILITY_FIELD_EMPTY",
                    f"{block['id']}:{label.replace(' ', '_')}",
                )
            )
        finding_summaries.append(
            {
                "finding_id": block["id"],
                "kind": block["kind"],
                "heading_line": block["start"] + 1,
                "missing_fields": missing_fields,
                "empty_fields": empty_fields,
            }
        )

    return {
        "schema_version": "2.0",
        "valid": not errors,
        "status": "READY_FOR_HUMAN_REVIEW" if not errors else "REVISION_REQUIRED",
        "errors": errors,
        "warnings": warnings,
        "line_count": len(lines),
        "structured_finding_count": len(blocks),
        "findings": finding_summaries,
        "notice": (
            "This deterministic lint uses structural and lexical rules. It does "
            "not judge scientific validity, verify whether statements are true, "
            "or replace accountable human review. Findings contain line numbers "
            "and rule IDs, not review or manuscript text."
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Lint an ADR-102 review report for professional tone, actionable "
            "finding fields, and correction ownership."
        )
    )
    parser.add_argument("review", help="Local review Markdown")
    parser.add_argument("-o", "--output", help="Optional local JSON report")
    parser.add_argument(
        "--force", action="store_true", help="Replace an existing output file"
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        report = lint(read_markdown(args.review))
        write_json_report(report, args.output, force=args.force)
        return 0 if report["valid"] else 1
    except ValidationError as exc:
        return error_exit(exc)


if __name__ == "__main__":
    raise SystemExit(main())
