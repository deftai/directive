"""Content + validation tests for the #1186 consumer-example deliverables.

Pins two surfaces so a future edit cannot silently drop the contract:

* ``docs/example-project-definition.md`` section structure mirrors the
  four canonical blocks the issue body locked in (empty template,
  deft's filled-in version, side-by-side annotation column,
  clone-and-edit closing note). Mirrors the snapshot-style content
  tests from N9 (#1149) / N12 (#1152).
* ``vbrief/PROJECT-DEFINITION.vbrief.json`` ``plan.policy.*`` carries
  deft's actual values and passes every framework primitive's
  schema validator (D10 / #1129, D11 / #1128, D12 / #1131, D14c /
  #1182, D4 / #1124).

NO framework code is touched; both surfaces are consumer-side
artifacts per umbrella #1119 Current Shape v3 section 12.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
DOC_PATH = REPO_ROOT / "docs" / "example-project-definition.md"
MAIN_PATH = REPO_ROOT / "main.md"
PROJECT_DEFINITION_PATH = REPO_ROOT / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
SCRIPTS_DIR = REPO_ROOT / "scripts"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def doc_text() -> str:
    return DOC_PATH.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def main_text() -> str:
    return MAIN_PATH.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def project_definition() -> dict:
    return json.loads(PROJECT_DEFINITION_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def policy(project_definition: dict) -> dict:
    plan = project_definition.get("plan")
    assert isinstance(plan, dict), "PROJECT-DEFINITION 'plan' must be an object"
    pol = plan.get("policy")
    assert isinstance(pol, dict), (
        "PROJECT-DEFINITION must carry 'plan.policy' object after #1186"
    )
    return pol


# ---------------------------------------------------------------------------
# 1. Doc presence + four canonical sections
# ---------------------------------------------------------------------------


def test_doc_file_exists() -> None:
    """The consumer-example reference doc must exist."""
    assert DOC_PATH.is_file(), (
        f"missing consumer-example reference doc at {DOC_PATH.relative_to(REPO_ROOT)}"
    )


REQUIRED_SECTIONS = (
    r"^#\s+Example PROJECT-DEFINITION",
    r"^##\s+1\.\s+Empty template",
    r"^##\s+2\.\s+Deft's filled-in version",
    r"^##\s+3\.\s+Side-by-side annotation column",
    r"^##\s+4\.\s+Closing note:\s*clone-and-edit",
)


@pytest.mark.parametrize("pattern", REQUIRED_SECTIONS)
def test_doc_carries_required_sections(doc_text: str, pattern: str) -> None:
    """Each of the four canonical sections from the #1186 issue body must be a heading."""
    assert re.search(pattern, doc_text, re.MULTILINE), (
        f"missing required section heading matching {pattern!r} in "
        f"{DOC_PATH.relative_to(REPO_ROOT)}"
    )


def test_doc_carries_per_primitive_annotation_subsections(doc_text: str) -> None:
    """Section 3 annotation column must call out each of the four typed policy fields."""
    for subsection in (
        r"^###\s+triageScope",
        r"^###\s+triageRankingLabels",
        r"^###\s+triageAutoClassify",
        r"^###\s+triageScopeIgnores",
    ):
        assert re.search(subsection, doc_text, re.MULTILINE), (
            f"annotation column missing per-primitive subsection matching {subsection!r}"
        )


# ---------------------------------------------------------------------------
# 2. Required annotation labels (issue body explicitly named them)
# ---------------------------------------------------------------------------


REQUIRED_ANNOTATION_LABELS = (
    "blocks-merge",
    "breaking-change",
    "status:superseded-pending",
)


@pytest.mark.parametrize("label", REQUIRED_ANNOTATION_LABELS)
def test_doc_annotates_required_labels(doc_text: str, label: str) -> None:
    """The issue body requires explicit annotation of these three labels."""
    assert label in doc_text, (
        f"annotation column must mention required label {label!r} per #1186 deliverable 2"
    )


def test_doc_distinguishes_deft_specific_from_common_convention(doc_text: str) -> None:
    """Annotation column must distinguish deft-specific from common-convention values."""
    assert "deft-specific" in doc_text, (
        "annotation column must explicitly tag at least one entry as 'deft-specific'"
    )
    assert "common convention" in doc_text, (
        "annotation column must explicitly tag at least one entry as 'common convention'"
    )


def test_doc_closes_with_clone_and_edit_pointer(doc_text: str) -> None:
    """Closing section must guide consumers to clone-and-edit into their own PROJECT-DEFINITION."""
    closing = doc_text.split("## 4. Closing note")[-1]
    assert "PROJECT-DEFINITION.vbrief.json" in closing, (
        "closing note must point at vbrief/PROJECT-DEFINITION.vbrief.json"
    )
    assert "label" in closing.lower(), (
        "closing note must instruct consumers to adjust labels to their repo's vocabulary"
    )


# ---------------------------------------------------------------------------
# 3. plan.policy.* shape + framework-validator round-trip
# ---------------------------------------------------------------------------


def test_policy_carries_four_typed_arrays(policy: dict) -> None:
    """Deliverable 1 must carry all four typed arrays from the issue body."""
    for key in (
        "triageScope",
        "triageRankingLabels",
        "triageAutoClassify",
        "triageScopeIgnores",
    ):
        assert key in policy, f"plan.policy must carry {key!r} per #1186 Deliverable 1"
        assert isinstance(policy[key], list), (
            f"plan.policy.{key} must be a list (got {type(policy[key]).__name__})"
        )
        assert policy[key], f"plan.policy.{key} must be non-empty per #1186 Deliverable 1"


def test_policy_omits_wip_cap(policy: dict) -> None:
    """Deft accepts the framework default 10; wipCap is OMITTED per the issue body."""
    assert "wipCap" not in policy, (
        "plan.policy.wipCap must remain unset -- deft accepts the framework default 10 "
        "per #1186 Deliverable 1"
    )


def test_triage_scope_carries_deft_labels_and_milestone_rule(policy: dict) -> None:
    """triageScope[] must carry deft's labels list + the milestone is-open:true rule."""
    rules = policy["triageScope"]
    label_rule = next((r for r in rules if r.get("rule") == "labels"), None)
    assert label_rule is not None, "triageScope must include a 'labels' rule"
    any_of = label_rule.get("any-of") or []
    for required in (
        "enhancement",
        "epic",
        "meta",
        "skills",
        "adoption-blocker",
        "blocks-merge",
        "blocks-release-tag",
    ):
        assert required in any_of, (
            f"triageScope labels.any-of must include {required!r} per #1186"
        )
    milestone_rule = next((r for r in rules if r.get("rule") == "milestone"), None)
    assert milestone_rule is not None, "triageScope must include a 'milestone' rule"
    assert milestone_rule.get("is-open") is True, (
        "triageScope milestone rule must use {is-open: true} per #1186 Deliverable 1"
    )


def test_triage_ranking_labels_in_declared_priority_order(policy: dict) -> None:
    """Ranking labels must match deft's declared priority (highest first)."""
    assert policy["triageRankingLabels"] == [
        "blocks-merge",
        "blocks-release-tag",
        "adoption-blocker",
        "breaking-change",
        "urgent",
    ], (
        "triageRankingLabels order must match #1186 Deliverable 1: "
        "[blocks-merge, blocks-release-tag, adoption-blocker, breaking-change, urgent]"
    )


def test_triage_auto_classify_carries_canonical_rules(policy: dict) -> None:
    """The five canonical auto-classify rules from the issue body must all be present."""
    rules = policy["triageAutoClassify"]
    by_first_label = {}
    for r in rules:
        labels = r.get("match", {}).get("labels", {}).get("any-of") or []
        if labels:
            by_first_label[labels[0]] = r
    # status:superseded-pending -> defer
    assert by_first_label["status:superseded-pending"]["action"] == "defer"
    # rfc / type:research -> defer with reason 'exploratory'
    exploratory = by_first_label.get("rfc")
    assert exploratory is not None and exploratory["action"] == "defer"
    assert exploratory["reason"] == "exploratory"
    # wontfix -> defer
    assert by_first_label["wontfix"]["action"] == "defer"
    # duplicate -> archive
    assert by_first_label["duplicate"]["action"] == "archive"
    # fixed-pending-merge -> defer + resume-on
    fpm = by_first_label["fixed-pending-merge"]
    assert fpm["action"] == "defer"
    assert fpm.get("resume-on") == "<linked-PR>:merged", (
        "fixed-pending-merge rule must carry resume-on:'<linked-PR>:merged' per #1186"
    )


def test_triage_scope_ignores_silences_wontfix_and_duplicate(policy: dict) -> None:
    """triageScopeIgnores[] must suppress wontfix + duplicate labels from drift."""
    entries = policy["triageScopeIgnores"]
    ignored_labels = {e.get("label") for e in entries if "label" in e}
    assert "wontfix" in ignored_labels, (
        "triageScopeIgnores must suppress 'wontfix' from drift per #1186"
    )
    assert "duplicate" in ignored_labels, (
        "triageScopeIgnores must suppress 'duplicate' from drift per #1186"
    )


# ---------------------------------------------------------------------------
# 4. Round-trip through every framework primitive's validator
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def _scripts_on_path() -> None:
    """Make scripts/ importable so per-primitive validators load."""
    path_str = str(SCRIPTS_DIR)
    if path_str not in sys.path:
        sys.path.insert(0, path_str)


def test_triage_scope_passes_d12_validator(
    project_definition: dict, _scripts_on_path: None
) -> None:
    """plan.policy.triageScope[] must pass D12 / #1131 validator."""
    from triage_scope import validate_triage_scope_on_plan  # type: ignore

    errors = validate_triage_scope_on_plan(
        project_definition["plan"], PROJECT_DEFINITION_PATH
    )
    assert errors == [], f"triageScope[] D12 validation failed: {errors}"


def test_triage_ranking_labels_passes_d11_validator(
    project_definition: dict, _scripts_on_path: None
) -> None:
    """plan.policy.triageRankingLabels[] must pass D11 / #1128 validator."""
    from triage_queue import validate_triage_ranking_labels_on_plan  # type: ignore

    errors = validate_triage_ranking_labels_on_plan(
        project_definition["plan"], PROJECT_DEFINITION_PATH
    )
    assert errors == [], f"triageRankingLabels[] D11 validation failed: {errors}"


def test_triage_auto_classify_passes_d10_validator(
    project_definition: dict, _scripts_on_path: None
) -> None:
    """plan.policy.triageAutoClassify[] must pass D10 / #1129 validator."""
    from triage_classify import validate_triage_auto_classify_on_plan  # type: ignore

    errors = validate_triage_auto_classify_on_plan(
        project_definition["plan"], PROJECT_DEFINITION_PATH
    )
    assert errors == [], f"triageAutoClassify[] D10 validation failed: {errors}"


def test_triage_scope_ignores_passes_d14_d14c_validator(
    project_definition: dict, _scripts_on_path: None
) -> None:
    """plan.policy.triageScopeIgnores[] must pass D14 / #1133 + D14c / #1182 validator."""
    from triage_scope import (  # type: ignore
        validate_triage_scope_ignores_on_plan,
    )

    errors = validate_triage_scope_ignores_on_plan(
        project_definition["plan"], PROJECT_DEFINITION_PATH
    )
    assert errors == [], f"triageScopeIgnores[] D14c validation failed: {errors}"


def test_wip_cap_passes_d4_validator_when_omitted(
    project_definition: dict, _scripts_on_path: None
) -> None:
    """plan.policy.wipCap is omitted; D4 / #1124 validator must accept the unset case."""
    from policy import validate_wip_cap_on_plan  # type: ignore

    errors = validate_wip_cap_on_plan(
        project_definition["plan"], PROJECT_DEFINITION_PATH
    )
    assert errors == [], (
        f"unset wipCap must not produce D4 errors (framework default 10 applies): {errors}"
    )


# ---------------------------------------------------------------------------
# 5. §12 boundary smoke -- no deft-specific labels leaked into framework code
# ---------------------------------------------------------------------------


def test_framework_defaults_do_not_carry_deft_specific_labels() -> None:
    """Section 12 boundary: deft-specific labels must not appear in framework defaults.

    Deliberately narrow: scans the small set of framework default surfaces (the
    auto-classify universal rules + the D11 default ranking labels constant +
    the D14c default ignore rules) for leakage. Mirrors the spirit of D10's
    own ``test_framework_defaults_do_not_reference_deft_labels`` test without
    duplicating its scope.
    """
    import importlib
    import sys as _sys

    path_str = str(SCRIPTS_DIR)
    if path_str not in _sys.path:
        _sys.path.insert(0, path_str)
    triage_classify = importlib.import_module("triage_classify")
    triage_queue = importlib.import_module("triage_queue")

    # D10 universal rules carry no labels at all -- they are label-agnostic.
    for rule in triage_classify.UNIVERSAL_RULES:
        assert "match" not in rule, (
            "framework universal rules must remain label-agnostic per #1119 section 12"
        )

    deft_specific = {
        "blocks-merge",
        "blocks-release-tag",
        "adoption-blocker",
        "status:superseded-pending",
        "fixed-pending-merge",
    }
    default_ranking = set(
        getattr(triage_queue, "DEFAULT_TRIAGE_RANKING_LABELS", ())
    )
    leaked = deft_specific & default_ranking
    assert not leaked, (
        f"framework D11 default ranking labels leak deft-specific values: {sorted(leaked)} "
        "(violates #1119 section 12 framework-vs-consumer boundary)"
    )


# ---------------------------------------------------------------------------
# 6. Consumer Taskfile include examples stay namespaced (#1523)
# ---------------------------------------------------------------------------


def _section_between(text: str, start: str, end: str) -> str:
    start_idx = text.index(start)
    end_idx = text.index(end, start_idx)
    return text[start_idx:end_idx]


def test_main_taskfile_include_uses_resolvable_deft_namespace(main_text: str) -> None:
    """The canonical consumer include exposes framework tasks as deft:<task>."""
    section = _section_between(
        main_text,
        "### Publishing deft tasks in your project root",
        "### What migration produces",
    )
    assert "task deft:migrate:vbrief" in section
    assert "task -t ./.deft/core/Taskfile.yml migrate:vbrief" in section
    assert "task migrate:vbrief\n" not in section
    assert "`task migrate:vbrief`" not in section


def test_main_preferred_workflow_uses_namespaced_consumer_tasks(
    main_text: str,
) -> None:
    """Preferred workflow examples must match the canonical deft: include."""
    section = _section_between(
        main_text,
        "## Preferred Workflow: Tasks + Skills Together",
        "## Continuous Improvement",
    )
    for marker in (
        "task deft:issue:ingest",
        "task deft:reconcile:issues",
        "task deft:scope:{promote,activate,complete,cancel,restore,block,unblock}",
        "task deft:roadmap:render",
        "task deft:project:render",
    ):
        assert marker in section
    for bare_marker in (
        "task scope:",
        "task roadmap:render",
        "task project:render",
    ):
        assert bare_marker not in section
