"""test_rule_ownership_lint.py -- Tests for scripts/rule_ownership_lint.py.

Covers (#635 ROM child, vBRIEF
``vbrief/proposed/2026-04-27-635-rule-ownership-map-data-file-and-lint.vbrief.json``):

- Section extraction over varying heading levels and multi-section files
- Happy path: every ROM row maps to a live (owner_file, owner_section, text) -> exit 0
- Drift: rule moved (owner_file gone) -> exit 1
- Drift: rule moved (owner_section renamed) -> exit 1
- Drift: rule text rewritten / deleted within section -> exit 1
- Lesson-owner case: authority="lesson", owner_file=meta/lessons.md style works
- Multiple drift rows accumulate into a single non-zero exit
- Repository-wide smoke test: the real conventions/rule-ownership.json passes the lint
- Config errors: missing data file / malformed JSON / wrong shape / unknown authority /
  duplicate id -> exit 2

Uses in-process module loading via ``importlib.util`` and synthetic
fixture trees built under ``tmp_path`` so the tests are hermetic.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load scripts/rule_ownership_lint.py in-process."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "rule_ownership_lint",
        scripts_dir / "rule_ownership_lint.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rom = _load_module()


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _write(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def _make_payload(rules: list[dict]) -> dict:
    return {"version": 1, "description": "test fixture", "rules": rules}


def _seed_clean_repo(tmp_path: Path) -> tuple[Path, Path]:
    """Seed a tiny synthetic repo with one owner file and one matching ROM row.

    Returns ``(repo_root, map_path)``.
    """
    owner = tmp_path / "coding" / "coding.md"
    _write(
        owner,
        "# Coding\n"
        "\n"
        "Intro paragraph.\n"
        "\n"
        "## Code Design\n"
        "\n"
        "- ! One responsibility per file/module\n"
        "- ! Define interfaces/types/protocols before implementation\n"
        "\n"
        "## Quality Standards\n"
        "\n"
        "- ! Run all relevant checks before submitting changes\n",
    )
    map_path = tmp_path / "conventions" / "rule-ownership.json"
    _write(
        map_path,
        json.dumps(
            _make_payload(
                [
                    {
                        "id": "coding-modularity",
                        "text": "One responsibility per file/module",
                        "owner_file": "coding/coding.md",
                        "owner_section": "## Code Design",
                        "authority": "MUST",
                        "last_verified": "2026-04-28",
                    }
                ]
            ),
            indent=2,
        ),
    )
    return tmp_path, map_path


# ---------------------------------------------------------------------------
# extract_section_body
# ---------------------------------------------------------------------------


class TestExtractSectionBody:
    def test_returns_body_until_next_same_level_heading(self):
        content = (
            "# Title\n"
            "## A\n"
            "alpha line\n"
            "\n"
            "## B\n"
            "beta line\n"
        )
        body = rom.extract_section_body(content, "## A")
        assert body is not None
        assert "alpha line" in body
        assert "beta line" not in body

    def test_includes_subsections(self):
        # A higher-level heading inside the body should be included; the body
        # ends only when an equal-or-higher-level heading appears.
        content = (
            "## Outer\n"
            "outer line\n"
            "\n"
            "### Subsection\n"
            "sub line\n"
            "\n"
            "## Sibling\n"
            "sibling line\n"
        )
        body = rom.extract_section_body(content, "## Outer")
        assert body is not None
        assert "outer line" in body
        assert "sub line" in body
        assert "sibling line" not in body

    def test_returns_none_when_section_missing(self):
        content = "# Title\n## Other\nbody\n"
        assert rom.extract_section_body(content, "## Missing") is None

    def test_section_at_eof_returns_body(self):
        content = "## Only\nbody line\n"
        body = rom.extract_section_body(content, "## Only")
        assert body is not None
        assert "body line" in body

    def test_owner_section_with_invalid_format_returns_none(self):
        # owner_section must include the leading hashes
        content = "## Heading\nbody\n"
        assert rom.extract_section_body(content, "Heading") is None

    def test_heading_level_match_required(self):
        # `## A` must NOT match a `### A` heading
        content = "### A\nbody\n## A\nright body\n"
        body = rom.extract_section_body(content, "## A")
        assert body is not None
        assert "right body" in body
        assert body.strip().splitlines()[0].strip() == "right body"


# ---------------------------------------------------------------------------
# _load_map (config errors)
# ---------------------------------------------------------------------------


class TestLoadMap:
    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(ValueError, match="not found"):
            rom._load_map(tmp_path / "missing.json")

    def test_malformed_json_raises(self, tmp_path):
        p = tmp_path / "rom.json"
        p.write_text("{not json", encoding="utf-8")
        with pytest.raises(ValueError, match="Malformed JSON"):
            rom._load_map(p)

    def test_top_level_not_object_raises(self, tmp_path):
        p = tmp_path / "rom.json"
        p.write_text("[]", encoding="utf-8")
        with pytest.raises(ValueError, match="JSON object"):
            rom._load_map(p)

    def test_missing_rules_array_raises(self, tmp_path):
        p = tmp_path / "rom.json"
        p.write_text('{"version": 1}', encoding="utf-8")
        with pytest.raises(ValueError, match="'rules' array"):
            rom._load_map(p)

    def test_missing_required_field_raises(self, tmp_path):
        p = tmp_path / "rom.json"
        # Missing 'last_verified'
        p.write_text(
            json.dumps(
                _make_payload(
                    [
                        {
                            "id": "x",
                            "text": "y",
                            "owner_file": "f.md",
                            "owner_section": "## H",
                            "authority": "MUST",
                        }
                    ]
                )
            ),
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="missing required field 'last_verified'"):
            rom._load_map(p)

    def test_invalid_authority_raises(self, tmp_path):
        p = tmp_path / "rom.json"
        p.write_text(
            json.dumps(
                _make_payload(
                    [
                        {
                            "id": "x",
                            "text": "y",
                            "owner_file": "f.md",
                            "owner_section": "## H",
                            "authority": "GUIDELINE",
                            "last_verified": "2026-04-28",
                        }
                    ]
                )
            ),
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="invalid authority"):
            rom._load_map(p)

    def test_duplicate_id_raises(self, tmp_path):
        p = tmp_path / "rom.json"
        rule = {
            "id": "dup",
            "text": "y",
            "owner_file": "f.md",
            "owner_section": "## H",
            "authority": "MUST",
            "last_verified": "2026-04-28",
        }
        p.write_text(json.dumps(_make_payload([rule, dict(rule)])), encoding="utf-8")
        with pytest.raises(ValueError, match="Duplicate ROM rule id"):
            rom._load_map(p)


# ---------------------------------------------------------------------------
# main / CLI
# ---------------------------------------------------------------------------


class TestMain:
    def test_happy_path_clean_repo_exits_0(self, tmp_path, capsys):
        root, map_path = _seed_clean_repo(tmp_path)
        rc = rom.main(["--root", str(root), "--map", str(map_path)])
        assert rc == rom.EXIT_OK
        captured = capsys.readouterr()
        assert "OK" in captured.err
        assert "1 row(s) verified" in captured.err

    def test_drift_owner_file_missing_exits_1(self, tmp_path, capsys):
        root, map_path = _seed_clean_repo(tmp_path)
        # Simulate: the owner file was removed without updating the ROM
        (root / "coding" / "coding.md").unlink()
        rc = rom.main(["--root", str(root), "--map", str(map_path)])
        assert rc == rom.EXIT_DRIFT
        captured = capsys.readouterr()
        assert "owner_file not found" in captured.err
        assert "coding/coding.md" in captured.err

    def test_drift_section_renamed_exits_1(self, tmp_path, capsys):
        root, map_path = _seed_clean_repo(tmp_path)
        # Simulate: the heading was renamed without updating the ROM
        owner = root / "coding" / "coding.md"
        owner.write_text(
            owner.read_text(encoding="utf-8").replace("## Code Design", "## Architecture"),
            encoding="utf-8",
        )
        rc = rom.main(["--root", str(root), "--map", str(map_path)])
        assert rc == rom.EXIT_DRIFT
        captured = capsys.readouterr()
        assert "owner_section" in captured.err
        assert "'## Code Design'" in captured.err

    def test_drift_text_rewritten_exits_1(self, tmp_path, capsys):
        root, map_path = _seed_clean_repo(tmp_path)
        # Simulate: the rule body was rewritten without updating the ROM
        owner = root / "coding" / "coding.md"
        owner.write_text(
            owner.read_text(encoding="utf-8").replace(
                "One responsibility per file/module",
                "Each file should have a single purpose",
            ),
            encoding="utf-8",
        )
        rc = rom.main(["--root", str(root), "--map", str(map_path)])
        assert rc == rom.EXIT_DRIFT
        captured = capsys.readouterr()
        assert "rule text not found" in captured.err
        assert "One responsibility per file/module" in captured.err

    def test_drift_text_in_wrong_section_exits_1(self, tmp_path, capsys):
        # Per #642 canonical decision: ROM lives or dies by section ownership.
        # If a rule moves to a different section in the same file, that's drift.
        root, map_path = _seed_clean_repo(tmp_path)
        owner = root / "coding" / "coding.md"
        # Move the rule body to the Quality Standards section instead.
        body = (
            "# Coding\n"
            "## Code Design\n"
            "- ! Define interfaces/types/protocols before implementation\n"
            "## Quality Standards\n"
            "- ! One responsibility per file/module\n"
        )
        owner.write_text(body, encoding="utf-8")
        rc = rom.main(["--root", str(root), "--map", str(map_path)])
        assert rc == rom.EXIT_DRIFT
        captured = capsys.readouterr()
        assert "rule text not found" in captured.err

    def test_lesson_owner_case_clean(self, tmp_path, capsys):
        # authority="lesson", owner_file=meta/lessons.md, owner_section="## <lesson title>"
        # mirrors the convention documented in the vBRIEF for lessons-owned rules.
        lessons = tmp_path / "meta" / "lessons.md"
        _write(
            lessons,
            "# Lessons Learned\n"
            "\n"
            "## Toolchain Validation Gate (2026-03)\n"
            "\n"
            "Before beginning any implementation phase, MUST verify that the complete toolchain "
            "required for that phase is installed and functional.\n"
            "\n"
            "## Other Lesson\n"
            "\n"
            "Body.\n",
        )
        map_path = tmp_path / "rom.json"
        _write(
            map_path,
            json.dumps(
                _make_payload(
                    [
                        {
                            "id": "lesson-toolchain-validation-gate",
                            "text": "Before beginning any implementation phase, MUST verify",
                            "owner_file": "meta/lessons.md",
                            "owner_section": "## Toolchain Validation Gate (2026-03)",
                            "authority": "lesson",
                            "last_verified": "2026-04-28",
                        }
                    ]
                )
            ),
        )
        rc = rom.main(["--root", str(tmp_path), "--map", str(map_path)])
        assert rc == rom.EXIT_OK
        captured = capsys.readouterr()
        assert "OK" in captured.err

    def test_lesson_owner_drift_exits_1(self, tmp_path, capsys):
        # Lesson title typo / rename should fail the lint just like any other drift.
        lessons = tmp_path / "meta" / "lessons.md"
        _write(lessons, "# Lessons\n\n## Toolchain Validation Gate (2026-04)\nbody\n")
        map_path = tmp_path / "rom.json"
        _write(
            map_path,
            json.dumps(
                _make_payload(
                    [
                        {
                            "id": "lesson-toolchain-validation-gate",
                            "text": "body",
                            "owner_file": "meta/lessons.md",
                            "owner_section": "## Toolchain Validation Gate (2026-03)",
                            "authority": "lesson",
                            "last_verified": "2026-04-28",
                        }
                    ]
                )
            ),
        )
        rc = rom.main(["--root", str(tmp_path), "--map", str(map_path)])
        assert rc == rom.EXIT_DRIFT
        captured = capsys.readouterr()
        assert "owner_section" in captured.err

    def test_multiple_drift_rows_aggregated(self, tmp_path, capsys):
        # Two separate drift causes accumulate into one EXIT_DRIFT, both reported.
        a = tmp_path / "a.md"
        _write(a, "## A\nbody\n")
        # b.md intentionally absent
        map_path = tmp_path / "rom.json"
        _write(
            map_path,
            json.dumps(
                _make_payload(
                    [
                        {
                            "id": "a-text-missing",
                            "text": "missing-text",
                            "owner_file": "a.md",
                            "owner_section": "## A",
                            "authority": "MUST",
                            "last_verified": "2026-04-28",
                        },
                        {
                            "id": "b-file-missing",
                            "text": "irrelevant",
                            "owner_file": "b.md",
                            "owner_section": "## B",
                            "authority": "MUST",
                            "last_verified": "2026-04-28",
                        },
                    ]
                )
            ),
        )
        rc = rom.main(["--root", str(tmp_path), "--map", str(map_path)])
        assert rc == rom.EXIT_DRIFT
        captured = capsys.readouterr()
        assert "drift detected in 2 row(s)" in captured.err
        assert "a-text-missing" in captured.err
        assert "b-file-missing" in captured.err

    def test_missing_data_file_exits_2(self, tmp_path, capsys):
        rc = rom.main(["--root", str(tmp_path), "--map", str(tmp_path / "missing.json")])
        assert rc == rom.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "Error" in captured.err
        assert "not found" in captured.err

    def test_malformed_json_exits_2(self, tmp_path, capsys):
        p = tmp_path / "rom.json"
        p.write_text("{not json", encoding="utf-8")
        rc = rom.main(["--root", str(tmp_path), "--map", str(p)])
        assert rc == rom.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "Malformed JSON" in captured.err

    def test_invalid_authority_exits_2(self, tmp_path, capsys):
        p = tmp_path / "rom.json"
        p.write_text(
            json.dumps(
                _make_payload(
                    [
                        {
                            "id": "x",
                            "text": "y",
                            "owner_file": "a.md",
                            "owner_section": "## A",
                            "authority": "GUIDELINE",
                            "last_verified": "2026-04-28",
                        }
                    ]
                )
            ),
            encoding="utf-8",
        )
        rc = rom.main(["--root", str(tmp_path), "--map", str(p)])
        assert rc == rom.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "invalid authority" in captured.err


# ---------------------------------------------------------------------------
# Repo-wide smoke test
# ---------------------------------------------------------------------------


class TestRepoSmoke:
    def test_real_rom_passes_lint(self, capsys):
        """The actual conventions/rule-ownership.json must lint clean against
        the real owner files in this repo. This is the test that fails when a
        contributor moves a rule between files / sections / wording without
        updating the ROM map -- which is the entire point of this lint and the
        canonical #642 workflow comment locked decision behind #635.
        """
        rc = rom.main([])
        assert rc == rom.EXIT_OK, capsys.readouterr().err
