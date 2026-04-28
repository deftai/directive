#!/usr/bin/env python3
"""
pr_check_protected_issues.py -- Pre-merge protected-issue link inspection (#701).

Verifies that no protected (umbrella / staying-OPEN) issue is GitHub-side
linked to a pull request via GitHub's persistent ``closingIssuesReferences``
relationship. This is the Taskfile-level encoding of the Layer 3
closing-keyword false-positive hardening rule documented in
``skills/deft-directive-swarm/SKILL.md`` Phase 6 Step 1 and (as a short
cross-reference) in ``meta/lessons.md``
``## GitHub Closing-Keyword False-Positive Layer 3``.

Background
----------
GitHub records linked-issue relationships in its database the moment a
closing keyword (``Closes #N`` / ``Fixes #N`` / ``Resolves #N``) first
appears in a PR body, OR the moment an operator manually attaches an issue
via the PR's "Development" sidebar panel. Subsequent PR body edits,
commit-message edits, and explicit ``--subject`` / ``--body-file``
overrides on ``gh pr merge`` do NOT clear that record. On squash merge,
GitHub iterates the persistent link list and closes every linked issue
regardless of the current body text.

Two real workflow #642 incidents triggered this hardening: PR #700
auto-closed #233 (concatenated commit-message variant), and PR #401
auto-closed #642 (persistent-link variant). The first was a Layer 1/2
edge case; the second motivated this Layer 3 inspection because every
text-level safeguard (PR body, commit messages, explicit squash payload)
was clean and the merge still closed #642 from the durable link list.

Usage
-----
    uv run python scripts/pr_check_protected_issues.py <pr-number> \\
        --protected <comma-separated-issue-numbers> [--repo OWNER/REPO]

    # Multiple --protected flags also accepted (additive):
    uv run python scripts/pr_check_protected_issues.py 701 \\
        --protected 167 --protected 698,642

Exit codes
----------
    0 -- no protected issue is GitHub-side linked to the PR (safe to merge)
    1 -- at least one protected issue IS linked (manually unlink via the PR's
         Development sidebar before merging)
    2 -- external error (gh missing, gh failed, malformed args, parse error)

Story: #701 (Layer 3 closing-keyword hardening).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

# Make sibling scripts importable both when run as __main__ and when imported by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

# ---- Exit codes -------------------------------------------------------------

EXIT_OK = 0
EXIT_PROTECTED_LINKED = 1
EXIT_EXTERNAL_ERROR = 2


# ---- gh wrapper -------------------------------------------------------------


def fetch_closing_issues_references(
    pr_number: int,
    repo: str | None = None,
    *,
    cwd: Path | None = None,
) -> list[int] | None:
    """Run ``gh pr view <N> --json closingIssuesReferences`` and return the
    list of linked issue numbers.

    Returns ``None`` on external error (the caller should map this to
    ``EXIT_EXTERNAL_ERROR``); the reason is printed to stderr.

    The ``--repo`` flag is forwarded only when explicitly provided. Without
    it, ``gh`` resolves the PR against the current working directory's git
    remote -- which is the typical local-checkout case.
    """
    cmd = ["gh", "pr", "view", str(pr_number), "--json", "closingIssuesReferences"]
    if repo:
        cmd.extend(["--repo", repo])
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(cwd) if cwd is not None else None,
        )
    except FileNotFoundError:
        print("Error: gh CLI not found. Install GitHub CLI.", file=sys.stderr)
        return None
    except subprocess.TimeoutExpired:
        print(f"Error: gh CLI timed out fetching PR #{pr_number}.", file=sys.stderr)
        return None

    if result.returncode != 0:
        print(
            f"Error: gh CLI failed fetching PR #{pr_number}: {result.stderr.strip()}",
            file=sys.stderr,
        )
        return None

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        print(
            f"Error: failed to parse gh CLI output for PR #{pr_number}: {exc}",
            file=sys.stderr,
        )
        return None

    refs = payload.get("closingIssuesReferences", [])
    if not isinstance(refs, list):
        print(
            f"Error: unexpected closingIssuesReferences shape for PR #{pr_number} "
            f"(expected list, got {type(refs).__name__})",
            file=sys.stderr,
        )
        return None

    linked: list[int] = []
    for entry in refs:
        if not isinstance(entry, dict):
            continue
        number = entry.get("number")
        if isinstance(number, int):
            linked.append(number)
        elif isinstance(number, str) and number.isdigit():
            linked.append(int(number))
    return linked


# ---- argument parsing -------------------------------------------------------


def _parse_protected(values: list[str]) -> list[int]:
    """Flatten comma-separated and repeated ``--protected`` flags into a
    single sorted, deduplicated list of issue numbers.

    Raises ``ValueError`` on any non-integer token so the caller can map to
    ``EXIT_EXTERNAL_ERROR``.
    """
    out: set[int] = set()
    for chunk in values:
        for tok in chunk.split(","):
            tok = tok.strip().lstrip("#")
            if not tok:
                continue
            # ``isdecimal()`` (vs ``isdigit()``) ONLY matches base-10 digits 0-9.
            # ``isdigit()`` returns True for Unicode digit characters such as
            # superscript '\u00b2' that ``int()`` rejects, which would let a malformed
            # token reach ``int(tok)`` below and surface Python's generic
            # ``invalid literal for int()`` error instead of our custom
            # ``Invalid protected issue token`` message (Greptile review #702).
            if not tok.isdecimal():
                raise ValueError(f"Invalid protected issue token: {tok!r}")
            out.add(int(tok))
    return sorted(out)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pr_check_protected_issues",
        description=(
            "Pre-merge protected-issue link inspection (#701). Exits non-zero "
            "if any protected issue is GitHub-side linked to the PR via "
            "closingIssuesReferences."
        ),
    )
    parser.add_argument(
        "pr_number",
        type=int,
        help="Pull request number to inspect.",
    )
    parser.add_argument(
        "--protected",
        action="append",
        default=[],
        metavar="ISSUE_NUMBERS",
        help=(
            "Comma-separated list of protected (umbrella / staying-OPEN) "
            "issue numbers; may be passed multiple times. Example: "
            "--protected 167,698 --protected 642"
        ),
    )
    parser.add_argument(
        "--repo",
        default=None,
        metavar="OWNER/REPO",
        help=(
            "Explicit repo (e.g. deftai/directive). When omitted, gh "
            "resolves the PR against the current working directory's git "
            "remote."
        ),
    )
    return parser


# ---- main -------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        protected = _parse_protected(args.protected)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_EXTERNAL_ERROR

    if not protected:
        # No protected list = nothing to check; safe to merge.
        print(
            f"PR #{args.pr_number}: no --protected issues supplied; skipping check.",
            file=sys.stderr,
        )
        return EXIT_OK

    linked = fetch_closing_issues_references(args.pr_number, repo=args.repo)
    if linked is None:
        return EXIT_EXTERNAL_ERROR

    linked_sorted = sorted(set(linked))
    print(
        f"PR #{args.pr_number}: closingIssuesReferences = {linked_sorted}",
        file=sys.stderr,
    )

    overlap = sorted(set(protected) & set(linked))
    if overlap:
        offenders = ", ".join(f"#{n}" for n in overlap)
        print(
            f"FAIL: PR #{args.pr_number} has persistent linked-issue relationships "
            f"with protected issue(s): {offenders}. The link is recorded in GitHub's "
            f"database from a prior PR body revision (or sidebar attachment) and "
            f"survives subsequent body edits. Manually unlink via the PR's "
            f"'Development' sidebar panel (web UI -> PR -> right-side Development "
            f"section -> X next to the linked issue) before merging. See #701.",
            file=sys.stderr,
        )
        return EXIT_PROTECTED_LINKED

    protected_str = ", ".join(f"#{n}" for n in protected)
    print(
        f"OK: PR #{args.pr_number} has no persistent links to any protected issue "
        f"({protected_str}). Safe to squash-merge with respect to Layer 3 (#701).",
        file=sys.stderr,
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
