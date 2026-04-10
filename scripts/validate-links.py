"""Validate internal links in markdown files."""

import os
import re
import sys
from pathlib import Path

EXCLUDE_DIRS = {
    ".git", "backup", "node_modules", ".venv", "__pycache__", "dist",
    ".planning", "specs",  # planning docs and test fixtures
}
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")

# Skip template variables, reference markers, and example-only links
SKIP_PATTERNS = re.compile(r"[{}@]|^\[|^\./relative-|^path$")


def main() -> int:
    broken = []

    for md in sorted(Path(".").rglob("*.md")):
        if any(p in md.parts for p in EXCLUDE_DIRS):
            continue
        # Skip history/archive/ files
        if "history" in md.parts and "archive" in md.parts:
            continue
        try:
            text = md.read_text("utf-8", errors="replace")
            for i, line in enumerate(text.splitlines(), 1):
                for m in LINK_RE.finditer(line):
                    target = m.group(2)
                    # Skip external URLs, anchors, and mailto
                    if target.startswith(("http://", "https://", "mailto:", "#")):
                        continue
                    # Skip template variables and example links
                    if SKIP_PATTERNS.search(target):
                        continue
                    # Strip anchor and query params
                    clean = target.split("#")[0].split("?")[0]
                    if not clean:
                        continue
                    resolved = (md.parent / clean).resolve()
                    if not resolved.exists():
                        broken.append((str(md), i, target))
        except Exception:
            pass

    strict = os.environ.get("LINK_CHECK_STRICT", "") == "1" or "--strict" in sys.argv

    if broken:
        mode = "errors" if strict else "warnings"
        print(f"Found {len(broken)} broken internal link(s) ({mode}):")
        for fp, ln, target in broken[:50]:
            print(f"  {fp}:{ln} -> {target}")
        if len(broken) > 50:
            print(f"  ... and {len(broken) - 50} more")
        return 1 if strict else 0

    print("All internal markdown links valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
