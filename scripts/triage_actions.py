#!/usr/bin/env python3
"""triage_actions.py -- per-issue triage decision commands (#845 Story 3).

Provides eight commands consumed via ``tasks/triage-actions.yml``:

- ``accept(n, repo)`` -- record an accept audit entry.
- ``reject(n, repo, reason)`` -- close the upstream GitHub issue with
  ``gh issue close <n> --comment <reason> --reason 'not planned'``, apply the
  ``triage-rejected`` label, and record a reject audit entry. If the upstream
  ``gh`` call fails, the audit entry is ROLLED BACK so the log never references
  a decision that did not actually take effect.
- ``defer(n, repo)`` -- record a defer audit entry.
- ``needs_ac(n, repo)`` -- record a needs-ac audit entry and post an
  AC-request comment on the upstream issue.
- ``mark_duplicate(n, repo, of_n)`` -- validate ``of_n`` exists in the local
  cache (Story 1) and record a mark-duplicate audit entry pointing at it.
- ``status(n, repo)`` -- return the latest decision for ``n`` (None if none).
- ``reset(n, repo)`` -- record a ``reset`` audit entry referencing the prior
  decision id. History is NEVER deleted; reset is the reversible exit.
- ``history(n, repo)`` -- return all audit entries for ``n`` ordered by
  timestamp.

All actions are idempotent on already-final state: invoking ``reject`` on an
already-rejected issue is a no-op (returns the existing ``decision_id``) and
does NOT re-call ``gh issue close`` nor re-write the audit log.

Upstream contracts (frozen public surfaces of Story 1 + Story 2):

- ``scripts.candidates_log.append(entry: dict) -> str`` (decision_id)
- ``scripts.candidates_log.latest_decision(issue_number: int, repo: str) -> dict | None``
- ``scripts.candidates_log.find_by_issue(issue_number: int, repo: str) -> list[dict]``
- ``scripts.triage_cache.show(issue_number: int, repo: str) -> str``

Story 1 + Story 2 PRs may not be merged when this script lands. Module-level
``candidates_log`` and ``triage_cache`` references are therefore guarded with
``try / except ImportError`` so the module imports cleanly. Tests substitute
fakes via ``monkeypatch.setattr(triage_actions, "candidates_log", ...)``.

Per ``conventions/task-caching.md`` the Taskfile fragment must NOT cache the
``cmds:`` block: every action accepts user-facing flags via ``{{.CLI_ARGS}}``.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

# Make sibling scripts importable when invoked from the project root or via
# ``uv run python scripts/triage_actions.py``. Mirrors the pattern in
# ``scripts/policy_set.py`` so we can do ``import candidates_log``.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Public, frozen interfaces from Story 1 + Story 2. These imports may fail in
# this PR's branch because Story 1 / Story 2 may not be merged yet -- the
# module attributes are then ``None`` and tests substitute a fake. Production
# bootstrap (Story 6) lands all three together so the runtime path is intact.
try:  # pragma: no cover -- exercised once Story 2 lands.
    import candidates_log  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    candidates_log = None  # type: ignore[assignment]

try:  # pragma: no cover -- exercised once Story 1 lands.
    import triage_cache  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    triage_cache = None  # type: ignore[assignment]


# Public constants ----------------------------------------------------------

#: Project-relative path of the audit log written by Story 2's ``append``
#: (canonical location frozen in the Story 2 vBRIEF). Used ONLY by
#: :func:`_rollback_audit_entry` -- the normal write path goes through
#: ``candidates_log.append``.
AUDIT_LOG_REL_PATH = "vbrief/.eval/candidates.jsonl"

#: Label applied to a rejected upstream issue alongside ``gh issue close``.
REJECTED_LABEL = "triage-rejected"

#: Decision values we treat as terminal for idempotency purposes. Repeating
#: the SAME terminal decision against an issue already in that state is a
#: no-op (returns the prior decision_id, no audit / no upstream call).
_TERMINAL_DECISIONS = frozenset({"accept", "reject", "mark-duplicate"})

#: Default ``actor`` string when callers do not specify one.
_DEFAULT_ACTOR = "agent:triage"


def _now_iso() -> str:
    """Return an ISO-8601 UTC timestamp with the canonical ``Z`` suffix.

    Story 2's audit-log schema regex is ``\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}
    (\\.\\d+)?Z`` -- microseconds are accepted but we omit them so the on-disk
    string is easy to grep. Defined as a module-level callable so tests can
    monkeypatch it for deterministic, strictly-monotonic timestamps.
    """
    return _dt.datetime.now(_dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_decision_id() -> str:
    """Generate a fresh UUID4 string for a new audit entry.

    Defers to ``candidates_log.new_decision_id()`` when the upstream module is
    importable so a future swap to UUID7 (time-ordered) is a one-file change.
    Falls back to ``uuid.uuid4()`` so this module remains self-contained when
    Story 2 is not yet on the branch (tests substitute a fake module anyway).
    """
    if candidates_log is not None and hasattr(candidates_log, "new_decision_id"):
        return str(candidates_log.new_decision_id())
    return str(uuid.uuid4())


class TriageError(RuntimeError):
    """Raised when an action cannot complete (e.g. mark-duplicate target missing)."""


class UpstreamCloseError(TriageError):
    """``gh issue close`` failed. The companion audit entry has been rolled back."""


# Helpers -------------------------------------------------------------------


def _audit_log_path(project_root: Path | None = None) -> Path:
    """Resolve the absolute path of the candidates audit log."""
    root = project_root or Path.cwd()
    return root / AUDIT_LOG_REL_PATH


def _resolve_actor(actor: str | None) -> str:
    """Default the actor to the local user identity, falling back to a marker."""
    if actor:
        return actor
    return os.environ.get("USER") or os.environ.get("USERNAME") or _DEFAULT_ACTOR


def _require_log() -> Any:
    """Return the live ``candidates_log`` module or raise if Story 2 is missing."""
    if candidates_log is None:
        raise TriageError(
            "scripts/candidates_log.py is not available in this checkout. "
            "Story 2 (#845) must land or this PR must be rebased onto master."
        )
    return candidates_log


def _require_cache() -> Any:
    """Return the live ``triage_cache`` module or raise if Story 1 is missing."""
    if triage_cache is None:
        raise TriageError(
            "scripts/triage_cache.py is not available in this checkout. "
            "Story 1 (#845) must land or this PR must be rebased onto master."
        )
    return triage_cache


def _run_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
    """Wrapper around ``gh`` so tests can patch a single seam.

    Raises ``UpstreamCloseError`` on non-zero exit so callers can roll back.
    """
    try:
        return subprocess.run(
            ["gh", *args],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise UpstreamCloseError(f"gh CLI not found on PATH: {exc}") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        raise UpstreamCloseError(f"gh {' '.join(args)} failed: {stderr}") from exc


def _rollback_audit_entry(decision_id: str, project_root: Path | None = None) -> bool:
    """Remove the audit-log line whose JSON ``decision_id`` matches.

    Story 2 documents an append-only contract for the normal flow; the
    rollback path is the explicit exceptional surface defined by the Story 3
    vBRIEF Constraint narrative ("On reject upstream-close failure, ROLL
    BACK the audit entry").

    The read+filter+rewrite cycle MUST be serialised against
    ``candidates_log.append`` -- otherwise a concurrent appender (e.g.
    Story 4 bulk ops) that commits between our ``open("r")`` and our
    ``write_text`` is silently clobbered, breaking the append-only
    guarantee for unrelated entries (Greptile #879 P1). We therefore
    acquire Story 2's own advisory lock primitive
    (``candidates_log._append_lock``) for the duration of the rewrite.
    The leading underscore is acknowledged: the alternative -- recreating
    the lock-file + msvcrt / fcntl dance from scratch here -- duplicates
    the cross-platform code path that Story 2 already encodes correctly.

    Returns True if a line was removed.
    """
    path = _audit_log_path(project_root)
    if not path.is_file():
        return False

    if candidates_log is not None and hasattr(candidates_log, "_append_lock"):
        lock_ctx = candidates_log._append_lock(path)
    else:
        lock_ctx = contextlib.nullcontext()

    kept: list[str] = []
    removed = False
    with lock_ctx:
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                stripped = raw.strip()
                if not stripped:
                    continue
                try:
                    entry = json.loads(stripped)
                except json.JSONDecodeError:
                    # Preserve malformed lines verbatim (Story 2 read tolerates them).
                    kept.append(raw if raw.endswith("\n") else raw + "\n")
                    continue
                if not removed and entry.get("decision_id") == decision_id:
                    removed = True
                    continue
                kept.append(raw if raw.endswith("\n") else raw + "\n")
        if removed:
            path.write_text("".join(kept), encoding="utf-8")
    return removed


def _build_entry(
    decision: str,
    issue_number: int,
    repo: str,
    *,
    actor: str,
    reason: str | None = None,
    linked_to: int | None = None,
    prior_decision_id: str | None = None,
) -> dict[str, Any]:
    """Construct an audit-log entry that satisfies the Story 2 schema.

    The Story 2 ``candidates_log.append`` is a strict validator: it does NOT
    fill in ``decision_id`` / ``timestamp`` for the caller. We generate both
    here (using :func:`_new_decision_id` and :func:`_now_iso`) so every code
    path that lands an audit entry produces a valid record.
    """
    entry: dict[str, Any] = {
        "decision_id": _new_decision_id(),
        "timestamp": _now_iso(),
        "repo": repo,
        "issue_number": int(issue_number),
        "decision": decision,
        "actor": actor,
    }
    if reason is not None:
        entry["reason"] = reason
    if linked_to is not None:
        entry["linked_to"] = int(linked_to)
    if prior_decision_id is not None:
        entry["prior_decision_id"] = prior_decision_id
    return entry


def _is_idempotent_repeat(
    n: int, repo: str, decision: str, *, linked_to: int | None = None
) -> dict | None:
    """Return the prior entry if the requested action is a no-op."""
    if decision not in _TERMINAL_DECISIONS:
        return None
    log = _require_log()
    prior = log.latest_decision(n, repo)
    if prior is None:
        return None
    if prior.get("decision") != decision:
        return None
    # mark-duplicate idempotency requires the SAME target.
    if decision == "mark-duplicate" and prior.get("linked_to") != linked_to:
        return None
    return prior


# Public action surface ----------------------------------------------------


def accept(
    n: int,
    repo: str,
    *,
    actor: str | None = None,
    project_root: Path | None = None,
) -> str:
    """Record an accept audit entry. Idempotent on already-accepted state."""
    actor_str = _resolve_actor(actor)
    prior = _is_idempotent_repeat(n, repo, "accept")
    if prior is not None:
        return str(prior["decision_id"])
    log = _require_log()
    entry = _build_entry("accept", n, repo, actor=actor_str)
    return str(log.append(entry))


def reject(
    n: int,
    repo: str,
    reason: str,
    *,
    actor: str | None = None,
    project_root: Path | None = None,
) -> str:
    """Close upstream + label + record. Roll the audit entry back on gh failure.

    Performs (in order):

    1. Idempotency check -- if the issue is already rejected, return the
       prior decision_id without re-calling gh.
    2. Append the audit entry, capturing ``decision_id``.
    3. ``gh issue close <n> --comment <reason> --reason 'not planned'``.
    4. ``gh issue edit <n> --add-label triage-rejected``.
    5. On step 3 OR step 4 failure: roll back the audit entry from the JSONL
       (per Story 3 vBRIEF Constraint) and re-raise as
       :class:`UpstreamCloseError`.
    """
    actor_str = _resolve_actor(actor)
    prior = _is_idempotent_repeat(n, repo, "reject")
    if prior is not None:
        return str(prior["decision_id"])
    log = _require_log()
    entry = _build_entry("reject", n, repo, actor=actor_str, reason=reason)
    decision_id = str(log.append(entry))
    try:
        _run_gh(
            [
                "issue",
                "close",
                str(n),
                "--repo",
                repo,
                "--comment",
                reason,
                "--reason",
                "not planned",
            ]
        )
        _run_gh(
            [
                "issue",
                "edit",
                str(n),
                "--repo",
                repo,
                "--add-label",
                REJECTED_LABEL,
            ]
        )
    except UpstreamCloseError:
        _rollback_audit_entry(decision_id, project_root=project_root)
        raise
    return decision_id


def defer(
    n: int,
    repo: str,
    *,
    actor: str | None = None,
    project_root: Path | None = None,
) -> str:
    """Record a defer audit entry."""
    log = _require_log()
    entry = _build_entry("defer", n, repo, actor=_resolve_actor(actor))
    return str(log.append(entry))


def needs_ac(
    n: int,
    repo: str,
    *,
    actor: str | None = None,
    comment: str | None = None,
    project_root: Path | None = None,
) -> str:
    """Record a needs-ac audit entry and post an AC-request comment upstream.

    The audit entry is appended FIRST so the trail records the request even
    if gh comment fails (this is a non-blocking signal -- we tolerate the
    upstream comment post failing without rolling back).
    """
    log = _require_log()
    body = comment or (
        "This issue lacks acceptance criteria. Please add a Test/Acceptance "
        "narrative before this can be triaged. (deft #845)"
    )
    entry = _build_entry("needs-ac", n, repo, actor=_resolve_actor(actor), reason=body)
    decision_id = str(log.append(entry))
    # Best-effort -- the audit entry is the source of truth; a failed
    # upstream comment is surfaced on stderr but does NOT roll back the
    # local trail. Greptile #879 P2: the prior `contextlib.suppress` here
    # contradicted this docstring's "logged" claim by silencing the error
    # entirely; the operator now sees the failure even when we keep the
    # audit entry.
    try:
        _run_gh(["issue", "comment", str(n), "--repo", repo, "--body", body])
    except UpstreamCloseError as exc:
        print(
            f"triage_actions: needs-ac comment not posted for #{n} "
            f"({repo}): {exc}",
            file=sys.stderr,
        )
    return decision_id


def mark_duplicate(
    n: int,
    repo: str,
    of_n: int,
    *,
    actor: str | None = None,
    project_root: Path | None = None,
) -> str:
    """Validate target exists in cache + record mark-duplicate audit entry."""
    if int(of_n) == int(n):
        raise TriageError(f"mark-duplicate target #{of_n} cannot equal source #{n}")
    cache = _require_cache()
    try:
        cache.show(int(of_n), repo)
    except Exception as exc:  # noqa: BLE001 -- cache may raise any error type
        raise TriageError(
            f"mark-duplicate target #{of_n} not found in cache for {repo}: {exc}"
        ) from exc
    prior = _is_idempotent_repeat(n, repo, "mark-duplicate", linked_to=int(of_n))
    if prior is not None:
        return str(prior["decision_id"])
    log = _require_log()
    entry = _build_entry(
        "mark-duplicate",
        n,
        repo,
        actor=_resolve_actor(actor),
        linked_to=int(of_n),
    )
    return str(log.append(entry))


def status(n: int, repo: str) -> dict | None:
    """Return the latest decision for ``n`` in ``repo`` (None if none)."""
    log = _require_log()
    return log.latest_decision(n, repo)


def reset(
    n: int,
    repo: str,
    *,
    actor: str | None = None,
    project_root: Path | None = None,
) -> str:
    """Record a reset audit entry referencing the prior decision_id.

    Reset is reversible: it does NOT delete history, it appends a new entry
    of type ``reset`` whose ``prior_decision_id`` is the most recent
    non-reset decision. Re-resetting an already-reset issue is a no-op.
    """
    log = _require_log()
    prior = log.latest_decision(n, repo)
    if prior is None:
        raise TriageError(f"cannot reset #{n}: no prior decision recorded for {repo}")
    if prior.get("decision") == "reset":
        return str(prior["decision_id"])
    entry = _build_entry(
        "reset",
        n,
        repo,
        actor=_resolve_actor(actor),
        prior_decision_id=str(prior["decision_id"]),
    )
    return str(log.append(entry))


def history(n: int, repo: str) -> list[dict]:
    """Return audit entries for ``n`` ordered ascending by timestamp."""
    log = _require_log()
    entries = list(log.find_by_issue(n, repo))
    entries.sort(key=lambda e: str(e.get("timestamp", "")))
    return entries


# CLI plumbing --------------------------------------------------------------


def _format_decision(entry: dict | None) -> str:
    if entry is None:
        return "(no decision recorded)"
    parts = [
        f"decision={entry.get('decision')}",
        f"issue=#{entry.get('issue_number')}",
        f"repo={entry.get('repo')}",
        f"actor={entry.get('actor')}",
        f"timestamp={entry.get('timestamp')}",
        f"decision_id={entry.get('decision_id')}",
    ]
    if entry.get("reason"):
        parts.append(f"reason={entry['reason']!r}")
    if entry.get("linked_to") is not None:
        parts.append(f"linked_to=#{entry['linked_to']}")
    if entry.get("prior_decision_id"):
        parts.append(f"prior_decision_id={entry['prior_decision_id']}")
    return "  " + " | ".join(parts)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="triage_actions.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def _common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--issue", type=int, required=True, help="Issue number (N).")
        p.add_argument("--repo", required=True, help="Upstream repo as owner/name.")
        p.add_argument("--actor", default=None, help="Override the audit actor field.")

    for cmd in ("accept", "defer", "status", "reset", "history"):
        p = sub.add_parser(cmd)
        _common(p)

    p_reject = sub.add_parser("reject")
    _common(p_reject)
    p_reject.add_argument("--reason", required=True)

    p_needs = sub.add_parser("needs-ac")
    _common(p_needs)
    p_needs.add_argument("--comment", default=None)

    p_dup = sub.add_parser("mark-duplicate")
    _common(p_dup)
    p_dup.add_argument("--of", type=int, required=True, dest="of_n")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    n = int(args.issue)
    repo = str(args.repo)
    actor = args.actor

    try:
        if args.cmd == "accept":
            decision_id = accept(n, repo, actor=actor)
            print(f"accept #{n} ({repo}) -> {decision_id}")
        elif args.cmd == "reject":
            decision_id = reject(n, repo, args.reason, actor=actor)
            print(f"reject #{n} ({repo}) -> {decision_id}")
        elif args.cmd == "defer":
            decision_id = defer(n, repo, actor=actor)
            print(f"defer #{n} ({repo}) -> {decision_id}")
        elif args.cmd == "needs-ac":
            decision_id = needs_ac(n, repo, actor=actor, comment=args.comment)
            print(f"needs-ac #{n} ({repo}) -> {decision_id}")
        elif args.cmd == "mark-duplicate":
            decision_id = mark_duplicate(n, repo, args.of_n, actor=actor)
            print(f"mark-duplicate #{n} -> #{args.of_n} ({repo}) -> {decision_id}")
        elif args.cmd == "status":
            print(_format_decision(status(n, repo)))
        elif args.cmd == "reset":
            decision_id = reset(n, repo, actor=actor)
            print(f"reset #{n} ({repo}) -> {decision_id}")
        elif args.cmd == "history":
            entries = history(n, repo)
            if not entries:
                print(_format_decision(None))
            else:
                for entry in entries:
                    print(_format_decision(entry))
        else:  # pragma: no cover -- argparse enforces above set
            parser.print_help()
            return 2
    except TriageError as exc:
        print(f"triage_actions: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
