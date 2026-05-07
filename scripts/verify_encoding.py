#!/usr/bin/env python3
"""verify_encoding.py -- deterministic gate against PS 5.1 non-ASCII round-trip corruption (#798).

Pure stdlib, cross-platform. Invoked from:

- ``.githooks/pre-commit`` via ``--staged`` after ``preflight_branch.py`` (#747)
- ``task verify:encoding`` (aggregated into ``task check``) via ``--all``
- ``uv run python scripts/verify_encoding.py [--staged|--all] [--allow-list <path>]``

Recurrence chain (this gate elevates the rule from prose tier to deterministic
tier per main.md Rule Authority [AXIOM]):

- #236 t1.11.1 -- ``Get-Content -Raw`` + BOM-safe write rules in scm/github.md
- #240 t1.11.2 -- Warp multi-line PS here-string rule in scm/github.md
- #283 t1.20.1 -- ``New-Object System.Text.UTF8Encoding $false`` rule in AGENTS.md
- PR #795 (2026-05-01) -- 132-line CHANGELOG mojibake on the same maintainer
  with all three rules loaded, because the corruption happened on the READ side
  (``Get-Content -Raw`` decodes via the active codepage, typically CP1252 or
  CP437 on Windows) BEFORE any safe write could preserve the bytes.

Detection scope (UTF-8 codepoint sequences that appear after a Windows
codepage round-trip):

- U+FFFD replacement chars (universal corruption marker).
- CP1252-as-UTF-8 mojibake bigrams (``Â§``, ``Â°``, ``â€™``, ``â€¦``, ``â†'`` ...).
- CP437-as-UTF-8 mojibake bigrams (``Γèù``, ``Γ£ô``, ``ΓÇª``, ``ΓÇö`` ...).
- Unexpected UTF-8 BOM (``EF BB BF``) on text formats where BOM is non-canonical
  (.md, .json, .yml, .yaml, .txt).

False-positive guards:

- Markdown inline code spans (single backticks) and fenced code blocks (triple
  backticks) are stripped before scanning .md files -- recurrence-record prose
  legitimately quotes mojibake bytes inside backticks.
- A built-in allow-list skips the #798 brief itself (which documents the
  bigram catalog as part of its acceptance criteria).
- ``--allow-list <path>`` accepts a newline-separated list of glob patterns
  for project-specific documented exceptions (e.g. regression fixtures).

Exit codes (three-state, mirrors ``scripts/preflight_branch.py``):

- ``0`` -- clean: no mojibake / U+FFFD / unexpected BOM detected.
- ``1`` -- corruption found: prints per-hit ``path:line:[label] context``.
- ``2`` -- config error: ``--allow-list`` path unreadable, ``--staged``
  outside a git repo, or unrecognised CLI shape.
"""

from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path

#: Codepoint sequences that signal a Windows codepage round-trip corruption.
#: Each entry maps a mojibake bigram to a short label naming the canonical
#: codepoint that was corrupted. The set is intentionally CONSERVATIVE --
#: only the bigrams observed in the four-recurrence record (#236, #240, #283,
#: PR #795 / #844) plus the most common Windows-codepage analogues are listed.
#: Adding a pattern here MUST be paired with a parametrized regression test
#: in ``tests/cli/test_verify_encoding.py``.
MOJIBAKE_PATTERNS: dict[str, str] = {
    # CP437-as-UTF-8 (Windows DOS codepage; recurrence record PR #844 / fix #846).
    # Pattern: original UTF-8 bytes E2 XX YY decoded by cp437 yields "Γ" + two cp437 glyphs.
    "Γèù": "U+2297 (⊗) corrupted via cp437 read",
    "Γ£ô": "U+2713 (✓) corrupted via cp437 read",
    "ΓÇª": "U+2026 (…) corrupted via cp437 read",
    "ΓÇö": "U+2014 (—) corrupted via cp437 read",
    "ΓÇô": "U+2013 (–) corrupted via cp437 read",
    "ΓÇó": "U+2022 (•) corrupted via cp437 read",
    "ΓÇÖ": "U+2019 (’) corrupted via cp437 read",
    "ΓÇÿ": "U+2018 (‘) corrupted via cp437 read",
    "ΓÇ£": "U+201C (“) corrupted via cp437 read",
    "ΓÇØ": "U+201D (”) corrupted via cp437 read",
    "ΓåÆ": "U+2192 (→) corrupted via cp437 read",
    # CP1252-as-UTF-8 (Windows ANSI codepage; recurrence record #236, #240, #283, PR #795).
    # Pattern: original UTF-8 bytes (typically prefixed C2/C3/E2) decoded by cp1252.
    "â€™": "U+2019 (’) corrupted via cp1252 read",
    "â€˜": "U+2018 (‘) corrupted via cp1252 read",
    "â€œ": "U+201C (“) corrupted via cp1252 read",
    "â€\x9d": "U+201D (”) corrupted via cp1252 read",
    "â€“": "U+2013 (–) corrupted via cp1252 read",
    "â€”": "U+2014 (—) corrupted via cp1252 read",
    "â€¦": "U+2026 (…) corrupted via cp1252 read",
    "â€¢": "U+2022 (•) corrupted via cp1252 read",
    "â†’": "U+2192 (→) corrupted via cp1252 read",
    "Â§": "U+00A7 (§) corrupted via cp1252 read",
    "Â°": "U+00B0 (°) corrupted via cp1252 read",
    "Â´": "U+00B4 (´) corrupted via cp1252 read",
    "Â­": "U+00AD (soft hyphen) corrupted via cp1252 read",
    "Â©": "U+00A9 (©) corrupted via cp1252 read",
    "Â®": "U+00AE (®) corrupted via cp1252 read",
    "Â±": "U+00B1 (±) corrupted via cp1252 read",
}

#: U+FFFD REPLACEMENT CHARACTER -- the universal mojibake marker emitted by
#: ``str.decode(..., errors='replace')`` when input bytes can't be decoded.
#: Distinct from MOJIBAKE_PATTERNS because U+FFFD detection is encoding-agnostic.
REPLACEMENT_CHAR = "\ufffd"

#: UTF-8 BOM byte sequence (``EF BB BF``). Some text formats accept it
#: (.ps1, .csv on Windows) but markdown / JSON / YAML / plain text do NOT --
#: a BOM in those files corrupts downstream parsers and is the signature
#: of a PS 5.1 ``Set-Content -Encoding UTF8`` write.
UTF8_BOM = b"\xef\xbb\xbf"

#: File extensions where a leading UTF-8 BOM is non-canonical and should be
#: flagged. Other extensions (.csv, .ps1, .bat) tolerate or expect a BOM.
NO_BOM_EXTENSIONS = frozenset({".md", ".json", ".yml", ".yaml", ".txt"})

#: File extensions to scan by default. Conservative -- excludes binary formats
#: and source files where the cost/benefit of mojibake detection is lower.
SCANNABLE_EXTENSIONS = frozenset({
    ".md", ".json", ".yml", ".yaml", ".txt",
    ".py", ".sh", ".ps1", ".toml", ".cfg",
})

#: Path-glob patterns auto-skipped because the file legitimately contains
#: mojibake byte sequences as part of its purpose. Each entry is matched
#: against the path's POSIX form (forward slashes) via ``fnmatch.fnmatchcase``.
#: When a future recurrence-record vBRIEF documents a new bigram, append its
#: rel-path here -- the rule body lives in this gate, NOT in prose.
BUILTIN_ALLOW_LIST: tuple[str, ...] = (
    # The #798 brief catalogues the bigram set being detected; quoting
    # the bigrams in its narrative is the brief's own acceptance criterion.
    "vbrief/active/*-798-*.vbrief.json",
    "vbrief/completed/*-798-*.vbrief.json",
    "vbrief/cancelled/*-798-*.vbrief.json",
    "vbrief/pending/*-798-*.vbrief.json",
    "vbrief/proposed/*-798-*.vbrief.json",
    # history/archive/ preserves historical task / vbrief state byte-for-byte.
    # Pre-existing mojibake in archived artifacts (e.g. v0.20 migration residue)
    # is intentionally retained as a forensic record and MUST NOT be rewritten.
    "history/archive/**",
    "history/archive/**/*",
    # Self-skip: this script and its test file are the canonical catalog of
    # the bigrams being detected. Scanning them would flag every entry in
    # MOJIBAKE_PATTERNS as a hit against the file that defines it. The
    # forward-coverage contract is upheld by tests/cli/test_verify_encoding.py
    # (parametrized over MOJIBAKE_PATTERNS), not by the gate scanning itself.
    "scripts/verify_encoding.py",
    "tests/cli/test_verify_encoding.py",
)

#: Markdown inline-code span: single backtick to single backtick on one line,
#: not crossing line boundaries (handles both LF and CRLF). Conservative: the
#: regex is non-greedy so a line like `` `foo` and `bar` `` produces two
#: separate matches, not one.
_MD_INLINE_CODE = re.compile(r"`[^`\r\n]*`")

#: Markdown fenced code block: ``` (or ~~~) ... ``` (or ~~~) across multiple
#: lines. CRLF-robust: trailing-whitespace classes include ``\r`` so the
#: ``$`` anchor still matches when the file is CRLF (Python regex MULTILINE
#: ``$`` matches *before* ``\n``, which on CRLF lines leaves the prior ``\r``
#: needing to be absorbed by the trailing whitespace class). The opening
#: fence allows a language tag (e.g. ``` ```python ```) before the newline.
_MD_FENCED_BLOCK = re.compile(
    r"(?ms)^[ \t]*(```|~~~)[^\n]*\n.*?^[ \t]*\1[ \t\r]*$"
)


class Finding:
    """One mojibake / U+FFFD / BOM detection record."""

    __slots__ = ("path", "line", "label", "context")

    def __init__(self, path: str, line: int, label: str, context: str) -> None:
        self.path = path
        self.line = line
        self.label = label
        self.context = context

    def render(self) -> str:
        ctx = self.context if len(self.context) <= 120 else self.context[:117] + "..."
        return f"  {self.path}:{self.line} [{self.label}] {ctx}"


def _blank_block(match: re.Match[str]) -> str:
    """Replace a fenced code block with the same number of newlines.

    Greptile P1 (PR #862): the prior implementation used
    ``_MD_FENCED_BLOCK.sub("", text)`` which removed the newlines that lived
    INSIDE the matched fence. After substitution every line that followed in
    ``scan_text`` shifted upward by the number of consumed newlines, so a
    mojibake hit AFTER a fenced block was reported at the wrong line number
    with the wrong context (and the true line was not reported at all). The
    gate still exited 1 -- corruption did not silently pass -- but the
    diagnostic was misleading.

    Replacing with ``\n`` * count preserves line-count alignment between
    ``original_lines`` and ``stripped_lines`` so the zip in :func:`scan_file`
    pairs each original line with its stripped counterpart at the same index.
    """
    return "\n" * match.group(0).count("\n")


def _strip_markdown_quotes(text: str) -> str:
    """Strip fenced code blocks and inline-code spans from markdown content.

    Rationale: recurrence-record documentation legitimately quotes mojibake
    bytes inside backticks (e.g. CHANGELOG entries describing the corruption
    being fixed). Stripping these before scanning prevents the gate from
    flagging its own documentation. Other file formats (JSON, YAML, source
    code) are scanned without this treatment because the false-positive rate
    is much lower outside markdown prose.

    Order matters: fenced blocks are stripped first (they may contain
    backticks themselves), then inline spans. Fenced blocks are replaced
    with newline-preserving blanks (see :func:`_blank_block`) so post-fence
    line numbers stay aligned with the original file.
    """
    text = _MD_FENCED_BLOCK.sub(_blank_block, text)
    return _MD_INLINE_CODE.sub("", text)


def _load_allow_list(path: Path | None) -> list[str]:
    """Read newline-separated glob patterns from ``path``; ignore comments.

    Lines starting with ``#`` and blank lines are skipped. Returns an empty
    list when ``path`` is ``None``. Raises :class:`FileNotFoundError` when
    a non-``None`` path does not exist (caller maps to exit 2).
    """
    if path is None:
        return []
    raw = path.read_text(encoding="utf-8", errors="replace")
    out: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        out.append(stripped)
    return out


def _is_allow_listed(rel_path: str, patterns: Iterable[str]) -> bool:
    """Return True when ``rel_path`` (POSIX form) matches any glob in patterns."""
    return any(fnmatch.fnmatchcase(rel_path, pat) for pat in patterns)


def _git_tracked_files(project_root: Path) -> list[str]:
    """Return ``git ls-files`` output as a list of POSIX-form rel paths."""
    proc = subprocess.run(
        ["git", "ls-files"],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"git ls-files failed (rc={proc.returncode}): {proc.stderr.strip()}"
        )
    return [line for line in proc.stdout.splitlines() if line.strip()]


def _git_staged_files(project_root: Path) -> list[str]:
    """Return ``git diff --cached --name-only`` output as POSIX-form rel paths."""
    proc = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"git diff --cached failed (rc={proc.returncode}): {proc.stderr.strip()}"
        )
    return [line for line in proc.stdout.splitlines() if line.strip()]


def scan_file(rel_path: str, full_path: Path) -> list[Finding]:
    """Scan one file for U+FFFD / mojibake / unexpected BOM.

    Returns a list of :class:`Finding` records (one per hit). An unreadable
    or binary file returns an empty list rather than raising -- the gate
    is intentionally permissive on read failures so a single unreadable
    file does not block a whole pre-commit.
    """
    findings: list[Finding] = []
    suffix = full_path.suffix.lower()

    try:
        raw = full_path.read_bytes()
    except OSError:
        return findings

    if suffix in NO_BOM_EXTENSIONS and raw.startswith(UTF8_BOM):
        findings.append(Finding(
            rel_path,
            1,
            "unexpected UTF-8 BOM",
            "leading bytes EF BB BF on a format where BOM is non-canonical",
        ))

    try:
        text = raw.decode("utf-8", errors="replace")
    except UnicodeDecodeError:
        # Should not happen with errors='replace' but guard anyway.
        return findings

    if "\x00" in text[:1024]:
        # Likely binary file -- skip mojibake scan.
        return findings

    scan_text = text
    if suffix == ".md":
        scan_text = _strip_markdown_quotes(text)

    # We need original line numbers for diagnostics, so iterate the original
    # text but check membership against the stripped form.
    if scan_text == text:
        lines = text.splitlines()
        for lineno, line in enumerate(lines, 1):
            findings.extend(_scan_line(rel_path, lineno, line))
    else:
        # For markdown, scan line-by-line on the stripped form so reported
        # line numbers correspond to the original file's line layout. We
        # split BOTH the original and stripped text on \n; fenced-block
        # stripping replaces blocks with empty strings, which preserves
        # line-count alignment because each newline in the block is
        # consumed by the regex.
        original_lines = text.splitlines()
        stripped_lines = scan_text.splitlines()
        # Pad stripped to original length defensively so a regex edge-case
        # (e.g. trailing newline mismatch) doesn't drop late findings.
        if len(stripped_lines) < len(original_lines):
            stripped_lines = stripped_lines + [""] * (
                len(original_lines) - len(stripped_lines)
            )
        for lineno, (orig, stripped) in enumerate(
            zip(original_lines, stripped_lines, strict=False), 1
        ):
            findings.extend(_scan_line(rel_path, lineno, stripped, context=orig))

    return findings


def _scan_line(
    rel_path: str,
    lineno: int,
    line: str,
    *,
    context: str | None = None,
) -> list[Finding]:
    """Scan one line; return findings for U+FFFD + each mojibake pattern hit."""
    findings: list[Finding] = []
    ctx = context if context is not None else line
    if REPLACEMENT_CHAR in line:
        findings.append(Finding(
            rel_path,
            lineno,
            "U+FFFD replacement char",
            ctx,
        ))
    for pattern, label in MOJIBAKE_PATTERNS.items():
        if pattern in line:
            findings.append(Finding(rel_path, lineno, label, ctx))
    return findings


def _filter_scannable(
    rel_paths: Iterable[str],
    project_root: Path,
    allow_globs: Iterable[str],
) -> list[tuple[str, Path]]:
    """Filter rel paths to existing scannable files, applying allow-list.

    SLizard P1 (PR #862): an earlier draft used
    ``str(full).startswith(str(project_root.resolve()))`` as a fallback for
    the path-containment check. That string-based comparison is vulnerable
    to substring path-traversal (e.g. ``project_root=/a/b`` would match a
    sibling ``/a/b-evil/file.txt`` because ``/a/b`` is a string prefix of
    ``/a/b-evil``). The current implementation uses
    :meth:`Path.is_relative_to` exclusively (Python 3.9+; this project
    targets 3.12+) which does proper path-segment containment and rejects
    the substring-match attack class by construction. A non-relative path
    is dropped silently because it cannot represent a tracked file under
    the working tree the gate is scanning.
    """
    out: list[tuple[str, Path]] = []
    allow_globs = list(allow_globs)
    project_root_resolved = project_root.resolve()
    for rel in rel_paths:
        # Normalize to POSIX form for glob matching (git output already is).
        posix = rel.replace("\\", "/")
        full = (project_root / rel).resolve()
        if not full.is_relative_to(project_root_resolved):
            continue
        if not full.is_file():
            continue
        if full.suffix.lower() not in SCANNABLE_EXTENSIONS:
            continue
        if _is_allow_listed(posix, allow_globs):
            continue
        out.append((posix, full))
    return out


def evaluate(
    project_root: Path,
    *,
    mode: str = "all",
    allow_list_path: Path | None = None,
) -> tuple[int, list[Finding], str]:
    """Pure function returning ``(exit_code, findings, human_message)``.

    Separated from :func:`main` so tests can drive every state without
    ``capsys`` plumbing or env-var leak.
    """
    if mode not in {"all", "staged"}:
        return 2, [], (
            f"❌ verify_encoding: unrecognised mode '{mode}' "
            "(expected 'all' or 'staged')."
        )

    try:
        custom_globs = _load_allow_list(allow_list_path)
    except FileNotFoundError as exc:
        return 2, [], (
            f"❌ verify_encoding: --allow-list file not found: {exc}\n"
            "  Recovery: pass an existing path or omit the flag."
        )
    except OSError as exc:
        return 2, [], (
            f"❌ verify_encoding: --allow-list unreadable: {exc}\n"
            "  Recovery: check file permissions."
        )

    allow_globs = list(BUILTIN_ALLOW_LIST) + custom_globs

    try:
        if mode == "staged":
            rel_paths = _git_staged_files(project_root)
        else:
            rel_paths = _git_tracked_files(project_root)
    except FileNotFoundError:
        return 2, [], (
            "❌ verify_encoding: 'git' executable not found on PATH.\n"
            "  Recovery: install git or set DEFT_PYTHON to a python that "
            "can spawn git."
        )
    except RuntimeError as exc:
        return 2, [], (
            f"❌ verify_encoding: git failed -- {exc}\n"
            "  Recovery: ensure --project-root points at a git working tree."
        )

    candidates = _filter_scannable(rel_paths, project_root, allow_globs)

    findings: list[Finding] = []
    for rel, full in candidates:
        findings.extend(scan_file(rel, full))

    if findings:
        header = (
            f"❌ verify_encoding: detected {len(findings)} mojibake / "
            f"U+FFFD / unexpected-BOM hit(s) across {len({f.path for f in findings})} "
            f"file(s) (#798).\n"
            "  Root cause: PowerShell 5.1 Get-Content -Raw decodes via the active "
            "Windows codepage (cp1252 or cp437) on the READ side, BEFORE any\n"
            "  safe write can preserve the bytes. Fix: rewrite the offending "
            "files with Python pathlib.Path.write_text(text, encoding='utf-8'),\n"
            "  re-read from a clean source (git checkout HEAD -- <path>), and "
            "do NOT round-trip through PS 5.1 again. See AGENTS.md ## PowerShell.\n"
            "  Allow-list a documented exception via --allow-list <path> "
            "(file with newline-separated glob patterns)."
        )
        body = "\n".join(f.render() for f in findings[:50])
        if len(findings) > 50:
            body += f"\n  ... and {len(findings) - 50} more"
        return 1, findings, f"{header}\n{body}"

    msg = (
        f"✓ verify_encoding: {len(candidates)} file(s) clean -- no mojibake / "
        "U+FFFD / unexpected-BOM detected (#798)."
    )
    return 0, findings, msg


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_encoding.py",
        description=(
            "Deterministic gate against PS 5.1 non-ASCII round-trip "
            "corruption (#798). Scans tracked text files for U+FFFD "
            "replacement chars, the curated CP1252-as-UTF-8 / "
            "CP437-as-UTF-8 mojibake bigram set, and unexpected UTF-8 "
            "BOM on .md/.json/.yml/.yaml/.txt."
        ),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--all",
        dest="mode",
        action="store_const",
        const="all",
        help="Scan all tracked files via 'git ls-files' (default).",
    )
    mode.add_argument(
        "--staged",
        dest="mode",
        action="store_const",
        const="staged",
        help=(
            "Scan only staged files via 'git diff --cached --name-only' "
            "(used by .githooks/pre-commit)."
        ),
    )
    parser.set_defaults(mode="all")
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root path (default: current working directory).",
    )
    parser.add_argument(
        "--allow-list",
        default=None,
        help=(
            "Path to a file with newline-separated glob patterns of "
            "documented exceptions. Lines starting with # are comments."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the OK message (errors still print).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # #814: Force UTF-8 stdout/stderr at hook-script entry. Windows Python
    # defaults stdout/stderr to cp1252 (or cp437) when the hook is invoked
    # by git, neither of which has a glyph for the U+2713 success marker
    # or the various non-ASCII glyphs in this script's diagnostic output.
    # Mirrors the block in scripts/preflight_branch.py exactly.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    allow_list_path = Path(args.allow_list).resolve() if args.allow_list else None

    code, _findings, msg = evaluate(
        project_root,
        mode=args.mode,
        allow_list_path=allow_list_path,
    )
    if code == 0:
        if not args.quiet:
            print(msg)
    else:
        print(msg, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
