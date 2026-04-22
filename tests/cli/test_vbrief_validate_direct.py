"""test_vbrief_validate_direct.py -- Direct-import tests for
scripts/vbrief_validate.py (per-function validators).

The existing tests/cli/test_vbrief_validate.py exercises the validator
end-to-end via ``subprocess.run(sys.executable, script, ...)``. Because
the child process is a separate Python interpreter, coverage.py (running
in the parent) cannot instrument it, so scripts/vbrief_validate.py was
reporting 0% tracked coverage. This module imports the validator
directly and exercises each per-function validator.

Companion file ``test_vbrief_validate_direct_orchestration.py`` covers
``validate_project_definition``, ``validate_epic_story_links``,
``check_render_staleness``, ``validate_deprecated_placeholders``,
``validate_all``, and ``main``.

Together they raise scripts/vbrief_validate.py coverage from 0% tracked
to ~95%, giving the TOTAL coverage gate (>=85%) headroom for the RC3
Wave 1 PRs (#507-#510).

Part of RC3 prep chore referenced by #506.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


def _load_vbrief_validate():
    """Load scripts/vbrief_validate.py in-process via importlib.util."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "vbrief_validate_direct",
        scripts_dir / "vbrief_validate.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vv = _load_vbrief_validate()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _minimal_plan(**overrides):
    """Return a minimal valid ``plan`` block."""
    plan = {
        "title": "Scope T",
        "status": "draft",
        "items": [],
    }
    plan.update(overrides)
    return plan


def _minimal_doc(plan_overrides=None, version="0.6"):
    return {
        "vBRIEFInfo": {"version": version},
        "plan": _minimal_plan(**(plan_overrides or {})),
    }


def _make_lifecycle_dirs(vbrief_dir: Path) -> None:
    for folder in vv.LIFECYCLE_FOLDERS:
        (vbrief_dir / folder).mkdir(parents=True, exist_ok=True)


# ===========================================================================
# validate_vbrief_schema
# ===========================================================================


class TestValidateVbriefSchema:
    def test_happy_path_returns_no_errors(self):
        assert vv.validate_vbrief_schema(_minimal_doc(), "f.json") == []

    def test_missing_vbrief_info(self):
        errs = vv.validate_vbrief_schema({"plan": _minimal_plan()}, "f.json")
        assert any("vBRIEFInfo" in e for e in errs)

    def test_vbrief_info_wrong_type(self):
        errs = vv.validate_vbrief_schema(
            {"vBRIEFInfo": "notadict", "plan": _minimal_plan()}, "f.json"
        )
        assert any("must be an object" in e for e in errs)

    def test_wrong_version(self):
        errs = vv.validate_vbrief_schema(_minimal_doc(version="0.4"), "f.json")
        # Validator is strict v0.6-only (#533).
        assert any("0.6" in e for e in errs)

    def test_rejects_v0_5(self):
        """Strict v0.6-only acceptance: v0.5 is now rejected (#533)."""
        errs = vv.validate_vbrief_schema(_minimal_doc(version="0.5"), "f.json")
        assert any("0.6" in e for e in errs)

    def test_accepts_v0_6(self):
        assert vv.validate_vbrief_schema(_minimal_doc(version="0.6"), "f.json") == []

    def test_missing_plan(self):
        errs = vv.validate_vbrief_schema({"vBRIEFInfo": {"version": "0.5"}}, "f.json")
        assert any("'plan'" in e for e in errs)

    def test_plan_wrong_type(self):
        errs = vv.validate_vbrief_schema({"vBRIEFInfo": {"version": "0.5"}, "plan": []}, "f.json")
        assert any("'plan' must be an object" in e for e in errs)

    def test_missing_plan_fields(self):
        errs = vv.validate_vbrief_schema({"vBRIEFInfo": {"version": "0.5"}, "plan": {}}, "f.json")
        assert sum(1 for e in errs if "missing required field" in e) == 3

    def test_empty_title(self):
        errs = vv.validate_vbrief_schema(_minimal_doc({"title": ""}), "f.json")
        assert any("title" in e for e in errs)

    def test_title_wrong_type(self):
        errs = vv.validate_vbrief_schema(_minimal_doc({"title": 123}), "f.json")
        assert any("non-empty string" in e for e in errs)

    def test_invalid_status(self):
        errs = vv.validate_vbrief_schema(_minimal_doc({"status": "bogus"}), "f.json")
        assert any("invalid" in e for e in errs)

    def test_narratives_non_dict(self):
        errs = vv.validate_vbrief_schema(_minimal_doc({"narratives": "not-a-dict"}), "f.json")
        assert any("plan.narratives" in e and "object" in e for e in errs)

    def test_narratives_non_string_values(self):
        errs = vv.validate_vbrief_schema(_minimal_doc({"narratives": {"overview": 123}}), "f.json")
        assert any("must be a string" in e for e in errs)

    def test_items_not_list(self):
        errs = vv.validate_vbrief_schema(_minimal_doc({"items": "nope"}), "f.json")
        assert any("plan.items" in e and "array" in e for e in errs)

    def test_item_not_dict(self):
        errs = vv.validate_vbrief_schema(_minimal_doc({"items": ["not-a-dict"]}), "f.json")
        assert any("plan.items[0]" in e for e in errs)

    def test_plan_item_missing_title_status(self):
        errs = vv.validate_vbrief_schema(_minimal_doc({"items": [{"id": "x"}]}), "f.json")
        assert any("missing 'title'" in e for e in errs)
        assert any("missing 'status'" in e for e in errs)

    def test_plan_item_invalid_status(self):
        errs = vv.validate_vbrief_schema(
            _minimal_doc({"items": [{"title": "T", "status": "weird"}]}),
            "f.json",
        )
        assert any("invalid status" in e for e in errs)

    def test_plan_item_items_preferred_v06(self):
        """v0.6: PlanItem.items is the preferred nested field (#533).

        Previously this asserted an error; v0.6 schema promotes `items`
        as canonical nesting so the same shape must now validate cleanly.
        """
        errs = vv.validate_vbrief_schema(
            _minimal_doc(
                {"items": [{"title": "T", "status": "draft", "items": []}]}
            ),
            "f.json",
        )
        assert errs == []

    def test_plan_item_items_recurses(self):
        """v0.6 PlanItem.items children are validated recursively."""
        bad_child = {
            "title": "T",
            "status": "draft",
            "items": [{"status": "draft"}],  # missing child title
        }
        errs = vv.validate_vbrief_schema(
            _minimal_doc({"items": [bad_child]}),
            "f.json",
        )
        assert any("missing 'title'" in e for e in errs)

    def test_plan_item_items_not_list(self):
        errs = vv.validate_vbrief_schema(
            _minimal_doc({"items": [{"title": "T", "status": "draft", "items": "nope"}]}),
            "f.json",
        )
        assert any("items must be an array" in e for e in errs)

    def test_plan_item_subitems_legacy_accepted(self):
        """Deprecated legacy alias `subItems` continues to validate."""
        errs = vv.validate_vbrief_schema(
            _minimal_doc(
                {"items": [{"title": "T", "status": "draft", "subItems": []}]}
            ),
            "f.json",
        )
        assert errs == []

    def test_plan_item_subitems_not_list(self):
        errs = vv.validate_vbrief_schema(
            _minimal_doc({"items": [{"title": "T", "status": "draft", "subItems": "nope"}]}),
            "f.json",
        )
        assert any("subItems must be an array" in e for e in errs)

    def test_plan_item_subitem_not_dict(self):
        errs = vv.validate_vbrief_schema(
            _minimal_doc({"items": [{"title": "T", "status": "draft", "subItems": ["oops"]}]}),
            "f.json",
        )
        assert any("subItems[0]" in e for e in errs)

    def test_plan_item_narrative_validated(self):
        errs = vv.validate_vbrief_schema(
            _minimal_doc(
                {"items": [{"title": "T", "status": "draft", "narrative": {"overview": 42}}]}
            ),
            "f.json",
        )
        assert any("must be a string" in e for e in errs)


# ===========================================================================
# validate_filename
# ===========================================================================


class TestValidateFilename:
    def test_project_definition_passthrough(self, tmp_path):
        assert vv.validate_filename(tmp_path / "PROJECT-DEFINITION.vbrief.json") == []

    def test_valid_filename(self, tmp_path):
        assert vv.validate_filename(tmp_path / "2026-04-13-feature-x.vbrief.json") == []

    def test_invalid_filename(self, tmp_path):
        errs = vv.validate_filename(tmp_path / "bad-name.json")
        assert errs and "D7" in errs[0]


# ===========================================================================
# validate_folder_status
# ===========================================================================


class TestValidateFolderStatus:
    def test_happy_path(self, tmp_path):
        vd = tmp_path / "vbrief"
        (vd / "proposed").mkdir(parents=True)
        fp = vd / "proposed" / "2026-04-01-x.vbrief.json"
        fp.write_text("{}")
        assert vv.validate_folder_status(fp, _minimal_doc({"status": "draft"}), vd) == []

    def test_file_outside_vbrief_dir(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        fp = tmp_path / "other.vbrief.json"
        assert vv.validate_folder_status(fp, _minimal_doc(), vd) == []

    def test_root_level_file_skipped(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        fp = vd / "PROJECT-DEFINITION.vbrief.json"
        assert vv.validate_folder_status(fp, _minimal_doc(), vd) == []

    def test_non_lifecycle_folder_skipped(self, tmp_path):
        vd = tmp_path / "vbrief"
        (vd / "misc").mkdir(parents=True)
        fp = vd / "misc" / "x.vbrief.json"
        assert vv.validate_folder_status(fp, _minimal_doc(), vd) == []

    def test_missing_status_skipped(self, tmp_path):
        vd = tmp_path / "vbrief"
        (vd / "proposed").mkdir(parents=True)
        fp = vd / "proposed" / "x.vbrief.json"
        doc = {"vBRIEFInfo": {"version": "0.5"}, "plan": {"title": "T"}}
        assert vv.validate_folder_status(fp, doc, vd) == []

    def test_mismatched_status(self, tmp_path):
        vd = tmp_path / "vbrief"
        (vd / "proposed").mkdir(parents=True)
        fp = vd / "proposed" / "x.vbrief.json"
        errs = vv.validate_folder_status(fp, _minimal_doc({"status": "running"}), vd)
        assert errs and "D2" in errs[0]


# ===========================================================================
# validate_origin_provenance
# ===========================================================================


class TestValidateOriginProvenance:
    def _fp(self, vd, folder):
        p = vd / folder / "x.vbrief.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{}")
        return p

    def test_pending_without_origin_warns(self, tmp_path):
        vd = tmp_path / "vbrief"
        fp = self._fp(vd, "pending")
        warnings = vv.validate_origin_provenance(fp, _minimal_doc(), vd)
        assert warnings and "D11" in warnings[0]

    def test_active_without_origin_warns(self, tmp_path):
        vd = tmp_path / "vbrief"
        fp = self._fp(vd, "active")
        warnings = vv.validate_origin_provenance(fp, _minimal_doc(), vd)
        assert warnings and "D11" in warnings[0]

    def test_with_origin_ok(self, tmp_path):
        vd = tmp_path / "vbrief"
        fp = self._fp(vd, "pending")
        doc = _minimal_doc({"references": [{"type": "github-issue", "id": "#1"}]})
        assert vv.validate_origin_provenance(fp, doc, vd) == []

    def test_extended_origin_type_accepted(self, tmp_path):
        vd = tmp_path / "vbrief"
        fp = self._fp(vd, "active")
        doc = _minimal_doc({"references": [{"type": "github-issue-v2", "id": "#1"}]})
        assert vv.validate_origin_provenance(fp, doc, vd) == []

    def test_proposed_folder_skipped(self, tmp_path):
        vd = tmp_path / "vbrief"
        fp = self._fp(vd, "proposed")
        assert vv.validate_origin_provenance(fp, _minimal_doc(), vd) == []

    def test_outside_vbrief_dir_skipped(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        fp = tmp_path / "other.vbrief.json"
        assert vv.validate_origin_provenance(fp, _minimal_doc(), vd) == []

    def test_root_level_file_skipped(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        fp = vd / "x.vbrief.json"
        fp.write_text("{}")
        assert vv.validate_origin_provenance(fp, _minimal_doc(), vd) == []

    def test_non_list_references_treated_as_missing(self, tmp_path):
        vd = tmp_path / "vbrief"
        fp = self._fp(vd, "pending")
        doc = _minimal_doc({"references": "not-a-list"})
        assert vv.validate_origin_provenance(fp, doc, vd)


# ===========================================================================
# load_vbrief / discover_vbriefs
# ===========================================================================


class TestLoadVbrief:
    def test_invalid_json_returns_error(self, tmp_path):
        fp = tmp_path / "x.vbrief.json"
        fp.write_text("{not json", encoding="utf-8")
        data, err = vv.load_vbrief(fp)
        assert data is None
        assert "invalid JSON" in err

    def test_missing_file_returns_error(self, tmp_path):
        fp = tmp_path / "ghost.vbrief.json"
        data, err = vv.load_vbrief(fp)
        assert data is None
        assert "cannot read" in err

    def test_happy_path(self, tmp_path):
        fp = tmp_path / "x.vbrief.json"
        fp.write_text(json.dumps(_minimal_doc()), encoding="utf-8")
        data, err = vv.load_vbrief(fp)
        assert err is None
        assert data is not None


class TestDiscoverVbriefs:
    def test_finds_files_across_lifecycle_folders(self, tmp_path):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        (vd / "proposed" / "2026-04-13-a.vbrief.json").write_text("{}")
        (vd / "active" / "2026-04-13-b.vbrief.json").write_text("{}")
        names = {f.name for f in vv.discover_vbriefs(vd)}
        assert "2026-04-13-a.vbrief.json" in names
        assert "2026-04-13-b.vbrief.json" in names


# ===========================================================================
# Private helper coverage (_collect_plan_refs / _resolve_ref_path /
# _has_plan_ref_to / _path_in_refs)
# ===========================================================================


class TestPrivateHelpers:
    def test_collect_plan_refs_root_and_items(self):
        plan = {
            "planRef": "root.vbrief.json",
            "items": [
                {"planRef": "item.vbrief.json"},
                {"planRef": ""},  # falsy skipped
                "not-a-dict",
                {"no_ref": True},
            ],
        }
        assert vv._collect_plan_refs(plan) == ["root.vbrief.json", "item.vbrief.json"]

    def test_collect_plan_refs_empty(self):
        assert vv._collect_plan_refs({"items": []}) == []

    def test_collect_plan_refs_non_string_root(self):
        assert vv._collect_plan_refs({"planRef": 123}) == []

    def test_resolve_ref_path_file_uri(self, tmp_path):
        assert (
            vv._resolve_ref_path("file://a.vbrief.json", tmp_path)
            == (tmp_path / "a.vbrief.json").resolve()
        )

    def test_resolve_ref_path_http_returns_none(self, tmp_path):
        assert vv._resolve_ref_path("https://x", tmp_path) is None

    def test_resolve_ref_path_fragment_returns_none(self, tmp_path):
        assert vv._resolve_ref_path("#anchor", tmp_path) is None

    def test_resolve_ref_path_non_string_returns_none(self, tmp_path):
        assert vv._resolve_ref_path(None, tmp_path) is None

    def test_resolve_ref_path_relative(self, tmp_path):
        assert (
            vv._resolve_ref_path("sub/x.json", tmp_path) == (tmp_path / "sub" / "x.json").resolve()
        )

    def test_has_plan_ref_to_via_items(self, tmp_path):
        (tmp_path / "parent.vbrief.json").write_text("{}")
        parent = tmp_path / "parent.vbrief.json"
        child_plan = {"items": [{"planRef": "parent.vbrief.json"}]}
        assert vv._has_plan_ref_to(child_plan, parent, tmp_path) is True

    def test_has_plan_ref_to_none(self, tmp_path):
        parent = tmp_path / "parent.vbrief.json"
        assert vv._has_plan_ref_to({}, parent, tmp_path) is False

    def test_path_in_refs_true(self, tmp_path):
        (tmp_path / "a.json").write_text("{}")
        assert vv._path_in_refs(tmp_path / "a.json", {"a.json"}, tmp_path) is True

    def test_path_in_refs_false(self, tmp_path):
        (tmp_path / "a.json").write_text("{}")
        assert vv._path_in_refs(tmp_path / "a.json", {"b.json"}, tmp_path) is False
