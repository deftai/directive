"""Tests for scripts/triage_scope_drift.py (D14 / #1133).

Covers:

* Drift detection: 3+ open cached issues using an unsubscribed label
  triggers the surface; <=2 stays below threshold.
* Closed issues do not count toward drift.
* Milestone drift surfaces independently of label drift.
* ``plan.policy.triageScopeIgnores[]`` suppresses surfaced signals.
* Reconciliation: subscribing to a previously-drifted label suppresses
  it on the next ``compute_drift`` call.
* ``add_ignore()`` mutates the PROJECT-DEFINITION atomically; idempotent.
* Output renderer surfaces both subscribe and ignore paths.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_scope_drift = importlib.import_module("triage_scope_drift")


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _write_cached_issue(
    cache_root: Path,
    repo: str,
    number: int,
    *,
    state: str = "open",
    labels: list[str] | None = None,
    milestone: str | None = None,
) -> Path:
    """Write a synthetic ``raw.json`` payload to the cache.

    Mirrors the GitHub REST issue shape that the drift detector reads.
    """
    owner, name = repo.split("/", 1)
    entry = cache_root / "github-issue" / owner / name / str(number)
    entry.mkdir(parents=True, exist_ok=True)
    payload = {
        "number": number,
        "state": state,
        "labels": [{"name": label} for label in (labels or [])],
        "repository_url": f"https://api.github.com/repos/{repo}",
    }
    if milestone is not None:
        payload["milestone"] = {"title": milestone, "number": 1}
    (entry / "raw.json").write_text(json.dumps(payload), encoding="utf-8")
    (entry / "meta.json").write_text("{}", encoding="utf-8")
    return entry / "raw.json"


def _write_pd(tmp_path: Path, policy: dict | None = None) -> Path:
    vbrief = tmp_path / "vbrief"
    vbrief.mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "x",
            "status": "running",
            "items": [],
            "policy": policy or {},
        },
    }
    path = vbrief / "PROJECT-DEFINITION.vbrief.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Drift detection -- thresholds + label/milestone partition
# ---------------------------------------------------------------------------


# Canonical tightened subscription used by every test that needs drift to
# actually surface. Under the framework-default ``all-open`` rule the
# drift detector short-circuits to an empty report (Greptile P1 on PR
# #1210; see ``test_default_all_open_with_non_empty_cache_yields_empty_drift``
# below for the regression test). To exercise drift surfacing we tighten
# the subscription to a label set that does not include the test fixture
# labels.
_TIGHTENED_POLICY = {"triageScope": [{"rule": "labels", "any-of": ["some-unrelated-label"]}]}


def test_empty_cache_returns_empty_report(tmp_path: Path):
    _write_pd(tmp_path)
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=tmp_path / ".deft-cache")
    assert report.labels == {}
    assert report.milestones == {}
    assert report.total == 0


def test_three_issues_with_unsubscribed_label_surface(tmp_path: Path):
    """The framework threshold is _DRIFT_MIN_ISSUES = 3."""
    _write_pd(tmp_path, policy=_TIGHTENED_POLICY)
    cache = tmp_path / ".deft-cache"
    for n in (101, 102, 103):
        _write_cached_issue(cache, "deftai/directive", n, labels=["priority:p0"])
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {"priority:p0": 3}
    assert report.total == 3
    assert report.threshold == 3


def test_two_issues_below_threshold_suppressed(tmp_path: Path):
    _write_pd(tmp_path, policy=_TIGHTENED_POLICY)
    cache = tmp_path / ".deft-cache"
    for n in (200, 201):
        _write_cached_issue(cache, "deftai/directive", n, labels=["rare-label"])
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {}
    assert report.total == 0


def test_closed_issues_excluded_from_drift(tmp_path: Path):
    _write_pd(tmp_path, policy=_TIGHTENED_POLICY)
    cache = tmp_path / ".deft-cache"
    for n in (300, 301, 302):
        _write_cached_issue(
            cache, "deftai/directive", n, state="closed", labels=["priority:p0"]
        )
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {}
    assert report.total == 0


def test_milestone_drift_surfaces_independently(tmp_path: Path):
    _write_pd(tmp_path, policy=_TIGHTENED_POLICY)
    cache = tmp_path / ".deft-cache"
    for n in (400, 401, 402):
        _write_cached_issue(cache, "deftai/directive", n, milestone="v2.0-blocker")
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.milestones == {"v2.0-blocker": 3}
    assert report.labels == {}
    assert report.total == 3


def test_mixed_label_and_milestone_drift(tmp_path: Path):
    _write_pd(tmp_path, policy=_TIGHTENED_POLICY)
    cache = tmp_path / ".deft-cache"
    # 3 issues with label X
    for n in (500, 501, 502):
        _write_cached_issue(cache, "deftai/directive", n, labels=["priority:p0"])
    # 3 issues with milestone Y (different issues)
    for n in (510, 511, 512):
        _write_cached_issue(cache, "deftai/directive", n, milestone="v2.0-blocker")
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {"priority:p0": 3}
    assert report.milestones == {"v2.0-blocker": 3}
    assert report.total == 6  # 6 distinct issues


def test_total_dedupes_when_issue_has_both_signals(tmp_path: Path):
    """An issue with an unsubscribed label AND milestone counts once."""
    _write_pd(tmp_path, policy=_TIGHTENED_POLICY)
    cache = tmp_path / ".deft-cache"
    # 3 issues with BOTH signals
    for n in (600, 601, 602):
        _write_cached_issue(
            cache,
            "deftai/directive",
            n,
            labels=["priority:p0"],
            milestone="v2.0",
        )
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.total == 3  # not 6


def test_default_all_open_with_non_empty_cache_yields_empty_drift(tmp_path: Path):
    """Regression: under default ``plan.policy.triageScope[]`` (unset ->
    ``all-open``), every cached open issue is already in scope by
    definition; drift MUST be empty regardless of how many labels /
    milestones appear across the cache (Greptile P1 on PR #1210).

    Before the early-return fix, default-config consumers saw spurious
    ``[scope-drift] N > 0`` warnings on every ``triage:summary`` because
    the empty subscribed-labels / subscribed-milestones sets fell through
    to the label-aggregation loop and surfaced every label / milestone
    that hit the 3-issue threshold.
    """
    _write_pd(tmp_path)  # default policy -- triageScope unset -> all-open
    cache = tmp_path / ".deft-cache"
    # Stage a backlog that WOULD trip drift under any non-all-open policy.
    for n in (701, 702, 703):
        _write_cached_issue(cache, "deftai/directive", n, labels=["priority:p0"])
    for n in (711, 712, 713):
        _write_cached_issue(
            cache, "deftai/directive", n, milestone="v2.0-blocker"
        )
    for n in (721, 722, 723):
        _write_cached_issue(
            cache,
            "deftai/directive",
            n,
            labels=["compat:breaking", "rfc-track"],
        )
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {}, (
        "all-open subscribes to every open issue by definition; no label "
        f"can be 'unsubscribed' (got {report.labels})"
    )
    assert report.milestones == {}
    assert report.total == 0
    assert report.threshold == 3  # threshold field still honoured for parity


def test_explicit_all_open_rule_short_circuits_even_with_sibling_rules(tmp_path: Path):
    """If ANY rule on triageScope[] is ``all-open``, the subscription is
    universal and the early-return MUST fire -- sibling rules cannot
    narrow ``all-open`` (the rule set is a union, not an intersection).
    """
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [
                {"rule": "all-open"},
                {"rule": "labels", "any-of": ["some-other-label"]},
            ]
        },
    )
    cache = tmp_path / ".deft-cache"
    for n in (801, 802, 803):
        _write_cached_issue(cache, "deftai/directive", n, labels=["priority:p0"])
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {}
    assert report.total == 0


def test_subscribed_label_excluded_from_drift(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "labels", "any-of": ["priority:p0"]}],
        },
    )
    cache = tmp_path / ".deft-cache"
    for n in (700, 701, 702):
        _write_cached_issue(cache, "deftai/directive", n, labels=["priority:p0"])
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {}


def test_subscribed_milestone_excluded_from_drift(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "milestone", "name": "v2.0-blocker"}],
        },
    )
    cache = tmp_path / ".deft-cache"
    for n in (800, 801, 802):
        _write_cached_issue(cache, "deftai/directive", n, milestone="v2.0-blocker")
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.milestones == {}


def test_milestone_any_of_subscription_excluded_from_drift(tmp_path: Path):
    """D14b (#1181): milestones subscribed via any-of MUST NOT appear in drift."""
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [
                {"rule": "milestone", "any-of": ["v0.27", "v0.28"]},
            ],
        },
    )
    cache = tmp_path / ".deft-cache"
    for n in (1300, 1301, 1302):
        _write_cached_issue(cache, "deftai/directive", n, milestone="v0.27")
    for n in (1310, 1311, 1312):
        _write_cached_issue(cache, "deftai/directive", n, milestone="v0.28")
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.milestones == {}, report.milestones
    assert report.total == 0


def test_milestone_is_open_subscription_excluded_from_drift(tmp_path: Path):
    """D14b (#1181): is-open consults the upstream snapshot to suppress drift."""
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "milestone", "is-open": True}],
        },
    )
    cache = tmp_path / ".deft-cache"
    for n in (1400, 1401, 1402):
        _write_cached_issue(cache, "deftai/directive", n, milestone="v0.27")
    report = triage_scope_drift.compute_drift(
        tmp_path,
        cache_root=cache,
        open_milestones_fetcher=lambda: {"v0.27", "v0.28"},
    )
    assert report.milestones == {}, report.milestones
    assert report.total == 0


def test_milestone_is_open_closed_milestone_still_drifts(tmp_path: Path):
    """A closed-upstream milestone is NOT in the snapshot, so it should drift."""
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "milestone", "is-open": True}],
        },
    )
    cache = tmp_path / ".deft-cache"
    for n in (1500, 1501, 1502):
        _write_cached_issue(
            cache, "deftai/directive", n, milestone="v0.20-archived"
        )
    report = triage_scope_drift.compute_drift(
        tmp_path,
        cache_root=cache,
        # snapshot does NOT include the archived milestone
        open_milestones_fetcher=lambda: {"v0.27", "v0.28"},
    )
    assert report.milestones == {"v0.20-archived": 3}
    assert report.total == 3


def test_ignore_list_suppresses_label_drift(tmp_path: Path):
    # Tighten triageScope so the all-open short-circuit does not
    # short-circuit drift before the ignore-list is consulted -- the
    # test asserts the IGNORE list is what suppresses the surface, not
    # the all-open default.
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "labels", "any-of": ["some-unrelated-label"]}],
            "triageScopeIgnores": [{"label": "rfc-track"}],
        },
    )
    cache = tmp_path / ".deft-cache"
    for n in (900, 901, 902):
        _write_cached_issue(cache, "deftai/directive", n, labels=["rfc-track"])
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {}
    assert report.total == 0


def test_ignore_list_suppresses_milestone_drift(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "labels", "any-of": ["some-unrelated-label"]}],
            "triageScopeIgnores": [{"milestone": "future"}],
        },
    )
    cache = tmp_path / ".deft-cache"
    for n in (1000, 1001, 1002):
        _write_cached_issue(cache, "deftai/directive", n, milestone="future")
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.milestones == {}


# ---------------------------------------------------------------------------
# Output renderer
# ---------------------------------------------------------------------------


def test_render_drift_report_empty():
    report = triage_scope_drift.DriftReport()
    out = triage_scope_drift.render_drift_report(report)
    assert "no unsubscribed" in out


def test_render_drift_report_includes_labels_and_subscribe_paths():
    report = triage_scope_drift.DriftReport(
        labels={"priority:p0": 12, "compat:breaking": 4},
        milestones={"v2.0-blocker": 7},
        total=18,
    )
    out = triage_scope_drift.render_drift_report(report)
    assert "[scope-drift] labels not in subscription" in out
    assert "priority:p0" in out
    assert "12 open issues" in out
    assert "[scope-drift] milestones not in subscription" in out
    assert "v2.0-blocker" in out
    assert "task triage:subscribe -- --label=priority:p0" in out
    assert "task triage:subscribe -- --milestone=v2.0-blocker" in out
    assert "task triage:scope-drift -- --ignore-label=priority:p0" in out


# ---------------------------------------------------------------------------
# add_ignore() mutation
# ---------------------------------------------------------------------------


def test_add_ignore_label_appends_entry(tmp_path: Path):
    pd = _write_pd(tmp_path)
    changed, message = triage_scope_drift.add_ignore(tmp_path, label="rfc-track")
    assert changed is True
    assert "rfc-track" in message
    data = json.loads(pd.read_text(encoding="utf-8"))
    assert data["plan"]["policy"]["triageScopeIgnores"] == [{"label": "rfc-track"}]


def test_add_ignore_milestone_appends_entry(tmp_path: Path):
    pd = _write_pd(tmp_path)
    changed, _ = triage_scope_drift.add_ignore(tmp_path, milestone="future")
    assert changed is True
    data = json.loads(pd.read_text(encoding="utf-8"))
    assert {"milestone": "future"} in data["plan"]["policy"]["triageScopeIgnores"]


def test_add_ignore_idempotent(tmp_path: Path):
    _write_pd(tmp_path)
    triage_scope_drift.add_ignore(tmp_path, label="rfc-track")
    changed, message = triage_scope_drift.add_ignore(tmp_path, label="rfc-track")
    assert changed is False
    assert "already-ignored" in message


def test_add_ignore_rejects_both_args(tmp_path: Path):
    _write_pd(tmp_path)
    with pytest.raises(ValueError):
        triage_scope_drift.add_ignore(tmp_path, label="a", milestone="b")


def test_add_ignore_rejects_empty_value(tmp_path: Path):
    _write_pd(tmp_path)
    with pytest.raises(ValueError):
        triage_scope_drift.add_ignore(tmp_path, label="   ")


def test_ignore_then_recompute_excludes_signal(tmp_path: Path):
    """End-to-end: add_ignore() suppresses the signal on the next compute.

    Uses a tightened triageScope so the all-open short-circuit does
    not pre-empt the ignore-list path.
    """
    _write_pd(tmp_path, policy=_TIGHTENED_POLICY)
    cache = tmp_path / ".deft-cache"
    for n in (1100, 1101, 1102):
        _write_cached_issue(cache, "deftai/directive", n, labels=["rfc-track"])
    pre = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert pre.labels == {"rfc-track": 3}
    triage_scope_drift.add_ignore(tmp_path, label="rfc-track")
    post = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert post.labels == {}
    assert post.total == 0


# ---------------------------------------------------------------------------
# Threshold override (test-only contract)
# ---------------------------------------------------------------------------


def test_threshold_override_lowers_bar(tmp_path: Path):
    _write_pd(tmp_path, policy=_TIGHTENED_POLICY)
    cache = tmp_path / ".deft-cache"
    for n in (1200, 1201):
        _write_cached_issue(cache, "deftai/directive", n, labels=["edge-case"])
    report = triage_scope_drift.compute_drift(
        tmp_path, cache_root=cache, threshold=2
    )
    assert report.labels == {"edge-case": 2}
