"""Tests for scripts/preflight_cache.py (#1127, D5 of #1119).

Covers the three-state exit contract (0 fresh / 1 stale-or-blocked /
2 config-error), the ``--for-issue`` decision-state matrix, the
``--allow-stale`` and ``--allow-missing-bootstrap`` escape hatches, the
D12 subscription-aware filtering surface, and the ``task check``
aggregate wiring.

Tests drive :func:`preflight_cache.evaluate` directly so we don't depend
on a real cache layout (the helpers in this module synthesize the
``.deft-cache/<source>/<owner>/<repo>/<N>/`` skeleton under ``tmp_path``).
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT_PATH = REPO_ROOT / "scripts" / "preflight_cache.py"
TRIAGE_SCOPE_PATH = REPO_ROOT / "scripts" / "triage_scope.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def preflight():
    # triage_scope must be importable as a sibling module so the
    # subscription-aware path resolves; the gate also imports
    # _triage_scope_cli at CLI entry, so make sure it's loadable too.
    _load_module("triage_scope", TRIAGE_SCOPE_PATH)
    cli_path = REPO_ROOT / "scripts" / "_triage_scope_cli.py"
    if cli_path.is_file():
        _load_module("_triage_scope_cli", cli_path)
    return _load_module("preflight_cache", PREFLIGHT_PATH)


# ---------------------------------------------------------------------------
# Filesystem fixture helpers
# ---------------------------------------------------------------------------


def _utc_iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write_meta(
    project_root: Path,
    repo: str,
    issue_number: int,
    fetched_at: datetime,
    *,
    source: str = "github-issue",
    raw_state: str = "open",
    raw_labels: list[str] | None = None,
    raw_title: str = "fixture issue",
    raw_milestone: str | None = None,
) -> Path:
    """Synthesize a single cache entry under ``project_root/.deft-cache/``."""
    owner, name = repo.split("/", 1)
    entry_dir = (
        project_root
        / ".deft-cache"
        / source
        / owner
        / name
        / str(issue_number)
    )
    entry_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "source": source,
        "key": f"{owner}/{name}/{issue_number}",
        "fetched_at": _utc_iso(fetched_at),
        "ttl_seconds": 7 * 24 * 60 * 60,
        "expires_at": _utc_iso(fetched_at + timedelta(days=7)),
        "scan_result": {
            "passed": True,
            "scanned_at": _utc_iso(fetched_at),
            "scanner_version": "1.0.0",
            "flags": [],
        },
        "size_bytes": 256,
        "stale": False,
    }
    (entry_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, sort_keys=True), encoding="utf-8"
    )
    raw = {
        "number": issue_number,
        "title": raw_title,
        "state": raw_state,
        "labels": [{"name": label} for label in (raw_labels or [])],
        "milestone": {"title": raw_milestone} if raw_milestone else None,
        "body": "",
        "created_at": _utc_iso(fetched_at - timedelta(days=1)),
        "updated_at": _utc_iso(fetched_at),
    }
    (entry_dir / "raw.json").write_text(
        json.dumps(raw, indent=2, sort_keys=True), encoding="utf-8"
    )
    return entry_dir


def _write_candidates(
    project_root: Path,
    entries: list[dict],
) -> Path:
    """Write ``vbrief/.eval/candidates.jsonl`` with the given entries."""
    path = project_root / "vbrief" / ".eval" / "candidates.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(entry, sort_keys=True) + "\n")
    return path


def _decision(
    repo: str,
    issue_number: int,
    decision: str,
    *,
    timestamp: datetime,
    actor: str = "agent:test",
    reason: str | None = None,
    linked_to: int | None = None,
    prior_decision_id: str | None = None,
) -> dict:
    out: dict = {
        "decision_id": str(uuid.uuid4()),
        "timestamp": _utc_iso(timestamp),
        "repo": repo,
        "issue_number": issue_number,
        "decision": decision,
        "actor": actor,
    }
    if reason is not None:
        out["reason"] = reason
    if linked_to is not None:
        out["linked_to"] = linked_to
    if prior_decision_id is not None:
        out["prior_decision_id"] = prior_decision_id
    return out


def _write_project_definition(project_root: Path, payload: dict) -> Path:
    path = project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Suite 1: three-state exit-code contract
# ---------------------------------------------------------------------------


class TestExitCodeContract:
    def test_fresh_cache_exits_zero(self, preflight, tmp_path):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 1127, now - timedelta(hours=2))
        _write_candidates(
            tmp_path,
            [_decision("deftai/directive", 1127, "accept", timestamp=now)],
        )
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        assert result.code == 0
        assert "✓" in result.message
        assert "deftai/directive" in result.message

    def test_stale_cache_exits_one_with_remediation(self, preflight, tmp_path):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        # 30h old > default 24h
        _write_meta(tmp_path, "deftai/directive", 1127, now - timedelta(hours=30))
        _write_candidates(
            tmp_path,
            [_decision("deftai/directive", 1127, "accept", timestamp=now)],
        )
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        assert result.code == 1
        assert "stale" not in result.message.lower() or "max-age" in result.message
        # Remediation MUST name both bootstrap and fetch-all per issue body.
        assert "task triage:bootstrap" in result.message
        assert "task cache:fetch-all" in result.message
        assert "--allow-stale" in result.message

    def test_missing_cache_exits_two(self, preflight, tmp_path):
        # No .deft-cache/ at all.
        _write_candidates(tmp_path, [])
        result = preflight.evaluate(tmp_path, repo="deftai/directive")
        assert result.code == 2
        assert ".deft-cache/" in result.message
        assert "task triage:bootstrap" in result.message

    def test_missing_candidates_jsonl_exits_two(self, preflight, tmp_path):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 1127, now - timedelta(hours=2))
        # Intentionally no candidates.jsonl.
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        assert result.code == 2
        assert "candidates.jsonl" in result.message
        assert "task triage:bootstrap" in result.message

    def test_empty_cache_repo_exits_two(self, preflight, tmp_path):
        """Cache root present but repo dir empty -> config error."""
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        (tmp_path / ".deft-cache" / "github-issue").mkdir(parents=True)
        _write_candidates(tmp_path, [])
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        assert result.code == 2

    def test_cannot_resolve_repo_exits_two(self, preflight, tmp_path, monkeypatch):
        """No --repo, no env, no git, multi-repo cache -> config error."""
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(tmp_path, "alpha/one", 1, now - timedelta(hours=1))
        _write_meta(tmp_path, "beta/two", 2, now - timedelta(hours=1))
        _write_candidates(tmp_path, [])
        monkeypatch.delenv("DEFT_TRIAGE_REPO", raising=False)
        # Forge a non-git cwd by pointing at tmp_path (no .git inside).
        # _infer_repo_from_git returns None because `git remote` fails outside
        # a repo.
        result = preflight.evaluate(tmp_path, repo=None, now=now)
        assert result.code == 2


# ---------------------------------------------------------------------------
# Suite 2: --for-issue decision-state matrix
# ---------------------------------------------------------------------------


class TestForIssueDecisionMatrix:
    def _setup(self, tmp_path, now):
        _write_meta(tmp_path, "deftai/directive", 1127, now - timedelta(hours=1))
        return now

    @pytest.mark.parametrize(
        "decision",
        ["defer", "reject", "needs-ac"],
    )
    def test_non_accept_decisions_block(self, preflight, tmp_path, decision):
        now = self._setup(tmp_path, datetime(2026, 5, 17, 12, tzinfo=UTC))
        kwargs = {"timestamp": now}
        if decision == "reject":
            kwargs["reason"] = "duplicate"
        _write_candidates(
            tmp_path,
            [_decision("deftai/directive", 1127, decision, **kwargs)],
        )
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=1127,
            now=now,
        )
        assert result.code == 1
        assert decision in result.message
        assert "task triage:status" in result.message

    def test_missing_decision_blocks(self, preflight, tmp_path):
        now = self._setup(tmp_path, datetime(2026, 5, 17, 12, tzinfo=UTC))
        _write_candidates(tmp_path, [])
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=1127,
            now=now,
        )
        assert result.code == 1
        assert "no triage decision" in result.message
        assert "task triage:accept" in result.message

    def test_accept_decision_passes(self, preflight, tmp_path):
        now = self._setup(tmp_path, datetime(2026, 5, 17, 12, tzinfo=UTC))
        _write_candidates(
            tmp_path,
            [_decision("deftai/directive", 1127, "accept", timestamp=now)],
        )
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=1127,
            now=now,
        )
        assert result.code == 0
        assert "Issue #1127" in result.message

    def test_latest_decision_wins_over_earlier_accept(self, preflight, tmp_path):
        """A later defer overrides an earlier accept -- dispatch blocked."""
        now = self._setup(tmp_path, datetime(2026, 5, 17, 12, tzinfo=UTC))
        earlier = now - timedelta(hours=3)
        _write_candidates(
            tmp_path,
            [
                _decision("deftai/directive", 1127, "accept", timestamp=earlier),
                _decision("deftai/directive", 1127, "defer", timestamp=now),
            ],
        )
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=1127,
            now=now,
        )
        assert result.code == 1
        assert "defer" in result.message


# ---------------------------------------------------------------------------
# Suite 3: --allow-stale escape hatch
# ---------------------------------------------------------------------------


class TestAllowStaleOverride:
    def test_allow_stale_clears_stale_cache(self, preflight, tmp_path):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 1127, now - timedelta(hours=72))
        _write_candidates(
            tmp_path,
            [_decision("deftai/directive", 1127, "accept", timestamp=now)],
        )
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            allow_stale=True,
            now=now,
        )
        assert result.code == 0
        assert "⚠" in result.message
        assert "--allow-stale" in result.message

    def test_allow_stale_still_blocks_for_issue_defer(self, preflight, tmp_path):
        """--allow-stale must NOT silently bypass a defer/reject decision."""
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 1127, now - timedelta(hours=72))
        _write_candidates(
            tmp_path,
            [_decision("deftai/directive", 1127, "defer", timestamp=now)],
        )
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=1127,
            allow_stale=True,
            now=now,
        )
        assert result.code == 1
        assert "defer" in result.message


# ---------------------------------------------------------------------------
# Suite 4: --allow-missing-bootstrap (framework `task check` fallback)
# ---------------------------------------------------------------------------


class TestAllowMissingBootstrap:
    def test_missing_cache_with_flag_passes(self, preflight, tmp_path):
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            allow_missing_bootstrap=True,
        )
        assert result.code == 0
        assert "bootstrap state" in result.message

    def test_missing_candidates_with_flag_passes(self, preflight, tmp_path):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 1127, now - timedelta(hours=1))
        # No candidates.jsonl.
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            allow_missing_bootstrap=True,
            now=now,
        )
        assert result.code == 0
        assert "bootstrap state" in result.message

    def test_flag_ignored_when_for_issue_passed(self, preflight, tmp_path):
        """--allow-missing-bootstrap MUST NOT mask a --for-issue dispatch."""
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=1127,
            allow_missing_bootstrap=True,
        )
        assert result.code == 2


# ---------------------------------------------------------------------------
# Suite 5: subscription-awareness (D12 / #1131)
# ---------------------------------------------------------------------------


class TestSubscriptionAwareness:
    def test_default_subscription_covers_all_open(self, preflight, tmp_path):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(
            tmp_path, "deftai/directive", 1127, now - timedelta(hours=1),
            raw_labels=["bug"],
        )
        _write_candidates(
            tmp_path,
            [_decision("deftai/directive", 1127, "accept", timestamp=now)],
        )
        # No PROJECT-DEFINITION -> framework default = all-open.
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=1127,
            now=now,
        )
        assert result.code == 0

    def test_labels_scope_excludes_unlabelled_issue(self, preflight, tmp_path):
        """A `labels` rule with any-of=[priority/p0] excludes a bug-only issue."""
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(
            tmp_path, "deftai/directive", 999, now - timedelta(hours=1),
            raw_labels=["bug"],
        )
        _write_candidates(
            tmp_path,
            [_decision("deftai/directive", 999, "accept", timestamp=now)],
        )
        _write_project_definition(
            tmp_path,
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": "T",
                    "status": "running",
                    "items": [],
                    "policy": {
                        "triageScope": [
                            {"rule": "labels", "any-of": ["priority/p0"]}
                        ]
                    },
                },
            },
        )
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=999,
            now=now,
        )
        assert result.code == 1
        # Either "OUTSIDE" subscription text or empty-scope text accepted.
        assert (
            "OUTSIDE" in result.message
            or "outside the active" in result.message
        )

    def test_labels_scope_includes_matching_issue(self, preflight, tmp_path):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(
            tmp_path, "deftai/directive", 999, now - timedelta(hours=1),
            raw_labels=["priority/p0", "bug"],
        )
        _write_candidates(
            tmp_path,
            [_decision("deftai/directive", 999, "accept", timestamp=now)],
        )
        _write_project_definition(
            tmp_path,
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": "T",
                    "status": "running",
                    "items": [],
                    "policy": {
                        "triageScope": [
                            {"rule": "labels", "any-of": ["priority/p0"]}
                        ]
                    },
                },
            },
        )
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=999,
            now=now,
        )
        assert result.code == 0


# ---------------------------------------------------------------------------
# Suite 5b: Greptile P1 regression -- empty-scope + --allow-stale + --for-issue
# ---------------------------------------------------------------------------


class TestEmptyScopeAllowStaleForIssueGuard:
    """Empty-scope branch must NOT silently bypass --for-issue when --allow-stale.

    Greptile P1 finding on PR #1192: the empty-scope branch (Step 4 in
    :func:`preflight_cache.evaluate`) previously early-returned exit 0
    on ``allow_stale=True`` BEFORE invoking :func:`_gate_for_issue`, so a
    dispatcher passing both ``--allow-stale`` and ``--for-issue N`` could
    silently dispatch against a refused issue. The Step 5 stale-cache
    branch already guarded against this -- the empty-scope branch now
    mirrors that pattern.
    """

    @staticmethod
    def _empty_scope_fixture(tmp_path, now, *, issue_decision, issue_number=999):
        """Populate cache + project-definition so every entry is out of scope.

        The cache holds one issue (``issue_number``) labelled ``bug``; the
        ``plan.policy.triageScope[]`` requires ``priority/p0``. After the
        subscription filter runs, scoped_meta_paths is empty -- triggering
        Step 4's empty-scope branch.
        """
        _write_meta(
            tmp_path, "deftai/directive", issue_number,
            now - timedelta(hours=1),
            raw_labels=["bug"],  # NOT in scope
        )
        if issue_decision is not None:
            kwargs = {"timestamp": now}
            if issue_decision == "reject":
                kwargs["reason"] = "duplicate"
            _write_candidates(
                tmp_path,
                [_decision(
                    "deftai/directive", issue_number, issue_decision, **kwargs,
                )],
            )
        else:
            _write_candidates(tmp_path, [])
        _write_project_definition(
            tmp_path,
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": "T",
                    "status": "running",
                    "items": [],
                    "policy": {
                        "triageScope": [
                            {"rule": "labels", "any-of": ["priority/p0"]}
                        ]
                    },
                },
            },
        )

    @pytest.mark.parametrize(
        "decision",
        ["defer", "reject", "needs-ac"],
    )
    def test_allow_stale_does_not_bypass_non_accept_decision_in_empty_scope(
        self, preflight, tmp_path, decision,
    ):
        """P1 regression: empty-scope + --allow-stale + --for-issue with a
        non-accept (or refused-scope) decision MUST exit 1, not exit 0."""
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        self._empty_scope_fixture(tmp_path, now, issue_decision=decision)
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=999,
            allow_stale=True,
            now=now,
        )
        # Refusal MUST propagate; --allow-stale must not paper over it.
        assert result.code == 1
        # Refusal can surface as either the OUTSIDE-subscription block
        # (scope check refuses first) or the decision-verdict block --
        # both routes are correct propagations of a refusal. The contract
        # is "non-zero exit", not a specific message.
        assert (
            "OUTSIDE" in result.message
            or "outside the active" in result.message
            or decision in result.message
        )

    def test_allow_stale_does_not_bypass_missing_decision_in_empty_scope(
        self, preflight, tmp_path,
    ):
        """P1 regression: empty-scope + --allow-stale + --for-issue with NO
        prior decision MUST exit 1 (no silent dispatch)."""
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        self._empty_scope_fixture(tmp_path, now, issue_decision=None)
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=999,
            allow_stale=True,
            now=now,
        )
        assert result.code == 1

    def test_allow_stale_still_blocks_out_of_scope_for_issue_with_accept(
        self, preflight, tmp_path,
    ):
        """Symmetric coverage: even an accept decision must NOT clear the
        gate when the for-issue target is itself out of subscription scope.
        The --allow-stale flag does not relax the scope contract."""
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        self._empty_scope_fixture(tmp_path, now, issue_decision="accept")
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            for_issue=999,
            allow_stale=True,
            now=now,
        )
        # Issue 999 is out of scope (label "bug" not matched by
        # any-of=["priority/p0"]) -- _gate_for_issue refuses on scope.
        assert result.code == 1
        assert "OUTSIDE" in result.message or "outside the active" in result.message

    def test_allow_stale_clears_empty_scope_when_no_for_issue(
        self, preflight, tmp_path,
    ):
        """Baseline preserved: empty-scope + EMPTY audit log + --allow-stale
        (no --for-issue) still exits 0 with the warning.

        Post-#1245 the fixture uses ``issue_decision=None`` (audit log
        empty) so the empty-scope branch falls into the widen-subscription
        path that ``--allow-stale`` can clear -- a populated audit log
        triggers the #1245 backfill-only-cache exit-0 path instead and
        bypasses ``--allow-stale`` entirely (see
        :class:`TestBackfillOnlyCacheState`).
        """
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        self._empty_scope_fixture(tmp_path, now, issue_decision=None)
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            allow_stale=True,
            now=now,
        )
        assert result.code == 0
        assert "\u26a0" in result.message  # ⚠ warning glyph
        assert "--allow-stale" in result.message


# ---------------------------------------------------------------------------
# Suite 5c: #1245 backfill-only cache state
# ---------------------------------------------------------------------------


class TestBackfillOnlyCacheState:
    """Empty-scope + populated audit log exits 0 (#1245).

    The pre-#1245 gate iterated ``meta_paths`` from ``.deft-cache/`` and
    refused any state where every cached entry was outside the active
    ``plan.policy.triageScope[]`` subscription -- even when the consumer
    had just run ``task triage:bootstrap`` and the backfilled ``accept``
    audit-log rows showed they were actively triaging. The recommended
    recovery ("widen the subscription") was wrong; the actual state was a
    ``backfill-only cache`` (cached open issues simply did not happen to
    match the operator's narrow subscription) and the session-start gate
    should pass so the pre-``start_agent`` stack composes.

    Downstream ``--for-issue`` dispatch still enforces per-issue scope +
    decision via :func:`_gate_for_issue`, so the relaxation only affects
    the cache-wide session check.
    """

    @staticmethod
    def _backfill_fixture(
        tmp_path,
        now,
        *,
        issue_number=999,
        raw_labels=None,
        meta_age_hours=1,
        audit_decision="accept",
    ):
        """Populate cache + audit log so the empty-scope branch fires.

        ``raw_labels`` defaults to ``["bug"]`` so the cached issue is
        out of scope under a ``priority/p0`` ``labels`` rule. The audit
        log carries one decision per ``audit_decision`` (or none when
        ``audit_decision is None``).
        """
        labels = raw_labels if raw_labels is not None else ["bug"]
        _write_meta(
            tmp_path,
            "deftai/directive",
            issue_number,
            now - timedelta(hours=meta_age_hours),
            raw_labels=labels,
        )
        if audit_decision is None:
            _write_candidates(tmp_path, [])
        else:
            kwargs = {"timestamp": now}
            if audit_decision == "reject":
                kwargs["reason"] = "duplicate"
            _write_candidates(
                tmp_path,
                [_decision(
                    "deftai/directive", issue_number, audit_decision, **kwargs,
                )],
            )
        _write_project_definition(
            tmp_path,
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": "T",
                    "status": "running",
                    "items": [],
                    "policy": {
                        "triageScope": [
                            {"rule": "labels", "any-of": ["priority/p0"]}
                        ]
                    },
                },
            },
        )

    def test_backfill_only_cache_with_populated_audit_log_exits_zero(
        self, preflight, tmp_path,
    ):
        """Primary #1245 DoD: empty-scope + populated audit log -> exit 0."""
        now = datetime(2026, 5, 20, 13, tzinfo=UTC)
        self._backfill_fixture(tmp_path, now)
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        assert result.code == 0, (
            f"expected exit 0 on backfill-only cache, got {result.code}: "
            f"{result.message!r}"
        )

    def test_backfill_only_cache_message_names_state(
        self, preflight, tmp_path,
    ):
        """OK message must surface the backfill-only-cache state so the
        operator is not surprised that ``triage:queue`` etc. show zero
        in-scope rows."""
        now = datetime(2026, 5, 20, 13, tzinfo=UTC)
        self._backfill_fixture(tmp_path, now)
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        assert result.code == 0
        assert "backfill-only cache" in result.message
        # 0 in-scope rows must be reported, not the total cache size.
        assert "0 entry/ies in scope" in result.message
        # Do NOT use the #1240 state-2/state-3 phrasing for this state.
        assert "fresh bootstrap, no triage actions yet" not in result.message
        assert "actively triaging" not in result.message

    def test_empty_scope_empty_audit_log_still_blocks(
        self, preflight, tmp_path,
    ):
        """Regression guard: when the audit log is empty AND scope is empty,
        the gate still refuses (exit 1) -- the consumer has not triaged
        anything AND nothing is in subscription, which IS a misconfiguration.
        """
        now = datetime(2026, 5, 20, 13, tzinfo=UTC)
        self._backfill_fixture(tmp_path, now, audit_decision=None)
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        assert result.code == 1
        # Updated remediation now also names task triage:accept and is
        # explicit about the audit log being empty.
        assert "audit log" in result.message.lower()
        assert "task triage:scope" in result.message
        assert "task cache:fetch-all" in result.message

    def test_backfill_only_for_issue_in_scope_accept_passes(
        self, preflight, tmp_path,
    ):
        """--for-issue=N with N in scope + accept decision still clears.

        Sets up a backfill-only cache (issue 999 out of scope with
        accept history) AND a second cached issue 1245 carrying the
        in-scope label + an accept decision. The session gate clears
        on the backfill-only relaxation; --for-issue=1245 then clears
        independently via :func:`_gate_for_issue`.
        """
        now = datetime(2026, 5, 20, 13, tzinfo=UTC)
        self._backfill_fixture(tmp_path, now, issue_number=999)
        # Add a second cached issue that IS in scope.
        _write_meta(
            tmp_path, "deftai/directive", 1245, now - timedelta(hours=1),
            raw_labels=["priority/p0"],
        )
        # Append the second decision to the candidates log.
        with (tmp_path / "vbrief" / ".eval" / "candidates.jsonl").open(
            "a", encoding="utf-8",
        ) as fh:
            fh.write(json.dumps(
                _decision("deftai/directive", 1245, "accept", timestamp=now),
                sort_keys=True,
            ) + "\n")
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", for_issue=1245, now=now,
        )
        assert result.code == 0
        assert "Issue #1245" in result.message

    def test_backfill_only_for_issue_out_of_scope_refuses(
        self, preflight, tmp_path,
    ):
        """--for-issue=N with N out of scope still refuses even when the
        cache-wide session check passes on the backfill-only relaxation.
        """
        now = datetime(2026, 5, 20, 13, tzinfo=UTC)
        self._backfill_fixture(tmp_path, now, issue_number=999)
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", for_issue=999, now=now,
        )
        assert result.code == 1
        assert (
            "OUTSIDE" in result.message
            or "outside the active" in result.message
        )

    @pytest.mark.parametrize("decision", ["defer", "reject", "needs-ac"])
    def test_backfill_only_for_issue_non_accept_decision_refuses(
        self, preflight, tmp_path, decision,
    ):
        """--for-issue=N with a non-accept latest decision still refuses
        on the backfill-only relaxation path. The scope check fires
        first (issue is out-of-scope under the fixture) so the OUTSIDE
        message is the canonical surface; the contract this test pins
        is "non-zero exit" rather than a specific message.
        """
        now = datetime(2026, 5, 20, 13, tzinfo=UTC)
        self._backfill_fixture(
            tmp_path, now, issue_number=999, audit_decision=decision,
        )
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", for_issue=999, now=now,
        )
        assert result.code == 1

    def test_backfill_only_stale_cache_still_fails(
        self, preflight, tmp_path,
    ):
        """Stale cache + backfill-only state still surfaces as stale.

        The relaxation only covers "every cached entry is out of
        subscription", not "every cached entry is also expired". When
        the cache is older than the max-age window the operator MUST
        re-fetch regardless of subscription overlap.
        """
        now = datetime(2026, 5, 20, 13, tzinfo=UTC)
        self._backfill_fixture(tmp_path, now, meta_age_hours=72)
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now,
        )
        assert result.code == 1
        assert "max-age" in result.message or "stale" in result.message.lower()
        assert "task cache:fetch-all" in result.message

    def test_candidates_jsonl_entries_not_evaluated_against_scope(
        self, preflight, tmp_path,
    ):
        """Document the candidate-vs-audit-log separation (#1245 Q1).

        The scope filter iterates ``.deft-cache/<source>/<repo>/*/meta.json``
        + ``raw.json`` (the live candidate set), NOT
        ``vbrief/.eval/candidates.jsonl`` (the immutable decision audit
        log). Audit-log entries are NEVER subject to subscription
        filtering. This test pins the separation by populating the
        audit log with decisions whose ``issue_number`` does NOT
        correspond to any cached ``meta.json`` and confirming the gate
        still treats the cache as backfill-only-with-audit-populated.
        """
        now = datetime(2026, 5, 20, 13, tzinfo=UTC)
        # Cache: issue 999 (out of scope under priority/p0).
        _write_meta(
            tmp_path, "deftai/directive", 999, now - timedelta(hours=1),
            raw_labels=["bug"],
        )
        # Audit log: decisions for OTHER issue numbers (no matching cache).
        # If the gate evaluated candidates.jsonl against scope it would
        # have to attempt scope-resolve on these issue numbers, fail
        # because no raw.json exists, and emit a different message.
        _write_candidates(
            tmp_path,
            [
                _decision("deftai/directive", 100, "accept", timestamp=now),
                _decision("deftai/directive", 101, "accept", timestamp=now),
                _decision("deftai/directive", 102, "accept", timestamp=now),
            ],
        )
        _write_project_definition(
            tmp_path,
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": "T",
                    "status": "running",
                    "items": [],
                    "policy": {
                        "triageScope": [
                            {"rule": "labels", "any-of": ["priority/p0"]}
                        ]
                    },
                },
            },
        )
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now,
        )
        assert result.code == 0
        assert "backfill-only cache" in result.message


# ---------------------------------------------------------------------------
# Suite 6: --max-age-hours / env var resolution
# ---------------------------------------------------------------------------


class TestMaxAgeResolution:
    def test_explicit_flag_overrides_env(self, preflight, tmp_path, monkeypatch):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 1, now - timedelta(hours=5))
        _write_candidates(tmp_path, [])
        monkeypatch.setenv("DEFT_CACHE_MAX_AGE_HOURS", "1")
        # Explicit flag of 24h beats env's 1h.
        result = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            max_age_hours=24,
            now=now,
        )
        assert result.code == 0

    def test_env_var_honoured_when_flag_absent(
        self, preflight, tmp_path, monkeypatch
    ):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 1, now - timedelta(hours=5))
        _write_candidates(tmp_path, [])
        monkeypatch.setenv("DEFT_CACHE_MAX_AGE_HOURS", "1")
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        assert result.code == 1

    def test_unparseable_env_falls_back_to_default(
        self, preflight, tmp_path, monkeypatch
    ):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 1, now - timedelta(hours=5))
        _write_candidates(tmp_path, [])
        monkeypatch.setenv("DEFT_CACHE_MAX_AGE_HOURS", "not-a-number")
        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        # Default 24h -> 5h-old cache is fresh.
        assert result.code == 0


# ---------------------------------------------------------------------------
# Suite 7: CLI surface
# ---------------------------------------------------------------------------


class TestCLI:
    def test_main_fresh_cache_returns_zero(self, preflight, tmp_path, monkeypatch):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        # Pin "now" by stubbing _utc_now so the CLI path is deterministic.
        monkeypatch.setattr(preflight, "_utc_now", lambda: now)
        _write_meta(tmp_path, "deftai/directive", 1, now - timedelta(hours=2))
        _write_candidates(tmp_path, [])
        rc = preflight.main(
            [
                "--project-root",
                str(tmp_path),
                "--repo",
                "deftai/directive",
                "--quiet",
            ]
        )
        assert rc == 0

    def test_main_stale_cache_returns_one(self, preflight, tmp_path, monkeypatch):
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        monkeypatch.setattr(preflight, "_utc_now", lambda: now)
        _write_meta(tmp_path, "deftai/directive", 1, now - timedelta(hours=72))
        _write_candidates(tmp_path, [])
        rc = preflight.main(
            [
                "--project-root",
                str(tmp_path),
                "--repo",
                "deftai/directive",
            ]
        )
        assert rc == 1

    def test_main_missing_cache_returns_two(self, preflight, tmp_path):
        rc = preflight.main(
            [
                "--project-root",
                str(tmp_path),
                "--repo",
                "deftai/directive",
            ]
        )
        assert rc == 2

    def test_main_allow_missing_bootstrap_returns_zero(self, preflight, tmp_path):
        rc = preflight.main(
            [
                "--project-root",
                str(tmp_path),
                "--repo",
                "deftai/directive",
                "--allow-missing-bootstrap",
                "--quiet",
            ]
        )
        assert rc == 0


# ---------------------------------------------------------------------------
# Suite 7b: #1240 three-state messaging (no cache / fresh bootstrap / triaging)
# ---------------------------------------------------------------------------


class TestThreeStateMessaging:
    """Pin the #1240 state machine: the OK message distinguishes three
    consumer states so ``task verify:cache-fresh`` no longer claims
    ``treating as bootstrap state`` after a successful
    ``task triage:bootstrap``.
    """

    def test_no_cache_exits_two_or_bootstrap_state_on_override(
        self, preflight, tmp_path
    ):
        """State 1 (no cache): exit 2 by default, exit 0 + bootstrap-state on override."""
        # No cache directory at all.
        result = preflight.evaluate(tmp_path, repo="deftai/directive")
        assert result.code == 2
        assert "not present" in result.message or "not populated" in result.message

        # With --allow-missing-bootstrap, exit 0 with bootstrap-state hint.
        result_override = preflight.evaluate(
            tmp_path,
            repo="deftai/directive",
            allow_missing_bootstrap=True,
        )
        assert result_override.code == 0
        assert "bootstrap state" in result_override.message

    def test_cache_present_audit_empty_says_fresh_bootstrap(
        self, preflight, tmp_path
    ):
        """State 2 (cache + empty audit log): "fresh bootstrap, no triage actions yet".

        Mirrors the post-#1240 ``task triage:bootstrap`` end state where
        step 5 has seeded ``vbrief/.eval/candidates.jsonl`` as a zero-length
        file. The gate must exit 0 AND its message must accurately describe
        the state.
        """
        now = datetime(2026, 5, 19, 19, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 1239, now - timedelta(hours=1))
        # Empty audit log -- the bootstrap step-5 seed shape.
        audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        audit_path.touch()
        assert audit_path.stat().st_size == 0

        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        assert result.code == 0
        assert "fresh bootstrap, no triage actions yet" in result.message, (
            f"#1240 state 2 message wrong; got {result.message!r}"
        )
        # CRITICAL: must NOT use the pre-#1240 "bootstrap state" phrasing
        # that conflated never-bootstrapped with freshly-bootstrapped.
        assert "treating as bootstrap state" not in result.message

    def test_cache_present_audit_populated_says_actively_triaging(
        self, preflight, tmp_path
    ):
        """State 3 (cache + populated audit log): "actively triaging"."""
        now = datetime(2026, 5, 19, 19, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 1239, now - timedelta(hours=1))
        _write_candidates(
            tmp_path,
            [_decision("deftai/directive", 1239, "accept", timestamp=now)],
        )

        result = preflight.evaluate(
            tmp_path, repo="deftai/directive", now=now
        )
        assert result.code == 0
        assert "actively triaging" in result.message, (
            f"#1240 state 3 message wrong; got {result.message!r}"
        )
        # "fresh bootstrap" phrasing is reserved for state 2 only.
        assert "fresh bootstrap" not in result.message


# ---------------------------------------------------------------------------
# Suite 8: `task check` aggregate wiring smoke
# ---------------------------------------------------------------------------


class TestTaskCheckWiring:
    """Pin the wiring contract so a future edit that drops the alias fails CI.

    Per the #1127 acceptance criteria the gate MUST be in the `task check`
    aggregate alongside the existing verify:* gates. We do NOT shell out to
    the `task` binary here (its presence on CI is orthogonal); we parse the
    Taskfile YAML/text to assert the wiring is in place.
    """

    @staticmethod
    def _task_block(text: str, task_name: str) -> str:
        start = re.search(rf"^  {re.escape(task_name)}:\n", text, re.MULTILINE)
        assert start is not None, f"{task_name} task missing"
        next_task = re.search(r"^  [^\s#][^\n]*:\n", text[start.end() :], re.MULTILINE)
        if next_task is None:
            return text[start.end() :]
        return text[start.end() : start.end() + next_task.start()]

    def test_taskfile_lists_verify_cache_fresh_in_check_deps(self):
        # Normalize CRLF -> LF so the test is platform-agnostic.
        text = (
            (REPO_ROOT / "Taskfile.yml").read_text(encoding="utf-8").replace("\r\n", "\n")
        )
        assert "verify:cache-fresh" in text, (
            "verify:cache-fresh missing from Taskfile.yml -- the gate is not "
            "wired into `task check`"
        )
        # `task check` dispatches to the framework-source aggregate in this repo;
        # pin the gate there so it remains part of the pre-commit path.
        block = self._task_block(text, "check:framework-source")
        assert "verify:branch" in block
        assert "verify:encoding" in block
        assert "verify:cache-fresh" in block

    def test_verify_cache_fresh_task_defined_in_verify_fragment(self):
        text = (REPO_ROOT / "tasks" / "verify.yml").read_text(encoding="utf-8")
        assert "cache-fresh:" in text
        assert "preflight_cache.py" in text
        assert "--allow-missing-bootstrap" in text


# ---------------------------------------------------------------------------
# Suite 9: #1424 batched subscription filter (one milestone fetch, not N)
# ---------------------------------------------------------------------------


class TestBatchedScopeFilter:
    """#1424: ``_filter_scoped_meta_paths`` evaluates the rule set ONCE over
    the whole cache rather than once per cached entry.

    The pre-#1424 implementation fanned out to ``evaluate_rules(rules,
    [issue])`` N times; because ``evaluate_rules`` builds (and memoizes
    only within a single call) a fresh open-milestones resolver, a
    ``milestone {is-open: true}`` scope rule re-fetched the upstream
    open-milestones snapshot once per issue -- an O(N) ``gh`` fan-out
    (~92s on a 500-entry cache). Batching collapses that to a single
    fetch with unchanged matching semantics.
    """

    MILESTONE_RULE = [{"rule": "milestone", "is-open": True}]

    @staticmethod
    def _meta_paths(preflight, tmp_path, repo="deftai/directive"):
        return list(
            preflight._iter_meta_paths(
                tmp_path / ".deft-cache", "github-issue", repo
            )
        )

    def test_milestone_is_open_fetcher_invoked_at_most_once(
        self, preflight, tmp_path
    ):
        """Primary #1424 DoD: a counting fetcher fires at most once for an
        N>=3 cache carrying a ``milestone {is-open: true}`` scope rule."""
        now = datetime(2026, 6, 3, 12, tzinfo=UTC)
        # N = 4 (>= 3) cached open issues across two milestones.
        _write_meta(
            tmp_path, "deftai/directive", 1, now - timedelta(hours=1),
            raw_milestone="M1",
        )
        _write_meta(
            tmp_path, "deftai/directive", 2, now - timedelta(hours=1),
            raw_milestone="M2",
        )
        _write_meta(
            tmp_path, "deftai/directive", 3, now - timedelta(hours=1),
            raw_milestone="M1",
        )
        _write_meta(
            tmp_path, "deftai/directive", 4, now - timedelta(hours=1),
        )  # no milestone
        meta_paths = self._meta_paths(preflight, tmp_path)
        assert len(meta_paths) >= 3

        calls = {"n": 0}

        def counting_fetcher():
            calls["n"] += 1
            return {"M1"}

        result = preflight._filter_scoped_meta_paths(
            meta_paths,
            self.MILESTONE_RULE,
            open_milestones_fetcher=counting_fetcher,
        )
        # The whole point of #1424: ONE fetch regardless of cache size.
        assert calls["n"] <= 1, (
            f"expected at most 1 milestone fetch, got {calls['n']} "
            f"(per-issue fan-out regressed for {len(meta_paths)} entries)"
        )
        # Only issues 1 and 3 (milestone M1, which is open) are retained.
        retained = {int(p.parent.name) for p in result}
        assert retained == {1, 3}

    def test_batched_matched_set_equals_per_issue_baseline(
        self, preflight, tmp_path
    ):
        """Semantics are unchanged: the batched matched set equals the
        pre-#1424 per-issue fan-out baseline."""
        triage_scope = sys.modules["triage_scope"]
        now = datetime(2026, 6, 3, 12, tzinfo=UTC)
        _write_meta(
            tmp_path, "deftai/directive", 10, now - timedelta(hours=1),
            raw_milestone="M1",
        )
        _write_meta(
            tmp_path, "deftai/directive", 11, now - timedelta(hours=1),
            raw_milestone="M2",
        )
        _write_meta(
            tmp_path, "deftai/directive", 12, now - timedelta(hours=1),
            raw_milestone="M3",
        )
        _write_meta(
            tmp_path, "deftai/directive", 13, now - timedelta(hours=1),
            raw_milestone="M1", raw_state="closed",
        )  # closed -> never matches
        meta_paths = self._meta_paths(preflight, tmp_path)
        open_set = {"M1", "M3"}

        batched = set(
            preflight._filter_scoped_meta_paths(
                meta_paths,
                self.MILESTONE_RULE,
                open_milestones_fetcher=lambda: set(open_set),
            )
        )

        # Per-issue baseline: emulate the pre-#1424 fan-out exactly.
        baseline: set = set()
        for mp in meta_paths:
            raw = preflight._read_raw_issue(mp)
            if raw is None:
                baseline.add(mp)
                continue
            matched = triage_scope.evaluate_rules(
                self.MILESTONE_RULE,
                [raw],
                open_milestones_fetcher=lambda: set(open_set),
            )
            target = raw.get("number")
            if any(
                isinstance(m, dict) and m.get("number") == target
                for m in matched
            ):
                baseline.add(mp)

        assert batched == baseline
        # Sanity: M1 (10) and M3 (12) open; M2 (11) excluded; closed (13) out.
        assert {int(p.parent.name) for p in batched} == {10, 12}

    def test_missing_or_unparseable_raw_json_retained(
        self, preflight, tmp_path
    ):
        """Over-include contract preserved: entries whose raw.json is
        missing or unparseable are retained even under a filtering rule
        that would otherwise exclude them."""
        now = datetime(2026, 6, 3, 12, tzinfo=UTC)
        _write_meta(
            tmp_path, "deftai/directive", 20, now - timedelta(hours=1),
            raw_milestone="M1",
        )  # in open set -> retained via match
        corrupt = _write_meta(
            tmp_path, "deftai/directive", 21, now - timedelta(hours=1),
            raw_milestone="M2",
        )  # would be filtered, but we corrupt raw.json below
        removed = _write_meta(
            tmp_path, "deftai/directive", 22, now - timedelta(hours=1),
            raw_milestone="M2",
        )  # would be filtered, but we delete raw.json below
        _write_meta(
            tmp_path, "deftai/directive", 23, now - timedelta(hours=1),
            raw_milestone="M2",
        )  # parseable + out of open set -> excluded
        # Corrupt issue 21's raw.json and remove issue 22's entirely.
        (corrupt / "raw.json").write_text("{not valid json", encoding="utf-8")
        (removed / "raw.json").unlink()

        meta_paths = self._meta_paths(preflight, tmp_path)
        result = preflight._filter_scoped_meta_paths(
            meta_paths,
            self.MILESTONE_RULE,
            open_milestones_fetcher=lambda: {"M1"},
        )
        retained = {int(p.parent.name) for p in result}
        # 20 matched, 21 corrupt-kept, 22 missing-kept; 23 excluded.
        assert retained == {20, 21, 22}

    def test_no_rules_returns_all_meta_paths_unchanged(
        self, preflight, tmp_path
    ):
        """A nil rule list short-circuits: no evaluation, no fetch."""
        now = datetime(2026, 6, 3, 12, tzinfo=UTC)
        _write_meta(tmp_path, "deftai/directive", 30, now - timedelta(hours=1))
        _write_meta(tmp_path, "deftai/directive", 31, now - timedelta(hours=1))
        meta_paths = self._meta_paths(preflight, tmp_path)

        calls = {"n": 0}

        def counting_fetcher():
            calls["n"] += 1
            return {"M1"}

        result = preflight._filter_scoped_meta_paths(
            meta_paths, None, open_milestones_fetcher=counting_fetcher
        )
        assert result == meta_paths
        assert calls["n"] == 0
