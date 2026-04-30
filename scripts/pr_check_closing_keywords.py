#!/usr/bin/env python3
"""
pr_check_closing_keywords.py -- Pre-PR closing-keyword negation-context lint (#737).

Scans a pull request body AND every commit message in the PR for GitHub
closing-keyword tokens (``close|closes|closed|fix|fixes|fixed|resolve|
resolves|resolved``) immediately followed by ``#\\d+`` that appear inside
a negation, quotation, example, or fenced-code-block context. GitHub's
closing-keyword parser is substring-based (Layer 1 / Layer 2 / Layer 3
recurrence record: #167, #698, #701, #735), so a phrase like
``DOES NOT CLOSE #734`` typed in a PR body or squash-commit footer will
auto-close the issue regardless of the surrounding semantics.

This lint is the **Layer 0 (prevention)** counterpart to the existing
**Layer 3 (recovery)** ``scripts/pr_check_protected_issues.py`` from
#701. It refuses to push a PR that contains any negation-context hit so
the operator can rewrite the wording before GitHub ever sees the body.

Background
----------
- #167 (Layer 1): post-merge close-verify check (some intended closes
  silently fail to fire).
- #698 (Layer 2): substring match on PR body even inside negation
  parentheticals (incident: PR #697 auto-closed #642).
- #701 (Layer 3): persistent ``closingIssuesReferences`` link survives
  body / commit-message edits (incidents: PR #700 closed #233; PR #401
  closed #642).
- #735: PR squash body contained ``DOES NOT CLOSE #734`` and auto-closed
  #734 (umbrella for #737); manual reopen required. This script is the
  structural gap-closer.

Usage
-----
    # Online: fetch PR <N> body + commit messages via gh.
    uv run python scripts/pr_check_closing_keywords.py --pr 735

    # Offline: lint pre-staged body / commits files (CI / pre-push hooks).
    uv run python scripts/pr_check_closing_keywords.py \\
        --body-file ./pr-body.md \\
        --commits-file ./commits.txt

    # Allow seeded false-positives by listing the issue numbers that are
    # known-safe (e.g. test-fixture wordings).
    uv run python scripts/pr_check_closing_keywords.py \\
        --pr 735 --allow-known-false-positives 999,1000

Exit codes
----------
    0 -- clean (no negation-context hits found)
    1 -- one or more negation-context hits found (refuse to push)
    2 -- configuration error (bad args, gh missing, file unreadable, ...)

Pure stdlib + ``gh`` CLI; no third-party deps. Story: #737.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# ---- Exit codes -------------------------------------------------------------

EXIT_OK = 0
EXIT_HITS_FOUND = 1
EXIT_CONFIG_ERROR = 2

# ---- Closing-keyword + context patterns -------------------------------------

# GitHub's documented closing-keyword set
# (https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword).
# We match the bare verb (the parser is whitespace-greedy) plus an
# immediately-following ``#\d+``. The two-character ``\b`` anchors guard
# against partial-word collisions (``unclosed`` would not match).
CLOSING_KEYWORD_RE = re.compile(
    r"\b(?P<keyword>close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)"
    r"\s+#(?P<number>\d+)\b",
    re.IGNORECASE,
)

# Negation markers we look for in the +/-20 char window AROUND the hit.
# Each marker is an entire substring -- the regex uses ``\b`` where
# meaningful but stays loose enough to catch capitalised / spaced
# variants (``DOES NOT``, ``cannot``, ``WITHOUT``, etc.). The list is
# intentionally generous; the cost of a false-positive is one
# ``--allow-known-false-positives`` flag, the cost of a missed
# negation is a real auto-close that the script was supposed to
# prevent.
_NEGATION_MARKERS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bnot\s+", re.IGNORECASE),
    re.compile(r"n't\s+", re.IGNORECASE),
    re.compile(r"\bnever\s+", re.IGNORECASE),
    re.compile(r"\bintentionally\s+(?:not\s+)?", re.IGNORECASE),
    re.compile(r"\bdoes\s+not\b", re.IGNORECASE),
    re.compile(r"\bdo\s+not\b", re.IGNORECASE),
    re.compile(r"\bwon't\b", re.IGNORECASE),
    re.compile(r"\bcannot\b", re.IGNORECASE),
    re.compile(r"\bWITHOUT\b"),
    re.compile(r"\bEXCEPT\b"),
)

# Quotation context markers (any of these inside the +/-20 char window
# treats the hit as quoted). Backticks + ASCII / curly quotes.
_QUOTE_MARKERS: tuple[str, ...] = ("`", "'", '"', "\u2018", "\u2019", "\u201c", "\u201d")

# Example / illustrative-context markers in the +/-20 char window.
_EXAMPLE_MARKERS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\be\.g\.", re.IGNORECASE),
    re.compile(r"\bi\.e\.", re.IGNORECASE),
    re.compile(r"\bfor\s+example\b", re.IGNORECASE),
    re.compile(r"\bsuch\s+as\b", re.IGNORECASE),
    re.compile(r"\blike\b", re.IGNORECASE),
)

# Blockquote prefix marker -- if the line starts with ``> `` the hit is
# inside a Markdown blockquote.
_BLOCKQUOTE_RE = re.compile(r"^\s*>\s", re.MULTILINE)

# Code-fence boundary regex (triple-backticks, optionally with a
# language tag). We track open/close balance to know whether a hit is
# inside a fenced block.
_CODE_FENCE_RE = re.compile(r"^```", re.MULTILINE)

# Window radius for negation / quotation / example detection (the
# vBRIEF specifies +/-20 char).
_WINDOW_RADIUS = 20


# ---- Hit dataclass ----------------------------------------------------------


@dataclass
class Hit:
    """A single closing-keyword + #number occurrence in some text."""
    source: str           # "pr-body" or "commit:<sha-or-index>"
    keyword: str          # the verb that matched (case preserved)
    issue_number: int
    context: str          # short snippet around the hit
    reason: str           # human-readable category

    def render(self) -> str:
        return (
            f"  [{self.source}] {self.reason}: "
            f"\"...{self.context}...\" -> {self.keyword} #{self.issue_number}"
        )


# ---- Detection helpers ------------------------------------------------------


def _line_starting_at(text: str, offset: int) -> str:
    """Return the line of ``text`` containing the byte ``offset``."""
    line_start = text.rfind("\n", 0, offset) + 1
    line_end = text.find("\n", offset)
    if line_end == -1:
        line_end = len(text)
    return text[line_start:line_end]


def _is_inside_code_fence(text: str, offset: int) -> bool:
    """Return True when ``offset`` falls inside a triple-backtick fence."""
    fences_before = list(_CODE_FENCE_RE.finditer(text[:offset]))
    return len(fences_before) % 2 == 1


def _classify_hit(text: str, match: re.Match[str]) -> str | None:
    """Classify the hit's context.

    Returns one of ``"negation"`` / ``"quotation"`` / ``"example"`` /
    ``"code-block"`` / ``"blockquote"`` when the surrounding context
    flags the hit as a false-positive risk; returns ``None`` when the
    hit is a true-positive (real closing keyword the operator wants to
    fire). The caller treats only non-None classifications as findings.
    """
    start, end = match.start(), match.end()
    # Code-fence context first -- it dominates other classifications.
    if _is_inside_code_fence(text, start):
        return "code-block"

    # Blockquote context -- if the entire line begins with ``> ``.
    line = _line_starting_at(text, start)
    if _BLOCKQUOTE_RE.match(line):
        return "blockquote"

    # Local +/-WINDOW_RADIUS window around the hit.
    win_start = max(0, start - _WINDOW_RADIUS)
    win_end = min(len(text), end + _WINDOW_RADIUS)
    window = text[win_start:win_end]
    # The keyword's offset within the window.
    kw_offset = start - win_start

    # Negation markers anywhere in the window.
    for negation in _NEGATION_MARKERS:
        for m in negation.finditer(window):
            # Negation must precede the closing keyword (left of it) AND
            # be within ~20 chars of the keyword to count.
            if m.end() <= kw_offset:
                return "negation"

    # Quotation markers immediately surrounding the keyword.
    # Specifically: a quote char in the 5 chars BEFORE the keyword AND
    # one in the closing-keyword segment region (i.e. the keyword token
    # is wrapped). This is a tight check to avoid quoting an entire
    # paragraph triggering a false-positive on every keyword inside.
    pre = text[max(0, start - 3) : start]
    post = text[end : min(len(text), end + 3)]
    if any(q in pre for q in _QUOTE_MARKERS) and any(q in post for q in _QUOTE_MARKERS):
        return "quotation"
    # Backticks specifically can appear on either side (single-side
    # backticks like ``` `Closes #N` ``` are also quotation context).
    if "`" in pre and "`" in post:
        return "quotation"

    # Example / illustrative markers in the window LEADING UP TO the
    # keyword (e.g. "e.g. Closes #N" -- "e.g." precedes the keyword).
    for example in _EXAMPLE_MARKERS:
        for m in example.finditer(window):
            if m.end() <= kw_offset:
                return "example"

    return None


def find_hits(text: str, source: str) -> list[Hit]:
    """Return all negation/quotation/example/code-block hits in ``text``."""
    hits: list[Hit] = []
    for match in CLOSING_KEYWORD_RE.finditer(text):
        category = _classify_hit(text, match)
        if category is None:
            continue
        # Build a short context snippet (+/- 30 chars) for the diagnostic.
        snippet_start = max(0, match.start() - 30)
        snippet_end = min(len(text), match.end() + 30)
        context = text[snippet_start:snippet_end].replace("\n", " ")
        hits.append(
            Hit(
                source=source,
                keyword=match.group("keyword"),
                issue_number=int(match.group("number")),
                context=context,
                reason=category,
            )
        )
    return hits


# ---- Input collection -------------------------------------------------------


def fetch_pr_body(pr_number: int, repo: str | None = None) -> str | None:
    """Fetch the PR body via ``gh pr view --json body``.

    Returns the body string on success, or ``None`` on external error.
    """
    cmd = ["gh", "pr", "view", str(pr_number), "--json", "body"]
    if repo:
        cmd.extend(["--repo", repo])
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30, check=False
        )
    except FileNotFoundError:
        print("Error: gh CLI not found. Install GitHub CLI.", file=sys.stderr)
        return None
    except subprocess.TimeoutExpired:
        print(f"Error: gh CLI timed out fetching PR #{pr_number}.", file=sys.stderr)
        return None
    if result.returncode != 0:
        print(
            f"Error: gh CLI failed fetching PR #{pr_number}: "
            f"{result.stderr.strip()}",
            file=sys.stderr,
        )
        return None
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        print(f"Error: failed to parse gh CLI output: {exc}", file=sys.stderr)
        return None
    body = payload.get("body", "")
    if not isinstance(body, str):
        print(
            f"Error: unexpected body shape: {type(body).__name__}",
            file=sys.stderr,
        )
        return None
    return body


def fetch_pr_commit_messages(
    pr_number: int, repo: str | None = None
) -> list[str] | None:
    """Fetch every commit message body from the PR via ``gh pr view --json commits``."""
    cmd = ["gh", "pr", "view", str(pr_number), "--json", "commits"]
    if repo:
        cmd.extend(["--repo", repo])
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30, check=False
        )
    except FileNotFoundError:
        print("Error: gh CLI not found. Install GitHub CLI.", file=sys.stderr)
        return None
    except subprocess.TimeoutExpired:
        print(
            f"Error: gh CLI timed out fetching commits for PR #{pr_number}.",
            file=sys.stderr,
        )
        return None
    if result.returncode != 0:
        print(
            f"Error: gh CLI failed fetching commits: {result.stderr.strip()}",
            file=sys.stderr,
        )
        return None
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        print(f"Error: failed to parse gh CLI output: {exc}", file=sys.stderr)
        return None
    commits = payload.get("commits", [])
    if not isinstance(commits, list):
        print(
            f"Error: unexpected commits shape: {type(commits).__name__}",
            file=sys.stderr,
        )
        return None
    messages: list[str] = []
    for entry in commits:
        if not isinstance(entry, dict):
            continue
        # gh returns ``{"messageHeadline": ..., "messageBody": ...}`` --
        # join both so the lint covers the headline AND the body.
        headline = entry.get("messageHeadline", "")
        body = entry.get("messageBody", "")
        combined = f"{headline}\n{body}".strip()
        if combined:
            messages.append(combined)
    return messages


def read_text_file(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"Error: failed to read {path}: {exc}", file=sys.stderr)
        return None


def read_commits_file(path: Path) -> list[str] | None:
    """A commits file is a stream of messages separated by ``\\n--END--\\n``.

    The shape is intentionally simple so an operator can author one with
    a here-doc / temp-file pattern. Empty messages are stripped.
    """
    text = read_text_file(path)
    if text is None:
        return None
    return [p.strip() for p in text.split("\n--END--\n") if p.strip()]


# ---- argparse + main --------------------------------------------------------


def _parse_allow_list(values: list[str]) -> set[int]:
    """Flatten comma-separated and repeated ``--allow-known-false-positives``."""
    out: set[int] = set()
    for chunk in values:
        for tok in chunk.split(","):
            tok = tok.strip().lstrip("#")
            if not tok:
                continue
            if not tok.isdecimal():
                raise ValueError(
                    f"Invalid issue number in --allow-known-false-positives: {tok!r}"
                )
            out.add(int(tok))
    return out


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pr_check_closing_keywords",
        description=(
            "Pre-PR closing-keyword negation-context lint (#737). Refuses "
            "with exit 1 when any closing-keyword + #N hit lands in a "
            "negation / quotation / example / code-block context."
        ),
    )
    src = parser.add_argument_group("input source (mutually exclusive)")
    src.add_argument(
        "--pr",
        type=int,
        default=None,
        metavar="N",
        help="Pull request number to inspect (online; uses `gh pr view`).",
    )
    src.add_argument(
        "--body-file",
        type=Path,
        default=None,
        metavar="PATH",
        help="Offline mode: read the PR body from this file.",
    )
    src.add_argument(
        "--commits-file",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Offline mode: read commit messages from this file "
            "(messages separated by `\\n--END--\\n`)."
        ),
    )
    parser.add_argument(
        "--repo",
        default=None,
        metavar="OWNER/REPO",
        help="Override the GitHub repo (used only with --pr).",
    )
    parser.add_argument(
        "--allow-known-false-positives",
        action="append",
        default=[],
        metavar="ISSUE_NUMBERS",
        help=(
            "Comma-separated list of issue numbers to suppress as known "
            "false-positives (e.g. test fixtures or documentation that "
            "legitimately discusses the keyword)."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        allow_list = _parse_allow_list(args.allow_known_false_positives)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    body_text: str | None = None
    commit_messages: list[str] = []

    if args.pr is not None:
        body_text = fetch_pr_body(args.pr, repo=args.repo)
        if body_text is None:
            return EXIT_CONFIG_ERROR
        msgs = fetch_pr_commit_messages(args.pr, repo=args.repo)
        if msgs is None:
            return EXIT_CONFIG_ERROR
        commit_messages = msgs
    else:
        if args.body_file is None and args.commits_file is None:
            print(
                "Error: must specify --pr OR --body-file / --commits-file.",
                file=sys.stderr,
            )
            return EXIT_CONFIG_ERROR
        if args.body_file is not None:
            text = read_text_file(args.body_file)
            if text is None:
                return EXIT_CONFIG_ERROR
            body_text = text
        if args.commits_file is not None:
            msgs = read_commits_file(args.commits_file)
            if msgs is None:
                return EXIT_CONFIG_ERROR
            commit_messages = msgs

    hits: list[Hit] = []
    if body_text is not None:
        hits.extend(find_hits(body_text, source="pr-body"))
    for idx, msg in enumerate(commit_messages):
        hits.extend(find_hits(msg, source=f"commit:{idx}"))

    # Filter the allow-list.
    filtered = [h for h in hits if h.issue_number not in allow_list]

    if not filtered:
        if hits:
            print(
                f"OK: {len(hits)} hit(s) suppressed by "
                f"--allow-known-false-positives.",
                file=sys.stderr,
            )
        else:
            print(
                "OK: no closing-keyword negation/quotation/example/code-block "
                "hits found.",
                file=sys.stderr,
            )
        return EXIT_OK

    print(
        f"FAIL: {len(filtered)} closing-keyword negation-context hit(s) found "
        "(see #737). Rewrite the PR body / commit messages to avoid the "
        "trigger token, or pass --allow-known-false-positives to suppress.",
        file=sys.stderr,
    )
    for h in filtered:
        print(h.render(), file=sys.stderr)
    return EXIT_HITS_FOUND


if __name__ == "__main__":
    raise SystemExit(main())
