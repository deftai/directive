#!/usr/bin/env python3
"""pr_merge_readiness.py -- Pre-merge Greptile-body verdict gate (#796 follow-up).

Verifies that a pull request's Greptile review state, parsed from the rolling
summary **comment body** (not the GitHub CheckRun status), satisfies the
``skills/deft-directive-review-cycle/SKILL.md`` Phase 2 Step 6 exit condition
AND the ``skills/deft-directive-swarm/SKILL.md`` Phase 5 -> 6 merge-readiness
checklist before any ``gh pr merge`` call.

Background
----------
The GitHub CheckRun named ``Greptile Review`` reports SUCCESS when the bot
finishes its review pass, irrespective of confidence score or P0 / P1
findings in the comment body. A swarm orchestrator that gates merges on the
CheckRun alone can start a merge cascade on a PR that Greptile has flagged
as unready (e.g. ``Confidence: 3/5`` with one P1 finding). The errored-state
guard at ``skills/deft-directive-swarm/SKILL.md`` Phase 6 Step 1 (#526)
covers the NEUTRAL CheckRun case but not the symmetric SUCCESS-with-findings
blind spot. This script is the structural gap-closer.

What it checks
--------------
1. The current PR HEAD SHA equals the SHA Greptile recorded as
   ``Last reviewed commit:`` (markdown-link form per
   ``templates/swarm-greptile-poller-prompt.md``).
2. The Greptile rolling-summary comment body is NOT the errored sentinel
   ``Greptile encountered an error while reviewing this PR`` (#526).
3. The body's ``Confidence Score: X / 5`` is ``> 3``.
4. The body's P0 / P1 finding counts (via HTML severity badges, with a
   structured-section heading fallback) are both zero. P2 findings are
   non-blocking style suggestions per
   ``skills/deft-directive-review-cycle/SKILL.md`` Phase 2 Step 6 and do
   NOT gate the loop.

Usage
-----
    uv run python scripts/pr_merge_readiness.py <pr-number> [--repo OWNER/REPO]
    uv run python scripts/pr_merge_readiness.py 652 --json

Exit codes
----------
    0 -- merge-ready (all gates pass)
    1 -- merge-blocked (one or more gates failed; see structured failure)
    2 -- external / config error (gh missing, gh failed, parse error, ...)

Pure stdlib + ``gh`` CLI; no third-party deps.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

# Make sibling scripts importable both when run as __main__ and when imported by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from _stdio_utf8 import reconfigure_stdio  # noqa: E402
    reconfigure_stdio()
except ImportError:
    # _stdio_utf8 is optional; some test contexts load this module directly.
    pass

# ---- Exit codes -------------------------------------------------------------

EXIT_OK = 0
EXIT_MERGE_BLOCKED = 1
EXIT_EXTERNAL_ERROR = 2

# ---- Greptile body parsing --------------------------------------------------

# Greptile's bot login -- used to identify the rolling-summary comment among
# all PR issue comments. The login is stable across reviews; the comment is
# edited in place rather than re-created.
_GREPTILE_LOGIN = "greptile-apps[bot]"

# Errored sentinel from #526. Exact-string match per the swarm SKILL.
_GREPTILE_ERRORED_SENTINEL = "Greptile encountered an error while reviewing this PR"

# `Last reviewed commit:` -- markdown-link form. The hand-authored variant
# `Last reviewed commit:\s*[0-9a-f]+` will NEVER match Greptile's actual
# output (Agent D, post-#721 swarm; #727 Bug 1). The regex below mirrors the
# canonical encoding in templates/swarm-greptile-poller-prompt.md.
_LAST_REVIEWED_RE = re.compile(
    r"Last reviewed commit:\s*\[[^\]]*\]\(https?://github\.com/[^/]+/[^/]+/commit/(?P<sha>[0-9a-f]{7,40})",
)

# Confidence Score parse. Tolerant of whitespace around the slash.
_CONFIDENCE_RE = re.compile(r"Confidence Score:\s*(?P<score>\d+)\s*/\s*5", re.IGNORECASE)

# P0 / P1 badge markers. These appear ONLY on actual findings, not in
# summary text or clean-summary phrasing like "No P0 or P1 issues found"
# (which contains the literal P0 / P1 tokens and would false-positive a
# raw substring scan). See templates/swarm-greptile-poller-prompt.md
# detection block (a) -- this is the "preferred" approach.
_P0_BADGE = '<img alt="P0"'
_P1_BADGE = '<img alt="P1"'

# Structured-section heading fallback (approach (b)). Used when no badges
# are present (some Greptile review templates render headings without
# badges). The heading captures `### P0 findings (N)` and similar.
_SECTION_RE = re.compile(
    r"###\s+(?P<sev>P[012])\s+findings\s*\((?P<count>\d+)\)",
    re.IGNORECASE,
)


@dataclass
class GreptileVerdict:
    """Structured parse of the Greptile rolling-summary comment body."""
    found: bool                         # was a Greptile comment present at all
    errored: bool                       # body == errored sentinel (#526)
    last_reviewed_sha: str | None
    confidence: int | None
    p0_count: int
    p1_count: int
    p2_count: int
    raw_body_excerpt: str = ""          # first ~200 chars for debugging


def parse_greptile_body(body: str) -> GreptileVerdict:
    """Parse a Greptile rolling-summary comment body into a structured verdict.

    Mirrors the per-poll detection block in
    ``templates/swarm-greptile-poller-prompt.md`` so this script and the
    poller agree on the same interpretation of any given comment.

    The whitespace-aware ``not body.strip()`` guard accounts for ``gh api
    --jq`` raw-output behaviour (Greptile review P2 #1, PR #797): in raw
    mode jq emits a trailing newline for every output value, including
    the empty-string fallback ``// ""``. With ``--paginate`` jq runs
    per-page, so a no-comment PR with N pages of issue comments produces
    ``"\\n" * N``. A bare ``not body`` guard treats that as truthy and
    falls through to the SHA / confidence parsers, producing the less
    useful "Could not parse ..." diagnostics instead of the intended
    "No Greptile rolling-summary comment found" message. Stripping first
    routes the empty-jq case through the right diagnostic.
    """
    if not body or not body.strip():
        return GreptileVerdict(
            found=False,
            errored=False,
            last_reviewed_sha=None,
            confidence=None,
            p0_count=0,
            p1_count=0,
            p2_count=0,
        )

    errored = body.strip().startswith(_GREPTILE_ERRORED_SENTINEL)

    # Take the LAST `Last reviewed commit:` match, not the first. Greptile
    # may quote suggestion code (test fixtures, prior comment text) that
    # contains the same `Last reviewed commit: [x](.../commit/<sha>)`
    # pattern -- those quotes appear earlier in the body. The actual
    # ground-truth SHA Greptile records lives in the trailing `<sub>` block
    # ("Reviews (N): Last reviewed commit: [...](.../commit/<sha>) | ...").
    # Self-dogfood on PR #797 surfaced this: my own test fixtures were
    # quoted in Greptile's P2 #3 suggestion and the parser picked their
    # `bbbbbbb` SHA over the real HEAD.
    sha_matches = list(_LAST_REVIEWED_RE.finditer(body))
    last_reviewed_sha = sha_matches[-1].group("sha") if sha_matches else None

    conf_match = _CONFIDENCE_RE.search(body)
    confidence = int(conf_match.group("score")) if conf_match else None

    # Badge-count first (preferred -- robust by construction).
    p0_count = body.count(_P0_BADGE)
    p1_count = body.count(_P1_BADGE)
    p2_count = body.count('<img alt="P2"')

    # Structured-section fallback -- only consulted when the body lacks
    # the rich-format `<details>` collapsible. Greptile's modern review
    # format ALWAYS uses HTML severity badges (`<img alt="P0" ...>`) and
    # wraps findings in `<details><summary>...</summary>...</details>`
    # collapsibles. When the body contains `<details>`, the badge counts
    # are authoritative -- a `### P1 findings (N)` heading appearing in
    # such a body is almost certainly Greptile QUOTING reviewer-suggested
    # code (test fixtures, prior P2 suggestions) rather than an actual
    # finding-section heading. The PR #797 self-dogfood surfaced this:
    # Greptile's clean review of HEAD `85c0b1d` quoted the new
    # `test_mixed_format_p2_badge_with_p1_section_heading` test fixture,
    # which contains the literal `### P1 findings (1)` string -- and the
    # naive fallback false-positived a P1 count.
    #
    # Heuristic: the legacy heading-only format never used `<details>`,
    # so its absence is the trigger for the fallback. This keeps the
    # fallback for hypothetical legacy bodies without sacrificing
    # correctness on the modern format. Badge-count primary remains the
    # source of truth for any body Greptile actually emits today.
    has_details_format = "<details>" in body
    if not has_details_format and p0_count == 0 and p1_count == 0:
        for match in _SECTION_RE.finditer(body):
            sev = match.group("sev").upper()
            count = int(match.group("count"))
            if sev == "P0":
                p0_count = count
            elif sev == "P1":
                p1_count = count
            elif sev == "P2" and p2_count == 0:
                # Only override P2 from heading if the badge pass found none
                # -- preserves badge-source-of-truth when both surfaces emit.
                p2_count = count

    return GreptileVerdict(
        found=True,
        errored=errored,
        last_reviewed_sha=last_reviewed_sha,
        confidence=confidence,
        p0_count=p0_count,
        p1_count=p1_count,
        p2_count=p2_count,
        raw_body_excerpt=body[:200],
    )


# ---- gh wrappers ------------------------------------------------------------


def _run_gh(cmd: list[str]) -> tuple[int, str, str]:
    """Run a gh subcommand and return (returncode, stdout, stderr).

    Returns (-1, "", message) on FileNotFoundError / TimeoutExpired so the
    caller can map either to EXIT_EXTERNAL_ERROR uniformly.
    """
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        return -1, "", "gh CLI not found. Install GitHub CLI."
    except subprocess.TimeoutExpired:
        return -1, "", f"gh CLI timed out: {' '.join(cmd)}"
    return result.returncode, result.stdout, result.stderr


def fetch_pr_head_sha(pr_number: int, repo: str | None) -> str | None:
    """Return the PR's current HEAD ref SHA, or None on error."""
    cmd = ["gh", "pr", "view", str(pr_number), "--json", "headRefOid", "--jq", ".headRefOid"]
    if repo:
        cmd.extend(["--repo", repo])
    rc, out, err = _run_gh(cmd)
    if rc != 0:
        print(
            f"Error: gh failed fetching PR #{pr_number} headRefOid: {err.strip()}",
            file=sys.stderr,
        )
        return None
    sha = out.strip()
    return sha or None


def fetch_greptile_comment_body(pr_number: int, repo: str | None) -> str | None:
    """Return the body of the Greptile rolling-summary comment, or "" if no
    Greptile comment is present, or None on external error.

    Greptile edits its summary comment in place rather than creating a new
    one each review pass, so we filter by the bot login.
    """
    if not repo:
        # Resolve repo from current checkout if the caller did not pass it.
        rc, out, err = _run_gh(
            ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]
        )
        if rc != 0:
            print(
                f"Error: could not resolve --repo from cwd: {err.strip()}",
                file=sys.stderr,
            )
            return None
        repo = out.strip()
        if not repo:
            print(
                "Error: empty repo from gh repo view (specify --repo OWNER/REPO).",
                file=sys.stderr,
            )
            return None

    cmd = [
        "gh", "api",
        f"repos/{repo}/issues/{pr_number}/comments",
        "--paginate",
        "--jq", f'[.[] | select(.user.login == "{_GREPTILE_LOGIN}")] | last | .body // ""',
    ]
    rc, out, err = _run_gh(cmd)
    if rc != 0:
        print(
            f"Error: gh failed fetching comments for PR #{pr_number}: {err.strip()}",
            file=sys.stderr,
        )
        return None
    return out  # may be empty string when no Greptile comment exists yet


# ---- Gate evaluation --------------------------------------------------------


@dataclass
class GateResult:
    """Aggregate result of all merge-readiness gates."""
    pr_number: int
    repo: str | None
    head_sha: str | None
    verdict: GreptileVerdict
    failures: list[str] = field(default_factory=list)

    @property
    def merge_ready(self) -> bool:
        return not self.failures

    def to_dict(self) -> dict:
        return {
            "pr_number": self.pr_number,
            "repo": self.repo,
            "head_sha": self.head_sha,
            "verdict": asdict(self.verdict),
            "failures": list(self.failures),
            "merge_ready": self.merge_ready,
        }


def evaluate_gates(pr_number: int, head_sha: str | None, verdict: GreptileVerdict) -> list[str]:
    """Return a list of failure messages (empty list == merge-ready)."""
    failures: list[str] = []

    if not verdict.found:
        failures.append(
            "No Greptile rolling-summary comment found on the PR. "
            "Either Greptile has not posted yet, or the bot login filter is wrong. "
            "Wait for the review to land before merging (see #796 late-bot-review re-check)."
        )
        return failures  # remaining gates are meaningless without a body

    if verdict.errored:
        failures.append(
            "Greptile review is in the ERRORED state on the current HEAD (#526). "
            "Retry via @greptileai or escalate per "
            "skills/deft-directive-swarm/SKILL.md Phase 6 Step 1."
        )

    if verdict.last_reviewed_sha is None:
        failures.append(
            "Could not parse `Last reviewed commit:` from Greptile body. "
            "The comment may be malformed or Greptile may still be writing it -- re-fetch."
        )
    elif head_sha and not (
        head_sha.startswith(verdict.last_reviewed_sha)
        or verdict.last_reviewed_sha.startswith(head_sha)
    ):
        failures.append(
            f"Greptile last reviewed {verdict.last_reviewed_sha} but PR HEAD is {head_sha}. "
            "Review is stale -- wait for Greptile to re-review the latest commit."
        )

    if verdict.confidence is None:
        failures.append(
            "Could not parse `Confidence Score: X/5` from Greptile body. "
            "Confidence is a required exit-condition input per "
            "skills/deft-directive-review-cycle/SKILL.md Phase 2 Step 6."
        )
    elif verdict.confidence <= 3:
        failures.append(
            f"Greptile confidence is {verdict.confidence}/5; exit condition requires > 3. "
            "Address remaining findings or push clarifying changes."
        )

    if verdict.p0_count > 0 or verdict.p1_count > 0:
        failures.append(
            f"Greptile reports {verdict.p0_count} P0 and {verdict.p1_count} P1 findings "
            "on the current HEAD. All P0 / P1 findings MUST be addressed before merge "
            "(P2 findings are non-blocking)."
        )

    return failures


# ---- CLI --------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pr_merge_readiness",
        description=(
            "Pre-merge Greptile-body verdict gate. Exits non-zero if the PR's "
            "Greptile rolling-summary comment fails any of: HEAD-SHA match, "
            "errored sentinel, confidence > 3, no P0/P1 findings."
        ),
    )
    parser.add_argument("pr_number", type=int, help="Pull request number to check.")
    parser.add_argument(
        "--repo", default=None, metavar="OWNER/REPO",
        help="Repository in OWNER/REPO form. Defaults to the current checkout's remote.",
    )
    parser.add_argument(
        "--json", dest="emit_json", action="store_true",
        help="Emit the gate result as a single JSON object on stdout (still respects exit code).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    head_sha = fetch_pr_head_sha(args.pr_number, args.repo)
    if head_sha is None:
        return EXIT_EXTERNAL_ERROR

    body = fetch_greptile_comment_body(args.pr_number, args.repo)
    if body is None:
        return EXIT_EXTERNAL_ERROR

    verdict = parse_greptile_body(body)
    failures = evaluate_gates(args.pr_number, head_sha, verdict)

    result = GateResult(
        pr_number=args.pr_number,
        repo=args.repo,
        head_sha=head_sha,
        verdict=verdict,
        failures=failures,
    )

    if args.emit_json:
        print(json.dumps(result.to_dict(), indent=2))
    else:
        print(f"PR #{args.pr_number} merge-readiness check")
        print(f"  HEAD SHA:           {head_sha or '<unknown>'}")
        print(f"  Greptile reviewed:  {verdict.last_reviewed_sha or '<not parsed>'}")
        confidence_str = (
            str(verdict.confidence) if verdict.confidence is not None else "<not parsed>"
        )
        print(f"  Confidence:         {confidence_str}/5")
        print(
            f"  Findings:           P0={verdict.p0_count}  "
            f"P1={verdict.p1_count}  P2={verdict.p2_count}"
        )
        print(f"  Errored sentinel:   {verdict.errored}")
        if result.merge_ready:
            print("\nResult: MERGE-READY")
        else:
            print("\nResult: MERGE-BLOCKED")
            for i, fail in enumerate(failures, 1):
                print(f"  [{i}] {fail}")

    return EXIT_OK if result.merge_ready else EXIT_MERGE_BLOCKED


if __name__ == "__main__":
    sys.exit(main())
