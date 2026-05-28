#!/usr/bin/env python3
"""subagent_monitor.py -- Sub-agent heartbeat watcher (#1365).

Walks one or more ``.deft-scratch/subagent-status/`` directories and reports
the liveness of every heartbeat record found there. The contract those
records implement is documented at ``docs/subagent-heartbeat.md``; this
script is the canonical reader.

Background (#1365)
------------------
The Grok Build hybrid swarm path dispatches review-cycle sub-agents via
``spawn_subagent``. Those agents run in isolated worktrees and have no
built-in lifecycle channel back to the monitor -- the only signals
available are side effects (commits, PR comments). The #1166 swarm
session demonstrated the failure mode: three review-cycle sub-agents
launched, one reported back, two went completely dark with **zero**
observable signals. The monitor could not distinguish "still working"
from "stalled" from "dead".

The heartbeat contract closes that gap: every long-running sub-agent
writes a small JSON record under ``.deft-scratch/subagent-status/`` with
its agent_id / parent_id / last_heartbeat_at / last_message / phase /
optional terminal_state. The monitor reads those records and flags
anything older than the staleness threshold (default 30 minutes).

This script intentionally does NOT shell out to ``gh`` or any other
external CLI -- the heartbeat surface is on-disk by design so a network
partition or rate-limit ceiling cannot mask agent liveness. The
``scripts/_safe_subprocess.py`` UTF-8 helper is imported in case a
future caller wants to surface gh-derived context alongside the
heartbeat report (per the AGENTS.md ``## Safe subprocess capture
(#1366)`` rule that mandates routing every gh capture through the
helper), but the core liveness path is filesystem-only.

Usage
-----
    # Scan the default project-root scratch dir
    uv --project . run python scripts/subagent_monitor.py

    # Scan one or more explicit scratch dirs (one per agent worktree)
    uv --project . run python scripts/subagent_monitor.py \\
      --scratch-dir C:/Repos/deft-agent3-1365/.deft-scratch/subagent-status \\
      --scratch-dir C:/Repos/deft-agent4-1368/.deft-scratch/subagent-status

    # Tighter threshold for impatient monitors
    uv --project . run python scripts/subagent_monitor.py --threshold-minutes 5

    # Machine-readable output for parent monitor agents
    uv --project . run python scripts/subagent_monitor.py --json

Exit codes (three-state, mirrors task verify:cache-fresh / task
pr:merge-ready / task swarm:verify-review-clean):

    0 -- every record is fresher than threshold AND parses cleanly
    1 -- one or more records is stale OR malformed
    2 -- config error (no scratch dirs given AND no default found, or
         invalid --threshold-minutes)

Pure stdlib; no third-party deps. Re-uses ``scripts/_safe_subprocess.py``
solely so any future gh capture inside this script routes through the
canonical UTF-8-safe helper (per AGENTS.md ``## Safe subprocess capture
(#1366)``).
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

# Make sibling scripts importable both when run as __main__ and when imported
# by tests (mirrors scripts/swarm_verify_review_clean.py + pr_merge_readiness.py
# layout so the import seam is consistent across the swarm-verb cluster).
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from _stdio_utf8 import reconfigure_stdio  # noqa: E402
    reconfigure_stdio()
except ImportError:
    # _stdio_utf8 is optional; some test contexts load this module directly.
    pass

# UTF-8-safe subprocess capture (#1366). The monitor itself does not shell
# out today -- the heartbeat surface is on-disk by design -- but the
# AGENTS.md ``## Safe subprocess capture (#1366)`` rule mandates that any
# script that MIGHT shell out for parsable output (and the monitor is one
# adjacent edit away from inspecting a Greptile body on behalf of a dark
# sub-agent) imports the helper from day one. Importing here keeps the
# contract visible at the module level so the next maintainer reaches for
# ``run_text`` without thinking.
from _safe_subprocess import run_text  # noqa: E402, F401

EXIT_OK = 0
EXIT_STALE = 1
EXIT_EXTERNAL_ERROR = 2

# Default staleness threshold (minutes). Calibrated for the review-cycle
# poller cadence (90s polls, 30-minute caps); the operator overrides via
# ``--threshold-minutes``.
DEFAULT_THRESHOLD_MINUTES = 30

# Canonical phase taxonomy from docs/subagent-heartbeat.md. An unknown
# phase flags the record as MALFORMED (exit 1) -- the docs declare the
# enum as a hard contract (`phase` MUST be one of the listed values), so
# the monitor surfaces an unknown phase as a typo + the operator fixes
# the agent that's writing it. Forward-compat extension is an additive
# enum bump under the contract, NOT silent acceptance at read time.
# Keep this in sync with the docs file -- the tests pin the doc + script
# as the same authoritative enumeration.
CANONICAL_PHASES = frozenset({
    "starting",
    "implementing",
    "validating",
    "committing",
    "pushing",
    "polling",
    "fixing",
    "terminal",
})

# Required field set per docs/subagent-heartbeat.md. Missing any one of
# these is a malformed-record failure (exit 1). Optional fields
# (terminal_state, pr_number, extra) are not enforced.
REQUIRED_FIELDS = ("agent_id", "parent_id", "last_heartbeat_at", "last_message", "phase")

# Module-level constant so we compute the zero-offset timedelta once. Defined
# before _parse_iso8601_utc so the reference is visible on the first call.
_UTC_ZERO_OFFSET = timedelta(0)


# ---------------------------------------------------------------------------
# Heartbeat record parsing
# ---------------------------------------------------------------------------


@dataclass
class HeartbeatRecord:
    """Parsed heartbeat record. ``failures`` non-empty == malformed."""
    path: str
    agent_id: str | None
    parent_id: str | None
    last_heartbeat_at_iso: str | None
    last_heartbeat_at: datetime | None
    last_message: str | None
    phase: str | None
    terminal_state: str | None
    pr_number: int | None
    age_seconds: float | None
    is_terminal: bool
    is_stale: bool
    failures: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures and not self.is_stale

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "agent_id": self.agent_id,
            "parent_id": self.parent_id,
            "last_heartbeat_at": self.last_heartbeat_at_iso,
            "last_message": self.last_message,
            "phase": self.phase,
            "terminal_state": self.terminal_state,
            "pr_number": self.pr_number,
            "age_seconds": self.age_seconds,
            "is_terminal": self.is_terminal,
            "is_stale": self.is_stale,
            "failures": list(self.failures),
            "ok": self.ok,
        }


def _parse_iso8601_utc(value: str) -> datetime | None:
    """Parse an ISO-8601 UTC timestamp ending in ``Z`` or a ``+00:00`` offset.

    Returns ``None`` on any parse failure or on a timezone other than UTC.
    Local-timezone timestamps are intentionally rejected per
    ``docs/subagent-heartbeat.md`` (the contract is UTC with the ``Z``
    suffix; the helper accepts the canonical ``+00:00`` Python emits when
    serializing ``datetime.now(timezone.utc)`` for forward-compat).
    """
    if not isinstance(value, str) or not value:
        return None
    candidate = value.strip()
    # Python's fromisoformat accepts `+00:00` natively; pre-3.11 lacks the
    # `Z` suffix shortcut, so we normalize manually for cross-version
    # compatibility.
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        # Naive timestamps would silently behave like local time; reject.
        return None
    if parsed.utcoffset() != _UTC_ZERO_OFFSET:
        return None
    return parsed


def parse_heartbeat_file(
    path: Path,
    *,
    now: datetime,
    threshold_seconds: float,
) -> HeartbeatRecord:
    """Parse one heartbeat record. ``now`` is the wall-clock reference for
    staleness; the caller passes a single value so every record in a sweep
    is judged against the same instant.

    The function NEVER raises -- every error path is captured in the
    record's ``failures`` list so a single malformed record cannot abort
    the whole sweep. This matches the philosophy of
    ``scripts/swarm_verify_review_clean.py``: a stalled / corrupt agent
    is information the monitor needs to surface, not a fatal condition.
    """
    rec = HeartbeatRecord(
        path=str(path),
        agent_id=None,
        parent_id=None,
        last_heartbeat_at_iso=None,
        last_heartbeat_at=None,
        last_message=None,
        phase=None,
        terminal_state=None,
        pr_number=None,
        age_seconds=None,
        is_terminal=False,
        is_stale=False,
    )

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        rec.failures.append(f"unreadable: {exc}")
        return rec

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        rec.failures.append(f"malformed JSON: {exc.msg} at line {exc.lineno}")
        return rec

    if not isinstance(payload, dict):
        rec.failures.append(
            f"top-level must be a JSON object, got {type(payload).__name__}"
        )
        return rec

    # Required field presence check. Collect ALL missing fields so the
    # operator sees the full gap in one diagnostic rather than a
    # cascade of single-field reruns.
    missing = [f for f in REQUIRED_FIELDS if f not in payload]
    if missing:
        rec.failures.append(f"missing required field(s): {', '.join(missing)}")

    # Required-field TYPE check. The presence check above only tests that
    # the key exists (`f not in payload`), so a payload like
    # ``{"last_heartbeat_at": null, ...}`` or
    # ``{"last_heartbeat_at": 1716906470, ...}`` passes the presence gate
    # while the downstream ``isinstance(..., str)`` guards silently skip
    # the field assignment WITHOUT recording a failure. The record's
    # ``.ok`` then evaluates to True and the monitor reports ALL ALIVE
    # for an agent whose timestamp / id / phase is structurally invalid.
    # Surface the type gap explicitly so writers cannot silently emit a
    # broken record (Greptile review, #1365). All five REQUIRED_FIELDS
    # are declared as strings in docs/subagent-heartbeat.md, so a
    # non-string value is a schema violation regardless of which field.
    wrong_type = [
        f for f in REQUIRED_FIELDS
        if f in payload and not isinstance(payload[f], str)
    ]
    if wrong_type:
        types = ", ".join(
            f"{f}={type(payload[f]).__name__}" for f in wrong_type
        )
        rec.failures.append(
            f"required field(s) must be string, got: {types}"
        )

    # Populate fields opportunistically even when malformed -- the operator
    # benefits from seeing whatever partial state is present (e.g. agent_id
    # parsed but timestamp invalid).
    if isinstance(payload.get("agent_id"), str):
        rec.agent_id = payload["agent_id"]
    if isinstance(payload.get("parent_id"), str):
        rec.parent_id = payload["parent_id"]
    if isinstance(payload.get("last_message"), str):
        rec.last_message = payload["last_message"]
    if isinstance(payload.get("phase"), str):
        rec.phase = payload["phase"]
    if isinstance(payload.get("terminal_state"), str):
        rec.terminal_state = payload["terminal_state"]
    pr_num = payload.get("pr_number")
    if isinstance(pr_num, int):
        rec.pr_number = pr_num

    # Identity cross-check: the filename (sans .json) MUST match agent_id
    # per docs/subagent-heartbeat.md. A mismatch surfaces a stale file
    # left behind by a renamed agent.
    expected_id = path.stem
    if rec.agent_id is not None and rec.agent_id != expected_id:
        rec.failures.append(
            f"agent_id mismatch: file is '{expected_id}.json' but payload has "
            f"agent_id={rec.agent_id!r}"
        )

    # Timestamp parse + staleness eval.
    ts_value = payload.get("last_heartbeat_at")
    if isinstance(ts_value, str):
        rec.last_heartbeat_at_iso = ts_value
        parsed_ts = _parse_iso8601_utc(ts_value)
        if parsed_ts is None:
            rec.failures.append(
                f"last_heartbeat_at not ISO-8601 UTC (must end in 'Z' or "
                f"'+00:00'): {ts_value!r}"
            )
        else:
            rec.last_heartbeat_at = parsed_ts
            rec.age_seconds = (now - parsed_ts).total_seconds()

    # Phase validity check: an unknown phase flags the record as MALFORMED
    # (see CANONICAL_PHASES docstring above for rationale). The contract in
    # docs/subagent-heartbeat.md declares the enum as a hard MUST, so an
    # unknown phase is treated as a writer-side typo, not a forward-compat
    # signal -- the operator fixes the agent writing it.
    if rec.phase is not None and rec.phase not in CANONICAL_PHASES:
        rec.failures.append(
            f"unknown phase {rec.phase!r}; expected one of "
            f"{sorted(CANONICAL_PHASES)}"
        )

    # Terminal-state classification: phase=='terminal' MUST carry a
    # populated terminal_state. The reverse is allowed (an agent MAY
    # populate terminal_state mid-flight if it has decided its exit
    # before writing the final heartbeat).
    if rec.phase == "terminal" and not rec.terminal_state:
        rec.failures.append(
            "phase='terminal' requires a non-empty terminal_state field"
        )
    rec.is_terminal = bool(rec.terminal_state)

    # Staleness: a terminal record is NEVER stale (the agent reached an
    # exit on its own terms). A mid-flight record (terminal_state==None)
    # IS stale if its age exceeds the threshold.
    if (
        rec.age_seconds is not None
        and not rec.is_terminal
        and rec.age_seconds > threshold_seconds
    ):
        rec.is_stale = True

    return rec


# ---------------------------------------------------------------------------
# Sweep + report
# ---------------------------------------------------------------------------


@dataclass
class SweepResult:
    """Aggregate result across one or more scratch directories."""
    scratch_dirs: list[str]
    threshold_minutes: float
    now_iso: str
    records: list[HeartbeatRecord] = field(default_factory=list)
    sweep_errors: list[str] = field(default_factory=list)

    @property
    def all_ok(self) -> bool:
        # An empty scratch dir that EXISTS (no sweep errors, no records)
        # is the canonical "no agents to monitor" state and counts as OK
        # per the docs/subagent-heartbeat.md three-state exit contract:
        # the monitor's job is to surface stale or malformed records, and
        # absence-of-records is neither. A missing scratch dir is a
        # different failure mode (config error, EXIT_EXTERNAL_ERROR)
        # handled upstream in main().
        return not self.sweep_errors and all(r.ok for r in self.records)

    def to_dict(self) -> dict:
        return {
            "scratch_dirs": list(self.scratch_dirs),
            "threshold_minutes": self.threshold_minutes,
            "now": self.now_iso,
            "record_count": len(self.records),
            "stale_count": sum(1 for r in self.records if r.is_stale),
            "malformed_count": sum(1 for r in self.records if r.failures),
            "all_ok": self.all_ok,
            "records": [r.to_dict() for r in self.records],
            "sweep_errors": list(self.sweep_errors),
        }


def sweep_scratch_dirs(
    scratch_dirs: list[Path],
    *,
    threshold_minutes: float,
    now: datetime | None = None,
) -> SweepResult:
    """Walk every scratch dir and parse every ``*.json`` record found there.

    Per-directory failures (missing dir, permission denied) are recorded in
    ``sweep_errors`` so the operator sees the partial picture. Per-record
    failures are captured on the record itself.
    """
    if now is None:
        now = datetime.now(UTC)
    threshold_seconds = threshold_minutes * 60.0

    result = SweepResult(
        scratch_dirs=[str(p) for p in scratch_dirs],
        threshold_minutes=threshold_minutes,
        now_iso=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    )

    for d in scratch_dirs:
        if not d.exists():
            result.sweep_errors.append(f"scratch dir does not exist: {d}")
            continue
        if not d.is_dir():
            result.sweep_errors.append(f"scratch path is not a directory: {d}")
            continue
        try:
            children = sorted(d.glob("*.json"))
        except OSError as exc:
            result.sweep_errors.append(f"scratch dir unreadable {d}: {exc}")
            continue
        for child in children:
            if not child.is_file():
                # Skip directories that happen to end in .json -- rare but
                # cheap to guard against.
                continue
            rec = parse_heartbeat_file(
                child, now=now, threshold_seconds=threshold_seconds
            )
            result.records.append(rec)

    return result


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _format_age(seconds: float | None) -> str:
    if seconds is None:
        return "<unknown>"
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes = seconds / 60.0
    if minutes < 60:
        return f"{minutes:.1f}m"
    hours = minutes / 60.0
    return f"{hours:.1f}h"


def render_text(result: SweepResult) -> str:
    """Pretty-print the sweep verdict for human consumers."""
    lines: list[str] = []
    n = len(result.records)
    lines.append(
        f"Sub-agent heartbeat sweep ({n} record{'s' if n != 1 else ''}, "
        f"threshold {result.threshold_minutes:g} min, now={result.now_iso})"
    )
    for d in result.scratch_dirs:
        lines.append(f"  Scratch dir: {d}")
    if result.sweep_errors:
        lines.append("  Sweep errors:")
        for err in result.sweep_errors:
            lines.append(f"    [!] {err}")
    if not result.records and not result.sweep_errors:
        lines.append("")
        lines.append("  No heartbeat records found (empty scratch dir).")
    for rec in result.records:
        if rec.failures and rec.is_stale:
            status = "STALE+MALFORMED"
        elif rec.failures:
            status = "MALFORMED"
        elif rec.is_stale:
            status = "STALE"
        elif rec.is_terminal:
            status = "TERMINAL"
        else:
            status = "OK"
        agent = rec.agent_id or Path(rec.path).stem
        lines.append("")
        lines.append(f"  {agent} -- {status}")
        lines.append(f"    Path:               {rec.path}")
        lines.append(f"    Parent:             {rec.parent_id or '<unset>'}")
        lines.append(
            f"    Last heartbeat:     {rec.last_heartbeat_at_iso or '<unparsed>'} "
            f"(age {_format_age(rec.age_seconds)})"
        )
        lines.append(f"    Phase:              {rec.phase or '<unset>'}")
        if rec.pr_number is not None:
            lines.append(f"    PR:                 #{rec.pr_number}")
        if rec.terminal_state:
            lines.append(f"    Terminal state:     {rec.terminal_state}")
        if rec.last_message:
            lines.append(f"    Last message:       {rec.last_message}")
        for i, fail in enumerate(rec.failures, 1):
            lines.append(f"      [{i}] {fail}")
    lines.append("")
    if not result.records and not result.sweep_errors:
        lines.append(
            "Result: NO AGENTS TO MONITOR -- empty scratch dir (no stale state)"
        )
    elif result.all_ok:
        lines.append(
            "Result: ALL AGENTS ALIVE -- no stale or malformed records"
        )
    else:
        stale = sum(1 for r in result.records if r.is_stale)
        malformed = sum(1 for r in result.records if r.failures)
        dir_errors = len(result.sweep_errors)
        # When the only blocker is a directory-load failure but every
        # record present is healthy, surface that as a CONFIG remediation
        # rather than "re-dispatch stalled agents" -- the misleading
        # phrasing was flagged on the #1375 review (the previous
        # ``ATTENTION -- 0 stale, 0 malformed`` line pushed the operator
        # at the wrong fix surface; the real action is to verify the
        # scratch-dir paths). The two failure modes -- agents-actually-
        # stale-or-malformed vs scratch-dir-unreadable -- now produce
        # distinct, actionable summary lines.
        if dir_errors and not stale and not malformed:
            healthy = len(result.records)
            lines.append(
                f"Result: ATTENTION -- {dir_errors} scratch dir "
                f"error(s); {healthy} record(s) healthy. Verify each "
                f"--scratch-dir path; correct the misconfigured or "
                f"missing directories surfaced above."
            )
        else:
            dir_tail = (
                f", {dir_errors} scratch dir error(s)" if dir_errors else ""
            )
            lines.append(
                f"Result: ATTENTION -- {stale} stale, {malformed} "
                f"malformed record(s){dir_tail}. Inspect diagnostics "
                f"above and either re-dispatch the stalled agent(s) "
                f"or take over manually."
            )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _default_scratch_dir() -> Path:
    """Default scratch dir = ``<cwd>/.deft-scratch/subagent-status``.

    The monitor runs from the parent's working directory (typically the
    swarm root) and inspects that root's scratch dir. For multi-worktree
    setups, the operator passes ``--scratch-dir`` explicitly per worktree.
    """
    return Path.cwd() / ".deft-scratch" / "subagent-status"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="subagent_monitor",
        description=(
            "Sub-agent heartbeat watcher (#1365). Walks one or more "
            ".deft-scratch/subagent-status/ directories and reports the "
            "liveness of every heartbeat record. Three-state exit: 0 ok, "
            "1 stale or malformed, 2 config error."
        ),
    )
    parser.add_argument(
        "--scratch-dir",
        dest="scratch_dirs",
        action="append",
        default=[],
        metavar="PATH",
        help=(
            "Path to a .deft-scratch/subagent-status/ directory. May be "
            "passed multiple times (one per agent worktree). Defaults to "
            "<cwd>/.deft-scratch/subagent-status when omitted."
        ),
    )
    parser.add_argument(
        "--threshold-minutes",
        dest="threshold_minutes",
        type=float,
        default=DEFAULT_THRESHOLD_MINUTES,
        metavar="N",
        help=(
            f"Staleness threshold in minutes. Records older than this whose "
            f"terminal_state is empty are flagged STALE. Default: "
            f"{DEFAULT_THRESHOLD_MINUTES}."
        ),
    )
    parser.add_argument(
        "--json",
        dest="emit_json",
        action="store_true",
        help="Emit the sweep result as a single JSON object on stdout.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.threshold_minutes <= 0:
        print(
            f"Error: --threshold-minutes must be positive, got "
            f"{args.threshold_minutes}",
            file=sys.stderr,
        )
        return EXIT_EXTERNAL_ERROR

    scratch_paths: list[Path] = (
        [Path(p) for p in args.scratch_dirs]
        if args.scratch_dirs
        else [_default_scratch_dir()]
    )

    result = sweep_scratch_dirs(
        scratch_paths,
        threshold_minutes=args.threshold_minutes,
    )

    # If the operator pointed at one or more scratch dirs that do not
    # exist AND we found no records at all, that's a config error
    # distinct from "the scratch dir exists but is empty" (which is
    # also non-zero but a different message). Both routes return
    # EXIT_EXTERNAL_ERROR so a missing-scratch-dir setup does not
    # silently masquerade as "all agents alive".
    config_error = (
        bool(result.sweep_errors)
        and not result.records
    )

    if args.emit_json:
        print(json.dumps(result.to_dict(), indent=2))
    else:
        print(render_text(result))

    if config_error:
        return EXIT_EXTERNAL_ERROR
    if result.all_ok:
        return EXIT_OK
    return EXIT_STALE


if __name__ == "__main__":
    sys.exit(main())
