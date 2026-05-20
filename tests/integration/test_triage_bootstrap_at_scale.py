"""tests/integration/test_triage_bootstrap_at_scale.py -- #952 regression.

Hermetic regression coverage for ``triage:bootstrap`` at backlog scale.

Background (docs/smoke-2026-05-06-v0.26.0-scale.md): the v0.26.0 unfiltered
smoke against ``deftai/directive`` ran ``task triage:bootstrap`` (which
internally calls :func:`cache.cache_fetch_all`) and observed the orchestrator
silently hang for 71+ minutes after the cache audit log went quiet at
``2026-05-06T18:00:09Z``. Root cause (per the #952 fix):
``cache.cache_fetch_all`` shells out to ``task scm:issue:view`` per issue
with no per-call timeout, so a stuck ``gh``/``ghx`` subprocess (auth
re-prompt, network stall, server hang) would block the orchestrator
indefinitely; the operator had no per-step visibility to diagnose where
the run was wedged.

This test file enforces three guarantees from the fix:

1. ``test_run_bootstrap_completes_within_wall_clock_cap`` -- a 60-issue
   hermetic backlog drives :func:`triage_bootstrap.run_bootstrap` to
   ``exit_code == 0`` within a generous wall-clock budget (≤ 30s) with
   all four steps reporting ``ok=True``. Mirrors Phase 1 of the smoke
   (50 issues / 58.5s) at slightly larger scale with the network stack
   stubbed out, so the test exercises the orchestrator's loop discipline,
   not the (unmocked) gh proxy.
2. ``test_run_bootstrap_emits_per_step_progress`` -- per-step
   ``triage:bootstrap step <i>/4 ...`` lines land on the supplied
   progress sink so future operators can see which step is in flight
   when a real run wedges.
3. ``test_run_bootstrap_watchdog_fires_when_fetch_hangs`` -- when the
   wrapped ``cache_fetch_all`` blocks past ``fetch_timeout_s``, the
   orchestrator returns control with ``populate_cache`` flagged
   ``ok=False`` + ``timed_out=True`` rather than wedging the parent
   process. This is the load-bearing property for #952.

Hermeticity: the cache layer is plumbed via the
``_cache_fetch._paginated_lister`` REST seam established under #1239
(see :mod:`tests.integration.test_cache_e2e`). No real ``gh``,
``ghx``, ``task``, or ``git`` invocations.
"""

from __future__ import annotations

import importlib
import io
import sys
import threading
import time
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

cache = importlib.import_module("cache")
_cache_fetch = importlib.import_module("_cache_fetch")
triage_bootstrap = importlib.import_module("triage_bootstrap")

REPO = "deftai/directive"
#: 60 issues -- comfortably above the 50 used by Phase 1 of the
#: 2026-05-06 smoke and small enough to keep CI fast even under
#: degraded runners.
SCALE_ISSUE_COUNT: int = 60


# ---------------------------------------------------------------------------
# Fake-gh fixture (mirrors tests/integration/test_cache_e2e.py shape)
# ---------------------------------------------------------------------------


def _fake_issue(number: int) -> dict[str, Any]:
    """REST-shape issue payload (#1239 migration)."""
    return {
        "number": number,
        "title": f"Scale fixture issue {number}",
        "body": (
            "## Summary\n\n"
            f"Scale-smoke regression body for issue {number}.\n"
            "No credentials, no injection-heading tokens, no invisible Unicode.\n"
        ),
        "state": "open",
        "user": {"login": "tester"},
        "created_at": "2026-05-01T00:00:00Z",
        "updated_at": "2026-05-05T00:00:00Z",
        "labels": [{"name": "triage"}],
        "comments": 0,
        "html_url": f"https://github.com/{REPO}/issues/{number}",
    }


@pytest.fixture
def fake_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Wire the fake REST lister + zero-delay sleep into ``_cache_fetch``."""

    numbers = tuple(range(1, SCALE_ISSUE_COUNT + 1))

    def fake_lister(repo: str, **_: Any) -> list[dict[str, Any]]:
        return [_fake_issue(n) for n in numbers]

    monkeypatch.setattr(_cache_fetch, "_paginated_lister", fake_lister)
    monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)


# ---------------------------------------------------------------------------
# Test 1 -- end-to-end bootstrap completes inside a wall-clock cap
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_run_bootstrap_completes_within_wall_clock_cap(
    tmp_path: Path, fake_cache: None
) -> None:
    """run_bootstrap returns exit 0 with all four steps OK in ≤ 30s.

    Replays the Phase 1 smoke shape (50-issue clean run finished in
    58.5s) at slightly larger scale (60 issues) with the network stack
    stubbed out. The 30s cap is generous: the un-mocked smoke spends
    most of its wall clock in ``gh``/``ghx`` subprocess RTT + the
    500ms inter-issue delay. With ``_sleep`` stubbed and ``_run_subprocess``
    returning canned JSON, the loop is CPU + scanner bound and finishes
    in a couple of seconds on commodity CI runners.
    """

    started = time.monotonic()
    result = triage_bootstrap.run_bootstrap(
        project_root=tmp_path,
        repo=REPO,
        # Override the cache:fetch-all knobs so the loop is fully
        # deterministic and we don't pull the module-level defaults.
        batch_size=10,
        delay_ms=0,
        fetch_timeout_s=30.0,
        progress=None,
    )
    elapsed = time.monotonic() - started

    assert result.exit_code == 0, (
        f"bootstrap must complete cleanly at backlog scale; got exit "
        f"{result.exit_code}; steps={[(s.name, s.ok, s.message) for s in result.steps]}"
    )
    assert elapsed < 30.0, (
        f"bootstrap exceeded the 30s hermetic wall-clock cap (elapsed={elapsed:.2f}s); "
        "the #952 fix must keep the orchestrator bounded for backlog-scale runs"
    )
    assert len(result.steps) == 5
    assert [s.name for s in result.steps] == [
        "populate_cache",
        "backfill_audit_log",
        "ensure_gitignore_entry",
        "ensure_gitignore_eval_entries",
        "seed_candidates_log",
    ]
    assert all(s.ok for s in result.steps), (
        f"every step must report ok=True; got {[(s.name, s.ok) for s in result.steps]}"
    )

    populate = result.steps[0]
    assert populate.details["succeeded"] == SCALE_ISSUE_COUNT
    assert populate.details["failed"] == 0
    assert populate.details["skipped"] == 0
    # Watchdog wired through but did not fire.
    assert populate.details["fetch_timeout_s"] == 30.0
    assert "elapsed_s" in populate.details

    # Cache layout populated for every fake issue (sanity check that we
    # actually exercised the cache code path).
    base = tmp_path / triage_bootstrap.CACHE_DIR_NAME / "github-issue" / "deftai" / "directive"
    assert base.is_dir()
    cached = sorted(int(p.name) for p in base.iterdir() if p.is_dir())
    assert cached == list(range(1, SCALE_ISSUE_COUNT + 1))

    # Gitignore lines were written. #1251: the eval step now writes the
    # three selective entries (NOT a blanket `vbrief/.eval/` line).
    gitignore = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    assert ".deft-cache/" in gitignore
    assert "vbrief/.eval/candidates.jsonl" in gitignore
    assert "vbrief/.eval/summary-history.jsonl" in gitignore
    assert "vbrief/.eval/scope-lifecycle.jsonl" in gitignore
    active_gitignore = [
        line.strip()
        for line in gitignore.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert "vbrief/.eval/" not in active_gitignore, (
        "#1251 forbids the blanket vbrief/.eval/ line in .gitignore"
    )


# ---------------------------------------------------------------------------
# Test 2 -- per-step progress emission (operator visibility)
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_run_bootstrap_emits_per_step_progress(
    tmp_path: Path, fake_cache: None
) -> None:
    """Each of the four steps emits a ``starting`` and ``done`` progress line."""

    sink = io.StringIO()
    result = triage_bootstrap.run_bootstrap(
        project_root=tmp_path,
        repo=REPO,
        batch_size=10,
        delay_ms=0,
        fetch_timeout_s=30.0,
        progress=sink,
    )
    assert result.exit_code == 0

    lines = [ln for ln in sink.getvalue().splitlines() if ln.strip()]
    # Every step should have a start + done line. The fake fixture is
    # clean, so no step should hit the 'error' / 'timeout' branches.
    expected_starts = [
        "triage:bootstrap step 1/5 populate_cache -- starting",
        "triage:bootstrap step 2/5 backfill_audit_log -- starting",
        "triage:bootstrap step 3/5 ensure_gitignore_entry -- starting",
        "triage:bootstrap step 4/5 ensure_gitignore_eval_entries -- starting",
        "triage:bootstrap step 5/5 seed_candidates_log -- starting",
    ]
    expected_dones = [
        "triage:bootstrap step 1/5 populate_cache -- done",
        "triage:bootstrap step 2/5 backfill_audit_log -- done",
        "triage:bootstrap step 3/5 ensure_gitignore_entry -- done",
        "triage:bootstrap step 4/5 ensure_gitignore_eval_entries -- done",
        "triage:bootstrap step 5/5 seed_candidates_log -- done",
    ]
    for stem in expected_starts + expected_dones:
        assert any(ln.startswith(stem) for ln in lines), (
            f"missing progress line starting with {stem!r}; emitted lines: {lines!r}"
        )


# ---------------------------------------------------------------------------
# Test 3 -- watchdog fires when cache_fetch_all hangs (#952 load-bearing)
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_run_bootstrap_watchdog_fires_when_fetch_hangs(tmp_path: Path) -> None:
    """A wedged cache_fetch_all is bounded by ``fetch_timeout_s``.

    Simulates the smoke-time hang: ``cache_fetch_all`` blocks
    indefinitely (analogue of an underlying ``task scm:issue:view``
    subprocess that never returns). The orchestrator MUST surrender
    control once ``fetch_timeout_s`` elapses and report ``ok=False``
    + ``timed_out=True`` on the populate_cache step. Without this, a
    stuck ``gh`` would silently hold the bootstrap parent process for
    the lifetime of the underlying subprocess (71+ min in the smoke).
    """

    def _hanging_fetch_all(**_kwargs: Any) -> Any:
        # Sleep well past the test's timeout. Never return.
        time.sleep(60.0)
        raise AssertionError("watchdog failed: hanging fetch returned")

    fake_cache_module = mock.Mock()
    fake_cache_module.cache_fetch_all = _hanging_fetch_all

    started = time.monotonic()
    outcome = triage_bootstrap.step_populate_cache(
        tmp_path,
        repo=REPO,
        cache_module=fake_cache_module,
        fetch_timeout_s=0.5,
    )
    elapsed = time.monotonic() - started

    assert outcome.ok is False
    assert outcome.details.get("timed_out") is True, (
        f"watchdog must flag timed_out on a wedged fetch; details={outcome.details!r}"
    )
    assert outcome.details["fetch_timeout_s"] == 0.5
    # The watchdog releases the main thread close to the deadline; allow
    # generous slack for slow CI but reject anything that suggests the
    # orchestrator was actually waiting on the hung call.
    assert elapsed < 5.0, (
        f"orchestrator must return inside ~timeout window; "
        f"actual elapsed={elapsed:.2f}s, timeout=0.5s"
    )
    assert outcome.error is not None
    assert "fetch_timeout_s" in outcome.error


# ---------------------------------------------------------------------------
# Test 3b -- run_bootstrap end-to-end watchdog (P2 cleanup for #955)
# ---------------------------------------------------------------------------
#
# Test 3 above exercises ``step_populate_cache`` directly, which leaves
# the ``run_bootstrap`` ``timeout`` progress-emit branch (the
# ``populate_phase = "timeout"`` selector at scripts/triage_bootstrap.py
# around the populate-step emit) untested. The watchdog contract is
# only meaningful at the orchestrator level: the operator runs
# ``task triage:bootstrap``, not ``step_populate_cache`` in isolation.
# This test drives ``run_bootstrap`` end-to-end with a hung fetch and
# asserts the three load-bearing properties:
#
#   (a) the watchdog actually fires (populate_cache.ok=False +
#       details["timed_out"]=True);
#   (b) the structured ``starting`` and ``timeout`` progress lines
#       both land on the supplied sink so a future operator can see
#       which step wedged from stderr alone;
#   (c) the orchestrator returns the structured failure exit per the
#       watchdog contract (``exit_code == 1`` with the remaining
#       non-fetch steps still attempted -- the bootstrap is partial,
#       not aborted).


@pytest.mark.slow
def test_run_bootstrap_watchdog_emits_timeout_progress_and_structured_exit(
    tmp_path: Path,
) -> None:
    """run_bootstrap drives the timeout progress-emit branch end-to-end."""

    def _hanging_fetch_all(**_kwargs: Any) -> Any:
        # Sleep well past the test's timeout. Never return.
        time.sleep(60.0)
        raise AssertionError("watchdog failed: hanging fetch returned")

    fake_cache_module = mock.Mock()
    fake_cache_module.cache_fetch_all = _hanging_fetch_all

    sink = io.StringIO()
    started = time.monotonic()
    result = triage_bootstrap.run_bootstrap(
        project_root=tmp_path,
        repo=REPO,
        cache_module=fake_cache_module,
        fetch_timeout_s=0.5,
        progress=sink,
    )
    elapsed = time.monotonic() - started

    # (a) Watchdog fired on the populate step.
    assert len(result.steps) == 5, (
        f"orchestrator must continue past the wedged fetch and run all five "
        f"steps; got {[(s.name, s.ok) for s in result.steps]}"
    )
    populate = result.steps[0]
    assert populate.name == "populate_cache"
    assert populate.ok is False
    assert populate.details.get("timed_out") is True, (
        f"watchdog must flag timed_out on a wedged fetch via run_bootstrap; "
        f"details={populate.details!r}"
    )
    assert populate.details["fetch_timeout_s"] == 0.5
    assert populate.error is not None and "fetch_timeout_s" in populate.error

    # The orchestrator must return inside ~timeout window even though
    # the underlying fetch is still wedged in its daemon thread; allow
    # generous slack for slow CI runners.
    assert elapsed < 10.0, (
        f"run_bootstrap must surrender control near the deadline; "
        f"actual elapsed={elapsed:.2f}s, timeout=0.5s"
    )

    # (b) The ``starting`` and ``timeout`` progress lines for step 1/4
    # both land on the sink. This is the regression-bearing assertion:
    # the ``timeout`` phase was previously unreachable through any
    # test, so a refactor that flipped the populate_phase selector to
    # ``error`` (or dropped the timeout branch entirely) would have
    # gone unnoticed.
    lines = [ln for ln in sink.getvalue().splitlines() if ln.strip()]
    assert any(
        ln.startswith("triage:bootstrap step 1/5 populate_cache -- starting")
        for ln in lines
    ), f"missing starting line; emitted={lines!r}"
    timeout_lines = [
        ln for ln in lines
        if ln.startswith("triage:bootstrap step 1/5 populate_cache -- timeout")
    ]
    assert timeout_lines, (
        f"orchestrator must emit a ``timeout`` progress line for the wedged "
        f"populate_cache step; emitted={lines!r}"
    )
    # The non-fetch steps still emit their own progress; this confirms
    # the orchestrator did not bail out at the watchdog.
    assert any(
        ln.startswith("triage:bootstrap step 3/5 ensure_gitignore_entry -- done")
        for ln in lines
    ), f"post-watchdog steps must still run; emitted={lines!r}"

    # (c) Structured failure exit per the watchdog contract.
    assert result.exit_code == 1, (
        f"a failed populate_cache step must surface as exit_code=1; "
        f"got {result.exit_code}; steps={[(s.name, s.ok) for s in result.steps]}"
    )
    # The non-fetch steps are independent of the cache layer and must
    # still succeed (gitignore is purely local); otherwise the
    # ``partial bootstrap`` invariant from the #952 fix is broken.
    assert result.steps[2].ok is True  # ensure_gitignore_entry
    assert result.steps[3].ok is True  # ensure_gitignore_eval_entries


# ---------------------------------------------------------------------------
# Test 3c -- silent BaseException in daemon thread (Greptile P1 #955)
# ---------------------------------------------------------------------------
#
# A ``BaseException`` subclass (e.g. ``SystemExit`` from a nested
# ``sys.exit()`` inside ``cache_fetch_all``) terminates the watchdog's
# daemon thread without populating ``box["exc"]`` -- Python threading
# does not propagate ``BaseException`` to the joining thread. Without
# the sentinel guard in ``_run_with_timeout``, the function would fall
# through to the success branch with ``report=None``, returning ok=True
# with ``succeeded=None``. This test pins the synthesized RuntimeError
# path so a regression that drops the sentinel guard is caught.


def test_run_with_timeout_synthesizes_error_on_silent_thread_death(
    tmp_path: Path,
) -> None:
    """BaseException in the daemon thread surfaces as ok=False, not silent ok=True."""

    def _suicide(**_kwargs: Any) -> Any:
        # SystemExit is a BaseException, not Exception, so the runner's
        # except-Exception guard does NOT catch it; the daemon thread
        # terminates silently. The sentinel-based guard added under the
        # P1 cleanup synthesizes a RuntimeError so the populate step
        # reports ok=False instead of falling through to ok=True with
        # succeeded=None.
        raise SystemExit("simulated nested sys.exit inside fetch_all")

    fake_cache_module = mock.Mock()
    fake_cache_module.cache_fetch_all = _suicide

    # Silence the threading.excepthook noise that SystemExit-in-thread
    # produces. The synthesized RuntimeError is the load-bearing
    # observable; the excepthook traceback is just stderr clutter.
    original_hook = threading.excepthook
    threading.excepthook = lambda _args: None
    try:
        outcome = triage_bootstrap.step_populate_cache(
            tmp_path,
            repo=REPO,
            cache_module=fake_cache_module,
            fetch_timeout_s=5.0,
        )
    finally:
        threading.excepthook = original_hook

    assert outcome.ok is False, (
        "a BaseException raised inside the daemon thread MUST surface as "
        "ok=False; the silent-thread-death gap was a Greptile P1 finding"
    )
    assert outcome.details.get("failed") == "fetch-all-error"
    assert outcome.details.get("exc_type") == "RuntimeError"
    assert outcome.error is not None
    assert "BaseException" in outcome.error or "thread" in outcome.error.lower()
    # The watchdog timeout slot MUST NOT be set -- this is an exception
    # path, not a timeout path.
    assert outcome.details.get("timed_out") is None


# ---------------------------------------------------------------------------
# Test 4 -- watchdog disable (legacy unbounded behavior)
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_run_bootstrap_watchdog_disabled_with_zero_timeout(
    tmp_path: Path, fake_cache: None
) -> None:
    """``fetch_timeout_s=0`` restores the legacy unbounded behavior.

    Operators who explicitly want to opt out of the watchdog (because
    they're running with a known-slow proxy and a high backlog count)
    can pass ``--fetch-timeout-s=0``. The step still completes
    successfully against the hermetic fixture; we just assert that the
    watchdog did not pre-empt the call.
    """

    result = triage_bootstrap.step_populate_cache(
        tmp_path,
        repo=REPO,
        batch_size=10,
        delay_ms=0,
        fetch_timeout_s=0,
    )
    assert result.ok is True
    assert result.details.get("timed_out") is None
    assert result.details["succeeded"] == SCALE_ISSUE_COUNT
    assert result.details["fetch_timeout_s"] == 0
