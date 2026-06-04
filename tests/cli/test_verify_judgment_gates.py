"""Tests for scripts/verify_judgment_gates.py (#1419 Delivery Slice 3).

The engine is ADVISORY by construction: in the default ``advise`` posture it
ALWAYS exits 0, so it can never fail-closed on the framework's own tree (it is
deliberately absent from the ``task check`` aggregate). The gate LOGIC still
supports a fail-closed exit, which is exercised here in an explicit ``enforce``
posture. Covers the four vBRIEF acceptance criteria:

* a1 -- a diff touching secrets paths fails the check closed (enforce).
* a2 -- a tagged declared gate with a recorded clearance validates + exits 0.
* a3 -- a cleared scope that changes after sign-off re-triggers (stale rejected).
* a4 -- with judgmentGatesDisabled unset, the default-on universals emit a
        block-tier requirement for matching changes.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from _pathspec import match_any, match_path  # noqa: E402, I001
from verify_judgment_gates import (  # noqa: E402, I001
    Candidate,
    build_report,
    clearance_log_path,
    effective_gates,
    evaluate,
    fingerprint_scope,
    main,
    read_clearances,
    record_clearance,
)

LIFECYCLE = ("proposed", "pending", "active", "completed", "cancelled")


def _make_project(
    tmp_path: Path,
    *,
    gates: list | None = None,
    disabled: list | None = None,
) -> Path:
    vbrief = tmp_path / "vbrief"
    for folder in LIFECYCLE:
        (vbrief / folder).mkdir(parents=True, exist_ok=True)
    plan: dict = {"title": "judgment-gate test", "status": "running", "items": []}
    policy: dict = {}
    if gates is not None:
        policy["judgmentGates"] = gates
    if disabled is not None:
        policy["judgmentGatesDisabled"] = disabled
    if policy:
        plan["policy"] = policy
    (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text(
        json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": plan}),
        encoding="utf-8",
    )
    return tmp_path


def _declared_gate() -> dict:
    return {
        "id": "api-contract",
        "class": "declared",
        "tier": "block",
        "reason": "API contract change needs human sign-off",
        "match": {"paths": {"any-of": ["api/**"]}},
    }


def _mechanical_gate() -> dict:
    return {
        "id": "db-migrations",
        "class": "mechanical",
        "tier": "block",
        "reason": "DB migration needs sign-off",
        "match": {"paths": {"any-of": ["migrations/**"]}},
    }


def _body_gate() -> dict:
    return {
        "id": "breaking-change",
        "class": "declared",
        "tier": "block",
        "reason": "Body declares a breaking change",
        "match": {"body-text": {"any-of": ["BREAKING CHANGE"]}},
    }


_ALL_UNIVERSALS = [
    "secrets-and-credentials",
    "production-infrastructure",
    "agents-md-and-skills",
    "installer-and-bootstrap",
]


# ---------------------------------------------------------------------------
# a1 -- mechanical fail-closed (enforce posture)
# ---------------------------------------------------------------------------


def test_secrets_path_fails_closed_under_enforce(tmp_path):
    root = _make_project(tmp_path)
    candidate = Candidate(paths=("secrets/prod.env",))
    code, message = evaluate(root, candidate, posture="enforce")
    assert code == 1
    assert "BLOCKED" in message
    assert "secrets-and-credentials" in message


def test_consumer_mechanical_gate_fails_closed_then_clears(tmp_path):
    root = _make_project(tmp_path, gates=[_mechanical_gate()])
    candidate = Candidate(paths=("migrations/0001_init.sql",))
    code, message = evaluate(root, candidate, posture="enforce")
    assert code == 1
    assert "db-migrations" in message

    scope = fingerprint_scope({"paths": ["migrations/0001_init.sql"]})
    record_clearance(root, gate_id="db-migrations", cleared_scope=scope)
    code2, _ = evaluate(root, candidate, posture="enforce")
    assert code2 == 0


def test_secrets_path_advise_never_fails_closed(tmp_path):
    """advise default exits 0 even though the mechanical block gate fires."""
    root = _make_project(tmp_path)
    candidate = Candidate(paths=("secrets/prod.env",))
    code, _ = evaluate(root, candidate)  # advise posture
    assert code == 0
    report = build_report(root, candidate)
    fired = {o.gate_id for o in report.fired}
    assert "secrets-and-credentials" in fired


# ---------------------------------------------------------------------------
# a2 -- declared gate with a recorded clearance validates + exits 0
# ---------------------------------------------------------------------------


def test_declared_gate_with_clearance_exits_zero(tmp_path):
    root = _make_project(tmp_path, gates=[_declared_gate()])
    candidate = Candidate(paths=("api/users.py",))
    scope = fingerprint_scope({"paths": ["api/users.py"]})
    record_clearance(
        root, gate_id="api-contract", cleared_scope=scope, reviewers=["alice"]
    )
    report = build_report(root, candidate)
    outcome = report.outcome_for("api-contract")
    assert outcome is not None
    assert outcome.cleared
    assert not outcome.fired
    code, _ = evaluate(root, candidate, posture="enforce")
    assert code == 0


def test_declared_gate_fails_open_on_omission(tmp_path):
    """A declared gate with no clearance fires but never blocks (fail-open)."""
    root = _make_project(tmp_path, gates=[_declared_gate()])
    candidate = Candidate(paths=("api/users.py",))
    report = build_report(root, candidate)
    outcome = report.outcome_for("api-contract")
    assert outcome is not None
    assert outcome.fired
    assert not outcome.blocking  # declared -> fail-open, not in blocking set
    code, _ = evaluate(root, candidate, posture="enforce")
    assert code == 0


# ---------------------------------------------------------------------------
# a3 -- cleared scope changes -> re-trigger + reject the stale clearance
# ---------------------------------------------------------------------------


def test_scope_creep_rejects_stale_clearance(tmp_path):
    root = _make_project(tmp_path, gates=[_declared_gate()])
    scope1 = fingerprint_scope({"paths": ["api/users.py"]})
    record_clearance(root, gate_id="api-contract", cleared_scope=scope1)

    # Scope creep: a second matched path is added after sign-off.
    candidate = Candidate(paths=("api/users.py", "api/admin.py"))
    report = build_report(root, candidate)
    outcome = report.outcome_for("api-contract")
    assert outcome is not None
    assert outcome.fired  # re-triggered
    assert outcome.clearance is None
    assert outcome.stale_clearance is not None  # the stale sign-off is rejected


def test_body_text_gate_scope_creep_re_triggers(tmp_path):
    """A body-text gate's clearance is rejected once the body is edited.

    Regression for the fingerprint-scope gap: clearances for body-text /
    state / age-days gates must re-trigger on scope creep, not stay cleared
    forever after one sign-off.
    """
    root = _make_project(tmp_path, gates=[_body_gate()])
    original = Candidate(body="This is a BREAKING CHANGE to the API.")
    scope = fingerprint_scope({"body-text": original.body})
    record_clearance(root, gate_id="breaking-change", cleared_scope=scope)

    # The cleared body validates the clearance...
    cleared = build_report(root, original).outcome_for("breaking-change")
    assert cleared is not None and cleared.cleared

    # ...but editing the body (still matching) rejects the stale clearance.
    edited = Candidate(body="This is a BREAKING CHANGE plus extra scope.")
    outcome = build_report(root, edited).outcome_for("breaking-change")
    assert outcome is not None
    assert outcome.fired
    assert outcome.stale_clearance is not None


def test_clearance_round_trips_through_durable_audit_log(tmp_path):
    root = _make_project(tmp_path, gates=[_declared_gate()])
    scope = fingerprint_scope({"paths": ["api/users.py"]})
    entry = record_clearance(
        root,
        gate_id="api-contract",
        cleared_scope=scope,
        reviewers=["alice"],
        reason="reviewed contract diff",
    )
    log_path = clearance_log_path(root)
    assert log_path.is_file()
    assert log_path.parent.name == ".audit"
    records = read_clearances(root)
    assert len(records) == 1
    assert records[0]["gate_id"] == "api-contract"
    assert records[0]["cleared_scope"] == scope
    assert records[0]["clearance_id"] == entry["clearance_id"]
    assert records[0]["reviewers"] == ["alice"]


# ---------------------------------------------------------------------------
# a4 -- default-on universals emit a block-tier requirement
# ---------------------------------------------------------------------------


def test_default_on_universals_emit_block_tier(tmp_path):
    root = _make_project(tmp_path)  # no policy -> judgmentGatesDisabled unset
    candidate = Candidate(
        paths=(
            "secrets/x.env",
            "terraform/main.tf",
            "AGENTS.md",
            "install.sh",
        )
    )
    report = build_report(root, candidate)
    block_ids = {o.gate_id for o in report.block_tier_requirements}
    assert block_ids == set(_ALL_UNIVERSALS)
    for outcome in report.block_tier_requirements:
        assert outcome.tier == "block"
        assert outcome.gate_class == "mechanical"
        assert outcome.source == "universal"


def test_disabled_universal_is_not_emitted(tmp_path):
    root = _make_project(tmp_path, disabled=["secrets-and-credentials"])
    candidate = Candidate(paths=("secrets/x.env",))
    report = build_report(root, candidate)
    assert report.outcomes == ()
    code, _ = evaluate(root, candidate, posture="enforce")
    assert code == 0


def test_label_predicate_matches_and_records_evidence(tmp_path):
    gate = {
        "id": "security-label",
        "class": "declared",
        "tier": "review",
        "reason": "security label flagged",
        "match": {"labels": {"any-of": ["security"]}},
    }
    root = _make_project(tmp_path, gates=[gate])
    candidate = Candidate(labels=("security", "bug"))
    report = build_report(root, candidate)
    outcome = report.outcome_for("security-label")
    assert outcome is not None
    assert outcome.matched_labels == ("security",)
    assert outcome.fired


# ---------------------------------------------------------------------------
# config / robustness
# ---------------------------------------------------------------------------


def test_invalid_root_exits_two(tmp_path):
    missing = tmp_path / "nope"
    code, message = evaluate(
        missing, Candidate(paths=("secrets/x.env",)), posture="enforce"
    )
    assert code == 2
    assert "not a directory" in message


def test_empty_candidate_exits_zero(tmp_path):
    root = _make_project(tmp_path)
    code, _ = evaluate(root)
    assert code == 0
    assert build_report(root, Candidate()).outcomes == ()


def test_malformed_policy_self_heals_to_universals(tmp_path):
    # Missing 'class' makes the consumer gate invalid; the resolver self-heals
    # to default-on-error and the engine evaluates the universal gates only.
    bad_gate = {
        "id": "bad",
        "tier": "block",
        "reason": "x",
        "match": {"paths": {"any-of": ["x/**"]}},
    }
    root = _make_project(tmp_path, gates=[bad_gate])
    candidate = Candidate(paths=("secrets/x.env",))
    report = build_report(root, candidate)
    assert report.policy_error is not None
    ids = {o.gate_id for o in report.outcomes}
    assert "secrets-and-credentials" in ids
    assert "bad" not in ids


def test_effective_gates_drops_disabled_consumer_gate(tmp_path):
    root = _make_project(
        tmp_path, gates=[_mechanical_gate()], disabled=["db-migrations"]
    )
    gate_ids = {g["id"] for g in effective_gates(root)}
    assert "db-migrations" not in gate_ids
    assert "secrets-and-credentials" in gate_ids


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def test_cli_enforce_secrets_returns_one(tmp_path):
    root = _make_project(tmp_path)
    rc = main(["--project-root", str(root), "--path", "secrets/x.env", "--enforce"])
    assert rc == 1


def test_cli_advise_default_returns_zero(tmp_path):
    root = _make_project(tmp_path)
    rc = main(["--project-root", str(root), "--path", "secrets/x.env"])
    assert rc == 0


def test_cli_json_report(tmp_path, capsys):
    root = _make_project(tmp_path)
    rc = main(
        ["--project-root", str(root), "--path", "secrets/x.env", "--enforce", "--json"]
    )
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert rc == 1
    assert payload["exit"] == 1
    assert any(o["gate_id"] == "secrets-and-credentials" for o in payload["outcomes"])


def test_cli_clear_age_days_gate(tmp_path):
    """An age-days gate is clearable via the CLI's --updated-at dimension."""
    gate = {
        "id": "stale-issue",
        "class": "declared",
        "tier": "review",
        "reason": "stale issue needs a fresh look",
        "match": {"age-days": {"gt": 0}},
    }
    root = _make_project(tmp_path, gates=[gate])
    rc = main(
        [
            "clear",
            "--project-root",
            str(root),
            "--gate-id",
            "stale-issue",
            "--updated-at",
            "2020-01-01T00:00:00Z",
        ]
    )
    assert rc == 0
    candidate = Candidate(updated_at="2020-01-01T00:00:00Z")
    now = datetime(2026, 6, 4, tzinfo=UTC)
    outcome = build_report(root, candidate, now=now).outcome_for("stale-issue")
    assert outcome is not None
    assert outcome.cleared


def test_cli_clear_then_enforce_clears(tmp_path):
    root = _make_project(tmp_path)
    rc_clear = main(
        [
            "clear",
            "--project-root",
            str(root),
            "--gate-id",
            "secrets-and-credentials",
            "--path",
            "secrets/x.env",
            "--reviewer",
            "alice",
        ]
    )
    assert rc_clear == 0
    assert len(read_clearances(root)) == 1
    rc_eval = main(
        ["--project-root", str(root), "--path", "secrets/x.env", "--enforce"]
    )
    assert rc_eval == 0


# ---------------------------------------------------------------------------
# _pathspec glob matcher (new helper; exercised directly for branch coverage)
# ---------------------------------------------------------------------------


def test_pathspec_double_star_matches_nested():
    assert match_path("secrets/**", "secrets/a/b.env")
    assert not match_path("secrets/**", "config/a.env")
    assert match_path("a/**/b", "a/b")
    assert match_path("a/**/b", "a/x/y/b")


def test_pathspec_single_star_and_question():
    assert match_path("**/*.env", ".env")
    assert match_path("**/*.env", "a/b/c.env")
    assert not match_path("*.env", "a/b.env")  # single * does not cross /
    assert match_path("file?.txt", "file1.txt")
    assert not match_path("file?.txt", "file12.txt")


def test_pathspec_literal_and_normalization():
    assert match_path("AGENTS.md", "AGENTS.md")
    assert not match_path("AGENTS.md", "sub/AGENTS.md")
    assert match_path("**/AGENTS.md", "sub/AGENTS.md")
    assert match_path("a/b/c", "a\\b\\c")  # backslash normalization


def test_pathspec_match_any_guards():
    assert match_any(["x/**", "secrets/**"], "secrets/a")
    assert not match_any(["x/**"], "secrets/a")
    assert not match_any("not-a-list", "secrets/a")
    assert not match_any([], "secrets/a")
