#!/usr/bin/env python3
"""Atomically publish one Markdown draft to a timestamped immutable path."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import uuid
from datetime import datetime, timezone
from pathlib import Path


ALLOWED_DIRECTORIES = frozenset({"handoffs", "reviews"})
PREFIX_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
MAX_DRAFT_BYTES = 2 * 1024 * 1024
MAX_COLLISIONS = 1000
WINDOWS = os.name == "nt"


def _same_file(first: os.stat_result, second: os.stat_result) -> bool:
    return (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)


def _relative_operations_supported() -> bool:
    return all(operation in os.supports_dir_fd for operation in (os.open, os.stat, os.link, os.unlink))


def _entry_stat(path: Path, name: str, directory_fd: int | None) -> os.stat_result:
    if directory_fd is None:
        return os.stat(path, follow_symlinks=False)
    return os.stat(name, dir_fd=directory_fd, follow_symlinks=False)


def _remove_entry(path: Path, name: str, directory_fd: int | None) -> None:
    if directory_fd is None:
        path.unlink()
    else:
        os.unlink(name, dir_fd=directory_fd)


def _rollback_destination(path: Path, name: str, directory_fd: int | None) -> None:
    try:
        _remove_entry(path, name, directory_fd)
    except FileNotFoundError:
        pass


def _stage_windows_cleanup(draft: Path, source_info: os.stat_result) -> Path:
    cleanup = draft.with_name(f".cleanup-{uuid.uuid4().hex}.md")
    draft.rename(cleanup)
    try:
        cleanup_info = os.stat(cleanup, follow_symlinks=False)
    except OSError:
        if not draft.exists():
            cleanup.rename(draft)
        raise
    if _same_file(source_info, cleanup_info):
        return cleanup
    if not draft.exists():
        cleanup.rename(draft)
    raise RuntimeError("source draft changed before Windows cleanup")


def publish(source: str, directory: str, prefix: str) -> str:
    if directory not in ALLOWED_DIRECTORIES:
        raise ValueError("directory must be handoffs or reviews")
    if not PREFIX_RE.fullmatch(prefix):
        raise ValueError("prefix must be a safe lowercase role or review_report")

    root = Path.cwd().resolve()
    destination_dir = root / directory
    destination_dir.mkdir(mode=0o700, exist_ok=True)
    if destination_dir.is_symlink() or destination_dir.resolve() != destination_dir:
        raise ValueError("destination directory must be a real project-local directory")

    source_path = Path(source)
    if source_path.is_absolute() or source_path.parent != Path(directory):
        raise ValueError("source draft must be directly inside the destination directory")
    if not source_path.name.startswith(".draft-") or source_path.suffix.lower() != ".md":
        raise ValueError("source draft must use a .draft-*.md filename")
    draft = root / source_path

    directory_fd: int | None = None
    source_fd: int | None = None
    try:
        directory_info = os.stat(destination_dir, follow_symlinks=False)
        if not stat.S_ISDIR(directory_info.st_mode):
            raise ValueError("destination directory must be a real project-local directory")

        if _relative_operations_supported():
            directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
            directory_fd = os.open(destination_dir, directory_flags)
            if not _same_file(directory_info, os.fstat(directory_fd)):
                raise ValueError("destination directory changed during validation")

        source_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        if directory_fd is None:
            source_fd = os.open(draft, source_flags)
        else:
            source_fd = os.open(source_path.name, source_flags, dir_fd=directory_fd)
        source_info = os.fstat(source_fd)
        if not stat.S_ISREG(source_info.st_mode):
            raise ValueError("source draft must be a regular file")
        if source_info.st_size > MAX_DRAFT_BYTES:
            raise ValueError("source draft exceeds the 2 MiB limit")
        if not _same_file(source_info, _entry_stat(draft, source_path.name, directory_fd)):
            raise ValueError("source draft changed during validation")
        os.fsync(source_fd)

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")[:19]
        for collision in range(MAX_COLLISIONS):
            suffix = "" if collision == 0 else f"-{collision:02d}"
            destination_name = f"{prefix}-{timestamp}{suffix}.md"
            destination = destination_dir / destination_name
            try:
                if directory_fd is None:
                    os.link(draft, destination, follow_symlinks=False)
                else:
                    os.link(
                        source_path.name,
                        destination_name,
                        src_dir_fd=directory_fd,
                        dst_dir_fd=directory_fd,
                        follow_symlinks=False,
                    )
            except FileExistsError:
                continue

            if WINDOWS and source_fd is not None:
                os.close(source_fd)
                source_fd = None

            try:
                destination_info = _entry_stat(destination, destination_name, directory_fd)
                current_directory_info = os.stat(destination_dir, follow_symlinks=False)
                current_source_info = _entry_stat(draft, source_path.name, directory_fd)
                if not _same_file(source_info, destination_info):
                    raise RuntimeError("published link does not name the opened draft")
                if not _same_file(directory_info, current_directory_info):
                    raise RuntimeError("destination directory changed during publication")
                if not _same_file(source_info, current_source_info):
                    raise RuntimeError("source draft changed during publication")
            except (OSError, RuntimeError, ValueError):
                _rollback_destination(destination, destination_name, directory_fd)
                raise

            cleanup_path = draft
            cleanup_name = source_path.name
            try:
                if WINDOWS:
                    cleanup_path = _stage_windows_cleanup(draft, source_info)
                    cleanup_name = cleanup_path.name
                _remove_entry(cleanup_path, cleanup_name, directory_fd)
            except (OSError, RuntimeError) as cleanup_error:
                try:
                    _rollback_destination(destination, destination_name, directory_fd)
                except OSError as rollback_error:
                    raise RuntimeError(
                        "draft cleanup and final-link rollback both failed; do not use the published path"
                    ) from rollback_error
                if WINDOWS and cleanup_path != draft and cleanup_path.exists() and not draft.exists():
                    cleanup_path.rename(draft)
                raise RuntimeError(
                    "draft cleanup failed; the final link was rolled back"
                ) from cleanup_error

            if not _same_file(directory_info, os.stat(destination_dir, follow_symlinks=False)):
                _rollback_destination(destination, destination_name, directory_fd)
                raise RuntimeError("destination directory changed before publication completed")
            return destination.relative_to(root).as_posix()
        raise RuntimeError("could not allocate an immutable path after 1000 collisions")
    finally:
        if source_fd is not None:
            os.close(source_fd)
        if directory_fd is not None:
            os.close(directory_fd)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Publish a project-local Markdown draft with atomic no-overwrite semantics."
    )
    parser.add_argument("--source", required=True, help="Draft path under handoffs/ or reviews/")
    parser.add_argument("--directory", required=True, choices=sorted(ALLOWED_DIRECTORIES))
    parser.add_argument("--prefix", required=True, help="Lowercase role or review_report")
    args = parser.parse_args()
    try:
        path = publish(args.source, args.directory, args.prefix)
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
        return 1
    print(json.dumps({"path": path}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
