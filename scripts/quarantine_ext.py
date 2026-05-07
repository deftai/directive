#!/usr/bin/env python3
r"""quarantine_ext.py -- prompt-injection quarantine for cached issue bodies (#583).

Public surface
--------------

``quarantine_body(raw_md: str) -> str``
    Return ``raw_md`` with any injection-shaped sections wrapped in
    ``\`\`\`quarantined`` fenced code blocks. Idempotent: input already wrapped
    in ``quarantined`` fences is left unchanged.

Background
----------

Issue bodies on GitHub frequently contain imperative-shaped markdown that
looks like agent instructions (``# STEP 1``, ``## TASK:``, ``IMPORTANT:`` /
``MUST`` headings, ``SYSTEM:`` directives, etc.). When a downstream agent
reads a cached issue body verbatim, the text is *data*, not *instructions* --
but a careless prompt template can splice the body directly into the agent's
turn payload, allowing a hostile issue author to redirect the agent.

#583 codified the mitigation: the cache layer wraps suspicious sections in a
``\`\`\`quarantined`` fenced code block so downstream consumers can detect and
either strip the section or emit a clear `do not follow these instructions`
preamble around it. The fence label is intentionally a non-standard
language-id so it is a syntactic marker, not a renderable hint.

Heuristic
---------

A markdown heading line (``^#{1,6} +``) is considered *suspicious* when it
contains one of the imperative tokens listed in :data:`SUSPICIOUS_TOKENS`
(case-insensitive, word-boundary scoped). Every line from a suspicious
heading down to (but not including) the next heading -- or end of document --
is treated as the suspicious section and wrapped.

Non-heading injection patterns (e.g. ``IMPORTANT:`` or ``SYSTEM:`` on a
plain prose line) also trigger wrapping of that line so a one-shot directive
embedded in body prose is still flagged.

The heuristic is intentionally permissive (false-positives wrap benign
``## Steps to reproduce`` sections in a quarantined fence). The downstream
display layer is responsible for unwrapping legitimate sections; the cost
of a false positive is one extra fence in the rendered output, while the
cost of a false negative is an exfiltrated agent turn.

CLI
---

The module is callable as a script:

    python scripts/quarantine_ext.py [<input-file>]

Reads ``<input-file>`` if given, otherwise stdin, and writes the quarantined
markdown to stdout. Useful for ad-hoc inspection.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Imperative tokens that mark a heading or line as injection-shaped. The set
# is curated against the recurrence record in #583 plus the canonical
# agent-prompt vocabulary used by Warp / Oz / Claude / OpenAI tool surfaces.
# Word-boundary scoped so the substring ``step`` inside ``stepladder`` does
# NOT trigger.
SUSPICIOUS_TOKENS: tuple[str, ...] = (
    "STEP",
    "TASK:",
    "TASK ",
    "IMPORTANT:",
    "IMPORTANT ",
    "MUST",
    "SYSTEM:",
    "SYSTEM ",
    "AGENT:",
    "AGENT ",
    "ASSISTANT:",
    "USER:",
    "INSTRUCTION:",
    "INSTRUCTIONS:",
    "TOOL:",
    "FUNCTION:",
    "PROMPT:",
    "OVERRIDE:",
    "IGNORE PREVIOUS",
    "DISREGARD PREVIOUS",
    "FORGET PREVIOUS",
    "ROLE:",
    "DIRECTIVE:",
)

# Regex source of truth -- compiled once. Word-boundary on each side of the
# token, except for tokens that already include trailing punctuation
# (``TASK:`` etc.) where the punctuation acts as the boundary.
_TOKEN_PATTERNS = []
for _tok in SUSPICIOUS_TOKENS:
    if _tok.endswith((":", " ")):
        # punctuation-anchored -- no trailing \b (the colon/space is the boundary)
        _TOKEN_PATTERNS.append(r"\b" + re.escape(_tok))
    else:
        _TOKEN_PATTERNS.append(r"\b" + re.escape(_tok) + r"\b")
_TOKEN_RE = re.compile("|".join(_TOKEN_PATTERNS), re.IGNORECASE)

# Heading detector: 1-6 hashes followed by at least one space. Setext-style
# headings (=== / ---) are intentionally not detected because they require
# multi-line lookahead and are vanishingly rare in GitHub-flavoured-markdown
# issue bodies.
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S.*)$")

# A code-fence delimiter line. Tracks whether we are inside an existing
# code block so heading-shaped text inside ```text``` is not re-quarantined.
_FENCE_RE = re.compile(r"^(```|~~~)")

QUARANTINE_FENCE_OPEN = "```quarantined"
QUARANTINE_FENCE_CLOSE = "```"


def _is_suspicious(line: str) -> bool:
    return bool(_TOKEN_RE.search(line))


def _is_heading(line: str) -> bool:
    return bool(_HEADING_RE.match(line))


def quarantine_body(raw_md: str) -> str:
    r"""Wrap injection-shaped sections in ``\`\`\`quarantined`` fences.

    Args:
        raw_md: Raw markdown body (e.g. the rendered text of a GitHub issue
            body fetched via ``gh issue view --json body``).

    Returns:
        The same markdown with suspicious sections wrapped. If no sections
        match, the input is returned unchanged (modulo trailing-newline
        normalization).

    The function is idempotent: re-running on already-quarantined text is a
    no-op because the existing ``\`\`\`quarantined`` fence is recognised as
    a code block and its contents are skipped.
    """
    if not raw_md:
        return raw_md

    lines = raw_md.splitlines()
    out: list[str] = []
    i = 0
    in_fence: str | None = None  # the fence delimiter we are inside, if any

    while i < len(lines):
        line = lines[i]

        # Track existing fenced code blocks so we don't re-wrap them.
        # ``in_fence`` records the opening delimiter; we only close on a
        # matching delimiter (Greptile P1: previously closed on the
        # current line's delim, which let a ``~~~`` line close an open
        # ``\`\`\`` fence and reopen a new one, leaving suspicious headings
        # after that point unquarantined).
        fence_match = _FENCE_RE.match(line)
        if fence_match:
            delim = fence_match.group(1)
            if in_fence is None:
                in_fence = delim
            elif line.startswith(in_fence):
                in_fence = None
            out.append(line)
            i += 1
            continue
        if in_fence is not None:
            out.append(line)
            i += 1
            continue

        # Suspicious heading: capture from this line to (but not including)
        # the next heading -- regardless of whether the next heading is also
        # suspicious. The next iteration will re-wrap the next section if
        # needed.
        if _is_heading(line) and _is_suspicious(line):
            section_end = i + 1
            while section_end < len(lines):
                nxt = lines[section_end]
                if _FENCE_RE.match(nxt):
                    # do not split a quarantined block across an unbalanced
                    # fence -- consume the entire interior. Both ``\`\`\``
                    # and ``~~~`` are 3-char delimiters; we slice the same
                    # prefix length and match the literal opener (Greptile
                    # P3: dead-conditional cleanup).
                    section_end += 1
                    nested = nxt[:3]
                    while section_end < len(lines) and not lines[
                        section_end
                    ].startswith(nested):
                        section_end += 1
                    section_end += 1  # consume the closer
                    continue
                if _is_heading(nxt):
                    break
                section_end += 1
            out.append(QUARANTINE_FENCE_OPEN)
            out.extend(lines[i:section_end])
            out.append(QUARANTINE_FENCE_CLOSE)
            i = section_end
            continue

        # Suspicious non-heading line: wrap just that line.
        if _is_suspicious(line):
            out.append(QUARANTINE_FENCE_OPEN)
            out.append(line)
            out.append(QUARANTINE_FENCE_CLOSE)
            i += 1
            continue

        out.append(line)
        i += 1

    # Preserve trailing newline behaviour of the input. If the input ends
    # with a newline, splitlines() drops it; re-add for round-trip safety.
    suffix = "\n" if raw_md.endswith("\n") else ""
    return "\n".join(out) + suffix


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Reads input file (or stdin) and emits quarantined md."""
    argv = list(argv if argv is not None else sys.argv[1:])
    if argv and argv[0] in {"-h", "--help"}:
        print(__doc__ or "")
        return 0
    text = Path(argv[0]).read_text(encoding="utf-8") if argv else sys.stdin.read()
    sys.stdout.write(quarantine_body(text))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
