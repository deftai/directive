#!/usr/bin/env python3
"""monitor_pr.py -- thin "wait until ready" helper for long-running PR monitors (#1368).

Background
----------
Long-running monitors during the #1166 swarm cascade looped on
``scripts/pr_merge_readiness.py`` and went blind for ~15+ minutes when a
single ``gh`` capture returned empty / malformed stdout under the Grok
Build harness. The #1366 ``_safe_subprocess.run_text`` helper closes the
``UnicodeDecodeError`` root cause; #1368 adds a layered fallback chain to
``pr_merge_readiness.py`` so a *single* gh failure no longer blinds the
monitor.

This script is the consumer-side counterpart -- a small, deterministic
"wait until the PR is CLEAN" loop that:

* sleeps with an **adaptive cadence** (~1 minute on the first few polls,
  then ~3 minutes, then ~5 minutes -- mirroring the cadence prescribed
  in ``skills/deft-directive-review-cycle/SKILL.md`` Step 4 but at the
  longer timescales appropriate for a *monitor* watching a swarm
  cascade, not a single Greptile review pass);

* **tolerates fallback responses** -- a ``via="fallback1"`` /
  ``via="fallback2"`` / ``via="error"`` result is treated as "keep
  polling", never as a terminal verdict;

* **exits 0 only on a primary or fallback1 CLEAN** -- ``via="fallback2"``
  is the coarse last-resort signal (see ``scripts/pr_merge_readiness.py``
  module docstring) and is NEVER a CLEAN verdict.

The helper writes one terse status line per poll to stderr so an
orchestrator's transcript shows progress, and the final verdict to
stdout (JSON when ``--json`` is passed, human-readable otherwise) so a
machine-readable summary survives the loop.

Subprocess capture routes through :func:`scripts._safe_subprocess.run_text`
per the ``AGENTS.md`` `## Safe subprocess capture (#1366)` rule.

Usage
-----
    uv run python scripts/monitor_pr.py 1363 --repo deftai/directive
    uv run python scripts/monitor_pr.py 1363 --repo deftai/directive --cap-minutes 30 --json

Exit codes
----------
    0 -- PR reached a primary/fallback1 CLEAN verdict (merge-ready)
    1 -- poll cap reached without a CLEAN verdict
    2 -- configuration error (gh missing on the monitor host, invalid args)
    3 -- PR was merged or closed before reaching CLEAN (terminal lifecycle)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# Make sibling scripts importable both when run as __main__ and when imported by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8-safe subprocess capture (#1366) -- per AGENTS.md
# ``## Safe subprocess capture (#1366)``, any new script that captures
# gh / python subprocess output MUST route the call through this helper.
from _safe_subprocess import run_text  # noqa: E402

# ---- Exit codes -------------------------------------------------------------

EXIT_CLEAN = 0
EXIT_CAP_REACHED = 1
EXIT_CONFIG_ERROR = 2
EXIT_PR_TERMINAL = 3

# ---- Adaptive cadence -------------------------------------------------------

# Cadence sequence (seconds). The first few polls run at ~1 minute so
# fast CLEAN exits are caught quickly; the loop then relaxes to ~3 and
# ~5 minutes per poll because Greptile re-reviews on a rebase cascade
# routinely take 2-5 minutes per branch and there is no value in
# polling more frequently than the upstream cadence (see
# ``skills/deft-directive-swarm/SKILL.md`` Phase 6 Step 1).
#
# Tuple shape: ``(interval_seconds, repeats)``. After all entries are
# consumed the last interval is held indefinitely until the poll cap is
# reached.
_DEFAULT_CADENCE: tuple[tuple[int, int], ...] = (
    (60, 3),    # 3 polls at ~1 minute
    (180, 3),   # 3 polls at ~3 minutes
    (300, 99),  # remaining polls at ~5 minutes
)


def _cadence_intervals(
    cadence: tuple[tuple[int, int], ...] = _DEFAULT_CADENCE,
) -> list[int]:
    """Expand the cadence tuple into a flat list of per-poll intervals.

    The last entry's repeat count is treated as a soft ceiling -- once the
    list is exhausted the caller is expected to break out via the
    ``--cap-minutes`` total-elapsed limit, not by polling forever.
    """
    intervals: list[int] = []
    for interval, repeats in cadence:
        intervals.extend([interval] * repeats)
    return intervals


# ---- Readiness call ---------------------------------------------------------


@dataclass
class PollResult:
    """One poll iteration's outcome."""
    exit_code: int
    payload: dict
    raw_stdout: str
    raw_stderr: str


def _readiness_script_path() -> Path:
    """Locate ``scripts/pr_merge_readiness.py`` relative to this helper."""
    return Path(__file__).resolve().parent / "pr_merge_readiness.py"


def call_readiness(
    pr_number: int,
    repo: str,
    *,
    python_executable: str | None = None,
    timeout: float = 90,
) -> PollResult:
    """Run ``pr_merge_readiness.py --json`` once and parse the verdict.

    Always returns a :class:`PollResult` -- a transient gh failure becomes
    a ``via="error"`` payload that the caller treats as "keep polling".
    The helper never raises on a ``pr_merge_readiness`` non-zero exit
    because the monitor must be able to step forward through transient
    failures without going blind.
    """
    python = python_executable or sys.executable
    cmd = [
        python,
        str(_readiness_script_path()),
        str(pr_number),
        "--repo",
        repo,
        "--json",
    ]
    try:
        result = run_text(cmd, timeout=timeout)
    except FileNotFoundError as exc:
        return PollResult(
            exit_code=EXIT_CONFIG_ERROR,
            payload={
                "via": "error",
                "merge_ready": False,
                "error": f"python executable not found: {exc}",
            },
            raw_stdout="",
            raw_stderr=str(exc),
        )
    except Exception as exc:  # pragma: no cover -- timeout / OS-level errors
        return PollResult(
            exit_code=EXIT_CONFIG_ERROR,
            payload={
                "via": "error",
                "merge_ready": False,
                "error": f"unexpected exception running readiness: {exc}",
            },
            raw_stdout="",
            raw_stderr=str(exc),
        )

    payload: dict
    if result.stdout.strip():
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            payload = {
                "via": "error",
                "merge_ready": False,
                "error": "pr_merge_readiness emitted non-JSON stdout",
                "raw_stdout_excerpt": result.stdout[:200],
            }
    else:
        payload = {
            "via": "error",
            "merge_ready": False,
            "error": "pr_merge_readiness emitted empty stdout",
        }

    return PollResult(
        exit_code=result.returncode,
        payload=payload,
        raw_stdout=result.stdout,
        raw_stderr=result.stderr,
    )


# ---- Loop -------------------------------------------------------------------


def _format_poll_status(poll_index: int, poll_result: PollResult) -> str:
    """One-line stderr status mirror per poll."""
    payload = poll_result.payload
    via = payload.get("via", "?")
    merge_ready = payload.get("merge_ready", False)
    head_sha = payload.get("head_sha") or "<unknown>"
    if isinstance(head_sha, str):
        head_sha = head_sha[:12]
    failures = payload.get("failures") or []
    first_failure = failures[0] if failures else ""
    label = "CLEAN" if merge_ready else "BLOCKED"
    return (
        f"[monitor_pr] poll #{poll_index} via={via} head={head_sha} "
        f"{label} ({len(failures)} failures)"
        + (f" -- {first_failure[:80]}" if first_failure else "")
    )


def _is_terminal_pr_state(payload: dict) -> bool:
    """Detect a merged / closed PR via the fallback2 partial_data.

    Fallback2 carries ``pr_state`` and ``merged`` so a monitor that hits
    the coarse-signal layer after the PR was merged out from under it
    can exit cleanly rather than waiting on a CLEAN that will never
    come.
    """
    partial = payload.get("partial_data") or {}
    # A closed-but-not-merged PR is also terminal -- the monitor cannot reach
    # CLEAN on a PR that the operator has rejected, so collapse both cases
    # into a single boolean expression (#1368 follow-up: ruff SIM103).
    return partial.get("merged") is True or partial.get("pr_state") == "closed"


def monitor(
    pr_number: int,
    repo: str,
    *,
    cap_minutes: float = 60,
    cadence: tuple[tuple[int, int], ...] = _DEFAULT_CADENCE,
    sleep_fn=time.sleep,
    clock_fn=time.monotonic,
    call_readiness_fn=call_readiness,
) -> tuple[int, dict, int]:
    """Loop ``pr_merge_readiness`` with adaptive cadence until CLEAN / cap / terminal.

    Returns ``(exit_code, last_payload, poll_count)``. ``last_payload`` is
    the final ``pr_merge_readiness`` JSON envelope so callers can attach
    diagnostics to their own report.

    ``sleep_fn``, ``clock_fn``, and ``call_readiness_fn`` are injected for
    tests so the loop runs in fake-time without real ``time.sleep`` cost.
    """
    intervals = _cadence_intervals(cadence)
    cap_seconds = cap_minutes * 60
    started_at = clock_fn()
    poll_index = 0
    last_payload: dict = {}
    last_exit = EXIT_CAP_REACHED

    for interval in intervals:
        poll_index += 1
        elapsed = clock_fn() - started_at
        if elapsed > cap_seconds:
            return EXIT_CAP_REACHED, last_payload, poll_index - 1

        poll_result = call_readiness_fn(pr_number, repo)
        last_payload = poll_result.payload
        last_exit = poll_result.exit_code

        # Mirror per-poll status to stderr so the orchestrator transcript
        # shows progress without parsing the final JSON envelope.
        print(_format_poll_status(poll_index, poll_result), file=sys.stderr)
        if poll_result.raw_stderr.strip():
            # Surface the readiness script's stderr verbatim -- it carries
            # the gh error message a downstream operator may need.
            sys.stderr.write(poll_result.raw_stderr)

        via = last_payload.get("via")
        merge_ready = bool(last_payload.get("merge_ready"))

        # Authoritative CLEAN exit -- only primary or fallback1 can fire.
        if merge_ready and via in ("primary", "fallback1"):
            return EXIT_CLEAN, last_payload, poll_index

        # Terminal lifecycle -- PR merged or closed out from under us.
        if _is_terminal_pr_state(last_payload):
            return EXIT_PR_TERMINAL, last_payload, poll_index

        # Otherwise: keep polling. fallback2 + error are NOT terminal --
        # the monitor steps forward until the cap.
        if poll_index < len(intervals):
            # Time-budget guard before sleeping: if the next sleep would
            # push us past the cap, return the current verdict now.
            elapsed_after_poll = clock_fn() - started_at
            remaining = cap_seconds - elapsed_after_poll
            if remaining <= 0:
                return EXIT_CAP_REACHED, last_payload, poll_index
            sleep_fn(min(interval, max(1, int(remaining))))

    final_exit = (
        last_exit if last_exit == EXIT_CONFIG_ERROR else EXIT_CAP_REACHED
    )
    return final_exit, last_payload, poll_index


# ---- CLI --------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="monitor_pr",
        description=(
            "Wait-until-ready helper for long-running PR monitors. "
            "Loops pr_merge_readiness.py with adaptive cadence (~1m -> 3m -> "
            "5m) until the PR reaches a primary/fallback1 CLEAN verdict, "
            "the poll cap is reached, or the PR is merged/closed. "
            "Tolerates fallback responses; never exits CLEAN on fallback2."
        ),
    )
    parser.add_argument("pr_number", type=int, help="Pull request number to watch.")
    parser.add_argument(
        "--repo",
        default=None,
        metavar="OWNER/REPO",
        help="Repository in OWNER/REPO form. Defaults to $GH_REPO or current checkout.",
    )
    parser.add_argument(
        "--cap-minutes",
        type=float,
        default=60.0,
        help="Total wall-clock cap for the monitor in minutes (default: 60).",
    )
    parser.add_argument(
        "--json",
        dest="emit_json",
        action="store_true",
        help="Emit the final pr_merge_readiness payload as JSON on stdout.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    repo = args.repo or os.environ.get("GH_REPO")
    if not repo:
        print(
            "Error: --repo OWNER/REPO is required (or set $GH_REPO).",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    exit_code, payload, poll_count = monitor(
        pr_number=args.pr_number,
        repo=repo,
        cap_minutes=args.cap_minutes,
    )

    summary_label = {
        EXIT_CLEAN: "CLEAN",
        EXIT_CAP_REACHED: "CAP-REACHED",
        EXIT_PR_TERMINAL: "PR-TERMINAL",
        EXIT_CONFIG_ERROR: "CONFIG-ERROR",
    }.get(exit_code, "UNKNOWN")
    print(
        f"[monitor_pr] PR #{args.pr_number} repo={repo} result={summary_label} "
        f"polls={poll_count} via={payload.get('via', '?')}",
        file=sys.stderr,
    )

    if args.emit_json:
        # Wrap the readiness payload with monitor-level context so a
        # consumer parsing the stdout sees both the verdict and the
        # monitor outcome in one envelope.
        envelope = {
            "monitor_result": summary_label,
            "polls": poll_count,
            "readiness": payload,
        }
        print(json.dumps(envelope, indent=2))
    else:
        # Plain-text summary for human consumption.
        print(f"PR #{args.pr_number} monitor result: {summary_label}")
        print(f"  polls: {poll_count}")
        print(f"  via:   {payload.get('via', '?')}")
        if payload.get("error"):
            print(f"  error: {payload['error']}")
        if payload.get("failures"):
            for i, fail in enumerate(payload["failures"], 1):
                print(f"  [{i}] {fail}")

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
