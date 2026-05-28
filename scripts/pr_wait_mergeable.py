#!/usr/bin/env python3
"""pr_wait_mergeable.py -- Resilient cascade automation helper (#1369).

Wraps the Wave-2 resilient wait-until-ready helper (`scripts/monitor_pr.py`,
#1368) and the Layer-3 protected-issue pre-merge link inspector
(`scripts/pr_check_protected_issues.py`, #701) into a single end-to-end
cascade automation surface so a swarm monitor can request
"wait until this PR is mergeable, then merge it" in one invocation without
hand-rolling the loop.

Background
----------
The 2026-05-26 #1166 swarm cascade for #1363 + Wave 3 saw the monitor
babysitting individual PRs because there was no first-class
"wait-until-ready, then merge" primitive that survived the documented
Grok Build harness fragility (#1353 / #1366). The Wave-1+2 work made the
underlying primitives reliable:

* ``scripts/_safe_subprocess.py::run_text`` (#1366) -- UTF-8-safe subprocess
  capture; closes the ``Thread-3 (_readerthread) UnicodeDecodeError``
  blind spot on Windows + Grok Build.
* ``scripts/pr_merge_readiness.py`` (#1368) -- layered fallback chain
  (primary -> fallback1 -> fallback2) with a ``via`` discriminator on
  every JSON response; fallback2 is structurally never CLEAN.
* ``scripts/monitor_pr.py`` (#1368) -- adaptive 1m/3m/5m cadence loop
  around ``pr_merge_readiness`` that tolerates layered fallbacks and
  exits 0 only on a primary/fallback1 CLEAN verdict.

This helper composes those primitives. The flow is strictly:

1. **Layer-3 protected-issue link inspection** -- if any ``--protected
   <issue-numbers>`` were supplied, run ``scripts/pr_check_protected_issues.py``
   BEFORE the wait loop. A persistent ``closingIssuesReferences`` link
   to a protected issue is a structural pre-condition failure: it cannot
   be resolved by waiting, so the helper exits 1 (escalation) without
   ever invoking the wait loop or the merge call. This is the
   "exit 1 BEFORE merge call" path the tests pin.

2. **Wait until CLEAN** -- delegate to ``scripts/monitor_pr.py``. The
   monitor's exit code maps onto this helper's three-state exit:

   * monitor exit 0 (PR reached a primary/fallback1 CLEAN) -> proceed to merge
   * monitor exit 1 (poll cap reached without CLEAN)       -> helper exit 1
   * monitor exit 2 (gh missing / invalid args)            -> helper exit 2
   * monitor exit 3 (PR merged or closed out from under)   -> helper exit 0
     when ``merged=True`` (the cascade goal was reached, just by a
     sibling cascade); helper exit 1 when ``state="closed"`` and not
     merged (operator rejected the PR mid-loop, escalate).

3. **Squash-merge** -- run
   ``gh pr merge <N> --squash --delete-branch --admin`` (per
   ``skills/deft-directive-swarm/SKILL.md`` Phase 6 Step 1). The per-PR
   atomic gate ``task pr:merge-ready && gh pr merge`` documented in
   the swarm skill still applies at the merge-time freshness window:
   the wait loop's last CLEAN verdict is at most one poll interval old,
   and the merge call itself is the freshness boundary.

Three-state exit (mirrors the rest of the framework's verb scripts):

    0 -- PR is now merged (either by this helper or by a sibling cascade)
    1 -- timeout or escalation: the PR was not merged. Reasons surfaced
         to stderr include cap-reached (no CLEAN within the cap window),
         protected-issue-link-present (Layer-3 false-positive on
         ``closingIssuesReferences``), PR closed without merge, or a
         non-zero exit from ``gh pr merge`` itself.
    2 -- configuration error: ``gh`` missing on the monitor host,
         invalid CLI args, malformed --protected tokens, or any failure
         from a chained script that mapped to config-error semantics.

Subprocess capture routes through :func:`scripts._safe_subprocess.run_text`
per the ``AGENTS.md`` ``## Safe subprocess capture (#1366)`` rule. All
external subprocess invocations (`monitor_pr.py`, `pr_check_protected_issues.py`,
`gh pr merge`) are exposed as module-level functions so tests can
monkey-patch them without hitting the network.

Usage
-----

    # Minimal -- wait for CLEAN, then merge.
    uv run python scripts/pr_wait_mergeable.py 1370 --repo deftai/directive

    # Layer-3 protected-issue gate ahead of the wait loop.
    uv run python scripts/pr_wait_mergeable.py 1370 \\
        --repo deftai/directive \\
        --protected 1119,1140

    # Tune the wait cap and emit a JSON envelope for a parent monitor.
    uv run python scripts/pr_wait_mergeable.py 1370 \\
        --repo deftai/directive \\
        --cap-minutes 45 \\
        --json

Exit codes
----------
    0 -- PR is merged (or already merged on entry)
    1 -- timeout / escalation (PR not merged; reason surfaced to stderr)
    2 -- configuration error (gh missing, invalid args, malformed --protected)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Make sibling scripts importable both when run as __main__ and when imported
# by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8-safe subprocess capture (#1366) -- per AGENTS.md
# ``## Safe subprocess capture (#1366)``, any new script that captures
# gh / python subprocess output MUST route the call through this helper.
from _safe_subprocess import run_text  # noqa: E402

# ---- Exit codes -------------------------------------------------------------

EXIT_MERGED = 0
EXIT_TIMEOUT_OR_ESCALATION = 1
EXIT_CONFIG_ERROR = 2

# ---- Companion script paths -------------------------------------------------

_SCRIPTS_DIR = Path(__file__).resolve().parent
_MONITOR_SCRIPT = _SCRIPTS_DIR / "monitor_pr.py"
_PROTECTED_SCRIPT = _SCRIPTS_DIR / "pr_check_protected_issues.py"


# ---- Result envelope --------------------------------------------------------


@dataclass
class WaitMergeableResult:
    """Structured outcome of one ``pr_wait_mergeable`` invocation.

    The envelope mirrors the shape ``scripts/monitor_pr.py`` emits so a
    parent monitor parsing both stdouts sees a familiar field layout.
    """

    pr_number: int
    repo: str | None
    outcome: str            # "merged" | "cap-reached" | "pr-closed" |
                            # "protected-linked" | "merge-failed" | "config-error"
    exit_code: int
    monitor_result: dict = field(default_factory=dict)
    protected_check: dict = field(default_factory=dict)
    merge_stdout: str = ""
    merge_stderr: str = ""
    error: str | None = None

    def to_dict(self) -> dict:
        payload: dict[str, Any] = {
            "pr_number": self.pr_number,
            "repo": self.repo,
            "outcome": self.outcome,
            "exit_code": self.exit_code,
        }
        if self.monitor_result:
            payload["monitor_result"] = self.monitor_result
        if self.protected_check:
            payload["protected_check"] = self.protected_check
        if self.merge_stdout:
            payload["merge_stdout"] = self.merge_stdout
        if self.merge_stderr:
            payload["merge_stderr"] = self.merge_stderr
        if self.error is not None:
            payload["error"] = self.error
        return payload


# ---- Chained subprocess wrappers --------------------------------------------
#
# Each wrapper is a module-level function so tests can monkey-patch the
# external call without going near a real ``gh`` invocation. The wrappers
# return uniform ``(returncode, stdout, stderr)`` tuples and route every
# text capture through ``_safe_subprocess.run_text`` per the #1366
# AGENTS.md rule.


def run_protected_check(
    pr_number: int,
    repo: str | None,
    protected: list[int],
    *,
    python_executable: str | None = None,
    timeout: float = 60,
) -> tuple[int, str, str]:
    """Invoke ``scripts/pr_check_protected_issues.py`` and return its result.

    Returns ``(returncode, stdout, stderr)``. Exit 0 means no protected
    link; exit 1 means a protected link is present; exit 2 means an
    external/config error from the inspection. The caller maps these
    onto the helper's three-state exit.

    ``protected`` is the explicit issue-number list. The helper joins it
    with commas onto a single ``--protected`` flag (the underlying
    script supports comma-separated as well as repeated-flag forms; we
    use the comma form for shell-quoting simplicity).
    """
    python = python_executable or sys.executable
    cmd: list[str] = [
        python,
        str(_PROTECTED_SCRIPT),
        str(pr_number),
        "--protected",
        ",".join(str(n) for n in protected),
    ]
    if repo:
        cmd.extend(["--repo", repo])
    try:
        result = run_text(cmd, timeout=timeout)
    except FileNotFoundError as exc:
        return -1, "", f"python executable not found: {exc}"
    except subprocess.TimeoutExpired:
        return -1, "", f"protected-issue check timed out after {timeout}s"
    return result.returncode, result.stdout, result.stderr


def run_monitor(
    pr_number: int,
    repo: str,
    cap_minutes: float,
    *,
    python_executable: str | None = None,
    timeout: float | None = None,
) -> tuple[int, str, str]:
    """Invoke ``scripts/monitor_pr.py --json`` and return its result.

    Returns ``(returncode, stdout, stderr)``. The monitor's three-state
    exit (plus an additional PR-terminal exit 3) is preserved verbatim;
    the caller maps onto the helper's three-state exit.

    ``timeout`` defaults to ``cap_minutes * 60 + 60`` seconds (one
    minute of slack past the monitor's cap so a TimeoutExpired only
    fires when the monitor itself is hung, not when it is mid-cap).
    """
    python = python_executable or sys.executable
    cmd: list[str] = [
        python,
        str(_MONITOR_SCRIPT),
        str(pr_number),
        "--repo",
        repo,
        "--cap-minutes",
        str(cap_minutes),
        "--json",
    ]
    if timeout is None:
        timeout = cap_minutes * 60 + 60
    try:
        result = run_text(cmd, timeout=timeout)
    except FileNotFoundError as exc:
        return -1, "", f"python executable not found: {exc}"
    except subprocess.TimeoutExpired:
        return -1, "", f"monitor_pr timed out after {timeout}s"
    return result.returncode, result.stdout, result.stderr


def run_gh_merge(
    pr_number: int,
    repo: str | None,
    *,
    timeout: float = 120,
) -> tuple[int, str, str]:
    """Invoke ``gh pr merge --squash --delete-branch --admin`` and return result.

    The merge call is the freshness boundary of the cascade: the wait
    loop's last CLEAN verdict is at most one monitor poll interval old,
    and ``gh pr merge`` fails non-zero if a sibling rebase has landed in
    the elapsed window (which is the per-merge atomic gate the swarm
    skill mandates).
    """
    cmd: list[str] = [
        "gh",
        "pr",
        "merge",
        str(pr_number),
        "--squash",
        "--delete-branch",
        "--admin",
    ]
    if repo:
        cmd.extend(["--repo", repo])
    try:
        result = run_text(cmd, timeout=timeout)
    except FileNotFoundError:
        return -1, "", "gh CLI not found. Install GitHub CLI."
    except subprocess.TimeoutExpired:
        return -1, "", f"gh pr merge timed out after {timeout}s"
    return result.returncode, result.stdout, result.stderr


# ---- Argument parsing -------------------------------------------------------


def _parse_protected(values: list[str]) -> list[int]:
    """Flatten comma-separated and repeated ``--protected`` flags.

    Mirrors :func:`scripts.pr_check_protected_issues._parse_protected`
    semantics so the helper rejects the same malformed tokens (Unicode
    superscripts, non-decimal junk) and gives the same user-facing
    error rather than letting the underlying script surface its own.

    Raises :class:`ValueError` on any non-decimal token so the caller
    can map to ``EXIT_CONFIG_ERROR``.
    """
    out: set[int] = set()
    for chunk in values:
        for tok in chunk.split(","):
            tok = tok.strip().lstrip("#")
            if not tok:
                continue
            # ``isdecimal()`` (vs ``isdigit()``) ONLY matches base-10 0-9 so
            # superscript '\u00b2' is rejected with the actionable error
            # rather than crashing inside int().
            if not tok.isdecimal():
                raise ValueError(f"Invalid protected issue token: {tok!r}")
            out.add(int(tok))
    return sorted(out)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pr_wait_mergeable",
        description=(
            "Resilient cascade automation helper (#1369). Polls "
            "mergeability via scripts/monitor_pr.py (#1368), runs the "
            "Layer-3 protected-issue link inspection (#701) ahead of the "
            "wait loop, and merges with `gh pr merge --squash "
            "--delete-branch --admin` only after the readiness call exits "
            "CLEAN on the current HEAD. Three-state exit: 0 merged, 1 "
            "timeout/escalation, 2 config error."
        ),
    )
    parser.add_argument(
        "pr_number",
        type=int,
        help="Pull request number to wait on and merge.",
    )
    parser.add_argument(
        "--repo",
        default=None,
        metavar="OWNER/REPO",
        help=(
            "Repository in OWNER/REPO form. Defaults to $GH_REPO or the "
            "current checkout's remote."
        ),
    )
    parser.add_argument(
        "--cap-minutes",
        type=float,
        default=60.0,
        help=(
            "Total wall-clock cap for the wait loop in minutes (default: "
            "60). Forwarded to scripts/monitor_pr.py."
        ),
    )
    parser.add_argument(
        "--protected",
        action="append",
        default=[],
        metavar="ISSUE_NUMBERS",
        help=(
            "Comma-separated list of protected (umbrella / staying-OPEN) "
            "issue numbers; may be passed multiple times. Inspected via "
            "scripts/pr_check_protected_issues.py (#701) BEFORE the wait "
            "loop -- a persistent link causes immediate exit 1 with no "
            "merge call."
        ),
    )
    parser.add_argument(
        "--json",
        dest="emit_json",
        action="store_true",
        help=(
            "Emit a structured JSON envelope on stdout summarising the "
            "monitor result, protected-issue check, merge output, and "
            "final outcome."
        ),
    )
    return parser


# ---- Outcome / exit mapping -------------------------------------------------


def _classify_monitor_outcome(
    monitor_returncode: int,
    monitor_payload: dict,
) -> tuple[str, int]:
    """Map monitor_pr's exit code onto a helper outcome + exit code.

    The mapping is intentionally narrow so a future addition to
    monitor_pr's exit table surfaces here as a config error rather than
    silently turning into a merged-claim.
    """
    if monitor_returncode == 0:
        # CLEAN -- the caller proceeds to the merge call.
        return ("clean", EXIT_MERGED)
    if monitor_returncode == 1:
        return ("cap-reached", EXIT_TIMEOUT_OR_ESCALATION)
    if monitor_returncode == 2:
        return ("config-error", EXIT_CONFIG_ERROR)
    if monitor_returncode == 3:
        # PR-TERMINAL: merged-out-from-under-us or closed-without-merge.
        # Map merged=True -> EXIT_MERGED (cascade goal reached); else
        # treat as escalation (operator rejected the PR mid-loop).
        readiness = (
            monitor_payload.get("readiness", {})
            if isinstance(monitor_payload, dict)
            else {}
        )
        partial = (
            readiness.get("partial_data", {})
            if isinstance(readiness, dict)
            else {}
        )
        if partial.get("merged") is True:
            return ("merged-by-sibling", EXIT_MERGED)
        return ("pr-closed", EXIT_TIMEOUT_OR_ESCALATION)
    # Unknown monitor exit -- treat as config error so it surfaces loudly.
    return ("config-error", EXIT_CONFIG_ERROR)


def _parse_monitor_payload(stdout: str) -> dict:
    """Parse the monitor's --json envelope. Returns ``{}`` on failure."""
    if not stdout or not stdout.strip():
        return {}
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return {}
    if isinstance(payload, dict):
        return payload
    return {}


# ---- Main orchestration -----------------------------------------------------


def wait_mergeable_and_merge(
    pr_number: int,
    repo: str,
    *,
    cap_minutes: float,
    protected: list[int],
    protected_fn=None,
    monitor_fn=None,
    merge_fn=None,
) -> WaitMergeableResult:
    """Run the protected-check -> wait -> merge cascade.

    Subprocess wrappers are injected as keyword arguments so tests can
    drive the cascade without spawning real processes. ``None`` (the
    default) resolves the wrapper via :func:`globals` lookup at call
    time so a ``monkeypatch.setattr(pwm, "run_monitor", fake)`` on the
    module attribute reaches the cascade -- binding the function in the
    default value would freeze the reference at function-definition
    time and silently bypass the patch. The function body is the single
    source of truth for the helper's state machine and is exhaustively
    exercised by ``tests/cli/test_pr_wait_mergeable.py``.
    """
    # Late-bind via the module dict so monkeypatch.setattr on the module
    # attribute takes effect; explicit-kwarg overrides still win.
    protected_fn = protected_fn or globals()["run_protected_check"]
    monitor_fn = monitor_fn or globals()["run_monitor"]
    merge_fn = merge_fn or globals()["run_gh_merge"]
    # --- Step 1: Layer-3 protected-issue link inspection (#701) ----------
    protected_check_payload: dict = {}
    if protected:
        prc_rc, prc_stdout, prc_stderr = protected_fn(pr_number, repo, protected)
        protected_check_payload = {
            "returncode": prc_rc,
            "stdout": prc_stdout,
            "stderr": prc_stderr,
            "protected": list(protected),
        }
        if prc_rc == 1:
            # Persistent link present -- escalation, do NOT run monitor or merge.
            return WaitMergeableResult(
                pr_number=pr_number,
                repo=repo,
                outcome="protected-linked",
                exit_code=EXIT_TIMEOUT_OR_ESCALATION,
                protected_check=protected_check_payload,
                error=(
                    "PR has a persistent closingIssuesReferences link to a "
                    "protected issue (#701). Unlink via the PR's Development "
                    "sidebar before re-running."
                ),
            )
        if prc_rc not in (0,):
            # Any non-zero non-1 exit collapses to a config error -- the
            # inspection cannot run, so the gate cannot affirm safety.
            return WaitMergeableResult(
                pr_number=pr_number,
                repo=repo,
                outcome="config-error",
                exit_code=EXIT_CONFIG_ERROR,
                protected_check=protected_check_payload,
                error=(
                    f"protected-issue check exited {prc_rc} (config error). "
                    f"stderr: {prc_stderr.strip()}"
                ),
            )

    # --- Step 2: Wait until CLEAN (#1368) --------------------------------
    mon_rc, mon_stdout, mon_stderr = monitor_fn(pr_number, repo, cap_minutes)
    monitor_payload = _parse_monitor_payload(mon_stdout)
    outcome, monitor_exit = _classify_monitor_outcome(mon_rc, monitor_payload)

    if outcome != "clean":
        # cap-reached, pr-closed, config-error, merged-by-sibling.
        # The merged-by-sibling outcome is a SUCCESS path (exit_code 0)
        # even though it lives in the non-clean branch, so it MUST NOT
        # carry an ``error`` string -- a downstream consumer parsing the
        # JSON envelope sees ``exit_code: 0`` and would treat a non-None
        # ``error`` field as a self-contradiction (Greptile P2 finding
        # on PR #1377).
        if monitor_exit == EXIT_MERGED:
            error_payload: str | None = None
        else:
            error_payload = (
                f"monitor exited {mon_rc} (outcome={outcome}). "
                f"stderr tail: {mon_stderr.strip()[-200:]}"
                if mon_stderr.strip()
                else f"monitor exited {mon_rc} (outcome={outcome})"
            )
        return WaitMergeableResult(
            pr_number=pr_number,
            repo=repo,
            outcome=outcome,
            exit_code=monitor_exit,
            monitor_result=monitor_payload,
            protected_check=protected_check_payload,
            error=error_payload,
        )

    # --- Step 3: Squash-merge --------------------------------------------
    merge_rc, merge_stdout, merge_stderr = merge_fn(pr_number, repo)
    if merge_rc == 0:
        return WaitMergeableResult(
            pr_number=pr_number,
            repo=repo,
            outcome="merged",
            exit_code=EXIT_MERGED,
            monitor_result=monitor_payload,
            protected_check=protected_check_payload,
            merge_stdout=merge_stdout,
            merge_stderr=merge_stderr,
        )

    # gh pr merge failed. The ``run_gh_merge`` wrapper signals "gh
    # binary missing" (FileNotFoundError) and "gh runtime/IO timeout"
    # by returning ``returncode == -1`` -- these are CONFIGURATION
    # errors (the cascade gate cannot run), NOT merge-time escalations,
    # and MUST surface as EXIT_CONFIG_ERROR per the documented
    # three-state contract so automated callers keying on exit 2 to
    # skip retries do not loop indefinitely (Greptile P1 finding on
    # PR #1377). Mirrors ``run_protected_check``'s rc=-1 path that
    # already collapses to EXIT_CONFIG_ERROR a few lines above.
    if merge_rc == -1:
        return WaitMergeableResult(
            pr_number=pr_number,
            repo=repo,
            outcome="config-error",
            exit_code=EXIT_CONFIG_ERROR,
            monitor_result=monitor_payload,
            protected_check=protected_check_payload,
            merge_stdout=merge_stdout,
            merge_stderr=merge_stderr,
            error=(
                f"gh pr merge wrapper failed at OS layer (rc=-1). "
                f"stderr: {merge_stderr.strip()[-200:]}"
                if merge_stderr.strip()
                else "gh pr merge wrapper failed at OS layer (rc=-1)."
            ),
        )

    # Non-zero non-sentinel exit -- sibling rebase landed in the
    # freshness window, branch-protection refusal, network blip mid-
    # merge, etc. The cascade goal was not reached but a retry MAY
    # succeed; surface as escalation (exit 1).
    return WaitMergeableResult(
        pr_number=pr_number,
        repo=repo,
        outcome="merge-failed",
        exit_code=EXIT_TIMEOUT_OR_ESCALATION,
        monitor_result=monitor_payload,
        protected_check=protected_check_payload,
        merge_stdout=merge_stdout,
        merge_stderr=merge_stderr,
        error=(
            f"gh pr merge exited {merge_rc}. stderr: {merge_stderr.strip()[-200:]}"
            if merge_stderr.strip()
            else f"gh pr merge exited {merge_rc}"
        ),
    )


# ---- CLI --------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    # Resolve --repo: explicit flag wins, then $GH_REPO. We do NOT auto-
    # detect from the current checkout here because cascade automation
    # is normally invoked from a non-clone harness (the swarm monitor's
    # working directory may not be a git checkout of the target repo).
    repo = args.repo or os.environ.get("GH_REPO")
    if not repo:
        print(
            "Error: --repo OWNER/REPO is required (or set $GH_REPO).",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    # Flatten --protected before the cascade so a malformed token is a
    # pre-flight config error rather than a mid-cascade surprise.
    try:
        protected = _parse_protected(args.protected)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    result = wait_mergeable_and_merge(
        pr_number=args.pr_number,
        repo=repo,
        cap_minutes=args.cap_minutes,
        protected=protected,
    )

    summary_label = {
        EXIT_MERGED: "MERGED",
        EXIT_TIMEOUT_OR_ESCALATION: "TIMEOUT-OR-ESCALATION",
        EXIT_CONFIG_ERROR: "CONFIG-ERROR",
    }.get(result.exit_code, "UNKNOWN")

    # Per-poll status mirror lands on stderr from monitor_pr already; the
    # final verdict goes on stdout so a consumer parsing the cascade
    # output sees the outcome regardless of --json mode.
    print(
        f"[pr_wait_mergeable] PR #{result.pr_number} repo={result.repo} "
        f"result={summary_label} outcome={result.outcome}",
        file=sys.stderr,
    )

    if args.emit_json:
        print(json.dumps(result.to_dict(), indent=2))
    else:
        print(f"PR #{result.pr_number} wait-mergeable-and-merge result: {summary_label}")
        print(f"  outcome: {result.outcome}")
        if result.error:
            print(f"  error:   {result.error}")
        if result.merge_stdout.strip():
            print("  merge stdout:")
            for line in result.merge_stdout.strip().splitlines():
                print(f"    {line}")

    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
