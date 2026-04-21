"""test_vbrief_validate_direct_orchestration.py -- Direct-import tests for
the orchestration-level validators in scripts/vbrief_validate.py.

Split from ``test_vbrief_validate_direct.py`` to keep individual test
modules below the 500-line SHOULD guideline from main.md.

Covers:
- ``validate_project_definition`` (D3 narratives + reference path checks)
- ``validate_epic_story_links`` (D4 bidirectional links)
- ``check_render_staleness`` (PRD/SPEC drift detection)
- ``validate_deprecated_placeholders`` (sentinel presence check)
- ``validate_all`` + ``main`` (top-level orchestration + CLI)

Part of RC3 prep chore referenced by #506.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


def _load_vbrief_validate():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "vbrief_validate_direct_orch",
        scripts_dir / "vbrief_validate.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vv = _load_vbrief_validate()


def _write_json(path: Path, data) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def _make_lifecycle_dirs(vbrief_dir: Path) -> None:
    for folder in vv.LIFECYCLE_FOLDERS:
        (vbrief_dir / folder).mkdir(parents=True, exist_ok=True)


def _minimal_doc(plan_overrides=None):
    plan = {"title": "Scope T", "status": "draft", "items": []}
    if plan_overrides:
        plan.update(plan_overrides)
    return {"vBRIEFInfo": {"version": "0.5"}, "plan": plan}


# ===========================================================================
# validate_project_definition
# ===========================================================================


class TestValidateProjectDefinition:
    def test_missing_narratives_warnings(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        fp = vd / "PROJECT-DEFINITION.vbrief.json"
        data = {
            "vBRIEFInfo": {"version": "0.5"},
            "plan": {
                "title": "Proj", "status": "draft", "items": [],
                "narratives": {"unrelated": "x"},
            },
        }
        errs = vv.validate_project_definition(fp, data, vd)
        assert sum(1 for e in errs if "D3" in e) >= 2

    def test_file_uri_references(self, tmp_path):
        vd = tmp_path / "vbrief"
        (vd / "proposed").mkdir(parents=True)
        (vd / "proposed" / "real.vbrief.json").write_text("{}")
        outside = tmp_path / "outside.json"
        outside.write_text("{}")
        data = {
            "vBRIEFInfo": {"version": "0.5"},
            "plan": {
                "title": "P", "status": "draft",
                "narratives": {"overview": "o", "tech stack": "ts"},
                "items": [
                    {
                        "title": "I", "status": "draft",
                        "references": [
                            {"type": "x-vbrief/plan",
                             "uri": "file://proposed/real.vbrief.json"},
                            {"type": "x-vbrief/plan",
                             "uri": "file://proposed/missing.vbrief.json"},
                            {"type": "x-vbrief/plan",
                             "uri": f"file://../{outside.name}"},
                        ],
                    }
                ],
            },
        }
        fp = vd / "PROJECT-DEFINITION.vbrief.json"
        errs = vv.validate_project_definition(fp, data, vd)
        assert any("does not exist" in e for e in errs)
        assert any("outside vbrief directory" in e for e in errs)

    def test_relative_references(self, tmp_path):
        vd = tmp_path / "vbrief"
        (vd / "pending").mkdir(parents=True)
        (vd / "pending" / "ok.vbrief.json").write_text("{}")
        data = {
            "vBRIEFInfo": {"version": "0.5"},
            "plan": {
                "title": "P", "status": "draft",
                "narratives": {"overview": "o", "tech stack": "ts"},
                "items": [
                    {
                        "title": "I", "status": "draft",
                        "references": [
                            {"type": "x-vbrief/plan",
                             "uri": "pending/ok.vbrief.json"},
                            {"type": "x-vbrief/plan",
                             "uri": "pending/gone.vbrief.json"},
                            {"type": "x-vbrief/plan", "uri": "../escape.json"},
                            {"type": "web", "uri": "https://example.com"},
                            {"type": "x-vbrief/plan", "uri": "#anchor"},
                            "garbage",
                        ],
                    },
                    "not-a-dict",
                ],
            },
        }
        fp = vd / "PROJECT-DEFINITION.vbrief.json"
        errs = vv.validate_project_definition(fp, data, vd)
        assert any("'pending/gone.vbrief.json'" in e for e in errs)
        assert any("../escape.json" in e and "outside" in e for e in errs)

    def test_refs_non_list(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        fp = vd / "PROJECT-DEFINITION.vbrief.json"
        data = {
            "vBRIEFInfo": {"version": "0.5"},
            "plan": {
                "title": "P", "status": "draft",
                "narratives": {"overview": "o", "tech stack": "ts"},
                "items": [{
                    "title": "I", "status": "draft",
                    "references": "not-a-list",
                }],
            },
        }
        assert vv.validate_project_definition(fp, data, vd) == []


# ===========================================================================
# validate_epic_story_links
# ===========================================================================


class TestValidateEpicStoryLinks:
    def _build(self, vd: Path, *specs):
        docs = {}
        for rel, plan in specs:
            path = vd / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            doc = {"vBRIEFInfo": {"version": "0.5"}, "plan": plan}
            path.write_text(json.dumps(doc), encoding="utf-8")
            docs[path.resolve()] = doc
        return docs

    def test_forward_child_missing(self, tmp_path):
        vd = tmp_path / "vbrief"
        docs = self._build(
            vd,
            ("pending/parent.vbrief.json", {
                "title": "P", "status": "pending", "items": [],
                "references": [
                    {"type": "x-vbrief/plan",
                     "uri": "pending/missing.vbrief.json"}
                ],
            }),
        )
        errs = vv.validate_epic_story_links(docs, vd)
        assert any("does not exist" in e and "(D4)" in e for e in errs)

    def test_child_missing_planref(self, tmp_path):
        vd = tmp_path / "vbrief"
        docs = self._build(
            vd,
            ("pending/parent.vbrief.json", {
                "title": "P", "status": "pending", "items": [],
                "references": [
                    {"type": "x-vbrief/plan",
                     "uri": "pending/child.vbrief.json"}
                ],
            }),
            ("pending/child.vbrief.json", {
                "title": "C", "status": "pending", "items": [],
            }),
        )
        errs = vv.validate_epic_story_links(docs, vd)
        assert any("missing planRef back" in e for e in errs)

    def test_backward_planref_without_parent_ref(self, tmp_path):
        vd = tmp_path / "vbrief"
        docs = self._build(
            vd,
            ("pending/parent.vbrief.json", {
                "title": "P", "status": "pending", "items": [],
            }),
            ("pending/child.vbrief.json", {
                "title": "C", "status": "pending", "items": [],
                "planRef": "pending/parent.vbrief.json",
            }),
        )
        errs = vv.validate_epic_story_links(docs, vd)
        assert any(
            "parent does not list this file" in e.replace("\n", " ")
            for e in errs
        )

    def test_happy_bidirectional(self, tmp_path):
        vd = tmp_path / "vbrief"
        docs = self._build(
            vd,
            ("pending/parent.vbrief.json", {
                "title": "P", "status": "pending", "items": [],
                "references": [
                    {"type": "x-vbrief/plan",
                     "uri": "pending/child.vbrief.json"}
                ],
            }),
            ("pending/child.vbrief.json", {
                "title": "C", "status": "pending", "items": [],
                "planRef": "pending/parent.vbrief.json",
            }),
        )
        assert vv.validate_epic_story_links(docs, vd) == []

    def test_planref_nonexistent_parent(self, tmp_path):
        vd = tmp_path / "vbrief"
        docs = self._build(
            vd,
            ("pending/child.vbrief.json", {
                "title": "C", "status": "pending", "items": [],
                "planRef": "pending/ghost.vbrief.json",
            }),
        )
        errs = vv.validate_epic_story_links(docs, vd)
        assert any("does not exist" in e for e in errs)

    def test_ignores_non_plan_ref_types(self, tmp_path):
        vd = tmp_path / "vbrief"
        docs = self._build(
            vd,
            ("pending/x.vbrief.json", {
                "title": "X", "status": "pending", "items": [],
                "references": [
                    {"type": "github-issue", "uri": "unused", "id": "#1"},
                    {"type": "x-vbrief/plan", "uri": ""},
                    "garbage",
                ],
            }),
        )
        assert vv.validate_epic_story_links(docs, vd) == []


# ===========================================================================
# check_render_staleness
# ===========================================================================


class TestRenderStaleness:
    def _write_spec(self, vd, narratives, items, title):
        vd.mkdir(parents=True, exist_ok=True)
        _write_json(
            vd / "specification.vbrief.json",
            {
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {
                    "title": title, "status": "draft", "items": items,
                    "narratives": narratives,
                },
            },
        )

    def test_no_spec_file_returns_empty(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        assert vv.check_render_staleness(vd) == []

    def test_invalid_spec_returns_empty(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        (vd / "specification.vbrief.json").write_text("{not json")
        assert vv.check_render_staleness(vd) == []

    def test_plan_not_dict_returns_empty(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        _write_json(
            vd / "specification.vbrief.json",
            {"vBRIEFInfo": {"version": "0.5"}, "plan": []},
        )
        assert vv.check_render_staleness(vd) == []

    def test_prd_stale(self, tmp_path):
        vd = tmp_path / "vbrief"
        self._write_spec(
            vd, {"overview": "brand new overview"}, [], "Fresh Title"
        )
        (tmp_path / "PRD.md").write_text("OUT OF DATE", encoding="utf-8")
        warnings = vv.check_render_staleness(vd)
        assert any("PRD.md" in w for w in warnings)

    def test_prd_fresh(self, tmp_path):
        vd = tmp_path / "vbrief"
        self._write_spec(vd, {"overview": "alpha"}, [], "Fresh Title")
        (tmp_path / "PRD.md").write_text(
            "Fresh Title\n\nalpha\n", encoding="utf-8"
        )
        warnings = vv.check_render_staleness(vd)
        assert not any("PRD.md" in w for w in warnings)

    def test_spec_md_stale_item_title(self, tmp_path):
        vd = tmp_path / "vbrief"
        self._write_spec(
            vd, {"overview": "o"},
            [{"title": "ItemFoo", "status": "draft"}],
            "Title",
        )
        (tmp_path / "SPECIFICATION.md").write_text(
            "No match here", encoding="utf-8"
        )
        warnings = vv.check_render_staleness(vd)
        assert any("SPECIFICATION.md" in w for w in warnings)

    def test_spec_md_with_redirect_sentinel_skipped(self, tmp_path):
        vd = tmp_path / "vbrief"
        self._write_spec(
            vd, {"overview": "o"},
            [{"title": "ItemFoo", "status": "draft"}],
            "Title",
        )
        (tmp_path / "SPECIFICATION.md").write_text(
            vv.DEPRECATED_REDIRECT_SENTINEL, encoding="utf-8"
        )
        warnings = vv.check_render_staleness(vd)
        assert not any("SPECIFICATION.md" in w for w in warnings)


class TestDeprecatedPlaceholders:
    def test_missing_files_noop(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        assert vv.validate_deprecated_placeholders(vd) == []

    def test_file_without_sentinel_warns(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        (tmp_path / "SPECIFICATION.md").write_text(
            "Real content", encoding="utf-8"
        )
        warnings = vv.validate_deprecated_placeholders(vd)
        assert any("SPECIFICATION.md" in w for w in warnings)

    def test_file_with_sentinel_no_warn(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        (tmp_path / "PROJECT.md").write_text(
            vv.DEPRECATED_REDIRECT_SENTINEL, encoding="utf-8"
        )
        assert vv.validate_deprecated_placeholders(vd) == []


# ===========================================================================
# validate_all + main
# ===========================================================================


class TestValidateAll:
    def test_clean_vbrief_dir_returns_no_errors(self, tmp_path):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        _write_json(
            vd / "proposed" / "2026-04-13-clean.vbrief.json",
            _minimal_doc(),
        )
        errors, _warnings, count = vv.validate_all(vd)
        assert errors == []
        assert count == 1

    def test_load_error_propagates(self, tmp_path):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        (vd / "proposed" / "2026-04-13-bad.vbrief.json").write_text("{oops")
        errors, _warnings, count = vv.validate_all(vd)
        assert any("invalid JSON" in e for e in errors)
        assert count == 1

    def test_project_definition_validated(self, tmp_path):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        _write_json(
            vd / "PROJECT-DEFINITION.vbrief.json",
            {
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {
                    "title": "Proj", "status": "draft", "items": [],
                    "narratives": {"overview": "o", "tech stack": "ts"},
                },
            },
        )
        errors, _warnings, _count = vv.validate_all(vd)
        assert errors == []

    def test_project_definition_invalid_json(self, tmp_path):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        (vd / "PROJECT-DEFINITION.vbrief.json").write_text("{oops")
        errors, _warnings, _count = vv.validate_all(vd)
        assert any("invalid JSON" in e for e in errors)


class TestMain:
    def test_no_vbrief_dir(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(sys, "argv", ["vbrief_validate.py"])
        rc = vv.main()
        assert rc == 0
        assert "No vbrief directory" in capsys.readouterr().out

    def test_unknown_argument(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(sys, "argv", ["vbrief_validate.py", "--bogus"])
        rc = vv.main()
        assert rc == 2
        assert "Unknown argument" in capsys.readouterr().err

    def test_validation_pass(self, tmp_path, monkeypatch, capsys):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        _write_json(
            vd / "proposed" / "2026-04-13-ok.vbrief.json",
            _minimal_doc(),
        )
        monkeypatch.setattr(
            sys, "argv", ["vbrief_validate.py", "--vbrief-dir", str(vd)]
        )
        rc = vv.main()
        assert rc == 0
        assert "validation passed" in capsys.readouterr().out

    def test_validation_pass_with_project_definition(
        self, tmp_path, monkeypatch, capsys
    ):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        _write_json(
            vd / "PROJECT-DEFINITION.vbrief.json",
            {
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {
                    "title": "Proj", "status": "draft", "items": [],
                    "narratives": {"overview": "o", "tech stack": "ts"},
                },
            },
        )
        monkeypatch.setattr(
            sys, "argv", ["vbrief_validate.py", "--vbrief-dir", str(vd)]
        )
        rc = vv.main()
        assert rc == 0
        assert "PROJECT-DEFINITION" in capsys.readouterr().out

    def test_validation_failure(self, tmp_path, monkeypatch, capsys):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        _write_json(
            vd / "proposed" / "2026-04-13-bad.vbrief.json",
            {
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {"status": "draft", "items": []},
            },
        )
        monkeypatch.setattr(
            sys, "argv", ["vbrief_validate.py", "--vbrief-dir", str(vd)]
        )
        rc = vv.main()
        assert rc == 1
        assert "FAIL" in capsys.readouterr().out

    def test_empty_vbrief_directory_passes_with_no_files_note(
        self, tmp_path, monkeypatch, capsys
    ):
        vd = tmp_path / "vbrief"
        vd.mkdir()
        monkeypatch.setattr(
            sys, "argv", ["vbrief_validate.py", "--vbrief-dir", str(vd)]
        )
        rc = vv.main()
        assert rc == 0
        assert "no vBRIEF files" in capsys.readouterr().out
