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

Layered fallback chain (#1368)
------------------------------
Long-running monitors that polled ``pr_merge_readiness.py --json`` saw
``head: None`` for ~15+ minutes during the #1166 swarm cascade because
the primary ``gh api ... --jq ...`` capture path occasionally returned
empty / malformed stdout under the Grok Build harness on Windows. The
#1366 ``_safe_subprocess.run_text`` helper closes the
``Thread-3 (_readerthread) UnicodeDecodeError`` root cause; #1368 adds a
layered fallback so a *single* gh failure on the primary path no longer
blinds the dependent monitor. Every response carries a ``via``
discriminator so callers can detect degraded mode:

- ``via: "primary"``   -- canonical Greptile rolling-summary parse path
- ``via: "fallback1"`` -- gh api REST + manual Python-side comment parse
  (no ``--jq``, so a jq decode hiccup on the primary cannot mask the
  comment list). Same gate evaluation as the primary; CLEAN verdicts are
  authoritative.
- ``via: "fallback2"`` -- coarse PR-view + check-run signal. Reports
  ``state``, ``head_sha``, and a flattened check-run summary so callers
  know the *PR* state even when no Greptile rolling-summary comment is
  reachable. ! Never produces a CLEAN verdict -- always merge-blocked
  with the failure ``"fallback2 is a coarse signal, not a CLEAN verdict"``.
  Use for monitor heartbeat only; merge cascade MUST continue waiting
  for a primary or fallback1 CLEAN.
- ``via: "error"``     -- every layer failed externally. Response
  carries ``error`` (one-line summary) + ``partial_data`` (whatever was
  observable across the cascade attempts) so the monitor can step
  forward instead of going blind.

Usage
-----
    uv run python scripts/pr_merge_readiness.py <pr-number> [--repo OWNER/REPO]
    uv run python scripts/pr_merge_readiness.py 652 --json

Exit codes
----------
    0 -- merge-ready (all gates pass; via primary or fallback1)
    1 -- merge-blocked (one or more gates failed; OR fallback2 reached;
         see structured failure list in --json output)
    2 -- external / config error (every layer failed; gh missing,
         total gh failure, ...; --json output still emits a structured
         envelope with via="error")

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

# UTF-8-safe subprocess capture (#1366). Greptile rolling-summary bodies
# frequently include non-cp1252 glyphs (smart quotes, em dashes, arrows);
# under the default ``text=True`` decode path on Windows + Grok Build,
# that crashes Python's internal reader thread with UnicodeDecodeError and
# leaves the caller with empty / malformed stdout. ``_safe_subprocess.run_text``
# forces encoding="utf-8", errors="replace" so any undecodable byte is
# substituted with U+FFFD rather than aborting the read.
from _safe_subprocess import run_text  # noqa: E402

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

# Informal-clean prose signals (#1543). Greptile sometimes posts a separate
# human-readable "all resolved / diff is clean" comment without the canonical
# rolling-summary fields. These patterns distinguish that state from a
# review that is still writing or a malformed partial summary.
_INFORMAL_CLEAN_SIGNAL_RE = re.compile(
    r"(?:"
    r"diff is clean|"
    r"(?:prior |previously flagged )?issues? (?:are )?now resolved|"
    r"all prior issues resolved|"
    r"no new issues(?: to flag)?|"
    r"looks solid|"
    r"good to proceed"
    r")",
    re.IGNORECASE,
)

_INFORMAL_CLEAN_STATE = "informal-clean missing-canonical-fields"

_INFORMAL_CLEAN_DIAGNOSTIC = (
    f"Greptile {_INFORMAL_CLEAN_STATE} state (#1543): the latest Greptile bot "
    "comment says the diff is clean / prior issues are resolved, but omits the "
    "canonical rolling-summary fields `Last reviewed commit:` and "
    "`Confidence Score: X/5` that merge gates require. Prose alone cannot "
    "prove review currency or confidence. Recovery: (1) comment "
    "`@greptileai review` on the PR to retrigger a canonical rolling summary, "
    "(2) wait for Greptile to edit its primary summary comment with both "
    "canonical fields on the current HEAD, or (3) document an explicit "
    "operator override per skills/deft-directive-swarm/SKILL.md Phase 6 "
    "Step 1. Do NOT keep polling -- this is not 'review still writing'."
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
    informal_clean: bool = False        # clean prose but missing canonical fields (#1543)
    raw_body_excerpt: str = ""          # first ~200 chars for debugging


def is_informal_clean_missing_canonical_fields(
    verdict: GreptileVerdict, body: str,
) -> bool:
    """Return True when Greptile posted informal clean prose without canonical fields.

    Mirrors the detection contract in
    ``templates/swarm-greptile-poller-prompt.md`` and
    ``skills/deft-directive-review-cycle/SKILL.md`` (#1543).
    """
    if not verdict.found or verdict.errored:
        return False
    if verdict.last_reviewed_sha is not None or verdict.confidence is not None:
        return False
    if verdict.p0_count > 0 or verdict.p1_count > 0:
        return False
    return _INFORMAL_CLEAN_SIGNAL_RE.search(body) is not None


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

    verdict = GreptileVerdict(
        found=True,
        errored=errored,
        last_reviewed_sha=last_reviewed_sha,
        confidence=confidence,
        p0_count=p0_count,
        p1_count=p1_count,
        p2_count=p2_count,
        raw_body_excerpt=body[:200],
    )
    if is_informal_clean_missing_canonical_fields(verdict, body):
        verdict.informal_clean = True
    return verdict


# ---- gh wrappers ------------------------------------------------------------


def _run_gh(cmd: list[str]) -> tuple[int, str, str]:
    """Run a gh subcommand and return (returncode, stdout, stderr).

    Routes through ``_safe_subprocess.run_text`` so the captured stdout /
    stderr are decoded as UTF-8 with ``errors="replace"`` (#1366). The
    default ``text=True`` binding decodes via the host codepage on
    Windows + Grok Build, which crashes Python's internal reader thread
    with ``UnicodeDecodeError`` whenever the Greptile rolling-summary
    body contains non-cp1252 bytes -- the exact failure mode behind the
    ``head: None`` symptom on the #1166 swarm monitor.

    Returns (-1, "", message) on FileNotFoundError / TimeoutExpired so the
    caller can map either to EXIT_EXTERNAL_ERROR uniformly.
    """
    try:
        result = run_text(cmd, timeout=60)
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

# Layered-fallback discriminator values (#1368). Always emitted on every
# response so a long-running monitor can detect degraded mode without
# inspecting the failure list.
VIA_PRIMARY = "primary"
VIA_FALLBACK1 = "fallback1"
VIA_FALLBACK2 = "fallback2"
VIA_ERROR = "error"

# Sentinel failure prepended to every fallback2 verdict so a monitor that
# only inspects ``failures`` cannot accidentally treat the coarse signal as
# CLEAN. The merge cascade MUST keep waiting for a primary/fallback1 CLEAN.
_FALLBACK2_NOT_CLEAN_MSG = (
    "fallback2 is a coarse signal, not a CLEAN verdict -- the Greptile "
    "rolling-summary comment was not reachable on either the primary or "
    "fallback1 path. PR state / check-runs reported below as a heartbeat "
    "only; do NOT merge on this verdict alone (#1368)."
)


@dataclass
class GateResult:
    """Aggregate result of all merge-readiness gates.

    The ``via`` discriminator (#1368) lets monitors detect which layer of
    the fallback chain produced this result. ``partial_data`` carries
    fallback-specific observations (PR state, check-run summary, raw error
    messages from each attempted layer) so a monitor stepping forward on a
    degraded response still has actionable context.
    """
    pr_number: int
    repo: str | None
    head_sha: str | None
    verdict: GreptileVerdict
    failures: list[str] = field(default_factory=list)
    via: str = VIA_PRIMARY
    partial_data: dict = field(default_factory=dict)
    error: str | None = None

    @property
    def merge_ready(self) -> bool:
        # fallback2 + error paths carry sentinel failures so merge_ready is
        # already False by construction; this property collapses to the
        # documented "no failures" check.
        return not self.failures

    def to_dict(self) -> dict:
        payload: dict = {
            "pr_number": self.pr_number,
            "repo": self.repo,
            "head_sha": self.head_sha,
            "verdict": asdict(self.verdict),
            "failures": list(self.failures),
            "merge_ready": self.merge_ready,
            "via": self.via,
        }
        if self.partial_data:
            payload["partial_data"] = dict(self.partial_data)
        if self.error is not None:
            payload["error"] = self.error
        return payload


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

    if verdict.informal_clean:
        failures.append(_INFORMAL_CLEAN_DIAGNOSTIC)
        return failures

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


# ---- Layered fallback chain (#1368) -----------------------------------------
#
# The primary path (existing #796 logic) calls ``gh api ... --jq ...`` to
# pull the Greptile rolling-summary comment body. When jq is invoked on
# the Grok Build harness and the gh stdout pipe carries non-cp1252 bytes,
# the helper-thread decode is now safe (#1366), but the jq filter itself
# can still emit empty output on a transient gh failure (rate-limit, 5xx,
# pagination boundary). Fallback1 routes around that by fetching the raw
# ``/issues/<N>/comments`` REST endpoint and parsing the comment list in
# Python so a jq glitch on the primary cannot blind the monitor.
#
# Fallback2 is the coarse last-resort signal: it asks for the PR's own
# state + check-runs via REST so we can at least report ``state``,
# ``head_sha``, and a flattened check summary even when no Greptile
# rolling-summary comment is reachable. It is NEVER CLEAN; the merge
# cascade MUST continue waiting on a primary/fallback1 verdict.


def _empty_verdict() -> GreptileVerdict:
    """Return the canonical not-found Greptile verdict for fallback paths."""
    return GreptileVerdict(
        found=False,
        errored=False,
        last_reviewed_sha=None,
        confidence=None,
        p0_count=0,
        p1_count=0,
        p2_count=0,
    )


def _resolve_repo(repo: str | None) -> tuple[str | None, str]:
    """Resolve --repo (or detect from cwd). Returns (repo, error_msg)."""
    if repo:
        return repo, ""
    rc, out, err = _run_gh(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]
    )
    if rc != 0:
        return None, f"could not resolve --repo from cwd: {err.strip()}"
    resolved = out.strip()
    if not resolved:
        return None, "empty repo from gh repo view (specify --repo OWNER/REPO)"
    return resolved, ""


def _compute_primary(
    pr_number: int, repo: str | None,
) -> tuple[GateResult | None, dict]:
    """Run the primary path; return (result, partial_data_on_failure).

    Returns (GateResult, {}) on success (gh calls all returned 0, body
    parsed); returns (None, partial_data) when an external/gh failure
    prevents the primary path from producing a verdict at all.

    A merge-blocked verdict with a parsed body is still a successful
    primary -- only external failures (head_sha unreachable, comment
    fetch failed) demote to fallback1.
    """
    partial: dict = {}

    head_sha = fetch_pr_head_sha(pr_number, repo)
    if head_sha is None:
        partial["primary_error"] = "gh pr view headRefOid returned non-zero"
        return None, partial
    partial["head_sha"] = head_sha

    body = fetch_greptile_comment_body(pr_number, repo)
    if body is None:
        partial["primary_error"] = (
            "gh api /issues/<N>/comments --jq returned non-zero"
        )
        return None, partial

    verdict = parse_greptile_body(body)
    failures = evaluate_gates(pr_number, head_sha, verdict)
    return (
        GateResult(
            pr_number=pr_number,
            repo=repo,
            head_sha=head_sha,
            verdict=verdict,
            failures=failures,
            via=VIA_PRIMARY,
        ),
        partial,
    )


def _fetch_greptile_body_rest(
    pr_number: int, repo: str,
) -> tuple[str | None, str]:
    """Fallback1 helper: fetch issue comments via REST, parse Python-side.

    Unlike the primary, this does NOT invoke ``--jq``; a jq decode hiccup
    on the primary cannot mask the comment list here. Returns (body, err)
    where ``body == ""`` means "no Greptile comment exists yet" and
    ``body is None`` means an external/gh failure prevented retrieval.
    """
    cmd = [
        "gh", "api",
        f"repos/{repo}/issues/{pr_number}/comments",
        "--paginate",
    ]
    rc, out, err = _run_gh(cmd)
    if rc != 0:
        return None, f"gh api /issues/{pr_number}/comments failed: {err.strip()}"
    if not out.strip():
        return "", ""
    # ``gh api --paginate`` concatenates pages as separate JSON arrays
    # back-to-back without delimiters. Parse forgivingly with raw_decode
    # so a multi-page response collapses to one combined comment list.
    decoder = json.JSONDecoder()
    comments: list = []
    idx = 0
    text = out.strip()
    while idx < len(text):
        # Skip whitespace between concatenated arrays.
        while idx < len(text) and text[idx].isspace():
            idx += 1
        if idx >= len(text):
            break
        try:
            obj, end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError as exc:
            return None, f"could not parse REST comments JSON: {exc}"
        if isinstance(obj, list):
            comments.extend(obj)
        elif isinstance(obj, dict):
            comments.append(obj)
        idx = end

    greptile_bodies = [
        c.get("body", "")
        for c in comments
        if isinstance(c, dict)
        and isinstance(c.get("user"), dict)
        and c["user"].get("login") == _GREPTILE_LOGIN
    ]
    if not greptile_bodies:
        return "", ""
    return greptile_bodies[-1] or "", ""


def _fetch_pr_head_sha_rest(
    pr_number: int, repo: str,
) -> tuple[str | None, str]:
    """Fallback1/2 helper: fetch PR head SHA via REST (no jq)."""
    rc, out, err = _run_gh(
        ["gh", "api", f"repos/{repo}/pulls/{pr_number}"],
    )
    if rc != 0:
        return None, f"gh api /pulls/{pr_number} failed: {err.strip()}"
    if not out.strip():
        return None, "empty body from gh api /pulls/<N>"
    try:
        payload = json.loads(out)
    except json.JSONDecodeError as exc:
        return None, f"could not parse PR JSON: {exc}"
    if not isinstance(payload, dict):
        return None, "unexpected PR JSON shape (not a dict)"
    head = payload.get("head")
    if isinstance(head, dict):
        sha = head.get("sha")
        if isinstance(sha, str) and sha:
            return sha, ""
    return None, "PR JSON missing head.sha"


def _compute_fallback1(
    pr_number: int, repo: str | None, primary_partial: dict,
) -> tuple[GateResult | None, dict]:
    """Fallback 1: gh api REST + Python-side comment parse (no --jq)."""
    partial: dict = dict(primary_partial)

    resolved_repo, repo_err = _resolve_repo(repo)
    if resolved_repo is None:
        partial["fallback1_error"] = repo_err
        return None, partial

    # Prefer the cached primary head SHA if we got one before the comment
    # fetch failed; otherwise re-fetch via REST.
    head_sha = partial.get("head_sha")
    if not head_sha:
        head_sha, head_err = _fetch_pr_head_sha_rest(pr_number, resolved_repo)
        if head_sha is None:
            partial["fallback1_error"] = head_err
            return None, partial
        partial["head_sha"] = head_sha

    body, body_err = _fetch_greptile_body_rest(pr_number, resolved_repo)
    if body is None:
        partial["fallback1_error"] = body_err
        return None, partial

    verdict = parse_greptile_body(body)
    failures = evaluate_gates(pr_number, head_sha, verdict)
    return (
        GateResult(
            pr_number=pr_number,
            repo=resolved_repo,
            head_sha=head_sha,
            verdict=verdict,
            failures=failures,
            via=VIA_FALLBACK1,
            partial_data={
                k: v for k, v in partial.items()
                if k not in ("head_sha",)  # head_sha is a first-class field
            },
        ),
        partial,
    )


def _fetch_check_runs_rest(
    sha: str, repo: str,
) -> tuple[dict | None, str]:
    """Fallback2 helper: flatten check-runs for the given commit."""
    rc, out, err = _run_gh(
        ["gh", "api", f"repos/{repo}/commits/{sha}/check-runs"],
    )
    if rc != 0:
        return None, f"gh api /commits/<sha>/check-runs failed: {err.strip()}"
    if not out.strip():
        return None, "empty body from gh api /commits/<sha>/check-runs"
    try:
        payload = json.loads(out)
    except json.JSONDecodeError as exc:
        return None, f"could not parse check-runs JSON: {exc}"
    if not isinstance(payload, dict):
        return None, "unexpected check-runs JSON shape (not a dict)"
    runs = payload.get("check_runs")
    if not isinstance(runs, list):
        return None, "check-runs JSON missing check_runs list"
    summary = {
        "total": len(runs),
        "by_status": {},
        "by_conclusion": {},
        "greptile_review": None,
    }
    for run in runs:
        if not isinstance(run, dict):
            continue
        status = run.get("status") or "unknown"
        conclusion = run.get("conclusion") or "none"
        summary["by_status"][status] = summary["by_status"].get(status, 0) + 1
        summary["by_conclusion"][conclusion] = (
            summary["by_conclusion"].get(conclusion, 0) + 1
        )
        if run.get("name") == "Greptile Review":
            summary["greptile_review"] = {
                "status": status,
                "conclusion": conclusion,
            }
    return summary, ""


def _compute_fallback2(
    pr_number: int, repo: str | None, prior_partial: dict,
) -> tuple[GateResult | None, dict]:
    """Fallback 2: coarse PR-view + check-run signal. NEVER CLEAN."""
    partial: dict = dict(prior_partial)

    resolved_repo, repo_err = _resolve_repo(repo)
    if resolved_repo is None:
        partial["fallback2_error"] = repo_err
        return None, partial

    # Hit /pulls/<N> directly so we capture state, mergeable, and head SHA
    # in one REST call. This is the structural last-resort observation.
    rc, out, err = _run_gh(
        ["gh", "api", f"repos/{resolved_repo}/pulls/{pr_number}"],
    )
    if rc != 0:
        partial["fallback2_error"] = (
            f"gh api /pulls/{pr_number} failed: {err.strip()}"
        )
        return None, partial

    try:
        pr_payload = json.loads(out) if out.strip() else None
    except json.JSONDecodeError as exc:
        partial["fallback2_error"] = f"could not parse PR JSON: {exc}"
        return None, partial

    if not isinstance(pr_payload, dict):
        partial["fallback2_error"] = "unexpected PR JSON shape (not a dict)"
        return None, partial

    state = pr_payload.get("state")
    merged = bool(pr_payload.get("merged"))
    mergeable = pr_payload.get("mergeable")
    mergeable_state = pr_payload.get("mergeable_state")
    head_block = pr_payload.get("head")
    head_sha = None
    if isinstance(head_block, dict):
        candidate = head_block.get("sha")
        if isinstance(candidate, str) and candidate:
            head_sha = candidate
    if head_sha is None and partial.get("head_sha"):
        head_sha = partial["head_sha"]

    # Check-runs are best-effort -- a missing endpoint must not down-rank
    # this layer to error, because the PR state/headSHA alone is still a
    # useful heartbeat for the monitor.
    check_summary: dict | None = None
    if head_sha:
        check_summary, check_err = _fetch_check_runs_rest(head_sha, resolved_repo)
        if check_summary is None and check_err:
            partial["fallback2_check_runs_error"] = check_err

    fallback_partial = {
        "pr_state": state,
        "merged": merged,
        "mergeable": mergeable,
        "mergeable_state": mergeable_state,
        "check_runs": check_summary,
    }
    # Carry forward the earlier layer error context so a monitor inspecting
    # the response sees both "why did we degrade?" and "what did the coarse
    # layer see?" in one envelope.
    for key in (
        "primary_error",
        "fallback1_error",
        "fallback2_check_runs_error",
    ):
        if key in partial:
            fallback_partial[key] = partial[key]

    failures = [_FALLBACK2_NOT_CLEAN_MSG]
    return (
        GateResult(
            pr_number=pr_number,
            repo=resolved_repo,
            head_sha=head_sha,
            verdict=_empty_verdict(),
            failures=failures,
            via=VIA_FALLBACK2,
            partial_data=fallback_partial,
        ),
        partial,
    )


def _error_result(
    pr_number: int, repo: str | None, partial: dict,
) -> GateResult:
    """Build the structured-error envelope when every layer failed."""
    # Compose a one-line error string from whichever layer-level errors
    # accumulated through the cascade.
    pieces = []
    for key in ("primary_error", "fallback1_error", "fallback2_error"):
        if key in partial:
            pieces.append(f"{key}={partial[key]}")
    error = (
        "; ".join(pieces)
        if pieces
        else "every fallback layer failed without a reportable error"
    )
    return GateResult(
        pr_number=pr_number,
        repo=repo,
        head_sha=partial.get("head_sha"),
        verdict=_empty_verdict(),
        failures=[
            "pr_merge_readiness external error -- every fallback layer "
            "failed; see partial_data for diagnostic detail (#1368)."
        ],
        via=VIA_ERROR,
        partial_data=dict(partial),
        error=error,
    )


def compute_gate_result(pr_number: int, repo: str | None) -> GateResult:
    """Run the primary->fallback1->fallback2 cascade and return a result.

    The result ALWAYS carries a ``via`` discriminator. ``via="error"``
    means every layer failed; the monitor MUST treat that as merge-blocked
    rather than CLEAN, but the response still carries ``partial_data`` so
    the monitor can step forward without going blind.
    """
    result, partial = _compute_primary(pr_number, repo)
    if result is not None:
        return result

    result, partial = _compute_fallback1(pr_number, repo, partial)
    if result is not None:
        return result

    result, partial = _compute_fallback2(pr_number, repo, partial)
    if result is not None:
        return result

    return _error_result(pr_number, repo, partial)


def _print_human(result: GateResult) -> None:
    """Print the merge-readiness check result in human-readable form."""
    print(f"PR #{result.pr_number} merge-readiness check  (via={result.via})")
    print(f"  HEAD SHA:           {result.head_sha or '<unknown>'}")
    print(
        f"  Greptile reviewed:  "
        f"{result.verdict.last_reviewed_sha or '<not parsed>'}"
    )
    confidence_str = (
        str(result.verdict.confidence)
        if result.verdict.confidence is not None
        else "<not parsed>"
    )
    print(f"  Confidence:         {confidence_str}/5")
    print(
        f"  Findings:           P0={result.verdict.p0_count}  "
        f"P1={result.verdict.p1_count}  P2={result.verdict.p2_count}"
    )
    print(f"  Errored sentinel:   {result.verdict.errored}")
    if result.via == VIA_FALLBACK2 and result.partial_data:
        print("  Fallback2 signal:")
        for key in ("pr_state", "merged", "mergeable", "mergeable_state"):
            if key in result.partial_data:
                print(f"    {key}: {result.partial_data[key]}")
        check_runs = result.partial_data.get("check_runs")
        if isinstance(check_runs, dict):
            greptile = check_runs.get("greptile_review")
            if greptile:
                print(f"    Greptile Review check: {greptile}")
    if result.merge_ready:
        print("\nResult: MERGE-READY")
    else:
        label = "MERGE-BLOCKED" if result.via != VIA_ERROR else "EXTERNAL-ERROR"
        print(f"\nResult: {label}")
        for i, fail in enumerate(result.failures, 1):
            print(f"  [{i}] {fail}")
        if result.error:
            print(f"\nUnderlying error: {result.error}")


def _exit_code_for(result: GateResult) -> int:
    if result.via == VIA_ERROR:
        return EXIT_EXTERNAL_ERROR
    return EXIT_OK if result.merge_ready else EXIT_MERGE_BLOCKED


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    result = compute_gate_result(args.pr_number, args.repo)

    if args.emit_json:
        print(json.dumps(result.to_dict(), indent=2))
    else:
        _print_human(result)

    return _exit_code_for(result)


if __name__ == "__main__":
    sys.exit(main())
