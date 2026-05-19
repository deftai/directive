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
        """Baseline preserved: empty-scope + --allow-stale (no --for-issue)
        still exits 0 with the warning. The fix only affects the
        --for-issue path."""
        now = datetime(2026, 5, 17, 12, tzinfo=UTC)
        self._empty_scope_fixture(tmp_path, now, issue_decision="accept")
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

    def test_taskfile_lists_verify_cache_fresh_in_check_deps(self):
        # Normalize CRLF -> LF so the test is platform-agnostic.
        text = (
            (REPO_ROOT / "Taskfile.yml").read_text(encoding="utf-8").replace("\r\n", "\n")
        )
        assert "verify:cache-fresh" in text, (
            "verify:cache-fresh missing from Taskfile.yml -- the gate is not "
            "wired into `task check`"
        )
        # Pin the sibling ordering so the gate runs alongside the existing
        # verify:* aggregate, not as a standalone target the operator must
        # opt into.
        check_block_idx = text.index("check:\n")
        cmds_idx = text.index("cmds:", check_block_idx)
        block = text[check_block_idx:cmds_idx]
        assert "verify:branch" in block
        assert "verify:encoding" in block
        assert "verify:cache-fresh" in block

    def test_verify_cache_fresh_task_defined_in_verify_fragment(self):
        text = (REPO_ROOT / "tasks" / "verify.yml").read_text(encoding="utf-8")
        assert "cache-fresh:" in text
        assert "preflight_cache.py" in text
        assert "--allow-missing-bootstrap" in text
