#!/usr/bin/env python3
"""swarm_verify_review_clean.py -- Cohort-level CLEAN verification gate (#1364).

Verifies that EVERY PR in a swarm cohort satisfies the
``skills/deft-directive-review-cycle/SKILL.md`` Phase 2 Step 6 exit condition
AND the ``skills/deft-directive-swarm/SKILL.md`` Phase 5 Exit Condition on the
**current HEAD** before the monitor is allowed to discuss the Phase 5 -> 6
merge cascade.

Background (#1364)
------------------
The swarm skill's Phase 5 Exit Condition correctly documents the strong
per-PR CLEAN bar (confidence > 3, no P0/P1, no errored sentinel, CI clean,
HEAD-SHA freshness), and the per-PR programmatic gate
(``scripts/pr_merge_readiness.py`` / ``task pr:merge-ready``) closes the
per-merge SUCCESS-with-findings blind spot. But there is no mandatory
deterministic gate the monitor must pass at the COHORT level after the
Phase 6 pollers terminate but before the merge discussion begins. The
result: during the #1166 strategy-consistency swarm, multiple pollers
exited with ``clean_gate_holdout=confidence`` (i.e. confidence == 3) and
the monitor still surfaced the Phase 5 -> 6 merge gate because the
trigger keyed on "all pollers have reported back" rather than "every PR
in the cohort is objectively CLEAN".

This script is that structural gap-closer. It re-uses the Greptile
rolling-summary parser from ``scripts/pr_merge_readiness.py`` so the two
surfaces stay in lockstep -- a future fix to the parser (e.g. a new
Greptile rendering surface, a new severity badge) lands in both surfaces
at once. Do NOT duplicate the parsing logic here.

What it checks (per PR)
-----------------------
For every PR in the cohort, all of the following MUST hold on the current
PR HEAD:

1. ``Last reviewed commit:`` SHA in the Greptile rolling-summary comment
   body matches the live PR HEAD ref OID.
2. The body is NOT the errored sentinel (#526) ``Greptile encountered an
   error while reviewing this PR``.
3. ``Confidence Score: X / 5`` is greater than 3 (i.e. 4 or 5).
4. P0 and P1 finding counts are both zero. P2 findings are non-blocking
   style suggestions per the review-cycle skill and do NOT gate the
   cohort.

CI lane verification is intentionally out of scope: lane names vary per
repository, the Greptile body verdict already encodes review readiness,
and the per-merge ``task pr:merge-ready`` gate stays the freshness-window-
atomic merge-time check that pins HEAD-SHA equality. This cohort gate
fires once after the pollers terminate; the per-merge gate fires inside
the shell-`&&` chain that follows.

Usage
-----
    # Explicit PR list
    task swarm:verify-review-clean -- 1370 1371 1372 --repo deftai/directive

    # Or cohort discovered from active vBRIEFs (resolves each vBRIEF's
    # x-vbrief/github-pr reference, if any)
    task swarm:verify-review-clean -- --cohort vbrief/active/*.vbrief.json --repo deftai/directive

    # JSON output for programmatic consumers (a parent monitor agent)
    task swarm:verify-review-clean -- 1370 1371 --repo deftai/directive --json

Exit codes
----------
    0 -- every PR in the cohort is CLEAN on current HEAD (merge discussion may proceed)
    1 -- one or more PRs is unclean; per-PR diagnostics printed
    2 -- external / config error (gh missing, empty cohort, malformed vBRIEF,
         no x-vbrief/github-pr references resolved, ...)

Pure stdlib + ``gh`` CLI; no third-party deps. The parser is imported
from ``scripts/pr_merge_readiness.py`` (so both surfaces share one source
of truth).
"""

from __future__ import annotations

import argparse
import glob
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

# Make sibling scripts importable both when run as __main__ and when imported
# by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from _stdio_utf8 import reconfigure_stdio  # noqa: E402
    reconfigure_stdio()
except ImportError:
    # _stdio_utf8 is optional; some test contexts load this module directly.
    pass

# Re-use the proven Greptile body parser + per-PR gate from
# pr_merge_readiness.py. Duplicating the parsing logic here would let the
# two surfaces drift -- a fix in one would not land in the other. The
# parser is module-private to pr_merge_readiness but exported by name and
# is the right load-bearing reuse point. See #1364.
import pr_merge_readiness as _mr  # noqa: E402

EXIT_OK = 0
EXIT_UNCLEAN = 1
EXIT_EXTERNAL_ERROR = 2

# ---------------------------------------------------------------------------
# Cohort discovery
# ---------------------------------------------------------------------------

# Regex for an x-vbrief/github-pr URI of the form
# `https://github.com/<owner>/<repo>/pull/<N>`. The cohort discovery path
# resolves the PR number from any reference that matches.
_PR_URI_RE = re.compile(
    r"https?://github\.com/[^/]+/[^/]+/pull/(?P<pr>\d+)",
)


@dataclass
class CohortResolutionError:
    """Structured failure from cohort discovery."""
    vbrief_path: str
    reason: str


def resolve_cohort_from_vbriefs(
    vbrief_globs: list[str],
) -> tuple[list[int], list[CohortResolutionError]]:
    """Resolve a list of PR numbers from one or more glob patterns over vBRIEF
    paths.

    For each matched ``*.vbrief.json`` file, read ``plan.references[]`` and
    extract every URI matching ``https://github.com/.../pull/<N>``. Returns
    a flat de-duplicated list of PR numbers preserving first-seen order
    AND a per-vBRIEF list of resolution failures so the caller can surface
    them with EXIT_EXTERNAL_ERROR.

    Acceptable failure modes (each surfaced as a structured
    ``CohortResolutionError`` but NOT raised) so a partial cohort can
    still be diagnosed:
    - vBRIEF JSON is malformed
    - vBRIEF carries no PR references at all
    - vBRIEF references a PR URL on a different host (we record but skip)
    """
    seen_prs: list[int] = []
    seen_set: set[int] = set()
    failures: list[CohortResolutionError] = []
    paths: list[Path] = []
    for pattern in vbrief_globs:
        # Each glob can match zero or more files. We treat a glob that
        # matches nothing as a soft failure (e.g. a typo): the caller
        # gets a structured error so they can fix the glob.
        matched = sorted(Path(p) for p in glob.glob(pattern))
        if not matched:
            failures.append(
                CohortResolutionError(
                    vbrief_path=pattern,
                    reason=f"glob matched no files: {pattern!r}",
                )
            )
            continue
        paths.extend(matched)
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            failures.append(
                CohortResolutionError(vbrief_path=str(path), reason=f"unreadable: {exc}")
            )
            continue
        references = payload.get("plan", {}).get("references", []) or []
        pr_numbers_in_file: list[int] = []
        for ref in references:
            uri = (ref or {}).get("uri", "") if isinstance(ref, dict) else ""
            if not uri:
                continue
            m = _PR_URI_RE.search(uri)
            if not m:
                continue
            pr_numbers_in_file.append(int(m.group("pr")))
        if not pr_numbers_in_file:
            failures.append(
                CohortResolutionError(
                    vbrief_path=str(path),
                    reason="no x-vbrief/github-pr-style references found",
                )
            )
            continue
        for pr_num in pr_numbers_in_file:
            if pr_num in seen_set:
                continue
            seen_set.add(pr_num)
            seen_prs.append(pr_num)
    return seen_prs, failures


# ---------------------------------------------------------------------------
# Per-PR + cohort evaluation
# ---------------------------------------------------------------------------


@dataclass
class CohortPRResult:
    """Per-PR slice of the cohort verdict."""
    pr_number: int
    head_sha: str | None
    verdict: dict  # asdict(GreptileVerdict)
    failures: list[str] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.failures


@dataclass
class CohortResult:
    """Aggregate cohort verdict."""
    repo: str | None
    pr_results: list[CohortPRResult] = field(default_factory=list)
    resolution_errors: list[CohortResolutionError] = field(default_factory=list)

    @property
    def all_clean(self) -> bool:
        return (
            bool(self.pr_results)
            and not self.resolution_errors
            and all(r.clean for r in self.pr_results)
        )

    def to_dict(self) -> dict:
        return {
            "repo": self.repo,
            "all_clean": self.all_clean,
            "pr_count": len(self.pr_results),
            "pr_results": [
                {
                    "pr_number": r.pr_number,
                    "head_sha": r.head_sha,
                    "clean": r.clean,
                    "verdict": r.verdict,
                    "failures": list(r.failures),
                }
                for r in self.pr_results
            ],
            "resolution_errors": [asdict(e) for e in self.resolution_errors],
        }


def evaluate_pr(
    pr_number: int,
    repo: str | None,
) -> CohortPRResult | None:
    """Evaluate one PR. Returns None on external error (caller maps to EXIT 2).

    Resolves every fetch / parse / gate call through the ``_mr`` module
    binding so monkey-patching ``_mr.fetch_pr_head_sha`` /
    ``_mr.fetch_greptile_comment_body`` (the canonical seam for tests of
    this script AND of pr_merge_readiness itself) propagates here at call
    time. A previous draft captured the fetchers as default keyword
    arguments, which froze the binding at function-definition time and
    silently bypassed monkeypatch; resolving via the module attribute is
    the right late-binding shape.
    """
    head_sha = _mr.fetch_pr_head_sha(pr_number, repo)
    if head_sha is None:
        return None
    body = _mr.fetch_greptile_comment_body(pr_number, repo)
    if body is None:
        return None
    verdict = _mr.parse_greptile_body(body)
    failures = _mr.evaluate_gates(pr_number, head_sha, verdict)
    return CohortPRResult(
        pr_number=pr_number,
        head_sha=head_sha,
        verdict=asdict(verdict),
        failures=failures,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="swarm_verify_review_clean",
        description=(
            "Cohort-level CLEAN verification gate (#1364). Exits 0 only when "
            "EVERY PR in the cohort has SHA match, confidence > 3, zero P0/P1, "
            "not errored on the current HEAD. Re-uses the Greptile body parser "
            "from scripts/pr_merge_readiness.py so the per-PR merge gate and "
            "the cohort gate stay in lockstep."
        ),
    )
    parser.add_argument(
        "pr_numbers",
        nargs="*",
        type=int,
        help="Explicit PR numbers to verify.",
    )
    parser.add_argument(
        "--cohort",
        dest="cohort_globs",
        action="append",
        default=[],
        metavar="GLOB",
        help=(
            "Glob pattern over vBRIEF JSON files. Each matched vBRIEF's "
            "plan.references[].uri is scanned for github.com/.../pull/<N> "
            "URIs; matching PRs join the cohort. May be passed multiple "
            "times."
        ),
    )
    parser.add_argument(
        "--repo",
        default=None,
        metavar="OWNER/REPO",
        help="Repository in OWNER/REPO form. Defaults to the current checkout's remote.",
    )
    parser.add_argument(
        "--json",
        dest="emit_json",
        action="store_true",
        help="Emit the cohort result as a single JSON object on stdout.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    # Step 1: build the cohort (union of explicit PR numbers + --cohort globs).
    pr_numbers: list[int] = list(dict.fromkeys(args.pr_numbers))  # de-dupe, preserve order
    resolution_errors: list[CohortResolutionError] = []
    if args.cohort_globs:
        discovered, errs = resolve_cohort_from_vbriefs(args.cohort_globs)
        for pr_num in discovered:
            if pr_num not in pr_numbers:
                pr_numbers.append(pr_num)
        resolution_errors.extend(errs)

    # Empty cohort is a config error -- the gate cannot affirm CLEAN over
    # zero PRs (it would silently exit 0 and let the merge discussion
    # proceed). Surface as EXIT_EXTERNAL_ERROR.
    if not pr_numbers:
        msg = (
            "Error: empty cohort. Pass one or more PR numbers as positional "
            "arguments and/or --cohort <glob> to discover PRs from vBRIEF "
            "references."
        )
        if args.emit_json:
            result = CohortResult(
                repo=args.repo, pr_results=[], resolution_errors=resolution_errors
            )
            print(json.dumps(result.to_dict(), indent=2))
        else:
            print(msg, file=sys.stderr)
            if resolution_errors:
                for err in resolution_errors:
                    print(f"  [{err.vbrief_path}] {err.reason}", file=sys.stderr)
        return EXIT_EXTERNAL_ERROR

    # If the --cohort globs surfaced resolution errors AND no PRs at all
    # were resolved from them (but explicit PR numbers are present), keep
    # going -- the explicit args satisfy the intent. If both surfaces
    # contribute nothing, the empty-cohort branch above already handled
    # it. We keep the resolution_errors in the result regardless so a
    # JSON consumer / human reader can see partial failures.

    # Step 2: per-PR evaluation.
    pr_results: list[CohortPRResult] = []
    for pr_num in pr_numbers:
        per_pr = evaluate_pr(pr_num, args.repo)
        if per_pr is None:
            # External error already printed by the fetchers; abort the
            # cohort with EXIT_EXTERNAL_ERROR so the operator sees the
            # failed PR rather than a misleading "MERGE-BLOCKED" verdict
            # on stale state.
            return EXIT_EXTERNAL_ERROR
        pr_results.append(per_pr)

    cohort = CohortResult(
        repo=args.repo,
        pr_results=pr_results,
        resolution_errors=resolution_errors,
    )

    if args.emit_json:
        print(json.dumps(cohort.to_dict(), indent=2))
    else:
        _render_text(cohort)

    return EXIT_OK if cohort.all_clean else EXIT_UNCLEAN


def _render_text(cohort: CohortResult) -> None:
    """Pretty-print the cohort verdict for human consumers."""
    n = len(cohort.pr_results)
    print(f"Swarm cohort CLEAN verification ({n} PR{'s' if n != 1 else ''})")
    if cohort.repo:
        print(f"  Repo: {cohort.repo}")
    if cohort.resolution_errors:
        print("  Resolution errors:")
        for err in cohort.resolution_errors:
            print(f"    [{err.vbrief_path}] {err.reason}")
    for r in cohort.pr_results:
        status = "CLEAN" if r.clean else "UNCLEAN"
        v = r.verdict
        print()
        print(f"  PR #{r.pr_number} -- {status}")
        print(f"    HEAD SHA:           {r.head_sha or '<unknown>'}")
        print(f"    Greptile reviewed:  {v.get('last_reviewed_sha') or '<not parsed>'}")
        conf = v.get("confidence")
        conf_str = str(conf) if conf is not None else "<not parsed>"
        print(f"    Confidence:         {conf_str}/5")
        print(
            f"    Findings:           P0={v.get('p0_count', 0)}  "
            f"P1={v.get('p1_count', 0)}  P2={v.get('p2_count', 0)}"
        )
        print(f"    Errored sentinel:   {v.get('errored', False)}")
        for i, fail in enumerate(r.failures, 1):
            print(f"      [{i}] {fail}")
    print()
    if cohort.all_clean:
        print("Result: COHORT CLEAN -- Phase 5 -> 6 merge discussion may proceed")
    else:
        n_unclean = sum(1 for r in cohort.pr_results if not r.clean)
        print(
            f"Result: COHORT BLOCKED -- {n_unclean}/{n} PR(s) unclean. "
            "Do NOT raise the Phase 5 -> 6 gate; re-dispatch pollers or "
            "address findings, then re-run task swarm:verify-review-clean."
        )


if __name__ == "__main__":
    sys.exit(main())
