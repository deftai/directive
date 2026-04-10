"""Scan source files for stub patterns (TODO, FIXME, HACK, return null, bare pass)."""

import re
import sys
from pathlib import Path

PATTERNS = [
    (re.compile(r"\bTODO\b"), "TODO"),
    (re.compile(r"\bFIXME\b"), "FIXME"),
    (re.compile(r"\bHACK\b"), "HACK"),
    (re.compile(r"\breturn\s+null\b"), "return null"),
]

EXCLUDE_DIRS = {
    "tests", "vendor", ".git", "backup", "history",
    "node_modules", ".venv", "__pycache__", "dist",
    "scripts",  # exclude tooling scripts (contain pattern strings)
}

EXTENSIONS = {".py", ".go", ".sh"}


def main() -> int:
    findings = []

    for f in sorted(Path(".").rglob("*")):
        if not f.is_file() or f.suffix not in EXTENSIONS:
            continue
        if any(p in f.parts for p in EXCLUDE_DIRS):
            continue
        try:
            text = f.read_text("utf-8", errors="replace")
            lines = text.splitlines()
            for i, line in enumerate(lines, 1):
                stripped = line.strip()
                # Detect bare 'pass' after a colon-ending line (stub function/method)
                if stripped == "pass" and f.suffix == ".py" and i >= 2:
                    prev = lines[i - 2].strip()
                    if prev.endswith(":") and not prev.startswith("#"):
                        findings.append((str(f), i, "bare pass", line.rstrip()))
                # Detect keyword patterns
                for pat, label in PATTERNS:
                    if pat.search(line):
                        findings.append((str(f), i, label, line.rstrip()))
        except Exception:
            pass

    if findings:
        print(f"Found {len(findings)} stub(s):")
        for fp, ln, label, text in findings[:50]:
            print(f"  {fp}:{ln} [{label}] {text[:120]}")
        if len(findings) > 50:
            print(f"  ... and {len(findings) - 50} more")
        return 1

    print("No stub patterns found in source files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
