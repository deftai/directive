#!/usr/bin/env python3
"""triage_actions.py -- per-issue triage decision commands (#845 Story 3).

Provides eight commands consumed via ``tasks/triage-actions.yml``:

- ``accept(n, repo)`` -- record an accept audit entry AND delegate the vBRIEF
  authoring to ``scripts/issue_ingest.py`` (#985). After ``log.append(entry)``
  succeeds, ``ingest_single_for_accept`` is invoked to materialise the issue
  in ``vbrief/proposed/`` per the refinement skill's three-tier inventory
  model. If the ingest fails, the audit entry is ROLLED BACK so the log
  never references an accept decision that did not actually produce a vBRIEF
  (mirrors :func:`reject`'s rollback pattern).
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

Upstream contracts (frozen public surfaces of Story 2 + #883 Story 2):

- ``scripts.candidates_log.append(entry: dict) -> str`` (decision_id)
- ``scripts.candidates_log.latest_decision(issue_number: int, repo: str) -> dict | None``
- ``scripts.candidates_log.find_by_issue(issue_number: int, repo: str) -> list[dict]``
- ``scripts.cache.cache_get(source: str, key: str, *, allow_stale=True) -> GetResult``
  -- the unified cache replaces the legacy triage_cache.show(...) seam under
  #883 Story 3.

The upstream PRs may not be merged when this script lands. Module-level
``candidates_log`` and ``cache`` references are therefore guarded with
``try / except ImportError`` so the module imports cleanly. Tests substitute
fakes via ``monkeypatch.setattr(triage_actions, "candidates_log", ...)`` and
``monkeypatch.setattr(triage_actions, "cache", ...)``.

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

# #1145 / N5: route ``gh`` invocations through the source-aware shim so a
# future GitLab / Gitea / local consumer sees a loud ``NotImplementedError``
# pointing at #445 / #935 Workstream 6, not a confusing
# ``gh: command not found`` deep in the call stack. The shim resolves the
# binary via the #884 ``ghx`` -> ``gh`` preference ladder, so this also
# transparently picks up the cached proxy when it is installed.
import scm  # noqa: E402 -- sibling-first path insertion above is intentional

# Public, frozen interfaces from #845 Story 2 (audit log) + #883 Story 2
# (unified cache). These imports may fail when an upstream PR has not yet
# merged onto the consumer's branch -- the module attributes are then
# ``None`` and tests substitute a fake. Production bootstrap lands all
# pieces together so the runtime path is intact.
try:  # pragma: no cover -- exercised once Story 2 lands.
    import candidates_log  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    candidates_log = None  # type: ignore[assignment]

try:  # pragma: no cover -- exercised once #883 Story 2 lands.
    import cache  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    cache = None  # type: ignore[assignment]

# #985: triage:accept delegates the vBRIEF authoring to issue_ingest after
# the audit-log append succeeds. Guarded so the module imports cleanly when
# issue_ingest pulls in transitive deps (e.g. ``cache``) that may not be
# present on a slimmed-down checkout. Tests substitute fakes via
# ``monkeypatch.setattr(triage_actions, "issue_ingest", ...)``.
try:  # pragma: no cover -- exercised once #454 lands on the same checkout.
    import issue_ingest  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    issue_ingest = None  # type: ignore[assignment]

# Optional dep: resume-condition grammar parser (#1123 / D3). When
# absent (slim test checkout) ``defer(resume_on=...)`` falls through
# without pre-validation; the audit-log validator still accepts the
# string verbatim.
try:  # pragma: no cover -- exercised once #1123 lands.
    import resume_conditions  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    resume_conditions = None  # type: ignore[assignment]


# Public constants ----------------------------------------------------------

#: Project-relative path of the audit log written by Story 2's ``append``
#: (canonical location frozen in the Story 2 vBRIEF). Used ONLY by
#: :func:`_rollback_audit_entry` -- the normal write path goes through
#: ``candidates_log.append``.
AUDIT_LOG_REL_PATH = "vbrief/.eval/candidates.jsonl"

#: Label applied to a rejected upstream issue alongside ``gh issue close``.
REJECTED_LABEL = "triage-rejected"

#: Default color (6-hex, no leading '#') applied when auto-creating
#: :data:`REJECTED_LABEL` on a repository that lacks it (#1420). GitHub's
#: own ``invalid`` / ``wontfix`` palette red; chosen so an auto-created
#: label reads as a negative-disposition marker at a glance.
REJECTED_LABEL_COLOR = "B60205"

#: Description applied when auto-creating :data:`REJECTED_LABEL` (#1420).
REJECTED_LABEL_DESCRIPTION = "Issue rejected during deft triage"

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
    """Return the live ``cache`` module or raise if #883 Story 2 is missing."""
    if cache is None:
        raise TriageError(
            "scripts/cache.py is not available in this checkout. "
            "#883 Story 2 must land or this PR must be rebased onto master."
        )
    return cache


def _run_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
    """Wrapper around ``gh`` so tests can patch a single seam.

    Routes through :func:`scripts.scm.call` (#1145 / N5) so the binary
    resolution (the #884 ``ghx`` -> ``gh`` ladder) and the source-aware
    indirection (GitLab / Gitea / local raise
    :class:`NotImplementedError`) live in one place. Raises
    :class:`UpstreamCloseError` on non-zero exit so callers can roll back.

    The ``args`` list begins with the gh verb (e.g. ``"issue"``) followed
    by its subcommand and flags -- the shim accepts the verb separately
    so call sites do not have to know whether the underlying binary is
    ``gh`` or ``ghx``. An empty ``args`` is treated as a programming
    error and surfaces as :class:`UpstreamCloseError` (mirrors the prior
    ``FileNotFoundError`` failure mode at the contract layer).
    """
    if not args:
        raise UpstreamCloseError("scm.call requires at least a verb; got empty args")
    try:
        return scm.call(
            "github-issue",
            args[0],
            args[1:],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise UpstreamCloseError(f"gh CLI not found on PATH: {exc}") from exc
    except scm.ScmStubError as exc:
        raise UpstreamCloseError(f"gh resolution failed: {exc}") from exc
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
    resume_on: str | None = None,
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
    if resume_on is not None:
        entry["resume_on"] = resume_on
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
    """Record an accept audit entry AND delegate vBRIEF authoring to issue_ingest.

    Performs (in order):

    1. Idempotency check -- if the issue is already accepted, return the
       prior ``decision_id`` without re-appending and WITHOUT re-ingesting.
       The pre-existing ``vbrief/proposed/`` artefact written on the first
       accept is preserved as-is.
    2. Append the audit entry, capturing ``decision_id``.
    3. Delegate to :func:`scripts.issue_ingest.ingest_single_for_accept` to
       materialise the issue as a scope vBRIEF in ``vbrief/proposed/``
       (per ``skills/deft-directive-refinement/SKILL.md`` Phase 0 Tier 3:
       "task triage:accept is the canonical write path -- it delegates the
       actual vBRIEF authoring to task issue:ingest so slug/reference/schema
       rules stay in one place"). The ingest call is cache-first per #883;
       slug rules + canonical reference shape stay owned by ``issue_ingest``
       per #537.
    4. On ingest failure: roll the audit entry back via
       :func:`_rollback_audit_entry` and re-raise as :class:`TriageError`
       (mirrors :func:`reject`'s upstream-close-failure handling).

    Idempotency note: the idempotent short-circuit at step 1 deliberately
    skips both the audit append AND the ingest delegation -- a re-accept
    must NOT write a second proposed/ vBRIEF. Story 2's append-only audit
    log preserves the original ``decision_id`` and the slug-stable vBRIEF
    path keeps the original artefact reachable.
    """
    actor_str = _resolve_actor(actor)
    prior = _is_idempotent_repeat(n, repo, "accept")
    if prior is not None:
        return str(prior["decision_id"])
    log = _require_log()
    entry = _build_entry("accept", n, repo, actor=actor_str)
    decision_id = str(log.append(entry))
    try:
        _delegate_accept_ingest(n, repo, project_root=project_root)
    except Exception as exc:  # noqa: BLE001 -- any ingest failure -> rollback
        _rollback_audit_entry(decision_id, project_root=project_root)
        # Surface as a structured TriageError so CLI / Taskfile callers exit
        # non-zero with an actionable message instead of a raw traceback.
        raise TriageError(
            f"accept #{n} ({repo}): issue:ingest delegation failed; "
            f"audit entry rolled back. Cause: {exc}"
        ) from exc
    return decision_id


def _delegate_accept_ingest(
    n: int,
    repo: str,
    *,
    project_root: Path | None = None,
) -> None:
    """Invoke ``issue_ingest.ingest_single_for_accept`` for ``(repo, n)``.

    Raises :class:`TriageError` when ``scripts/issue_ingest.py`` is not
    importable in this checkout (mirrors :func:`_require_log` /
    :func:`_require_cache`). Any exception raised by the ingest path is
    propagated unchanged so :func:`accept` can roll the audit entry back
    with the original cause attached to the chained ``TriageError``.
    """
    if issue_ingest is None:
        raise TriageError(
            "scripts/issue_ingest.py is not available in this checkout. "
            "#454 (task issue:ingest) must land or this PR must be rebased "
            "onto master."
        )
    issue_ingest.ingest_single_for_accept(n, repo, project_root=project_root)


def reject(
    n: int,
    repo: str,
    reason: str,
    *,
    actor: str | None = None,
    project_root: Path | None = None,
) -> str:
    """Close upstream + best-effort label + record. Roll back only on close failure.

    Performs (in order):

    1. Idempotency check -- if the issue is already rejected, return the
       prior decision_id without re-calling gh.
    2. Append the audit entry, capturing ``decision_id``.
    3. ``gh issue close <n> --comment <reason> --reason 'not planned'``.
    4. Best-effort ``gh issue edit <n> --add-label triage-rejected`` via
       :func:`_ensure_rejected_label_applied` -- self-healing when the
       label is missing on the repo (#1420).
    5. On step 3 (close) failure ONLY: roll back the audit entry from the
       JSONL (per Story 3 vBRIEF Constraint) and re-raise as
       :class:`UpstreamCloseError`.

    #1420 -- label-application is NOT load-bearing. The close-with-reason
    is the decision that takes effect; once it succeeds the audit entry
    MUST persist. A repository that lacks the ``triage-rejected`` label
    used to fail step 4 and roll back the whole reject even though the
    issue was already closed. The reject flow now auto-creates the label
    when absent and, failing that, tolerates the missing label with a
    stderr warning -- it never rolls back a successful close.
    """
    actor_str = _resolve_actor(actor)
    prior = _is_idempotent_repeat(n, repo, "reject")
    if prior is not None:
        return str(prior["decision_id"])
    log = _require_log()
    entry = _build_entry("reject", n, repo, actor=actor_str, reason=reason)
    decision_id = str(log.append(entry))
    # Step 3: the close-with-reason is the load-bearing action -- a close
    # failure is the ONLY condition that rolls back the audit entry.
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
    except UpstreamCloseError:
        _rollback_audit_entry(decision_id, project_root=project_root)
        raise
    # Step 4: label application is best-effort and self-healing. A missing
    # ``triage-rejected`` label MUST NOT roll back a successful close (#1420).
    _ensure_rejected_label_applied(n, repo)
    return decision_id


def _looks_like_missing_label(exc: UpstreamCloseError) -> bool:
    """Heuristic: did ``gh issue edit --add-label`` fail because the label is absent?

    ``gh`` surfaces a missing label as ``"'triage-rejected' not found"`` (or
    a ``label ... not found`` variant). The check is intentionally broad --
    a false positive only triggers a (harmless, idempotent) label-create
    attempt, while a false negative would leave the #1420 bug unfixed.
    """
    text = str(exc).lower()
    return "not found" in text or "could not add label" in text


def _ensure_label_exists(repo: str) -> None:
    """Create :data:`REJECTED_LABEL` on ``repo`` when it is missing (#1420).

    ``gh label create`` exits non-zero when the label already exists; that
    specific case is swallowed so a concurrent create or a pre-existing
    label is not treated as an error. Any other failure propagates as
    :class:`UpstreamCloseError` for the caller to tolerate (it must never
    roll back the already-closed issue).
    """
    try:
        _run_gh(
            [
                "label",
                "create",
                REJECTED_LABEL,
                "--repo",
                repo,
                "--description",
                REJECTED_LABEL_DESCRIPTION,
                "--color",
                REJECTED_LABEL_COLOR,
            ]
        )
    except UpstreamCloseError as exc:
        if "already exists" in str(exc).lower():
            return
        raise


def _ensure_rejected_label_applied(n: int, repo: str) -> None:
    """Apply :data:`REJECTED_LABEL` to issue ``n``, auto-creating it if missing.

    Best-effort by contract (#1420): the caller has already closed the
    issue, so this helper MUST NOT raise -- a failure to label is surfaced
    on stderr but never rolls back the decision. The flow is:

    1. Try ``gh issue edit --add-label triage-rejected``.
    2. On a missing-label failure, create the label once and re-attempt.
    3. On any continued failure, warn on stderr and return.
    """
    try:
        _run_gh(
            ["issue", "edit", str(n), "--repo", repo, "--add-label", REJECTED_LABEL]
        )
        return
    except UpstreamCloseError as add_exc:
        if not _looks_like_missing_label(add_exc):
            print(
                f"triage_actions: reject #{n} ({repo}) closed successfully but "
                f"the {REJECTED_LABEL!r} label could not be applied: {add_exc}",
                file=sys.stderr,
            )
            return
    # The label is absent on the repo -- create it once, then re-add.
    try:
        _ensure_label_exists(repo)
        _run_gh(
            ["issue", "edit", str(n), "--repo", repo, "--add-label", REJECTED_LABEL]
        )
    except UpstreamCloseError as heal_exc:
        print(
            f"triage_actions: reject #{n} ({repo}) closed successfully but the "
            f"{REJECTED_LABEL!r} label is missing and auto-create/re-add "
            f"failed: {heal_exc}",
            file=sys.stderr,
        )


def defer(
    n: int,
    repo: str,
    reason: str | None = None,
    *,
    actor: str | None = None,
    resume_on: str | None = None,
    project_root: Path | None = None,
) -> str:
    """Record a defer audit entry (#1123 / D3 -- structured reason + resume_on).

    ``reason`` was free-text-only in #845 Story 3 and is now the structured
    rationale field on the audit entry (still optional at the API layer for
    back-compat with callers that pre-date #1123; the CLI surface treats it
    as required so new operator-driven defers always carry rationale).

    ``resume_on`` is the optional structured condition that the resume
    evaluator (`scripts/resume_conditions.evaluate_resume_eligibility`)
    will later consult to surface this defer as ``resume-eligible``.
    Pre-validated at write time when the ``resume_conditions`` module is
    importable so a malformed expression cannot land in the audit log.
    """
    if resume_on is not None and resume_conditions is not None:
        # Will raise ResumeGrammarError (ValueError subclass) on a bad
        # expression; we let it propagate as a TriageError-shaped
        # ValueError so CLI / Taskfile callers exit non-zero with the
        # parser's actionable message attached.
        try:
            resume_conditions.parse(resume_on)
        except resume_conditions.ResumeGrammarError as exc:
            raise TriageError(
                f"defer #{n} ({repo}): invalid --resume-on expression -- {exc}"
            ) from exc
    log = _require_log()
    entry = _build_entry(
        "defer",
        n,
        repo,
        actor=_resolve_actor(actor),
        reason=reason,
        resume_on=resume_on,
    )
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
    """Validate target exists in unified cache + record mark-duplicate audit entry.

    Reads the target via :func:`scripts.cache.cache_get` (#883 Story 3 rebind
    onto cache:*). The ``allow_stale=True`` flag lets the validation succeed
    against an entry whose TTL has expired -- a stale-but-cached duplicate
    target is still an acceptable cross-link reference; the operator can
    refresh the entry later via ``task cache:fetch-all``.
    """
    if int(of_n) == int(n):
        raise TriageError(f"mark-duplicate target #{of_n} cannot equal source #{n}")
    cache_mod = _require_cache()
    key = f"{repo}/{int(of_n)}"
    try:
        cache_mod.cache_get("github-issue", key, allow_stale=True)
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

    for cmd in ("accept", "status", "reset", "history"):
        p = sub.add_parser(cmd)
        _common(p)

    # #1123: ``defer`` now requires --reason (replacing free-text defer)
    # and optionally accepts --resume-on.
    p_defer = sub.add_parser("defer")
    _common(p_defer)
    p_defer.add_argument(
        "--reason",
        required=True,
        help="Structured rationale captured on the defer audit entry (#1123).",
    )
    p_defer.add_argument(
        "--resume-on",
        default=None,
        dest="resume_on",
        help=(
            "Optional resume-condition expression (#1123). Grammar v1: "
            "ref:closed:#N | ref:merged:#N | date:>=YYYY-MM-DD | "
            "pending-count:>=N | pending-count:<=N, joined by AND/OR."
        ),
    )

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
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_actions", argv)
    if rc is not None:
        return rc
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
            decision_id = defer(
                n,
                repo,
                args.reason,
                actor=actor,
                resume_on=getattr(args, "resume_on", None),
            )
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
