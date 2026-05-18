"""Tests for D14c (#1182) -- triageScopeIgnores[] author rule + wrapper verbs.

Covers:

* Validator -- ``{rule: 'author', any-of: [...]}`` accept / reject matrix.
* ``resolve_scope_ignores`` returns ``authors`` set alongside labels / milestones.
* Drift detector suppresses cached issues whose ``user.login`` matches an
  author-ignore rule.
* ``add_ignore`` writes a ``subscription-change`` audit-log entry to
  ``vbrief/.eval/subscription-history.jsonl``.
* Wrapper-verb helpers -- ``add_label_to_scope`` / ``add_milestone_to_scope``
  / ``add_label_to_ignores`` are idempotent, merge into existing rules,
  and persist atomically.
* ``compute_diff_from_upstream`` partitions upstream labels / milestones
  into subscribed / ignored / neither sets.
* CLI integration -- ``triage:scope --list`` shows both scope + ignores;
  ``--add-label`` + ``--ignore-label`` flags work end-to-end through
  ``main(argv)``; flags are mutually exclusive; ``--diff-from-upstream``
  requires ``--repo``.
* Backward-compat -- ``task triage:scope-drift -- --ignore-label`` still
  works against the same typed field (alias check via direct
  ``triage_scope_drift.add_ignore`` invocation).
"""

from __future__ import annotations

import importlib
import io
import json
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_scope = importlib.import_module("triage_scope")
triage_scope_drift = importlib.import_module("triage_scope_drift")
triage_scope_mutations = importlib.import_module("_triage_scope_mutations")
triage_scope_renderers = importlib.import_module("_triage_scope_renderers")


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


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


def _read_pd(tmp_path: Path) -> dict:
    pd = tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    return json.loads(pd.read_text(encoding="utf-8"))


def _read_history(tmp_path: Path) -> list[dict]:
    path = tmp_path / "vbrief" / ".eval" / "subscription-history.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def _write_cached_issue(
    cache_root: Path,
    repo: str,
    number: int,
    *,
    state: str = "open",
    labels: list[str] | None = None,
    milestone: str | None = None,
    author_login: str | None = None,
) -> Path:
    owner, name = repo.split("/", 1)
    entry = cache_root / "github-issue" / owner / name / str(number)
    entry.mkdir(parents=True, exist_ok=True)
    payload: dict = {
        "number": number,
        "state": state,
        "labels": [{"name": label} for label in (labels or [])],
        "repository_url": f"https://api.github.com/repos/{repo}",
    }
    if milestone is not None:
        payload["milestone"] = {"title": milestone, "number": 1}
    if author_login is not None:
        payload["user"] = {"login": author_login}
    (entry / "raw.json").write_text(json.dumps(payload), encoding="utf-8")
    (entry / "meta.json").write_text("{}", encoding="utf-8")
    return entry / "raw.json"


_TIGHTENED_POLICY = {
    "triageScope": [{"rule": "labels", "any-of": ["some-unrelated-label"]}]
}


# ---------------------------------------------------------------------------
# author rule validator
# ---------------------------------------------------------------------------


def test_validate_accepts_author_rule_with_any_of():
    errors, warnings = triage_scope.validate_scope_ignores(
        [{"rule": "author", "any-of": ["dependabot[bot]", "renovate[bot]"]}]
    )
    assert errors == [], errors
    assert warnings == [], warnings


def test_validate_rejects_author_with_empty_any_of():
    errors, _ = triage_scope.validate_scope_ignores(
        [{"rule": "author", "any-of": []}]
    )
    assert any("any-of" in e and "non-empty" in e for e in errors)


def test_validate_rejects_author_with_missing_any_of():
    errors, _ = triage_scope.validate_scope_ignores([{"rule": "author"}])
    assert any("any-of" in e for e in errors)


def test_validate_rejects_author_with_non_string_member():
    errors, _ = triage_scope.validate_scope_ignores(
        [{"rule": "author", "any-of": ["good", 42, ""]}]
    )
    # Two errors: index 1 (non-string) + index 2 (empty string)
    assert sum(1 for e in errors if "must be a non-empty string" in e) >= 2


def test_validate_rejects_unknown_rule_kind():
    errors, _ = triage_scope.validate_scope_ignores(
        [{"rule": "sunset-on", "any-of": ["foo"]}]
    )
    assert any("not a recognised ignore-rule" in e for e in errors)


def test_validate_accepts_mixed_legacy_and_rule_shapes():
    """D14 single-key and D14c rule-shape entries coexist on one list."""
    errors, warnings = triage_scope.validate_scope_ignores(
        [
            {"label": "wontfix"},
            {"milestone": "future"},
            {"rule": "author", "any-of": ["dependabot[bot]"]},
        ]
    )
    assert errors == []
    assert warnings == []


def test_validate_author_warns_on_unknown_keys():
    _, warnings = triage_scope.validate_scope_ignores(
        [
            {
                "rule": "author",
                "any-of": ["dependabot[bot]"],
                "extra-key": "ignored",
            }
        ]
    )
    assert any("extra-key" in w for w in warnings)


def test_vbrief_validate_hook_tags_author_errors_with_1182_pointer(tmp_path: Path):
    plan = {"policy": {"triageScopeIgnores": [{"rule": "author"}]}}
    errs = triage_scope.validate_triage_scope_ignores_on_plan(
        plan, tmp_path / "PROJECT-DEFINITION.vbrief.json"
    )
    assert errs
    assert any("(#1182)" in e for e in errs)


# ---------------------------------------------------------------------------
# Pointer-heuristic regression (Greptile P1 on PR #1213)
# ---------------------------------------------------------------------------
# The original substring-based pointer heuristic mistagged two rule-shape
# error paths -- `{rule: ""}` ("rule must be a non-empty string") and
# `{rule: "sunset-on"}` ("rule 'sunset-on' is not a recognised ignore-rule
# kind") -- because neither error mentions `.author` / `"author rule"`. The
# unrecognised-kind path additionally double-tagged itself with an inline
# `(D14c / #1182)` AND the wrapper's appended `(#1133)`. The fix replaced
# the substring heuristic with a shape inspection that walks the raw
# entry list and pointer-tags by presence of a top-level `rule` key.


@pytest.mark.parametrize(
    ("entry", "expected_token"),
    [
        ({"rule": ""}, "must be a non-empty string"),
        ({"rule": "sunset-on"}, "not a recognised ignore-rule"),
    ],
)
def test_rule_shape_errors_tagged_with_1182_only(
    tmp_path: Path, entry: dict, expected_token: str
) -> None:
    plan = {"policy": {"triageScopeIgnores": [entry]}}
    errs = triage_scope.validate_triage_scope_ignores_on_plan(
        plan, tmp_path / "PROJECT-DEFINITION.vbrief.json"
    )
    assert errs
    relevant = [e for e in errs if expected_token in e]
    assert relevant, errs
    for err in relevant:
        assert "(#1182)" in err, err
        assert "(#1133)" not in err, err
        # The unrecognised-kind error MUST NOT also inline the pointer --
        # that was the source of the original double-pointer rendering.
        assert "(D14c / #1182)" not in err, err


def test_single_key_errors_still_tag_with_1133(tmp_path: Path) -> None:
    """Defensive: a D14 single-key error must continue to render as (#1133)."""
    plan = {"policy": {"triageScopeIgnores": [{"label": "  "}]}}
    errs = triage_scope.validate_triage_scope_ignores_on_plan(
        plan, tmp_path / "PROJECT-DEFINITION.vbrief.json"
    )
    assert errs
    for err in errs:
        assert "(#1133)" in err, err
        assert "(#1182)" not in err, err


def test_mixed_list_tags_each_entry_independently(tmp_path: Path) -> None:
    """A list mixing single-key and rule-shape entries pointer-tags each
    error independently by source-entry shape."""
    plan = {
        "policy": {
            "triageScopeIgnores": [
                {"label": "  "},  # entry[0] -> #1133
                {"rule": "sunset-on"},  # entry[1] -> #1182
                {"milestone": ""},  # entry[2] -> #1133
                {"rule": "author"},  # entry[3] -> #1182
            ]
        }
    }
    errs = triage_scope.validate_triage_scope_ignores_on_plan(
        plan, tmp_path / "PROJECT-DEFINITION.vbrief.json"
    )
    assert errs
    for err in errs:
        # Exactly one pointer per line, never both.
        has_1133 = "(#1133)" in err
        has_1182 = "(#1182)" in err
        assert has_1133 ^ has_1182, err
        if "triageScopeIgnores[0]" in err or "triageScopeIgnores[2]" in err:
            assert has_1133, err
        if "triageScopeIgnores[1]" in err or "triageScopeIgnores[3]" in err:
            assert has_1182, err


# ---------------------------------------------------------------------------
# resolve_scope_ignores returns authors
# ---------------------------------------------------------------------------


def test_resolve_scope_ignores_returns_authors_key(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScopeIgnores": [
                {"label": "wontfix"},
                {"rule": "author", "any-of": ["dependabot[bot]", "renovate[bot]"]},
            ]
        },
    )
    ignores = triage_scope.resolve_scope_ignores(tmp_path)
    assert ignores["labels"] == {"wontfix"}
    assert ignores["authors"] == {"dependabot[bot]", "renovate[bot]"}
    assert ignores["milestones"] == set()


def test_resolve_scope_ignores_empty_default(tmp_path: Path):
    _write_pd(tmp_path)
    ignores = triage_scope.resolve_scope_ignores(tmp_path)
    assert ignores == {"labels": set(), "milestones": set(), "authors": set()}


# ---------------------------------------------------------------------------
# Drift detector honours author ignores
# ---------------------------------------------------------------------------


def test_author_ignore_suppresses_drift_surface(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "labels", "any-of": ["some-unrelated-label"]}],
            "triageScopeIgnores": [
                {"rule": "author", "any-of": ["dependabot[bot]"]}
            ],
        },
    )
    cache = tmp_path / ".deft-cache"
    # 3 dependabot PRs with a label that would otherwise trip drift
    for n in (2000, 2001, 2002):
        _write_cached_issue(
            cache,
            "deftai/directive",
            n,
            labels=["dependencies"],
            author_login="dependabot[bot]",
        )
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {}, report
    assert report.total == 0


def test_author_ignore_does_not_suppress_unrelated_issue(tmp_path: Path):
    """A non-dependabot issue still surfaces when its label is unsubscribed."""
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "labels", "any-of": ["some-unrelated-label"]}],
            "triageScopeIgnores": [
                {"rule": "author", "any-of": ["dependabot[bot]"]}
            ],
        },
    )
    cache = tmp_path / ".deft-cache"
    for n in (3000, 3001, 3002):
        _write_cached_issue(
            cache,
            "deftai/directive",
            n,
            labels=["priority:p0"],
            author_login="real-user",
        )
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {"priority:p0": 3}
    assert report.total == 3


def test_author_ignore_distinct_total_excludes_ignored_issues(tmp_path: Path):
    """Mixed dependabot + real-user pool -- only the real-user issues count."""
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "labels", "any-of": ["some-unrelated-label"]}],
            "triageScopeIgnores": [
                {"rule": "author", "any-of": ["dependabot[bot]"]}
            ],
        },
    )
    cache = tmp_path / ".deft-cache"
    for n in (4000, 4001, 4002):
        _write_cached_issue(
            cache,
            "deftai/directive",
            n,
            labels=["priority:p0"],
            author_login="dependabot[bot]",
        )
    for n in (4100, 4101, 4102):
        _write_cached_issue(
            cache,
            "deftai/directive",
            n,
            labels=["priority:p0"],
            author_login="real-user",
        )
    report = triage_scope_drift.compute_drift(tmp_path, cache_root=cache)
    assert report.labels == {"priority:p0": 3}  # 3 real-user issues
    assert report.total == 3


# ---------------------------------------------------------------------------
# add_ignore audit-log entry (D14c hardening)
# ---------------------------------------------------------------------------


def test_add_ignore_appends_audit_entry(tmp_path: Path):
    _write_pd(tmp_path)
    changed, _ = triage_scope_drift.add_ignore(tmp_path, label="rfc-track")
    assert changed is True
    history = _read_history(tmp_path)
    assert len(history) == 1
    rec = history[0]
    assert rec["op"] == "ignore-label"
    assert rec["label"] == "rfc-track"
    assert rec["before"] == []
    assert rec["after"] == [{"label": "rfc-track"}]
    assert "change_id" in rec
    assert "timestamp" in rec


def test_add_ignore_idempotent_skips_audit_entry(tmp_path: Path):
    _write_pd(tmp_path)
    triage_scope_drift.add_ignore(tmp_path, label="rfc-track")
    triage_scope_drift.add_ignore(tmp_path, label="rfc-track")  # no-op
    history = _read_history(tmp_path)
    assert len(history) == 1


def test_add_ignore_milestone_audit_op(tmp_path: Path):
    _write_pd(tmp_path)
    triage_scope_drift.add_ignore(tmp_path, milestone="future")
    history = _read_history(tmp_path)
    assert len(history) == 1
    assert history[0]["op"] == "ignore-milestone"
    assert history[0]["milestone"] == "future"


# ---------------------------------------------------------------------------
# Wrapper-verb helpers
# ---------------------------------------------------------------------------


def test_add_label_to_scope_creates_new_rule(tmp_path: Path):
    _write_pd(tmp_path)
    changed, _ = triage_scope_mutations.add_label_to_scope(tmp_path, "priority:p0")
    assert changed is True
    rules = _read_pd(tmp_path)["plan"]["policy"]["triageScope"]
    assert rules == [{"rule": "labels", "any-of": ["priority:p0"]}]


def test_add_label_to_scope_merges_into_existing_rule(tmp_path: Path):
    _write_pd(
        tmp_path, policy={"triageScope": [{"rule": "labels", "any-of": ["bug"]}]}
    )
    triage_scope_mutations.add_label_to_scope(tmp_path, "regression")
    rules = _read_pd(tmp_path)["plan"]["policy"]["triageScope"]
    assert rules == [{"rule": "labels", "any-of": ["bug", "regression"]}]


def test_add_label_to_scope_idempotent(tmp_path: Path):
    _write_pd(tmp_path)
    triage_scope_mutations.add_label_to_scope(tmp_path, "bug")
    changed, message = triage_scope_mutations.add_label_to_scope(tmp_path, "bug")
    assert changed is False
    assert "already-subscribed" in message


def test_add_milestone_to_scope_appends_rule(tmp_path: Path):
    _write_pd(tmp_path)
    changed, _ = triage_scope_mutations.add_milestone_to_scope(tmp_path, "v2.0-blocker")
    assert changed is True
    rules = _read_pd(tmp_path)["plan"]["policy"]["triageScope"]
    assert {"rule": "milestone", "name": "v2.0-blocker"} in rules


def test_add_milestone_to_scope_idempotent(tmp_path: Path):
    _write_pd(tmp_path)
    triage_scope_mutations.add_milestone_to_scope(tmp_path, "v2.0")
    changed, _ = triage_scope_mutations.add_milestone_to_scope(tmp_path, "v2.0")
    assert changed is False


def test_add_label_to_ignores_round_trips(tmp_path: Path):
    _write_pd(tmp_path)
    triage_scope_mutations.add_label_to_ignores(tmp_path, "wontfix")
    raw = _read_pd(tmp_path)["plan"]["policy"]["triageScopeIgnores"]
    assert raw == [{"label": "wontfix"}]
    # Idempotent on second call
    changed, _ = triage_scope_mutations.add_label_to_ignores(tmp_path, "wontfix")
    assert changed is False


def test_wrapper_verbs_reject_empty_arg(tmp_path: Path):
    _write_pd(tmp_path)
    with pytest.raises(ValueError):
        triage_scope_mutations.add_label_to_scope(tmp_path, "   ")
    with pytest.raises(ValueError):
        triage_scope_mutations.add_milestone_to_scope(tmp_path, "")
    with pytest.raises(ValueError):
        triage_scope_mutations.add_label_to_ignores(tmp_path, "")


# ---------------------------------------------------------------------------
# compute_diff_from_upstream
# ---------------------------------------------------------------------------


def test_compute_diff_partitions_labels(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "labels", "any-of": ["bug"]}],
            "triageScopeIgnores": [{"label": "wontfix"}],
        },
    )
    report = triage_scope_mutations.compute_diff_from_upstream(
        tmp_path,
        upstream_labels={"bug", "wontfix", "feature"},
        upstream_milestones=set(),
        repo="deftai/directive",
    )
    # Greptile P2 on PR #1213: DiffReport is frozen=True with frozenset
    # fields so the wrapper is hashable. Mutable set fields on a frozen
    # dataclass are a documented footgun.
    assert isinstance(report.subscribed_labels, frozenset)
    assert isinstance(report.ignored_labels, frozenset)
    assert isinstance(report.neither_labels, frozenset)
    assert report.subscribed_labels == frozenset({"bug"})
    assert report.ignored_labels == frozenset({"wontfix"})
    assert report.neither_labels == frozenset({"feature"})


def test_compute_diff_partitions_milestones(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "milestone", "name": "v2.0-blocker"}],
            "triageScopeIgnores": [{"milestone": "future"}],
        },
    )
    report = triage_scope_mutations.compute_diff_from_upstream(
        tmp_path,
        upstream_labels=set(),
        upstream_milestones={"v2.0-blocker", "future", "backlog"},
    )
    assert report.subscribed_milestones == {"v2.0-blocker"}
    assert report.ignored_milestones == {"future"}
    assert report.neither_milestones == {"backlog"}


def test_render_diff_report_human_readable(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "labels", "any-of": ["bug"]}],
            "triageScopeIgnores": [{"label": "wontfix"}],
        },
    )
    report = triage_scope_mutations.compute_diff_from_upstream(
        tmp_path,
        upstream_labels={"bug", "wontfix", "todo"},
        upstream_milestones={"backlog"},
        repo="deftai/directive",
    )
    text = triage_scope_mutations.render_diff_report(report)
    assert "deftai/directive" in text
    assert "subscribed (1): bug" in text
    assert "ignored    (1): wontfix" in text
    assert "neither    (1): todo" in text
    assert "Milestones:" in text
    assert "neither    (1): backlog" in text


# ---------------------------------------------------------------------------
# render_ignores helper
# ---------------------------------------------------------------------------


def test_render_ignores_empty():
    text = triage_scope_renderers.render_ignores([])
    assert "0 entries" in text
    assert "(none)" in text


def test_render_ignores_groups_by_kind():
    text = triage_scope_renderers.render_ignores(
        [
            {"label": "wontfix"},
            {"milestone": "future"},
            {"rule": "author", "any-of": ["dependabot[bot]"]},
        ]
    )
    assert "3 entries" in text
    assert "wontfix" in text
    assert "future" in text
    assert "dependabot[bot]" in text


# ---------------------------------------------------------------------------
# CLI integration -- main(argv)
# ---------------------------------------------------------------------------


def _run_cli(argv: list[str]) -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        rc = triage_scope.main(argv)
    return rc, stdout.getvalue(), stderr.getvalue()


def test_cli_list_shows_scope_and_ignores(tmp_path: Path):
    _write_pd(
        tmp_path,
        policy={
            "triageScope": [{"rule": "labels", "any-of": ["bug"]}],
            "triageScopeIgnores": [
                {"label": "wontfix"},
                {"rule": "author", "any-of": ["dependabot[bot]"]},
            ],
        },
    )
    rc, out, _ = _run_cli(["--project-root", str(tmp_path), "--list"])
    assert rc == 0
    assert "effective rules" in out
    assert "bug" in out
    assert "ignores" in out
    assert "wontfix" in out
    assert "dependabot[bot]" in out


def test_cli_add_label_persists(tmp_path: Path):
    _write_pd(tmp_path)
    rc, _, _ = _run_cli(
        ["--project-root", str(tmp_path), "--add-label=priority:p0"]
    )
    assert rc == 0
    rules = _read_pd(tmp_path)["plan"]["policy"]["triageScope"]
    assert rules == [{"rule": "labels", "any-of": ["priority:p0"]}]


def test_cli_add_milestone_persists(tmp_path: Path):
    _write_pd(tmp_path)
    rc, _, _ = _run_cli(
        ["--project-root", str(tmp_path), "--add-milestone=v2.0-blocker"]
    )
    assert rc == 0
    rules = _read_pd(tmp_path)["plan"]["policy"]["triageScope"]
    assert {"rule": "milestone", "name": "v2.0-blocker"} in rules


def test_cli_ignore_label_persists_and_list_shows_it(tmp_path: Path):
    _write_pd(tmp_path)
    rc, _, _ = _run_cli(
        ["--project-root", str(tmp_path), "--ignore-label=wontfix"]
    )
    assert rc == 0
    raw = _read_pd(tmp_path)["plan"]["policy"]["triageScopeIgnores"]
    assert raw == [{"label": "wontfix"}]
    # --list shows the new entry
    rc, out, _ = _run_cli(["--project-root", str(tmp_path), "--list"])
    assert rc == 0
    assert "wontfix" in out


def test_cli_mutation_flags_mutually_exclusive(tmp_path: Path):
    _write_pd(tmp_path)
    rc, _, err = _run_cli(
        [
            "--project-root",
            str(tmp_path),
            "--add-label=bug",
            "--ignore-label=wontfix",
        ]
    )
    assert rc == 2
    assert "mutually exclusive" in err


def test_cli_diff_from_upstream_requires_repo(tmp_path: Path):
    _write_pd(tmp_path)
    rc, _, err = _run_cli(
        ["--project-root", str(tmp_path), "--diff-from-upstream"]
    )
    assert rc == 2
    assert "--repo" in err


# ---------------------------------------------------------------------------
# Backward-compat: triage:scope-drift --ignore-label still works
# ---------------------------------------------------------------------------


def test_scope_drift_ignore_label_alias_writes_same_field(tmp_path: Path):
    """The older `task triage:scope-drift -- --ignore-label` form keeps writing
    to ``plan.policy.triageScopeIgnores[]``; D14c does not break the alias."""
    _write_pd(tmp_path)
    triage_scope_drift.add_ignore(tmp_path, label="legacy-path")
    raw = _read_pd(tmp_path)["plan"]["policy"]["triageScopeIgnores"]
    assert raw == [{"label": "legacy-path"}]
