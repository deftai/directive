"""test_pack_render.py -- in-process tests for the lessons pack renderer + migration.

Covers (per the #1294 test mandate):
- pack_render: round-trip (rendering the committed source reproduces exactly
  the committed meta/lessons.md -- the same invariant the drift gate asserts),
  banner presence, drift detection, and main() exit codes.
- pack_migrate_lessons: parsing a small fixture lessons.md yields the expected
  entries (dates, issue_refs, tags, source, body blob, unique slugs).
- schema: the generated source validates against the lessons-pack schema
  (lightweight in-test validator -- no jsonschema dependency).

All tests drive the module functions directly so coverage attributes to
pack_render.py and pack_migrate_lessons.py.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

import pack_migrate_lessons  # type: ignore[import-not-found]  # noqa: E402
import pack_render  # type: ignore[import-not-found]  # noqa: E402

_REAL_SOURCE = _REPO_ROOT / "packs" / "lessons" / "lessons-pack-0.1.json"
_REAL_OUTPUT = _REPO_ROOT / "meta" / "lessons.md"
_REAL_SCHEMA = _REPO_ROOT / "vbrief" / "schemas" / "lessons-pack.schema.json"


# --- fixtures ---------------------------------------------------------------

# Note: the em dash in the Source line is intentional -- it exercises the
# UTF-8 read/write path the encoding gate (#798) guards.
FIXTURE_MD = """# Lessons Learned

<!-- authoring comment to be discarded as chrome -->

## Alpha Lesson (2026-05)

**Source:** PR #100 \u2014 alpha.

Body line about windows cp1252 encoding.

## Beta Lesson (#754)

**Source:** issue thing.

Some debugging root-cause content.

## Alpha Lesson (2026-05)

Duplicate title to test slug uniqueness.
"""


# --- migration --------------------------------------------------------------


def test_parse_lessons_counts_and_chrome() -> None:
    entries = pack_migrate_lessons.parse_lessons(FIXTURE_MD)
    # Three `## ` sections; the `# Lessons Learned` chrome is discarded.
    assert len(entries) == 3


def test_parse_lessons_dates_and_refs() -> None:
    entries = pack_migrate_lessons.parse_lessons(FIXTURE_MD)
    alpha, beta, dup = entries
    assert alpha["date"] == "2026-05"
    assert alpha["issue_refs"] == []  # #100 is in the body, not the title
    assert beta["date"] is None
    assert beta["issue_refs"] == ["#754"]
    assert dup["date"] == "2026-05"


def test_parse_lessons_source_extraction() -> None:
    entries = pack_migrate_lessons.parse_lessons(FIXTURE_MD)
    assert entries[0]["source"] == "PR #100 \u2014 alpha."
    assert entries[1]["source"] == "issue thing."
    assert entries[2]["source"] is None  # no **Source:** line


def test_parse_lessons_tags_deterministic() -> None:
    entries = pack_migrate_lessons.parse_lessons(FIXTURE_MD)
    assert entries[0]["tags"] == ["windows", "encoding"]
    assert entries[1]["tags"] == ["debugging"]
    # No keyword match -> fallback tag.
    assert entries[2]["tags"] == [pack_migrate_lessons.FALLBACK_TAG]


def test_parse_lessons_body_blob_verbatim() -> None:
    entries = pack_migrate_lessons.parse_lessons(FIXTURE_MD)
    assert entries[0]["body"] == (
        "**Source:** PR #100 \u2014 alpha.\n\nBody line about windows cp1252 encoding."
    )
    assert entries[2]["body"] == "Duplicate title to test slug uniqueness."


def test_parse_lessons_unique_slugs() -> None:
    entries = pack_migrate_lessons.parse_lessons(FIXTURE_MD)
    ids = [e["id"] for e in entries]
    assert len(ids) == len(set(ids))
    assert ids[0] == "alpha-lesson-2026-05"
    assert ids[2] == "alpha-lesson-2026-05-2"  # de-duplicated
    assert all(re.match(r"^[a-z0-9][a-z0-9-]*$", i) for i in ids)


def test_migrate_writes_file_and_returns_pack(tmp_path: Path) -> None:
    src = tmp_path / "lessons.md"
    src.write_text(FIXTURE_MD, encoding="utf-8")
    out = tmp_path / "out" / "pack.json"
    pack = pack_migrate_lessons.migrate(src, out)
    assert out.is_file()
    assert pack["pack"] == "lessons-pack-0.1"
    assert pack["version"] == "0.1"
    assert len(pack["lessons"]) == 3
    # Written file round-trips.
    on_disk = json.loads(out.read_text(encoding="utf-8"))
    assert on_disk == pack


def test_migrate_missing_source_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        pack_migrate_lessons.migrate(tmp_path / "nope.md", tmp_path / "out.json")


def test_migrate_empty_source_raises(tmp_path: Path) -> None:
    src = tmp_path / "empty.md"
    src.write_text("   \n", encoding="utf-8")
    with pytest.raises(ValueError, match="empty"):
        pack_migrate_lessons.migrate(src, tmp_path / "out.json")


def test_migrate_main_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    src = tmp_path / "lessons.md"
    src.write_text(FIXTURE_MD, encoding="utf-8")
    out = tmp_path / "pack.json"
    rc = pack_migrate_lessons.main(["--source", str(src), "--out", str(out)])
    assert rc == 0
    assert "Migrated 3 lessons" in capsys.readouterr().out
    rc_missing = pack_migrate_lessons.main(
        ["--source", str(tmp_path / "nope.md"), "--out", str(out)]
    )
    assert rc_missing == 1


# --- renderer ---------------------------------------------------------------


def test_render_banner_present() -> None:
    pack = json.loads(_REAL_SOURCE.read_text(encoding="utf-8"))
    text = pack_render.render(pack)
    lines = text.splitlines()
    assert lines[0].startswith("<!-- AUTO-GENERATED by task packs:render")
    assert "DO NOT EDIT MANUALLY" in lines[0]
    assert lines[1] == "<!-- Purpose: rendered lessons -->"
    assert lines[2] == "<!-- Source of truth: packs/lessons/lessons-pack-0.1.json -->"
    assert lines[3] == "<!-- Regenerate with: task packs:render -->"
    # ADR-001 Layer-A slice deflection pointer + edit-the-source guidance.
    assert "Edit the source" in lines[4]
    assert "task packs:slice lessons" in lines[4]
    assert "# Lessons Learned" in text


def test_render_entry_shape(tmp_path: Path) -> None:
    pack = {
        "pack": "lessons-pack-0.1",
        "version": "0.1",
        "lessons": [
            {"title": "Title One (2026-05)", "body": "Body one."},
            {"title": "Title Two (#7)", "body": "Body two."},
        ],
    }
    text = pack_render.render(pack)
    assert "## Title One (2026-05)\n\nBody one.\n" in text
    assert "## Title Two (#7)\n\nBody two.\n" in text


def test_render_roundtrip_matches_committed_projection() -> None:
    """Rendering the committed source reproduces exactly the committed
    meta/lessons.md -- the invariant the drift gate asserts (ADR-001)."""
    rendered = pack_render.render_file(_REAL_SOURCE)
    committed = _REAL_OUTPUT.read_text(encoding="utf-8")
    assert rendered == committed


def test_check_drift_clean_on_committed() -> None:
    has_drift, _rendered, _current = pack_render.check_drift(_REAL_SOURCE, _REAL_OUTPUT)
    assert has_drift is False


def test_check_drift_detects_divergence(tmp_path: Path) -> None:
    out = tmp_path / "lessons.md"
    out.write_text("stale content\n", encoding="utf-8")
    has_drift, rendered, current = pack_render.check_drift(_REAL_SOURCE, out)
    assert has_drift is True
    assert current == "stale content\n"
    assert rendered != current


def test_check_drift_missing_output_is_drift(tmp_path: Path) -> None:
    has_drift, _r, current = pack_render.check_drift(_REAL_SOURCE, tmp_path / "absent.md")
    assert has_drift is True
    assert current == ""


def test_render_file_missing_source_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        pack_render.render_file(tmp_path / "nope.json")


def test_write_render_creates_output(tmp_path: Path) -> None:
    out = tmp_path / "nested" / "lessons.md"
    text = pack_render.write_render(_REAL_SOURCE, out)
    assert out.read_text(encoding="utf-8") == text
    assert text.startswith("<!-- AUTO-GENERATED")


def test_render_main_check_clean(capsys: pytest.CaptureFixture) -> None:
    rc = pack_render.main(["--source", str(_REAL_SOURCE), "--output", str(_REAL_OUTPUT), "--check"])
    assert rc == 0
    assert "in sync" in capsys.readouterr().out


def test_render_main_check_drift_exit1(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    out = tmp_path / "lessons.md"
    out.write_text("stale\n", encoding="utf-8")
    rc = pack_render.main(["--source", str(_REAL_SOURCE), "--output", str(out), "--check"])
    assert rc == 1
    assert "pack-drift" in capsys.readouterr().err


def test_render_main_write_mode(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    out = tmp_path / "lessons.md"
    rc = pack_render.main(["--source", str(_REAL_SOURCE), "--output", str(out)])
    assert rc == 0
    assert out.read_text(encoding="utf-8") == pack_render.render_file(_REAL_SOURCE)


def test_render_main_missing_source_exit1(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    rc = pack_render.main(["--source", str(tmp_path / "nope.json")])
    assert rc == 1
    assert "error" in capsys.readouterr().err


def test_first_diff_line_helper() -> None:
    assert pack_render._first_diff_line("a\nb\nc", "a\nb\nc") == 0
    assert pack_render._first_diff_line("a\nX\nc", "a\nb\nc") == 2
    # Extra trailing line counts as a difference.
    assert pack_render._first_diff_line("a\nb\nc\nd", "a\nb\nc") == 4


# --- schema validation (lightweight, no jsonschema dependency) --------------


def _validate_against_schema(pack: dict, schema: dict) -> list[str]:
    """Minimal structural validator for the lessons-pack schema.

    Checks the load-bearing constraints (required keys, const pack/version,
    id/date/issue_refs patterns, tags enum + 1..3 cardinality) without pulling
    in a jsonschema dependency the framework does not ship.
    """
    errors: list[str] = []
    props = schema["properties"]
    enum = set(props["lessons"]["items"]["properties"]["tags"]["items"]["enum"])
    id_re = re.compile(props["lessons"]["items"]["properties"]["id"]["pattern"])
    date_re = re.compile(props["lessons"]["items"]["properties"]["date"]["pattern"])
    ref_re = re.compile(props["lessons"]["items"]["properties"]["issue_refs"]["items"]["pattern"])
    required = props["lessons"]["items"]["required"]

    if pack.get("pack") != props["pack"]["const"]:
        errors.append("pack const mismatch")
    if pack.get("version") != props["version"]["const"]:
        errors.append("version const mismatch")
    if not isinstance(pack.get("lessons"), list):
        errors.append("lessons must be a list")
        return errors

    for i, entry in enumerate(pack["lessons"]):
        for key in required:
            if key not in entry:
                errors.append(f"entry {i} missing required key {key}")
        if not id_re.match(entry.get("id", "")):
            errors.append(f"entry {i} id pattern: {entry.get('id')!r}")
        date = entry.get("date")
        if date is not None and not date_re.match(date):
            errors.append(f"entry {i} date pattern: {date!r}")
        for ref in entry.get("issue_refs", []):
            if not ref_re.match(ref):
                errors.append(f"entry {i} issue_ref pattern: {ref!r}")
        tags = entry.get("tags", [])
        if not (1 <= len(tags) <= 3):
            errors.append(f"entry {i} tags cardinality: {tags!r}")
        for tag in tags:
            if tag not in enum:
                errors.append(f"entry {i} tag not in enum: {tag!r}")
        if not isinstance(entry.get("body"), str):
            errors.append(f"entry {i} body must be a string")
    return errors


def test_generated_source_validates_against_schema() -> None:
    pack = json.loads(_REAL_SOURCE.read_text(encoding="utf-8"))
    schema = json.loads(_REAL_SCHEMA.read_text(encoding="utf-8"))
    errors = _validate_against_schema(pack, schema)
    assert errors == [], f"schema validation errors: {errors}"


def test_schema_enum_matches_migration_vocabulary() -> None:
    schema = json.loads(_REAL_SCHEMA.read_text(encoding="utf-8"))
    enum = schema["properties"]["lessons"]["items"]["properties"]["tags"]["items"]["enum"]
    assert tuple(enum) == pack_migrate_lessons.TAG_VOCABULARY
    assert list(schema["x-tagVocabulary"]) == list(pack_migrate_lessons.TAG_VOCABULARY)


def test_schema_slice_registry_matches_packs_slice_expectations() -> None:
    schema = json.loads(_REAL_SCHEMA.read_text(encoding="utf-8"))
    registry = schema["x-sliceRegistry"]
    assert set(registry) == {"recent", "by-tag"}
    assert registry["recent"]["filters"] == ["since"]
    assert registry["by-tag"]["filters"] == ["tag"]
    assert registry["recent"]["path"] == "lessons"
