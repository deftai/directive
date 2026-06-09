#!/usr/bin/env python3
"""probe_session.py -- mechanical guard for probe artifact handoff (#1518c).

Records whether a probe session is still interrogating or ready for artifact
registration. Callers MUST invoke the guard helpers before writing probe output
or updating ``completedStrategies`` for ``"probe"`` in ``plan.vbrief.json``.

Session state lives at ``.deft/probe-session.json`` (gitignored, per-clone).

Exit codes (CLI):
  0 -- success
  1 -- handoff blocked (interrogation still active)
  2 -- usage / config error

Usage:
    uv run python scripts/probe_session.py start --target <scope> [--branch <decision-branch>]
    uv run python scripts/probe_session.py record --question ... --answer ... --status locked
    uv run python scripts/probe_session.py set-branch --branch <decision-branch>
    uv run python scripts/probe_session.py complete
    uv run python scripts/probe_session.py status [--json]
    uv run python scripts/probe_session.py guard-artifact --path <artifact-path>
    uv run python scripts/probe_session.py guard-plan-registration

Refs #1518 recommendation C.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

SCHEMA_VERSION: int = 1
SESSION_RELPATH: tuple[str, str] = (".deft", "probe-session.json")

STATE_INTERROGATE: Literal["interrogate"] = "interrogate"
STATE_COMPLETE: Literal["complete"] = "complete"
ProbeState = Literal["interrogate", "complete"]

VALID_DECISION_STATUSES = frozenset({"locked", "deferred", "risk-accepted"})


class ProbeHandoffBlockedError(Exception):
    """Raised when probe artifacts or plan registration are attempted too early."""

    def __init__(self, message: str, *, session: ProbeSession | None = None) -> None:
        super().__init__(message)
        self.session = session


@dataclass(frozen=True)
class ResolvedDecision:
    question: str
    answer: str
    status: str

    def to_dict(self) -> dict[str, str]:
        return {
            "question": self.question,
            "answer": self.answer,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, raw: object) -> ResolvedDecision | None:
        if not isinstance(raw, dict):
            return None
        question = raw.get("question")
        answer = raw.get("answer")
        status = raw.get("status")
        if not all(isinstance(v, str) and v.strip() for v in (question, answer, status)):
            return None
        if status not in VALID_DECISION_STATUSES:
            return None
        return cls(question=question.strip(), answer=answer.strip(), status=status.strip())


@dataclass(frozen=True)
class ProbeSession:
    schema_version: int
    state: ProbeState
    target: str
    current_branch: str
    resolved_decisions: tuple[ResolvedDecision, ...]
    started_at: datetime
    completed_at: datetime | None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schemaVersion": self.schema_version,
            "state": self.state,
            "target": self.target,
            "currentBranch": self.current_branch,
            "resolvedDecisions": [d.to_dict() for d in self.resolved_decisions],
            "startedAt": _format_timestamp(self.started_at),
        }
        if self.completed_at is not None:
            payload["completedAt"] = _format_timestamp(self.completed_at)
        return payload


def _session_path(project_root: Path) -> Path:
    return project_root.joinpath(*SESSION_RELPATH)


def _format_timestamp(value: datetime) -> str:
    instant = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return instant.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_timestamp(raw: object) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    normalised = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalised)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def _detect_git_branch(project_root: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "--short", "HEAD"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    if result.returncode == 0:
        branch = (result.stdout or "").strip()
        if branch:
            return branch
    try:
        rev_result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    if rev_result.returncode == 0:
        sha = (rev_result.stdout or "").strip()
        if sha:
            return f"detached:{sha}"
    return ""


def read(project_root: Path) -> ProbeSession | None:
    """Read ``.deft/probe-session.json`` from ``project_root``."""
    session_file = _session_path(project_root)
    if not session_file.is_file():
        return None
    try:
        payload = json.loads(session_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("schemaVersion") != SCHEMA_VERSION:
        return None
    state = payload.get("state")
    if state not in (STATE_INTERROGATE, STATE_COMPLETE):
        return None
    target = payload.get("target")
    current_branch = payload.get("currentBranch")
    if not isinstance(target, str) or not target.strip():
        return None
    if not isinstance(current_branch, str):
        return None
    started_at = _parse_timestamp(payload.get("startedAt"))
    if started_at is None:
        return None
    completed_at = _parse_timestamp(payload.get("completedAt"))
    if state == STATE_COMPLETE and completed_at is None:
        return None
    if state == STATE_INTERROGATE and completed_at is not None:
        return None
    raw_decisions = payload.get("resolvedDecisions")
    if not isinstance(raw_decisions, list):
        return None
    decisions: list[ResolvedDecision] = []
    for item in raw_decisions:
        parsed = ResolvedDecision.from_dict(item)
        if parsed is None:
            return None
        decisions.append(parsed)
    return ProbeSession(
        schema_version=SCHEMA_VERSION,
        state=state,
        target=target.strip(),
        current_branch=current_branch.strip(),
        resolved_decisions=tuple(decisions),
        started_at=started_at,
        completed_at=completed_at,
    )


def write(project_root: Path, session: ProbeSession) -> Path:
    """Atomically persist ``session`` to ``.deft/probe-session.json``."""
    session_file = _session_path(project_root)
    session_file.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_name = tempfile.mkstemp(
        prefix=".probe-session.",
        suffix=".json.tmp",
        dir=str(session_file.parent),
    )
    fdopen_succeeded = False
    try:
        fh = os.fdopen(tmp_fd, "w", encoding="utf-8", newline="\n")
        fdopen_succeeded = True
        try:
            json.dump(session.to_dict(), fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            with contextlib.suppress(OSError):
                os.fsync(fh.fileno())
        finally:
            fh.close()
        os.replace(tmp_name, session_file)
    except Exception:
        if not fdopen_succeeded:
            with contextlib.suppress(OSError):
                os.close(tmp_fd)
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise
    return session_file


def start_session(
    project_root: Path,
    *,
    target: str,
    current_branch: str = "",
    now: datetime | None = None,
) -> ProbeSession:
    """Start (or replace) an interrogating probe session for ``target``."""
    scope = target.strip()
    if not scope:
        raise ValueError("target must be a non-empty scope name")
    branch = current_branch.strip() or _detect_git_branch(project_root)
    instant = now if now is not None else datetime.now(UTC)
    session = ProbeSession(
        schema_version=SCHEMA_VERSION,
        state=STATE_INTERROGATE,
        target=scope,
        current_branch=branch,
        resolved_decisions=(),
        started_at=instant,
        completed_at=None,
    )
    write(project_root, session)
    return session


def record_decision(
    project_root: Path,
    *,
    question: str,
    answer: str,
    status: str,
) -> ProbeSession:
    """Append a resolved decision while the session is interrogating."""
    session = read(project_root)
    if session is None:
        raise ProbeHandoffBlockedError(
            "No active probe session. Start one with "
            "`uv run python scripts/probe_session.py start --target <scope>`."
        )
    if session.state != STATE_INTERROGATE:
        raise ProbeHandoffBlockedError(
            "Probe session is already complete; decisions cannot be appended.",
            session=session,
        )
    if status not in VALID_DECISION_STATUSES:
        raise ValueError(
            f"status must be one of {sorted(VALID_DECISION_STATUSES)}, got {status!r}"
        )
    q = question.strip()
    a = answer.strip()
    if not q or not a:
        raise ValueError("question and answer must be non-empty strings")
    updated = ProbeSession(
        schema_version=session.schema_version,
        state=session.state,
        target=session.target,
        current_branch=session.current_branch,
        resolved_decisions=session.resolved_decisions + (
            ResolvedDecision(question=q, answer=a, status=status),
        ),
        started_at=session.started_at,
        completed_at=session.completed_at,
    )
    write(project_root, updated)
    return updated


def set_current_branch(project_root: Path, branch: str) -> ProbeSession:
    """Update the decision branch currently under interrogation."""
    session = read(project_root)
    if session is None:
        raise ProbeHandoffBlockedError(
            "No active probe session. Start one with "
            "`uv run python scripts/probe_session.py start --target <scope>`."
        )
    if session.state != STATE_INTERROGATE:
        raise ProbeHandoffBlockedError(
            "Probe session is already complete; current branch cannot change.",
            session=session,
        )
    updated = ProbeSession(
        schema_version=session.schema_version,
        state=session.state,
        target=session.target,
        current_branch=branch.strip(),
        resolved_decisions=session.resolved_decisions,
        started_at=session.started_at,
        completed_at=session.completed_at,
    )
    write(project_root, updated)
    return updated


def mark_complete(project_root: Path, *, now: datetime | None = None) -> ProbeSession:
    """Mark the active probe session complete so artifact handoff is allowed."""
    session = read(project_root)
    if session is None:
        raise ProbeHandoffBlockedError(
            "No active probe session. Start one with "
            "`uv run python scripts/probe_session.py start --target <scope>`."
        )
    if session.state == STATE_COMPLETE:
        return session
    instant = now if now is not None else datetime.now(UTC)
    updated = ProbeSession(
        schema_version=session.schema_version,
        state=STATE_COMPLETE,
        target=session.target,
        current_branch=session.current_branch,
        resolved_decisions=session.resolved_decisions,
        started_at=session.started_at,
        completed_at=instant,
    )
    write(project_root, updated)
    return updated


def _blocked_message(session: ProbeSession | None, action: str) -> str:
    if session is None:
        return (
            f"Probe handoff blocked for {action}: no active probe session. "
            "Start interrogation with "
            "`uv run python scripts/probe_session.py start --target <scope>` "
            "and finish with `... complete` only after transition criteria are met."
        )
    return (
        f"Probe handoff blocked for {action}: session state is "
        f"'{session.state}' (target={session.target!r}, "
        f"currentBranch={session.current_branch!r}, "
        f"resolvedDecisions={len(session.resolved_decisions)}). "
        "Continue interrogation until transition criteria are met, record decisions "
        "with `uv run python scripts/probe_session.py record ...`, then run "
        "`uv run python scripts/probe_session.py complete` before writing artifacts "
        "or updating completedStrategies.probe in plan.vbrief.json."
    )


def require_handoff_allowed(project_root: Path, *, action: str) -> ProbeSession:
    """Return the session when handoff is allowed; raise otherwise."""
    session = read(project_root)
    if session is None or session.state != STATE_COMPLETE:
        raise ProbeHandoffBlockedError(_blocked_message(session, action), session=session)
    return session


def guard_probe_artifact(project_root: Path, artifact_path: str) -> ProbeSession:
    """Guard writing a probe scope vBRIEF artifact."""
    action = f"probe artifact write ({artifact_path})"
    return require_handoff_allowed(project_root, action=action)


def guard_plan_probe_registration(project_root: Path) -> ProbeSession:
    """Guard updating completedStrategies.probe in plan.vbrief.json."""
    return require_handoff_allowed(
        project_root,
        action="completedStrategies.probe registration in plan.vbrief.json",
    )


def session_summary(session: ProbeSession) -> dict[str, Any]:
    """JSON-serialisable summary for CLI status output."""
    return {
        "state": session.state,
        "target": session.target,
        "currentBranch": session.current_branch,
        "resolvedDecisions": [d.to_dict() for d in session.resolved_decisions],
        "startedAt": _format_timestamp(session.started_at),
        "completedAt": (
            _format_timestamp(session.completed_at) if session.completed_at is not None else None
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Mechanical guard for probe session state and artifact handoff."
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path("."),
        help="Project root containing .deft/ (default: cwd)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    start_parser = subparsers.add_parser("start", help="Start an interrogating probe session")
    start_parser.add_argument("--target", required=True, help="Probe scope / feature slug")
    start_parser.add_argument(
        "--branch",
        default="",
        help="Decision branch under interrogation (defaults to git branch)",
    )

    record_parser = subparsers.add_parser("record", help="Record a resolved decision")
    record_parser.add_argument("--question", required=True)
    record_parser.add_argument("--answer", required=True)
    record_parser.add_argument(
        "--status",
        required=True,
        choices=sorted(VALID_DECISION_STATUSES),
    )

    branch_parser = subparsers.add_parser(
        "set-branch",
        help="Update the decision branch under interrogation",
    )
    branch_parser.add_argument("--branch", required=True)

    subparsers.add_parser("complete", help="Mark the probe session complete")
    status_parser = subparsers.add_parser("status", help="Show current probe session state")
    status_parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")

    guard_artifact_parser = subparsers.add_parser(
        "guard-artifact",
        help="Fail unless probe artifact handoff is allowed",
    )
    guard_artifact_parser.add_argument(
        "--path",
        required=True,
        help="Probe artifact path (e.g. vbrief/proposed/my-app-probe.vbrief.json)",
    )

    subparsers.add_parser(
        "guard-plan-registration",
        help="Fail unless completedStrategies.probe registration is allowed",
    )

    args = parser.parse_args(argv)
    project_root = args.project_root.resolve()

    try:
        if args.command == "start":
            session = start_session(project_root, target=args.target, current_branch=args.branch)
            print(
                f"Probe session started: state={session.state}, target={session.target!r}, "
                f"currentBranch={session.current_branch!r}"
            )
            return 0
        if args.command == "record":
            session = record_decision(
                project_root,
                question=args.question,
                answer=args.answer,
                status=args.status,
            )
            print(
                f"Recorded decision ({len(session.resolved_decisions)} total); "
                f"state={session.state}"
            )
            return 0
        if args.command == "set-branch":
            session = set_current_branch(project_root, args.branch)
            print(f"Current branch set to {session.current_branch!r}; state={session.state}")
            return 0
        if args.command == "complete":
            session = mark_complete(project_root)
            print(f"Probe session marked complete for target={session.target!r}")
            return 0
        if args.command == "status":
            session = read(project_root)
            if session is None:
                print("No active probe session.")
                return 0
            if args.json:
                print(json.dumps(session_summary(session), indent=2, sort_keys=True))
            else:
                summary = session_summary(session)
                print(f"state: {summary['state']}")
                print(f"target: {summary['target']}")
                print(f"currentBranch: {summary['currentBranch']}")
                print(f"resolvedDecisions: {len(summary['resolvedDecisions'])}")
            return 0
        if args.command == "guard-artifact":
            guard_probe_artifact(project_root, args.path)
            print(f"Probe artifact handoff allowed: {args.path}")
            return 0
        if args.command == "guard-plan-registration":
            guard_plan_probe_registration(project_root)
            print("completedStrategies.probe registration allowed")
            return 0
    except ProbeHandoffBlockedError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    print(f"Unknown command: {args.command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
