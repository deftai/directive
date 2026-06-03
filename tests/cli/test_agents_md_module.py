"""tests/cli/test_agents_md_module.py -- shared AGENTS.md helpers (#1389).

Forward-coverage for ``scripts/_agents_md.py``, the pure module extracted from
``run`` so both ``run`` and ``scripts/doctor.py`` share ONE managed-section /
refresh-plan implementation (the duplication gap that left doctor's freshness
check stubbed and warning spuriously on every consumer ``task doctor`` run).

Covers:
- The module imports cleanly with no import-time side effects and exposes the
  managed-section marker contract + helper surface.
- ``_AGENTS_MANAGED_OPEN_RE`` accepts the v1 / v2 / v3 open markers (the #1044
  / #1046 back-compat parser ``run`` relied on).
- ``_agents_refresh_plan`` computes a genuine verdict
  (``current`` / ``stale`` / ``absent`` / ``missing`` / ``template-missing``)
  for an injected template, with NO hard-coded ``unreadable``.
- ``run``'s thin ``_agents_refresh_plan`` wrapper routes through its
  patchable ``_read_agents_template`` seam (so existing monkeypatch-based
  tests keep driving the shared implementation) and re-exports the helper
  surface tests expect on ``deft_run``.

Story: #1389 (follow-up to the #1335 / #1336 doctor carve).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_AGENTS_MD_PATH = _REPO_ROOT / "scripts" / "_agents_md.py"

_TEMPLATE = (
    "<!-- deft:managed-section v3 -->\n"
    "# Deft\n"
    "Body\n"
    "<!-- /deft:managed-section -->\n"
)
_CLOSE = "<!-- /deft:managed-section -->"


@pytest.fixture(scope="module")
def agents_md():
    """Load ``scripts/_agents_md.py`` fresh under a private name.

    Importing under a unique module name (rather than the bare ``_agents_md``
    that ``run`` / ``doctor`` register in ``sys.modules``) proves the module
    imports cleanly on its own and lets the test exercise it in isolation.
    A successful ``exec_module`` here is itself the no-import-time-side-effects
    assertion -- the module must not shell out / read files / mutate global
    state simply by being imported.
    """
    spec = importlib.util.spec_from_file_location(
        "_agents_md_under_test", _AGENTS_MD_PATH
    )
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def _refresh_plan(agents_md, project_root, template=_TEMPLATE):
    """Call the shared plan with an injected template reader (deterministic)."""
    return agents_md._agents_refresh_plan(
        project_root, read_template=lambda: template
    )


# ---------------------------------------------------------------------------
# Module surface + import purity
# ---------------------------------------------------------------------------


def test_module_exposes_expected_surface(agents_md):
    """The shared module exposes the marker contract + refresh-plan helpers."""
    for name in (
        "_AGENTS_MANAGED_OPEN_RE",
        "_AGENTS_MANAGED_CLOSE",
        "_AGENTS_MANAGED_V3_ATTR_KEYS",
        "_read_agents_template",
        "_render_managed_section",
        "_strip_managed_section_attrs",
        "_parse_managed_section_attrs",
        "_iter_managed_sections",
        "_extract_managed_section",
        "_attribute_render_managed_section",
        "_wrap_legacy_in_markers",
        "_resolve_framework_sha",
        "_new_session_id",
        "_agents_refresh_plan",
        "framework_root",
    ):
        assert hasattr(agents_md, name), f"shared module missing {name!r}"


def test_open_marker_regex_accepts_v1_v2_v3(agents_md):
    """The parser accepts v1, v2 AND v3 open markers (#1044 / #1046 back-compat)."""
    for version in (1, 2, 3):
        marker = f"<!-- deft:managed-section v{version} -->"
        match = agents_md._AGENTS_MANAGED_OPEN_RE.search(marker)
        assert match is not None, f"regex must accept v{version} marker"
        assert match.group(1) == str(version)


# ---------------------------------------------------------------------------
# Refresh-plan verdict states (no hard-coded 'unreadable')
# ---------------------------------------------------------------------------


def test_plan_current_for_byte_identical_section(agents_md, tmp_path):
    (tmp_path / "AGENTS.md").write_text(_TEMPLATE, encoding="utf-8")
    plan = _refresh_plan(agents_md, tmp_path)
    assert plan["state"] == "current"
    assert plan["state"] != "unreadable"


def test_plan_stale_for_diverged_body(agents_md, tmp_path):
    (tmp_path / "AGENTS.md").write_text(
        f"<!-- deft:managed-section v3 -->\nOLD\n{_CLOSE}\n", encoding="utf-8"
    )
    plan = _refresh_plan(agents_md, tmp_path)
    assert plan["state"] == "stale"


def test_plan_absent_when_no_agents_md(agents_md, tmp_path):
    plan = _refresh_plan(agents_md, tmp_path)
    assert plan["state"] == "absent"


def test_plan_missing_for_legacy_unmarked_file(agents_md, tmp_path):
    (tmp_path / "AGENTS.md").write_text("# hand-rolled, no markers\n", encoding="utf-8")
    plan = _refresh_plan(agents_md, tmp_path)
    assert plan["state"] == "missing"


def test_plan_template_missing_when_template_unreadable(agents_md, tmp_path):
    (tmp_path / "AGENTS.md").write_text(_TEMPLATE, encoding="utf-8")
    plan = agents_md._agents_refresh_plan(tmp_path, read_template=lambda: None)
    assert plan["state"] == "template-missing"


def test_legacy_v2_marker_classifies_as_stale(agents_md, tmp_path):
    """A v2-marker file with a byte-identical body still upgrades (stale -> v3)."""
    (tmp_path / "AGENTS.md").write_text(
        f"<!-- deft:managed-section v2 -->\n# Deft\nBody\n{_CLOSE}\n", encoding="utf-8"
    )
    plan = _refresh_plan(agents_md, tmp_path)
    assert plan["state"] == "stale"


# ---------------------------------------------------------------------------
# run delegation: wrapper routes through run's patchable seam
# ---------------------------------------------------------------------------


def test_run_reexports_shared_helpers(deft_run_module):
    """``run`` re-exports the shared helpers so there is a single implementation."""
    import _agents_md  # registered in sys.modules when deft_run imported it

    assert deft_run_module._read_agents_template is _agents_md._read_agents_template
    assert deft_run_module._render_managed_section is _agents_md._render_managed_section
    assert (
        deft_run_module._strip_managed_section_attrs
        is _agents_md._strip_managed_section_attrs
    )


def test_run_wrapper_routes_through_patchable_template(
    deft_run_module, tmp_path, monkeypatch
):
    """Patching ``deft_run._read_agents_template`` flows into the shared plan.

    This is the load-bearing back-compat seam: the existing monkeypatch-based
    suites patch ``deft_run._read_agents_template`` and expect
    ``cmd_agents_refresh`` / ``_agents_refresh_plan`` to honour it. The thin
    wrapper injects that seam into the shared implementation.
    """
    monkeypatch.setattr(deft_run_module, "_read_agents_template", lambda: _TEMPLATE)
    (tmp_path / "AGENTS.md").write_text(_TEMPLATE, encoding="utf-8")

    plan = deft_run_module._agents_refresh_plan(tmp_path)

    assert plan["state"] == "current"
