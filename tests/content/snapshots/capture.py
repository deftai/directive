"""
capture.py — Baseline snapshot tool for the Deft Directive testbed.

Walks the repo and captures, for every .md file:
  - Relative path from repo root
  - Top-level section headers (lines starting with # or ##)
  - Internal markdown links [text](target) per file

Output: tests/content/snapshots/baseline.json

Usage (from repo root):
    uv run python tests/content/snapshots/capture.py

Author: Scott Adams (msadams) — 2026-03-10
"""

import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Directories to skip entirely during the walk
SKIP_DIRS = {
    ".git",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    "node_modules",
    "backup",
    "dist",
    ".task",
}

# Regex: markdown link [text](target) — capture the target group
_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")

# Regex: section headers — lines that start with one or more # followed by space
_HEADER_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def collect_md_files(repo_root: Path) -> list[Path]:
    """Return all .md files under repo_root, sorted, skipping SKIP_DIRS."""
    results: list[Path] = []
    for path in sorted(repo_root.rglob("*.md")):
        # Skip any path whose parts include a skipped directory name
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        results.append(path)
    return results


def parse_file(path: Path) -> dict:
    """Extract headers and links from a single .md file."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {"error": str(exc), "headers": [], "links": []}

    headers = [
        {"level": len(m.group(1)), "text": m.group(2).strip()}
        for m in _HEADER_RE.finditer(text)
    ]

    links = [
        {"text": m.group(1).strip(), "target": m.group(2).strip()}
        for m in _LINK_RE.finditer(text)
        # Exclude pure URL links (http/https/mailto) and anchor-only links
        if not m.group(2).startswith(("http://", "https://", "mailto:", "#"))
    ]

    return {"headers": headers, "links": links}


def build_snapshot(repo_root: Path) -> dict:
    """Walk the repo and build the full baseline snapshot."""
    md_files = collect_md_files(repo_root)
    snapshot: dict = {}

    for abs_path in md_files:
        rel_path = abs_path.relative_to(repo_root).as_posix()
        snapshot[rel_path] = parse_file(abs_path)

    return {
        "repo_root": repo_root.as_posix(),
        "file_count": len(snapshot),
        "files": snapshot,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    # Repo root is three levels up from this file:
    # tests/content/snapshots/capture.py -> repo root
    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    out_path = Path(__file__).resolve().parent / "baseline.json"

    print(f"Scanning: {repo_root}")
    snapshot = build_snapshot(repo_root)
    print(f"Found {snapshot['file_count']} .md files")

    out_path.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Written: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
