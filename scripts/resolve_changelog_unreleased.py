#!/usr/bin/env python3
"""resolve_changelog_unreleased.py -- union-merge CHANGELOG [Unreleased] conflicts (#911).

Pure stdlib, cross-platform. Invoked from:

- ``task changelog:resolve-unreleased`` (Taskfile target wraps this script)
- ``uv run python scripts/resolve_changelog_unreleased.py [--changelog-path PATH]``
- Manually as a swarm cascade Phase 6 Step 1 helper, replacing the older
  HEAD-take-and-discard pattern that silently dropped the rebasing branch's
  CHANGELOG entry on every cascade rebase.

Recurrence record (the bug this script closes):

The 2026-05-04 v0.25.1 swarm cascade (4 PRs: #909 -> #907 -> #908 -> #906)
honoured the swarm-skill Phase 6 Step 1 rules ("use ``edit_files`` not shell
regex; verify structural integrity post-resolve") and the structural integrity
check passed. But the resolution PATTERN used (taking only the HEAD side of
each ``[Unreleased]``-section conflict) silently dropped the rebasing branch's
new CHANGELOG entry on every rebase after the first. Net effect: PR #908
squash-merged WITHOUT its CHANGELOG entry for #900; PR #906 squash-merged
WITHOUT its CHANGELOG entry for #901.

The correct resolution is a **union merge**: keep ALL HEAD entries (they are
the prior PRs' contributions that already landed on master) AND prepend each
branch entry that is not already in HEAD by ``(#NNN)`` issue-number heuristic.

Algorithm (per the #911 vBRIEF Overview):

1. Read CHANGELOG.md (UTF-8, atomic).
2. Locate the ``## [Unreleased]`` section and the next top-level ``## [...]``
   section header (or EOF).
3. Within those bounds, locate each conflict block delimited by
   ``<<<<<<< HEAD`` / ``=======`` / ``>>>>>>> <sha>``.
4. For each conflict block:
   - Determine the ambient ``### <subsection>`` (the most recent ``### header``
     between the start of ``[Unreleased]`` and the conflict marker).
   - Parse HEAD side and branch side as ``### <subsection>`` -> entries
     mappings; entries that appear before any ``###`` header are attached to
     the ambient subsection.
   - Union-merge: keep ALL HEAD entries; for each branch entry, if its
     ``(#NNN)`` issue-number set does not overlap any HEAD entry in the same
     subsection, PREPEND it under that subsection. Subsections that exist
     only in the branch side are appended.
5. Atomic write back via ``tempfile.NamedTemporaryFile`` + ``os.replace``;
   verify no ``<<<<<<<`` / ``=======`` / ``>>>>>>>`` markers remain
   post-resolve. If markers remain (e.g. conflict outside [Unreleased]),
   exit 1.

Three-state exit (mirrors ``scripts/preflight_branch.py`` / ``scripts/verify_encoding.py``):

- ``0`` -- resolved (or no-op when no conflict markers were present).
- ``1`` -- unresolvable: corrupted / mismatched / nested markers, or markers
  remained after the resolve pass.
- ``2`` -- config error: ``--changelog-path`` does not exist, file unreadable,
  or unrecognised CLI shape.

Out of scope (documented, NOT worked around):

- Conflicts INSIDE released sections (``## [0.X.Y]``) are NOT resolved here;
  the script reports them as exit 1 unresolvable so the operator falls back
  to ``edit_files`` (the manual fallback path documented in
  ``skills/deft-directive-swarm/SKILL.md`` Phase 6 Step 1).
- Multi-line entries with non-bullet continuation lines are preserved when
  the continuation is indented (leading whitespace) but a bare blank line
  ends the entry block. This matches the dominant CHANGELOG.md style.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import re
import sys
import tempfile
from pathlib import Path

#: Top-level section header (``## [Unreleased]`` or ``## [0.26.0] - ...``).
SECTION_HEADER_RE = re.compile(r"^##\s+\[([^\]]+)\]")

#: Subsection header (``### Added`` / ``### Fixed`` / ...).
SUBSECTION_HEADER_RE = re.compile(r"^###\s+(.+?)\s*$")

#: Bullet entry start (`- entry text` -- leading whitespace tolerated for
#: indented sublists).
ENTRY_BULLET_RE = re.compile(r"^\s*-\s")

#: Issue-number reference (``(#911)`` / ``(#1234)``). The dedup heuristic
#: extracts the SET of all issue numbers in an entry; two entries are
#: considered duplicates iff their sets share at least one number.
ISSUE_NUM_RE = re.compile(r"\(#(\d+)\)")

#: Entry-start with an opening bold marker (``- **`` / ``* **``). A deft
#: CHANGELOG entry canonically opens ``- **<conventional-commit subject>** --``;
#: a *truncated* header keeps the opening ``**`` but loses the closing ``**``
#: (and the trailing ``(#NNN)``), which is the orphan-stub shape #1003 fixes.
ENTRY_BOLD_OPEN_RE = re.compile(r"^\s*[-*]\s+\*\*")

#: Number of normalized leading characters used by the content-prefix dedup
#: fallback for entries that carry no ``(#NNN)`` reference (#1003).
CONTENT_PREFIX_LEN = 60

#: Conflict markers (the three-state union of git's standard merge markers).
CONFLICT_HEAD_PREFIX = "<<<<<<< "
CONFLICT_SEP = "======="
CONFLICT_TAIL_PREFIX = ">>>>>>> "

#: Sentinel for "no ambient subsection" (entries directly under ``[Unreleased]``
#: with no ``###`` header above them). Empty string is used internally; on
#: render we emit entries-only without re-emitting any header.
AMBIENT_NONE = ""


def _self_reconfigure_utf8() -> None:
    """Force UTF-8 stdout/stderr at script entry per #814.

    Mirrors the block at the top of :mod:`scripts.preflight_branch` and
    :mod:`scripts.verify_encoding`. Windows Python defaults stdout to cp1252
    (or cp437) when invoked from a hook or Taskfile target, neither of which
    has glyphs for the diagnostic messages this script may emit (``->``,
    ``check``, etc.). Without this reconfigure, the script can crash with
    ``UnicodeEncodeError`` AFTER the resolve has already succeeded, leaving
    the operator unsure whether the file was rewritten. ``errors='replace'``
    is a belt-and-suspenders fallback for the rare environment that still
    cannot render UTF-8.
    """
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def find_unreleased_bounds(lines: list[str]) -> tuple[int, int] | tuple[None, None]:
    """Return ``(start, end)`` line indices of the ``[Unreleased]`` section.

    ``start`` is the index of the ``## [Unreleased]`` header line; ``end`` is
    the index of the NEXT ``## [...]`` header (or ``len(lines)`` when
    ``[Unreleased]`` is the last section). When no ``[Unreleased]`` header
    exists, returns ``(None, None)``.
    """
    start: int | None = None
    for i, line in enumerate(lines):
        m = SECTION_HEADER_RE.match(line)
        if m and m.group(1).strip().lower() == "unreleased":
            start = i
            break
    if start is None:
        return None, None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if SECTION_HEADER_RE.match(lines[j]):
            end = j
            break
    return start, end


def find_conflict_blocks(
    lines: list[str], start: int, end: int
) -> list[tuple[int, int, int]] | None:
    """Find conflict blocks within ``lines[start:end]``.

    Returns a list of ``(head_idx, sep_idx, tail_idx)`` triples (inclusive line
    indices). Returns ``None`` on any structural error -- nested marker, missing
    separator, missing tail, or sep/tail before head -- so the caller can
    surface exit 1 with a clear unresolvable diagnostic.
    """
    blocks: list[tuple[int, int, int]] = []
    i = start
    while i < end:
        line = lines[i]
        if line.startswith(CONFLICT_HEAD_PREFIX):
            head_idx = i
            sep_idx: int | None = None
            tail_idx: int | None = None
            j = i + 1
            while j < end:
                inner = lines[j]
                if inner.startswith(CONFLICT_HEAD_PREFIX):
                    # Nested conflict head before a tail closes the prior --
                    # not supported here. Bail to manual fallback.
                    return None
                if inner == CONFLICT_SEP and sep_idx is None:
                    sep_idx = j
                elif inner.startswith(CONFLICT_TAIL_PREFIX) and sep_idx is not None:
                    tail_idx = j
                    break
                j += 1
            if sep_idx is None or tail_idx is None:
                return None
            blocks.append((head_idx, sep_idx, tail_idx))
            i = tail_idx + 1
        elif line == CONFLICT_SEP or line.startswith(CONFLICT_TAIL_PREFIX):
            # Stray separator/tail without a preceding head -- malformed.
            return None
        else:
            i += 1
    return blocks


def find_ambient_subsection(
    lines: list[str], conflict_start: int, unreleased_start: int
) -> str:
    """Walk back from ``conflict_start - 1`` to find the most recent ``### header``.

    Stops at the ``[Unreleased]`` header to avoid matching subsections inside
    a previously-rendered released section. Returns the subsection name when
    found, else :data:`AMBIENT_NONE` (``""``).
    """
    for i in range(conflict_start - 1, unreleased_start, -1):
        m = SUBSECTION_HEADER_RE.match(lines[i])
        if m:
            return m.group(1).strip()
    return AMBIENT_NONE


def parse_side(
    side_lines: list[str], ambient_subsection: str
) -> list[tuple[str, list[str]]]:
    """Parse one side of a conflict into ``[(subsection_name, entries)]``.

    Each entry is the joined text (with embedded ``\\n``) of one bullet block,
    including any indented continuation lines. Lines that are neither bullets
    nor ``###`` headers are dropped between entry blocks (they are blank
    separators that the renderer regenerates).

    The ambient subsection collects entries that appear before the first
    ``###`` header in the side. Subsequent ``###`` headers introduce new
    subsections in the order they appear.
    """
    sections: list[tuple[str, list[str]]] = []
    current_name = ambient_subsection
    current_entries: list[str] = []
    current_entry_lines: list[str] = []

    def flush_entry() -> None:
        nonlocal current_entry_lines
        if current_entry_lines:
            current_entries.append("\n".join(current_entry_lines))
            current_entry_lines = []

    def flush_section() -> None:
        nonlocal current_entries
        flush_entry()
        # Drop empty ambient sections so the renderer does not emit empty
        # subsection blocks for sides that contained zero entries above the
        # first ``###`` header.
        if current_entries or current_name != AMBIENT_NONE:
            sections.append((current_name, current_entries))
        current_entries = []

    for raw_line in side_lines:
        line = raw_line.rstrip("\n")
        sub_m = SUBSECTION_HEADER_RE.match(line)
        if sub_m:
            flush_section()
            current_name = sub_m.group(1).strip()
            continue
        if ENTRY_BULLET_RE.match(line):
            flush_entry()
            current_entry_lines = [line]
            continue
        if current_entry_lines:
            stripped = line.strip()
            if stripped == "":
                # Blank line ends the current entry block.
                flush_entry()
            elif line.startswith((" ", "\t")):
                # Indented continuation of the current entry.
                current_entry_lines.append(line)
            else:
                # Non-bullet, non-indented, non-blank line: ends the entry,
                # otherwise discarded as inter-entry prose.
                flush_entry()
        # Lines outside any entry are blank separators; the renderer
        # regenerates them, so we drop them on parse.

    flush_section()
    return sections


def issue_numbers(entry_text: str) -> set[str]:
    """Return the SET of ``#NNN`` issue numbers referenced in an entry."""
    return set(ISSUE_NUM_RE.findall(entry_text))


def is_orphan_header(entry_text: str) -> bool:
    """Return ``True`` when ``entry_text`` is a truncated orphan header (#1003).

    A deft CHANGELOG entry canonically opens
    ``- **<subject>** -- <body> (#NNN)``. A cascade rebase can splice a
    *truncated* header that keeps the opening ``**`` but loses the closing
    ``**`` AND the ``(#NNN)`` reference, e.g.::

        - **feat(scripts): `gh_rest.py` REST-fallback helpers

    Such a stub has no ``(#NNN)`` dedup key, so the union-merge helper used to
    preserve a fresh copy on every rebase -- two duplicate stubs shipped in
    v0.26.2. An orphan header is detected as an entry whose first line opens a
    bold span (``- **`` / ``* **``) but does NOT close it on that line
    (fewer than two ``**`` markers), AND carries no ``(#NNN)`` reference
    anywhere in the entry.
    """
    first_line = entry_text.split("\n", 1)[0]
    if not ENTRY_BOLD_OPEN_RE.match(first_line):
        return False
    # A well-formed header closes its bold span on the same line (>= 2 ``**``).
    if first_line.count("**") >= 2:
        return False
    # A trailing issue reference is a valid dedup key -- not an orphan.
    return not issue_numbers(entry_text)


def content_prefix(entry_text: str) -> str:
    """Return a normalized leading-content key for prefix-based dedup (#1003).

    Entries that carry no ``(#NNN)`` reference have no issue-number dedup key.
    To stop issue-numberless duplicates from accumulating across cascade
    rebases, the helper falls back to a normalized content prefix: the first
    line with its bullet marker, bold markers, and any ``(#NNN)`` references
    stripped, whitespace collapsed, lowercased, and truncated to
    :data:`CONTENT_PREFIX_LEN` chars. Dropping the ``(#NNN)`` token lets a
    cross-parity duplicate collapse -- a HEAD entry that carries the issue
    reference and an otherwise-identical branch entry that does not still
    share a prefix.
    """
    first_line = entry_text.split("\n", 1)[0]
    stripped = re.sub(r"^\s*[-*]\s+", "", first_line, count=1)
    stripped = stripped.replace("**", "")
    stripped = ISSUE_NUM_RE.sub("", stripped)
    stripped = " ".join(stripped.split())
    return stripped[:CONTENT_PREFIX_LEN].lower()


def union_merge(
    head_sections: list[tuple[str, list[str]]],
    branch_sections: list[tuple[str, list[str]]],
    *,
    warnings: list[str] | None = None,
) -> list[tuple[str, list[str]]]:
    """Union-merge branch entries into HEAD's section structure.

    Per the #911 contract:
    - All HEAD entries are kept verbatim, in HEAD's order.
    - For each branch entry, if its ``(#NNN)`` set does not overlap any
      HEAD entry in the SAME subsection, the branch entry is PREPENDED
      under that subsection.
    - Subsections that exist only in the branch side are appended after
      all HEAD subsections in the order they first appear in the branch.

    Two #1003 safeguards stop truncated / issue-numberless stubs from
    accumulating across cascade rebases:

    - **Orphan-header drop.** A truncated orphan header (see
      :func:`is_orphan_header`) has no dedup key, so it used to be prepended
      fresh on every rebase. Such stubs are now DROPPED from BOTH sides and
      never dedup against valid entries; each drop is recorded in
      ``warnings`` (when supplied) so the caller can surface a stderr WARN.
    - **Content-prefix fallback.** A branch entry with NO ``(#NNN)``
      reference is deduplicated against HEAD by a normalized content prefix
      (see :func:`content_prefix`); when no HEAD entry shares its prefix it is
      still prepended, so a genuinely new issue-numberless entry survives.
    """

    def _warn(side: str, name: str, entry_text: str) -> None:
        if warnings is None:
            return
        first_line = entry_text.split("\n", 1)[0]
        subsection = name or "(ambient)"
        warnings.append(
            f"dropped truncated orphan header from {side} side under "
            f"'{subsection}': {first_line!r}"
        )

    head_dict: dict[str, list[str]] = {}
    head_order: list[str] = []
    for name, entries in head_sections:
        kept: list[str] = []
        for e in entries:
            if is_orphan_header(e):
                _warn("HEAD", name, e)
                continue
            kept.append(e)
        if name in head_dict:
            head_dict[name].extend(kept)
        else:
            head_dict[name] = list(kept)
            head_order.append(name)

    for name, entries in branch_sections:
        if name not in head_dict:
            head_dict[name] = []
            head_order.append(name)
        existing_nums: set[str] = set()
        existing_prefixes: set[str] = set()
        for e in head_dict[name]:
            existing_nums |= issue_numbers(e)
            existing_prefixes.add(content_prefix(e))
        new_entries: list[str] = []
        for e in entries:
            if is_orphan_header(e):
                _warn("branch", name, e)
                continue
            nums = issue_numbers(e)
            if nums and nums & existing_nums:
                continue
            if not nums and content_prefix(e) in existing_prefixes:
                # Content-prefix fallback: an issue-numberless entry whose
                # normalized prefix already exists in HEAD is a duplicate.
                continue
            new_entries.append(e)
            existing_nums |= nums
            existing_prefixes.add(content_prefix(e))
        # Prepend in branch-side order so the leftmost branch entry ends up
        # at the top of the resolved section.
        head_dict[name] = new_entries + head_dict[name]

    return [(name, head_dict[name]) for name in head_order]


def render_resolved(
    merged: list[tuple[str, list[str]]], ambient_subsection: str
) -> list[str]:
    """Render merged sections as a list of lines (no trailing newline).

    The ambient subsection is rendered without a header (its ``###`` line
    is already in the file ABOVE the conflict block). Other subsections are
    rendered with their ``###`` header followed by a blank line, matching
    the existing CHANGELOG.md house style.
    """
    out: list[str] = []
    for name, entries in merged:
        if name != ambient_subsection:
            if out and out[-1] != "":
                out.append("")
            out.append(f"### {name}")
            out.append("")
        for entry in entries:
            for entry_line in entry.split("\n"):
                out.append(entry_line)
        # Trailing blank between non-ambient subsections is added on the
        # next iteration's leading-blank insertion above. The final
        # subsection gets no trailing blank here; the surrounding file
        # context provides the spacing.
    return out


def resolve_changelog(content: str) -> tuple[str | None, str]:
    """Pure function: take CHANGELOG content, return (new_content, message).

    Returns ``(new_content, "resolved" message)`` on a successful merge,
    ``(content, "no-op" message)`` when no conflicts were found, or
    ``(None, error message)`` when the content is unresolvable. Separated
    from :func:`main` so tests can drive every branch without temp files.
    """
    # Preserve trailing-newline behaviour: split keeps everything line-by-line
    # and we re-join with ``\n`` then add a trailing newline iff the original
    # had one. This mirrors the round-trip behaviour that ``edit_files``
    # produces and matches tools/git's expectation.
    had_trailing_newline = content.endswith("\n")
    lines = content.split("\n")
    # Drop the synthetic empty final element introduced by split() when the
    # input ends with a newline. We re-introduce it on render.
    if had_trailing_newline and lines and lines[-1] == "":
        lines = lines[:-1]

    unreleased_start, unreleased_end = find_unreleased_bounds(lines)
    if unreleased_start is None:
        # No [Unreleased] section -- check if any conflict markers exist
        # anywhere; if so, fail unresolvable. Otherwise no-op.
        if any(
            line.startswith((CONFLICT_HEAD_PREFIX, CONFLICT_TAIL_PREFIX))
            or line == CONFLICT_SEP
            for line in lines
        ):
            return None, (
                "unresolvable: conflict markers present but no [Unreleased] "
                "section found"
            )
        return content, "no-op: no [Unreleased] section, no conflict markers"

    blocks = find_conflict_blocks(lines, unreleased_start, unreleased_end)
    if blocks is None:
        return None, (
            "unresolvable: malformed conflict markers (nested / missing "
            "separator / orphan tail) inside [Unreleased]"
        )

    # Detect conflicts OUTSIDE [Unreleased]: scan the rest of the file.
    has_outside_marker = any(
        (
            line.startswith((CONFLICT_HEAD_PREFIX, CONFLICT_TAIL_PREFIX))
            or line == CONFLICT_SEP
        )
        for i, line in enumerate(lines)
        if i < unreleased_start or i >= unreleased_end
    )

    if not blocks:
        if has_outside_marker:
            return None, (
                "unresolvable: conflict markers present outside [Unreleased] "
                "section -- resolve manually with edit_files"
            )
        return content, "no-op: no conflict markers in [Unreleased]"

    # Resolve each conflict block, walking back-to-front so earlier indices
    # remain valid as we splice replacement lines in.
    new_lines = list(lines)
    warnings: list[str] = []
    for head_idx, sep_idx, tail_idx in reversed(blocks):
        # Sides are sliced exclusive of the markers themselves.
        head_side = new_lines[head_idx + 1 : sep_idx]
        branch_side = new_lines[sep_idx + 1 : tail_idx]
        ambient = find_ambient_subsection(new_lines, head_idx, unreleased_start)
        head_parsed = parse_side(head_side, ambient)
        branch_parsed = parse_side(branch_side, ambient)
        merged = union_merge(head_parsed, branch_parsed, warnings=warnings)
        rendered = render_resolved(merged, ambient)
        new_lines[head_idx : tail_idx + 1] = rendered

    # Verify no markers remain anywhere in the file.
    for line in new_lines:
        if (
            line.startswith((CONFLICT_HEAD_PREFIX, CONFLICT_TAIL_PREFIX))
            or line == CONFLICT_SEP
        ):
            if has_outside_marker:
                return None, (
                    "unresolvable: conflict markers remain outside "
                    "[Unreleased] -- resolve manually with edit_files"
                )
            return None, (
                "unresolvable: conflict markers remain after resolve "
                "(internal error -- please file an issue)"
            )

    # Surface any dropped orphan stubs on stderr so the operator can recover
    # the canonical entry manually if the drop was unexpected (#1003 AC-1).
    for warning in warnings:
        print(f"WARN resolve_changelog: {warning}", file=sys.stderr)

    new_content = "\n".join(new_lines)
    if had_trailing_newline:
        new_content += "\n"
    return new_content, f"resolved: union-merged {len(blocks)} conflict block(s)"


def atomic_write(path: Path, content: str) -> None:
    """Write ``content`` to ``path`` atomically via tempfile + ``os.replace``.

    The temp file is created in the SAME directory as the target so the
    rename is on the same filesystem (``os.replace`` is atomic only within a
    single filesystem on POSIX; on Windows it requires same-volume too).
    UTF-8 encoding mandated per #798 root-cause rule -- no PowerShell-side
    string round-trip ever touches the bytes.
    """
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(parent)
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(content)
        os.replace(str(tmp_path), str(path))
    except Exception:
        # Best-effort cleanup of the temp file on any failure path.
        with contextlib.suppress(OSError):
            tmp_path.unlink()
        raise


def evaluate(
    changelog_path: Path, *, dry_run: bool = False
) -> tuple[int, str]:
    """Pure function returning ``(exit_code, human_message)``.

    Separated from :func:`main` so tests can drive every state without
    ``capsys`` plumbing or ``argparse`` round-tripping.
    """
    if not changelog_path.exists():
        return 2, (
            f"config error: CHANGELOG path does not exist: {changelog_path}\n"
            "  Recovery: pass --changelog-path pointing at an existing file."
        )
    if not changelog_path.is_file():
        return 2, (
            f"config error: CHANGELOG path is not a regular file: {changelog_path}"
        )
    try:
        content = changelog_path.read_text(encoding="utf-8")
    except OSError as exc:
        return 2, f"config error: cannot read {changelog_path}: {exc}"

    new_content, message = resolve_changelog(content)
    if new_content is None:
        # Greptile P2 (PR #999): inner messages from resolve_changelog already
        # carry the canonical ``unresolvable: ...`` prefix; do not re-prefix
        # here or operators see ``unresolvable: unresolvable: ...`` on stderr.
        return 1, f"{message}\n  Path: {changelog_path}"

    if new_content == content:
        return 0, f"OK {changelog_path}: {message}"

    if dry_run:
        return 0, f"OK (dry-run) {changelog_path}: {message}"

    try:
        atomic_write(changelog_path, new_content)
    except OSError as exc:
        return 2, f"config error: cannot write {changelog_path}: {exc}"

    return 0, f"OK {changelog_path}: {message}"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="resolve_changelog_unreleased.py",
        description=(
            "Union-merge CHANGELOG.md [Unreleased] conflicts (#911). "
            "Replaces the HEAD-take-and-discard pattern that silently "
            "dropped the rebasing branch's CHANGELOG entry on swarm "
            "cascade rebase. Three-state exit: 0 resolved (or no-op), "
            "1 unresolvable, 2 config error."
        ),
    )
    parser.add_argument(
        "--changelog-path",
        default="CHANGELOG.md",
        help=(
            "Path to CHANGELOG.md (default: ./CHANGELOG.md relative to "
            "the working directory)."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Compute the resolution and report what would change without "
            "writing the file. Useful for review-cycle preview."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the OK message (errors still print).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    _self_reconfigure_utf8()
    parser = _build_parser()
    args = parser.parse_args(argv)
    changelog_path = Path(args.changelog_path).resolve()
    code, msg = evaluate(changelog_path, dry_run=args.dry_run)
    if code == 0:
        if not args.quiet:
            print(msg)
    else:
        print(msg, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
