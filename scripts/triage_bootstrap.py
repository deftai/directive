#!/usr/bin/env python3
"""triage_bootstrap.py -- idempotent triage v1 installer (#883 Story 3 rebind).

Single-command opt-in for triage v1. Wires the consumer's project for
the pre-ingest triage workflow without touching any existing vBRIEF,
scope, or skill state. Designed to be re-runnable: every step is
idempotent and a second invocation is a no-op.

Steps (in order):

1. ``populate_cache`` -- delegates to :func:`scripts.cache.cache_fetch_all`
   with ``--source=github-issue`` to mirror upstream issues into
   ``.deft-cache/github-issue/<owner>/<repo>/<N>/``. Gracefully degrades
   to a deferred-action message when ``--repo`` is neither passed nor
   inferable from ``git remote get-url origin`` and when the cache
   module has not yet landed on the consumer's branch.

2. ``backfill_audit_log`` -- writes one ``accept`` audit entry per
   scope vBRIEF currently in ``vbrief/proposed/``, ``vbrief/pending/``,
   or ``vbrief/active/``. Skips ``vbrief/cancelled/`` so rejected items
   are NOT reanimated. Skips ``vbrief/completed/`` because completed
   work is not in the triage funnel. Delegates to
   :func:`scripts.candidates_log.append` when present; falls back to a
   self-contained JSONL append when not.

3. ``ensure_gitignore_entry`` -- append ``.deft-cache/`` to
   ``.gitignore`` when absent.

4. ``ensure_gitignore_eval_entries`` -- ensure the #1144 hybrid policy
   is encoded: append the selective ``candidates.jsonl`` /
   ``summary-history.jsonl`` / ``scope-lifecycle.jsonl`` entries to
   ``.gitignore`` when missing, add the
   ``vbrief/.eval/*.jsonl  merge=union`` rule to ``.gitattributes``,
   and write the canonical ``vbrief/.eval/README.md``. Replaces the
   pre-#1251 ``ensure_gitignore_eval_dir`` which appended a blanket
   ``vbrief/.eval/`` line that silently ignored the tracked
   ``slices.jsonl`` (#1132 / D13).

5. ``seed_candidates_log`` -- ensure ``vbrief/.eval/candidates.jsonl``
   exists as a zero-length file so ``task verify:cache-fresh`` can
   distinguish a never-bootstrapped consumer (no cache) from a
   freshly-bootstrapped one (cache + empty audit log). Option A of
   issue #1240.

Exit codes (three-state, mirrors ``scripts/preflight_branch.py``):

- ``0`` -- bootstrap completed (or all steps were no-ops on a re-run).
- ``1`` -- bootstrap failed at a runtime step.
- ``2`` -- config error: ``--project-root`` doesn't exist or isn't a
  directory.

Refs:

- #883 (parent epic for the unified cache rebind).
- #845 (the pre-ingest triage workflow this script orchestrates).
- ``docs/privacy-nfr.md`` -- privacy contract for ``.deft-cache/``.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import importlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Make sibling ``scripts`` modules importable when the consumer invokes
# this script via ``python scripts/triage_bootstrap.py`` from the
# project root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8-safe subprocess capture (#1366 / #1002). MUST be imported after the
# ``sys.path`` insert above so the sibling helper resolves whether deft is the
# project root or installed as a ``deft/`` subdirectory.
from _safe_subprocess import run_text  # noqa: E402 -- needs sys.path insert above

# UTF-8 self-reconfigure (mirrors #814 fix). The Windows cp1252 default
# would crash on the ✓ / ⚠ glyphs we print in the recap.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


#: Canonical cache-directory name. The unified cache writes to
#: ``.deft-cache/github-issue/<owner>/<repo>/<N>/`` under #883 Story 2.
CACHE_DIR_NAME = ".deft-cache"

#: Canonical audit-log path relative to the project root.
AUDIT_LOG_RELPATH = Path("vbrief") / ".eval" / "candidates.jsonl"

#: Lifecycle folders whose contents are backfilled with ``accept``
#: entries. ``cancelled/`` is excluded so rejected items are not
#: reanimated; ``completed/`` is excluded because completed work is no
#: longer in the triage funnel.
BACKFILL_FOLDERS = ("proposed", "pending", "active")

#: Canonical actor for bootstrap-emitted backfill entries.
BOOTSTRAP_ACTOR = "agent:bootstrap"

#: Cache source consumed by triage v1 (only github-issue is supported).
_CACHE_SOURCE: str = "github-issue"

#: Default wall-clock cap (seconds) on the cache:fetch-all step. The
#: underlying ``cache.cache_fetch_all`` shells out to ``task
#: scm:issue:view`` per issue with no per-call timeout, so a stuck
#: ``gh``/``ghx`` process (auth re-prompt, network stall, server-side
#: hang) will block the orchestrator indefinitely. The watchdog in
#: :func:`step_populate_cache` enforces this cap so the orchestrator
#: always exits in bounded time even when the underlying subprocess
#: tree is wedged. Override via ``--fetch-timeout-s`` or the
#: ``DEFT_BOOTSTRAP_FETCH_TIMEOUT_S`` env var. Set to ``0`` to disable
#: (legacy unbounded behavior). Sized for a 1000-issue full-backlog run
#: at the default 500ms inter-issue delay (#952).
DEFAULT_FETCH_TIMEOUT_S: int = 3600

#: subprocess.run timeout for ``git remote get-url origin``. Defensive:
#: a stuck ``git`` proxy (corporate VPN re-auth) would otherwise hang
#: bootstrap before any progress line is emitted.
_GIT_INFER_TIMEOUT_S: int = 10


@dataclass
class StepOutcome:
    """Per-step result captured by the dispatcher."""

    name: str
    ok: bool
    message: str
    error: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Progress emit (#952)
# ---------------------------------------------------------------------------
#
# A real-world v0.26.0 backlog smoke (docs/smoke-2026-05-06-v0.26.0-scale.md)
# saw the orchestrator silently hang for 71+ minutes after cache:fetch-all
# *appeared* to complete -- the operator had no per-step visibility so could
# not tell whether the script was wedged inside step_populate_cache (the
# real culprit) or one of the post-fetch steps. The structured stderr lines
# below match the cadence of ``scripts/cache.py`` / ``cache_scanner.py``
# status output and let future operators (and the integration test) verify
# that each step is entered and exited.

#: Total number of steps executed by :func:`run_bootstrap`. Update if a
#: step is added or removed so the ``step <i>/<TOTAL>`` numerator stays
#: accurate. v0.32.0 (#1240): add step 5 ``seed_candidates_log``.
_TOTAL_STEPS: int = 5


def _emit_progress(
    out: object | None,
    step_index: int,
    name: str,
    phase: str,
    detail: str = "",
) -> None:
    """Write a single ``triage:bootstrap step <i>/<N> <name> -- <phase>`` line.

    ``out`` is any file-like object with a ``write()`` method (or ``None``
    to silence emission, e.g. inside test fixtures that don't capture
    stderr). The phase string is one of ``starting`` / ``done`` /
    ``error`` / ``timeout``; callers are free to add a parenthetical
    ``detail`` for cardinality (e.g. counts, repo, elapsed seconds).
    """
    if out is None:
        return
    line = f"triage:bootstrap step {step_index}/{_TOTAL_STEPS} {name} -- {phase}"
    if detail:
        line = f"{line} ({detail})"
    try:
        out.write(line + "\n")
        flush = getattr(out, "flush", None)
        if callable(flush):
            flush()
    except (OSError, ValueError):
        # A closed-stream / broken-pipe write must never propagate from
        # an observability path; the bootstrap result is canonical.
        pass


#: Sentinel separating "func() returned None" from "runner thread died
#: before assigning result" (Greptile P1 cleanup for #955).
_RUNNER_UNSET: Any = object()


def _run_with_timeout(
    func: Callable[[], Any],
    timeout_s: float,
) -> tuple[bool, Any, Exception | None]:
    """Run ``func()`` in a daemon thread; return ``(completed, result, exc)``.

    ``completed`` is False when ``timeout_s`` elapsed; the daemon thread
    is left running (load-bearing property for #952). Non-positive
    ``timeout_s`` disables the watchdog (legacy unbounded behavior).

    Only :class:`Exception` is captured into ``box["exc"]``. A
    :class:`BaseException` raised inside the daemon thread (``SystemExit`` /
    ``MemoryError`` / ...) terminates the runner silently -- Python
    threading does not propagate ``BaseException`` to the joining thread.
    To stop that masquerading as ``ok=True`` with ``succeeded=None``,
    ``box["result"]`` starts as a sentinel; a thread that joins without
    setting either slot synthesizes a :class:`RuntimeError` so
    :func:`step_populate_cache` reports ``ok=False`` (Greptile P1
    cleanup for #955). Operator-issued Ctrl+C is unaffected.
    """
    box: dict[str, Any] = {"result": _RUNNER_UNSET, "exc": None}

    def _runner() -> None:
        try:
            box["result"] = func()
        except Exception as exc:  # noqa: BLE001 -- forward verbatim
            box["exc"] = exc

    thread = threading.Thread(
        target=_runner, name="triage_bootstrap.populate_cache", daemon=True
    )
    thread.start()
    thread.join(timeout_s if timeout_s and timeout_s > 0 else None)
    if thread.is_alive():
        return False, None, None
    if box["result"] is _RUNNER_UNSET and box["exc"] is None:
        # Thread joined without result OR exc -- unhandled BaseException.
        return True, None, RuntimeError(
            "worker thread terminated without completing "
            "(unhandled BaseException not propagated by Python threading)"
        )
    result = None if box["result"] is _RUNNER_UNSET else box["result"]
    return True, result, box["exc"]


@dataclass
class BootstrapResult:
    """Aggregate result returned by :func:`run_bootstrap`."""

    project_root: Path
    repo: str | None
    steps: list[StepOutcome] = field(default_factory=list)
    exit_code: int = 0

    def summary(self) -> str:
        """Render a recap the operator sees at the end of bootstrap."""

        lines = ["", "Triage v1 bootstrap recap:"]
        for step in self.steps:
            mark = "✓" if step.ok else "✗"
            lines.append(f"  {mark} {step.name}: {step.message}")
            if step.error:
                lines.append(f"      error: {step.error}")
        if self.exit_code == 0:
            lines.append("")
            lines.append("Next steps:")
            lines.append(
                "  task cache:fetch-all -- --source=github-issue "
                "--repo OWNER/NAME   # refresh the cache (#883 Story 2)"
            )
            lines.append(
                "  task cache:get -- github-issue OWNER/NAME/<N>            "
                "# inspect cached issue N"
            )
            lines.append(
                "  task triage:accept -- --issue <N> --repo OWNER/NAME      "
                "# accept issue N (#845 Story 3)"
            )
            lines.append(
                "  task triage:reject -- --issue <N> --repo OWNER/NAME --reason 'why' "
                "# reject issue N"
            )
            lines.append(
                "  task triage:bulk-accept -- --repo OWNER/NAME --label adoption-blocker "
                "# bulk accept"
            )
            lines.append(
                "  task triage:refresh-active                              "
                "# pre-swarm freshness gate"
            )
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Repo resolution
# ---------------------------------------------------------------------------

#: Regex mapping a ``git remote get-url origin`` value to ``(owner, repo)``.
_GIT_ORIGIN_RE = re.compile(
    r"^(?:https?://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com[:/])"
    r"(?P<owner>[A-Za-z0-9][A-Za-z0-9._-]*)/"
    r"(?P<repo>[A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?/?\s*$"
)
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")


def _infer_repo_from_git(cwd: Path | None = None) -> str | None:
    """Infer ``owner/repo`` from ``git remote get-url origin``.

    A bounded ``timeout`` is applied to the subprocess call so a stuck
    ``git`` proxy (corporate VPN re-auth, hung credential helper)
    cannot wedge the orchestrator before any progress line lands
    (#952 defensive). On timeout / OSError the function returns
    ``None`` and the caller falls back to its existing skip-with-OK
    branch.

    The capture is routed through :func:`_safe_subprocess.run_text`
    (#1366), which FORCES ``encoding="utf-8", errors="replace"`` so a
    non-ASCII byte on the captured stream (e.g. a localized ``git``
    warning on stderr) decodes to U+FFFD instead of crashing Python's
    subprocess reader thread with ``UnicodeDecodeError`` under the
    Windows cp1252 codepage (#1002, the #798 chain at the
    subprocess-read surface).
    """

    if shutil.which("git") is None:
        return None
    try:
        proc = run_text(
            ["git", "remote", "get-url", "origin"],
            cwd=str(cwd) if cwd is not None else None,
            timeout=_GIT_INFER_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    url = (proc.stdout or "").strip()
    if not url:
        return None
    m = _GIT_ORIGIN_RE.search(url)
    if not m:
        return None
    return f"{m.group('owner')}/{m.group('repo')}"


# ---------------------------------------------------------------------------
# Step 1 -- populate cache via cache:fetch-all
# ---------------------------------------------------------------------------


def _load_cache_module() -> Any | None:
    """Return the unified cache module, or ``None`` if not importable."""

    for candidate in ("cache", "scripts.cache"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError:
            continue
    return None


def step_populate_cache(
    project_root: Path,
    repo: str | None,
    *,
    cache_module: Any | None = None,
    batch_size: int | None = None,
    delay_ms: int | None = None,
    state: str | None = None,
    limit: int | None = None,
    labels: tuple[str, ...] | None = None,
    author: str | None = None,
    fetch_timeout_s: float | None = None,
) -> StepOutcome:
    """Mirror upstream issues for ``repo`` via :func:`cache_fetch_all`.

    ``labels`` (#1033) and ``author`` (#1055) scope the cache:fetch-all
    enumeration so an operator can bootstrap against a subset of the
    backlog (e.g. one label, or one author) instead of the entire open
    queue. Both forward to :func:`cache.cache_fetch_all` and compose
    with AND semantics when supplied together.

    Resolution precedence for ``repo``:

    1. Explicit argument (kwargs / ``--repo`` flag / ``DEFT_TRIAGE_REPO`` env).
    2. Inference from ``git remote get-url origin`` inside ``project_root``.

    When neither resolves, the step returns ``ok=True`` with a friendly
    skip message -- the gitignore + audit-log steps are still useful
    without a repo. When the cache module is missing on the branch the
    step degrades to a deferred-action message so the bootstrap exit
    code stays 0 (per the re-runnable contract).

    ``fetch_timeout_s`` is the wall-clock cap on the wrapped
    ``cache.cache_fetch_all`` call; ``None`` selects
    :data:`DEFAULT_FETCH_TIMEOUT_S`. ``0`` disables the watchdog and
    restores the legacy unbounded behavior. The watchdog is the load-
    bearing fix for #952: a stuck ``task scm:issue:view`` subprocess
    (auth re-prompt, network stall, server hang) can no longer wedge
    the orchestrator past this cap, even though Python cannot
    reliably interrupt the underlying process tree.
    """

    effective_repo = repo
    if effective_repo is None:
        effective_repo = _infer_repo_from_git(cwd=project_root)
    if effective_repo is None:
        return StepOutcome(
            name="populate_cache",
            ok=True,
            message=(
                "skipped (no --repo provided and could not infer from "
                "`git remote get-url origin`; pass --repo OWNER/NAME)"
            ),
            details={"skipped": "no-repo"},
        )
    if not _REPO_RE.match(effective_repo):
        return StepOutcome(
            name="populate_cache",
            ok=False,
            message=f"invalid --repo {effective_repo!r}",
            error="repo must be 'owner/name' (alphanumerics, '.', '_', '-' only)",
        )

    cache_mod = cache_module if cache_module is not None else _load_cache_module()
    if cache_mod is None:
        return StepOutcome(
            name="populate_cache",
            ok=True,
            message=(
                "deferred (scripts/cache.py not present on this branch; "
                "re-run after rebase to populate via task cache:fetch-all)"
            ),
            details={"deferred": "cache-module-missing", "repo": effective_repo},
        )
    fetch_all = getattr(cache_mod, "cache_fetch_all", None)
    if not callable(fetch_all):
        return StepOutcome(
            name="populate_cache",
            ok=False,
            message="cache_fetch_all is not callable",
            error="#883 Story 2 contract violated: cache_fetch_all() not exposed",
        )

    kwargs: dict[str, Any] = {
        "source": _CACHE_SOURCE,
        "repo": effective_repo,
        "cache_root": project_root / CACHE_DIR_NAME,
    }
    if batch_size is not None:
        kwargs["batch_size"] = batch_size
    if delay_ms is not None:
        kwargs["delay_ms"] = delay_ms
    if state is not None:
        kwargs["state"] = state
    if limit is not None:
        kwargs["limit"] = limit
    if labels:
        kwargs["labels"] = labels
    if author is not None:
        kwargs["author"] = author

    effective_timeout = (
        fetch_timeout_s if fetch_timeout_s is not None else DEFAULT_FETCH_TIMEOUT_S
    )

    started = time.monotonic()
    completed, report, exc = _run_with_timeout(
        lambda: fetch_all(**kwargs), effective_timeout
    )
    elapsed = time.monotonic() - started

    if not completed:
        return StepOutcome(
            name="populate_cache",
            ok=False,
            message=(
                f"cache:fetch-all wall-clock timeout after "
                f"{effective_timeout:g}s for repo={effective_repo} "
                "(an underlying `task scm:issue:view` subprocess is likely "
                "stuck; re-run with --fetch-timeout-s=0 to disable the "
                "watchdog or with a higher value, or shrink the run via "
                "--limit / --state=open)"
            ),
            error=(
                f"step_populate_cache exceeded fetch_timeout_s={effective_timeout:g}; "
                "see #952 for the watchdog rationale"
            ),
            details={
                "repo": effective_repo,
                "source": _CACHE_SOURCE,
                "fetch_timeout_s": effective_timeout,
                "elapsed_s": round(elapsed, 3),
                "timed_out": True,
            },
        )

    if exc is not None:
        # cache_fetch_all raised; report the failure honestly so callers
        # (and the orchestrator's recap) see a non-OK populate step. The
        # bootstrap is partial -- ``run_bootstrap`` continues to the
        # remaining (cache-independent) steps and surfaces ``exit_code=1``
        # via the aggregate ``any(not step.ok)`` rule (P1 cleanup for
        # #955; SLizard finding ``step_populate_cache misreports ok=True
        # on exception``). Re-run after the underlying issue is resolved.
        return StepOutcome(
            name="populate_cache",
            ok=False,
            message=(
                f"cache:fetch-all raised {type(exc).__name__} for repo="
                f"{effective_repo} (re-run after the underlying issue is "
                "resolved; see error for detail)"
            ),
            error=str(exc),
            details={
                "failed": "fetch-all-error",
                "exc_type": type(exc).__name__,
                "repo": effective_repo,
                "elapsed_s": round(elapsed, 3),
                "fetch_timeout_s": effective_timeout,
            },
        )

    # #1247: FetchAllReport's counter names are being renamed to
    # ``issues_written`` / ``already_fresh`` / ``issues_failed`` (PR
    # #1254). When the new ``summary_line()`` renderer is available we
    # delegate so the recap stays unambiguous; otherwise we fall back
    # to the legacy hand-formatted string. The compatibility shim lets
    # this PR land before or after #1254 without an ordering coupling.
    succeeded = getattr(report, "succeeded", None)
    failed = getattr(report, "failed", None)
    skipped = getattr(report, "skipped", None)
    summary_line = getattr(report, "summary_line", None)
    legacy_message = (
        f"cache:fetch-all source={_CACHE_SOURCE} repo={effective_repo} "
        f"succeeded={succeeded} failed={failed} skipped={skipped}"
    )
    message = legacy_message
    if callable(summary_line):
        # Greptile P2 finding on PR #1256: pre-flight the kwarg shape
        # via ``inspect.signature(...).bind(...)`` so a future
        # signature change is the ONLY thing that re-routes us to the
        # legacy path. A ``TypeError`` from inside ``summary_line()``
        # itself (post-#1254 implementation bug) now propagates rather
        # than silently falling back to a cryptic
        # ``succeeded=None failed=None skipped=None`` recap.
        import inspect

        try:
            sig = inspect.signature(summary_line)
        except (TypeError, ValueError):
            sig = None
        kwargs_ok = True
        if sig is not None:
            try:
                sig.bind(source=_CACHE_SOURCE, repo=effective_repo)
            except TypeError:
                kwargs_ok = False
        if kwargs_ok:
            message = summary_line(source=_CACHE_SOURCE, repo=effective_repo)
    return StepOutcome(
        name="populate_cache",
        ok=True,
        message=message,
        details={
            "repo": effective_repo,
            "source": _CACHE_SOURCE,
            "succeeded": succeeded,
            "failed": failed,
            "skipped": skipped,
            "elapsed_s": round(elapsed, 3),
            "fetch_timeout_s": effective_timeout,
        },
    )


# ---------------------------------------------------------------------------
# Step 2 -- backfill audit log with `accept` entries
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    """Return current time as ISO-8601 UTC with the literal ``Z`` suffix."""

    return (
        _dt.datetime.now(tz=_dt.timezone.utc)  # noqa: UP017
        .replace(microsecond=0)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def _extract_issue_number(vbrief_data: dict[str, Any]) -> int | None:
    """Pull the issue number from a scope vBRIEF's references[] block."""

    plan = vbrief_data.get("plan")
    if not isinstance(plan, dict):
        return None
    refs = plan.get("references")
    if not isinstance(refs, list):
        return None
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        if ref.get("type") != "x-vbrief/github-issue":
            continue
        uri = ref.get("uri", "")
        if not isinstance(uri, str):
            continue
        tail = uri.rstrip("/").rsplit("/", 1)[-1]
        if tail.isdigit():
            return int(tail)
    return None


def _scan_lifecycle_folder(folder: Path) -> list[tuple[int, Path]]:
    """Walk a lifecycle folder, returning (issue_number, vbrief_path) tuples."""

    results: list[tuple[int, Path]] = []
    if not folder.exists() or not folder.is_dir():
        return results
    for path in sorted(folder.glob("*.vbrief.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        issue_number = _extract_issue_number(data)
        if issue_number is None:
            continue
        results.append((issue_number, path))
    return results


def _existing_audit_issue_numbers(audit_path: Path) -> set[int]:
    """Read the audit log and return the set of issue numbers already logged."""

    if not audit_path.exists():
        return set()
    seen: set[int] = set()
    try:
        for line in audit_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                entry = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict):
                continue
            n = entry.get("issue_number")
            if isinstance(n, int):
                seen.add(n)
    except (OSError, UnicodeDecodeError):
        return set()
    return seen


def _build_audit_entry(repo: str, issue_number: int, source_folder: str) -> dict[str, Any]:
    """Compose a single ``accept`` audit entry per Story 2's schema."""

    return {
        "decision_id": str(uuid.uuid4()),
        "timestamp": _now_iso(),
        "repo": repo,
        "issue_number": issue_number,
        "decision": "accept",
        "actor": BOOTSTRAP_ACTOR,
        "reason": (
            f"bootstrap backfill: vBRIEF already in vbrief/{source_folder}/ "
            "at opt-in time"
        ),
    }


def _append_audit_entry(audit_path: Path, entry: dict[str, Any]) -> None:
    """Self-contained JSONL append used when Story 2 hasn't merged yet."""

    audit_path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(entry, ensure_ascii=False, sort_keys=True)
    with audit_path.open("a", encoding="utf-8") as fh:
        fh.write(serialized)
        fh.write("\n")


def step_backfill_audit_log(project_root: Path, repo: str | None) -> StepOutcome:
    """Backfill ``accept`` audit entries for items already in lifecycle folders."""

    if repo is None:
        return StepOutcome(
            name="backfill_audit_log",
            ok=True,
            message=(
                "skipped (no --repo provided; pass --repo OWNER/NAME to backfill)"
            ),
            details={"skipped": "no-repo"},
        )

    vbrief_root = project_root / "vbrief"
    if not vbrief_root.exists() or not vbrief_root.is_dir():
        return StepOutcome(
            name="backfill_audit_log",
            ok=True,
            message=f"skipped (no vbrief/ directory under {project_root})",
            details={"skipped": "no-vbrief"},
        )

    audit_path = project_root / AUDIT_LOG_RELPATH
    already_logged = _existing_audit_issue_numbers(audit_path)

    try:
        candidates_log = importlib.import_module("candidates_log")
        story2_append = getattr(candidates_log, "append", None)
        if not callable(story2_append):
            story2_append = None
    except ModuleNotFoundError:
        story2_append = None

    appended = 0
    skipped_existing = 0
    skipped_cancelled = 0

    cancelled_dir = vbrief_root / "cancelled"
    if cancelled_dir.exists():
        skipped_cancelled = len(_scan_lifecycle_folder(cancelled_dir))

    for folder_name in BACKFILL_FOLDERS:
        folder_path = vbrief_root / folder_name
        for issue_number, _vbrief_path in _scan_lifecycle_folder(folder_path):
            if issue_number in already_logged:
                skipped_existing += 1
                continue
            entry = _build_audit_entry(repo, issue_number, folder_name)
            try:
                if story2_append is not None:
                    story2_append(entry, path=audit_path)
                else:
                    _append_audit_entry(audit_path, entry)
            except Exception as exc:  # noqa: BLE001
                return StepOutcome(
                    name="backfill_audit_log",
                    ok=False,
                    message=(
                        f"append failed at issue #{issue_number} after "
                        f"{appended} successful writes"
                    ),
                    error=f"{type(exc).__name__}: {exc}",
                    details={
                        "appended": appended,
                        "skipped_existing": skipped_existing,
                        "skipped_cancelled": skipped_cancelled,
                    },
                )
            appended += 1
            already_logged.add(issue_number)

    return StepOutcome(
        name="backfill_audit_log",
        ok=True,
        message=(
            f"appended {appended} accepted entries; skipped "
            f"{skipped_existing} (already logged); skipped "
            f"{skipped_cancelled} (cancelled/, no reanimation)"
        ),
        details={
            "appended": appended,
            "skipped_existing": skipped_existing,
            "skipped_cancelled": skipped_cancelled,
            "audit_path": str(audit_path),
        },
    )


# ---------------------------------------------------------------------------
# Step 3 + 4 -- ensure .deft-cache/ and vbrief/.eval/ are gitignored
# ---------------------------------------------------------------------------
#
# Implementation lives in scripts/_triage_bootstrap_gitignore.py to keep
# this module under the 1000-line MUST limit (coding/coding.md). The
# step functions are re-exported from that submodule so the public
# import surface (``triage_bootstrap.step_ensure_gitignore_entry`` /
# ``...eval_dir``) stays exactly as Story 3 shipped.

# Re-export the gitignore step functions and the canonical line
# constants. ``GITIGNORE_LINE`` / ``GITIGNORE_EVAL_ENTRIES`` /
# ``GITATTRIBUTES_EVAL_RULE`` are part of the module's public surface
# (consumers / tests reference ``triage_bootstrap.GITIGNORE_LINE``);
# the ``__all__``-style guard below keeps ruff F401 silent without
# losing the re-export. ``step_ensure_gitignore_eval_entries`` is the
# #1251 rename of the pre-existing ``step_ensure_gitignore_eval_dir``.
from _triage_bootstrap_gitignore import (  # noqa: E402, F401 -- re-exported public surface
    GITATTRIBUTES_EVAL_RULE,
    GITIGNORE_EVAL_ENTRIES,
    GITIGNORE_LINE,
    step_ensure_gitignore_entry,
    step_ensure_gitignore_eval_entries,
    step_seed_candidates_log,
)

# ---------------------------------------------------------------------------
# Dispatcher + CLI
# ---------------------------------------------------------------------------


#: Sentinel signalling that the caller did not pass a ``progress``
#: argument and the dispatcher should default to ``sys.stderr``. We
#: distinguish ``None`` (silent) from "not provided" (default to stderr)
#: so test callers can reliably suppress emission with ``progress=None``.
_PROGRESS_DEFAULT: object = object()


def run_bootstrap(
    project_root: Path,
    repo: str | None,
    *,
    cache_module: Any | None = None,
    batch_size: int | None = None,
    delay_ms: int | None = None,
    state: str | None = None,
    limit: int | None = None,
    labels: tuple[str, ...] | None = None,
    author: str | None = None,
    fetch_timeout_s: float | None = None,
    progress: Any = _PROGRESS_DEFAULT,
) -> BootstrapResult:
    """Run the bootstrap pipeline, returning the aggregate result.

    Dispatches the five mutating steps documented in the module
    docstring (populate_cache, backfill_audit_log,
    ensure_gitignore_entry, ensure_gitignore_eval_entries,
    seed_candidates_log) and appends one :class:`StepOutcome` per
    step. ``len(result.steps) == 5`` is the expected post-condition.

    Repo resolution (#1237): the explicit ``repo`` argument takes
    priority. When ``None``, the dispatcher infers from ``git remote
    get-url origin`` ONCE up-front and threads the result through every
    downstream step. Pre-#1237 the populate step did the inference
    inside itself but the backfill step did not, so step 2 silently
    no-op'd with ``details.skipped="no-repo"`` on the happy path even
    when step 1 had resolved a slug from git origin. Lifting the
    resolution makes the four steps see the same answer for the same
    invocation.

    ``fetch_timeout_s`` is forwarded to :func:`step_populate_cache` and
    bounds the cache:fetch-all step so the orchestrator always exits
    even when an underlying subprocess hangs (#952).

    ``progress`` is a file-like sink for per-step status lines; it
    defaults to ``sys.stderr`` and may be set to ``None`` to silence
    emission. The lines mirror ``scripts/cache.py`` cadence so a future
    operator can see exactly which step is in flight if the run wedges.
    """

    progress_sink: Any = sys.stderr if progress is _PROGRESS_DEFAULT else progress

    # #1237: resolve the repo ONCE so every downstream step sees the
    # same answer. Mirrors the precedence chain used by
    # ``step_populate_cache`` pre-#1237 (explicit -> git remote);
    # consolidating it here eliminates the step-2 ``skipped=no-repo``
    # gap documented on issue #1237.
    effective_repo: str | None = repo
    if effective_repo is None:
        effective_repo = _infer_repo_from_git(cwd=project_root)

    result = BootstrapResult(project_root=project_root, repo=effective_repo)

    repo_detail = (
        f"repo={effective_repo}" if effective_repo else "repo=<unresolved>"
    )
    effective_timeout = (
        fetch_timeout_s if fetch_timeout_s is not None else DEFAULT_FETCH_TIMEOUT_S
    )
    timeout_detail = f"fetch_timeout_s={effective_timeout:g}"

    _emit_progress(
        progress_sink, 1, "populate_cache", "starting",
        f"{repo_detail}; {timeout_detail}",
    )
    populate = step_populate_cache(
        project_root,
        effective_repo,
        cache_module=cache_module,
        batch_size=batch_size,
        delay_ms=delay_ms,
        state=state,
        limit=limit,
        labels=labels,
        author=author,
        fetch_timeout_s=fetch_timeout_s,
    )
    result.steps.append(populate)
    populate_phase = "done" if populate.ok else (
        "timeout" if populate.details.get("timed_out") else "error"
    )
    _emit_progress(
        progress_sink, 1, "populate_cache", populate_phase, populate.message,
    )

    _emit_progress(progress_sink, 2, "backfill_audit_log", "starting", repo_detail)
    backfill = step_backfill_audit_log(project_root, effective_repo)
    result.steps.append(backfill)
    _emit_progress(
        progress_sink, 2, "backfill_audit_log",
        "done" if backfill.ok else "error", backfill.message,
    )

    _emit_progress(progress_sink, 3, "ensure_gitignore_entry", "starting")
    gi_cache = step_ensure_gitignore_entry(project_root)
    result.steps.append(gi_cache)
    _emit_progress(
        progress_sink, 3, "ensure_gitignore_entry",
        "done" if gi_cache.ok else "error", gi_cache.message,
    )

    _emit_progress(progress_sink, 4, "ensure_gitignore_eval_entries", "starting")
    gi_eval = step_ensure_gitignore_eval_entries(project_root)
    result.steps.append(gi_eval)
    _emit_progress(
        progress_sink, 4, "ensure_gitignore_eval_entries",
        "done" if gi_eval.ok else "error", gi_eval.message,
    )

    # #1240 step 5: seed the audit log so verify:cache-fresh can tell
    # "never bootstrapped" from "freshly bootstrapped, no triage
    # actions yet". Always runs; independent of repo resolution.
    _emit_progress(progress_sink, 5, "seed_candidates_log", "starting")
    seed = step_seed_candidates_log(project_root)
    result.steps.append(seed)
    _emit_progress(
        progress_sink, 5, "seed_candidates_log",
        "done" if seed.ok else "error", seed.message,
    )

    if any(not step.ok for step in result.steps):
        result.exit_code = 1
    return result


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_bootstrap.py",
        description=(
            "Idempotent triage v1 installer (#883 Story 3 rebind). "
            "Re-runnable by design; reversible via "
            "`rm -rf .deft-cache/ vbrief/.eval/` and removing the "
            ".deft-cache/ + vbrief/.eval/ lines from .gitignore."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=os.environ.get("DEFT_PROJECT_ROOT", "."),
        help=(
            "Path to the consumer project root (default: $DEFT_PROJECT_ROOT or "
            "current working directory)."
        ),
    )
    parser.add_argument(
        "--repo",
        default=os.environ.get("DEFT_TRIAGE_REPO"),
        help=(
            "Upstream repo slug 'owner/name'. Resolution precedence: "
            "(1) this explicit flag; (2) the DEFT_TRIAGE_REPO env var; "
            "(3) inferred from `git remote get-url origin` inside the populate "
            "step. Bootstrap remains partial only when all three surfaces "
            "fail to resolve a slug."
        ),
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help=(
            "Cap on the number of issues fetched (forwarded to "
            "cache:fetch-all --limit)."
        ),
    )
    parser.add_argument(
        "--state",
        default=None,
        choices=["open", "closed", "all"],
        help="Issue state filter forwarded to cache:fetch-all --state.",
    )
    parser.add_argument(
        "--label",
        action="append",
        default=None,
        dest="labels",
        metavar="NAME[,NAME...]",
        help=(
            "Scope ingestion to issues carrying the given label(s) (#1033), "
            "forwarded to cache:fetch-all --label. Repeatable and comma-"
            "separated. Composes with --author via AND."
        ),
    )
    parser.add_argument(
        "--author",
        default=None,
        metavar="LOGIN",
        help=(
            "Scope ingestion to issues created by LOGIN (#1055), forwarded "
            "to cache:fetch-all --author. Composes with --label via AND."
        ),
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=None,
        dest="batch_size",
        help="Forwarded to cache:fetch-all --batch-size.",
    )
    parser.add_argument(
        "--delay-ms",
        type=int,
        default=None,
        dest="delay_ms",
        help="Forwarded to cache:fetch-all --delay-ms.",
    )
    parser.add_argument(
        "--fetch-timeout-s",
        type=float,
        default=_default_fetch_timeout_from_env(),
        dest="fetch_timeout_s",
        help=(
            "Wall-clock cap (seconds) on the cache:fetch-all step. The "
            "watchdog protects the orchestrator from a stuck `task "
            "scm:issue:view` subprocess so bootstrap always exits in "
            "bounded time (#952). 0 disables the cap (legacy unbounded "
            "behavior). Default: $DEFT_BOOTSTRAP_FETCH_TIMEOUT_S or "
            f"{DEFAULT_FETCH_TIMEOUT_S}s."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        dest="quiet",
        help=(
            "Suppress per-step `triage:bootstrap step <i>/<N> ...` progress "
            "lines on stderr. The recap and --json output are unaffected."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="emit_json",
        help=(
            "Emit a structured JSON payload to stdout (one object per step) "
            "instead of the human-readable recap. Exit code is unchanged."
        ),
    )
    return parser


def _normalise_label_filter(raw: list[str] | None) -> tuple[str, ...]:
    """Flatten repeated + comma-separated ``--label`` values into a tuple.

    Mirrors ``cache._normalise_label_filter`` so the bootstrap and the
    underlying cache:fetch-all surface parse the multi-label convention
    identically (#1033). ``argparse(action="append")`` yields one list
    entry per flag occurrence; each entry may itself be comma-separated.
    """
    if not raw:
        return ()
    return tuple(
        item.strip()
        for value in raw
        for item in value.split(",")
        if item.strip()
    )


def _default_fetch_timeout_from_env() -> float:
    """Resolve the default ``--fetch-timeout-s`` from the environment.

    Reads ``DEFT_BOOTSTRAP_FETCH_TIMEOUT_S`` and falls back to
    :data:`DEFAULT_FETCH_TIMEOUT_S` on absence or unparseable value. A
    bad value is silently ignored (the CLI default is the canonical
    constant) so a misconfigured env never blocks an opt-in run.
    """
    raw = os.environ.get("DEFT_BOOTSTRAP_FETCH_TIMEOUT_S")
    if not raw:
        return float(DEFAULT_FETCH_TIMEOUT_S)
    try:
        return max(0.0, float(raw))
    except ValueError:
        return float(DEFAULT_FETCH_TIMEOUT_S)


def _emit_json(result: BootstrapResult) -> str:
    """Render the structured ``--json`` payload."""

    payload = {
        "project_root": str(result.project_root),
        "repo": result.repo,
        "exit_code": result.exit_code,
        "steps": [
            {
                "name": s.name,
                "ok": s.ok,
                "message": s.message,
                "error": s.error,
                "details": s.details,
            }
            for s in result.steps
        ],
    }
    return json.dumps(payload, sort_keys=True)


def main(argv: list[str] | None = None) -> int:
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_bootstrap", argv)
    if rc is not None:
        return rc
    parser = _build_parser()
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    if not project_root.exists() or not project_root.is_dir():
        msg = (
            f"❌ triage:bootstrap: --project-root {project_root} does not exist "
            "or is not a directory."
        )
        print(msg, file=sys.stderr)
        return 2

    labels = _normalise_label_filter(getattr(args, "labels", None))
    result = run_bootstrap(
        project_root=project_root,
        repo=args.repo,
        batch_size=args.batch_size,
        delay_ms=args.delay_ms,
        state=args.state,
        limit=args.limit,
        labels=labels,
        author=args.author,
        fetch_timeout_s=args.fetch_timeout_s,
        progress=None if args.quiet else sys.stderr,
    )

    if args.emit_json:
        print(_emit_json(result))
    else:
        print(result.summary())

    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
