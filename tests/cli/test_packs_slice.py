"""test_packs_slice.py -- in-process tests for the packs:slice surface (#1294, #1283).

Covers the converged-design contract: `recent` --since filtering, `by-tag`
--tag filtering, text vs json output, provenance fields, --list discovery,
unknown-slice exit 2 + did-you-mean, unsupported-filter / bad-since usage
errors, and the source-read-never-md guarantee. All tests import the module
functions and drive them in-process (with tmp_path fixtures or monkeypatched
PACK_REGISTRY) so coverage attributes to packs_slice.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

import packs_slice  # type: ignore[import-not-found]  # noqa: E402

# --- fixtures ---------------------------------------------------------------


def _write_fixture_pack(tmp_path: Path) -> tuple[Path, Path]:
    """Write a minimal fixture schema + source and return (source, schema)."""
    schema = {
        "x-sliceRegistry": {
            "recent": {
                "path": "lessons",
                "filters": ["since"],
                "description": "Lessons dated on or after --since.",
            },
            "by-tag": {
                "path": "lessons",
                "filters": ["tag"],
                "description": "Lessons carrying any requested --tag.",
            },
        }
    }
    source = {
        "pack": "lessons-pack-0.1",
        "version": "0.1",
        "lessons": [
            {
                "id": "old-windows",
                "title": "Old Windows Lesson (2026-03)",
                "date": "2026-03",
                "issue_refs": [],
                "tags": ["windows", "encoding"],
                "source": "PR #1",
                "body": "Body about cp1252.",
            },
            {
                "id": "mid-swarm",
                "title": "Mid Swarm Lesson (2026-05)",
                "date": "2026-05",
                "issue_refs": ["#42"],
                "tags": ["swarm"],
                "source": None,
                "body": "Body about a swarm cohort.",
            },
            {
                "id": "undated-debug",
                "title": "Undated Debug Lesson (#99)",
                "date": None,
                "issue_refs": ["#99"],
                "tags": ["debugging"],
                "source": "issue #99",
                "body": "Body about root-cause.",
            },
        ],
    }
    schema_path = tmp_path / "lessons-pack.schema.json"
    source_path = tmp_path / "lessons-pack-0.1.json"
    schema_path.write_text(json.dumps(schema), encoding="utf-8")
    source_path.write_text(json.dumps(source), encoding="utf-8")
    return source_path, schema_path


@pytest.fixture()
def fixture_pack(tmp_path: Path) -> tuple[Path, Path]:
    return _write_fixture_pack(tmp_path)


@pytest.fixture()
def patched_registry(
    fixture_pack: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, Path]:
    """Point packs_slice.PACK_REGISTRY['lessons'] at the fixture pack."""
    source_path, schema_path = fixture_pack
    monkeypatch.setitem(
        packs_slice.PACK_REGISTRY,
        "lessons",
        {"source": source_path, "schema": schema_path},
    )
    return fixture_pack


def _slice(source_path: Path, schema_path: Path, name: str, **kw):
    registry = packs_slice.load_registry(schema_path)
    data = packs_slice.load_source(source_path)
    return packs_slice.slice_pack(data["pack"], name, registry, data, source_path, **kw)


# --- recent / since ---------------------------------------------------------


def test_recent_filters_by_since(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    result = _slice(source_path, schema_path, "recent", since="2026-05")
    ids = [e["id"] for e in result["results"]]
    assert ids == ["mid-swarm"]
    assert result["count"] == 1


def test_recent_excludes_null_dated(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    result = _slice(source_path, schema_path, "recent", since="2026-01")
    ids = [e["id"] for e in result["results"]]
    # Undated entry is excluded even with an early --since.
    assert "undated-debug" not in ids
    assert ids == ["old-windows", "mid-swarm"]


def test_recent_accepts_full_date(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    result = _slice(source_path, schema_path, "recent", since="2026-05-15")
    assert [e["id"] for e in result["results"]] == ["mid-swarm"]


def test_bad_since_raises(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    with pytest.raises(packs_slice.UsageError, match="YYYY-MM"):
        _slice(source_path, schema_path, "recent", since="May2026")


# --- by-tag -----------------------------------------------------------------


def test_by_tag_filters(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    result = _slice(source_path, schema_path, "by-tag", tags=["swarm"])
    assert [e["id"] for e in result["results"]] == ["mid-swarm"]


def test_by_tag_multiple_tags_union(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    result = _slice(source_path, schema_path, "by-tag", tags=["windows", "debugging"])
    assert {e["id"] for e in result["results"]} == {"old-windows", "undated-debug"}


def test_collect_tags_comma_and_repeat() -> None:
    assert packs_slice._collect_tags(["windows,encoding", " swarm "]) == [
        "windows",
        "encoding",
        "swarm",
    ]
    assert packs_slice._collect_tags([]) == []


# --- output formats ---------------------------------------------------------


def test_text_output_has_provenance_header(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    result = _slice(source_path, schema_path, "by-tag", tags=["swarm"])
    text = packs_slice.format_slice_text(result)
    assert text.startswith("# pack: lessons-pack-0.1 | slice: by-tag |")
    assert "source: " in text
    assert "source_sha: " in text
    assert "## Mid Swarm Lesson (2026-05)" in text
    assert "Body about a swarm cohort." in text


def test_text_output_empty_results(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    result = _slice(source_path, schema_path, "by-tag", tags=["nonexistent-tag"])
    text = packs_slice.format_slice_text(result)
    assert "(no matching lessons)" in text
    assert result["count"] == 0


def test_json_provenance_fields_present(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    result = _slice(source_path, schema_path, "recent", since="2026-01")
    for key in ("pack", "slice", "source", "source_sha", "count", "results"):
        assert key in result
    assert result["pack"] == "lessons-pack-0.1"
    assert result["slice"] == "recent"
    assert result["source"].endswith(".json")
    assert len(result["source_sha"]) == 64  # sha256 hex


# --- --list -----------------------------------------------------------------


def test_list_slices_payload(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    registry = packs_slice.load_registry(schema_path)
    payload = packs_slice.list_slices("lessons-pack-0.1", registry, source_path)
    names = [s["name"] for s in payload["slices"]]
    assert names == ["by-tag", "recent"]  # sorted
    assert payload["source_sha"]
    text = packs_slice.format_list_text(payload)
    assert "by-tag" in text and "recent" in text
    assert "[filters: tag]" in text and "[filters: since]" in text


# --- --list-packs (pack-level discovery, #1637) -----------------------------


def _write_fixture_registry(tmp_path: Path) -> tuple[Path, Path]:
    """Build a synthetic on-disk pack registry with TWO packs + schemas.

    Returns (packs_dir, schemas_dir). Proves discovery is registry-driven:
    both packs appear with no code change to packs_slice.discover_packs.
    """
    packs_dir = tmp_path / "packs"
    schemas_dir = tmp_path / "schemas"
    packs_dir.mkdir()
    schemas_dir.mkdir()

    # Pack 1: lessons
    (packs_dir / "lessons").mkdir()
    (packs_dir / "lessons" / "lessons-pack-0.1.json").write_text(
        json.dumps({"pack": "lessons-pack-0.1", "version": "0.1", "lessons": []}),
        encoding="utf-8",
    )
    (schemas_dir / "lessons-pack.schema.json").write_text(
        json.dumps({"title": "Lessons Pack", "description": "Captured lessons. More prose."}),
        encoding="utf-8",
    )

    # Pack 2: a synthetic second pack added with NO code change.
    (packs_dir / "skills").mkdir()
    (packs_dir / "skills" / "skills-pack-0.2.json").write_text(
        json.dumps({"pack": "skills-pack-0.2", "version": "0.2", "skills": []}),
        encoding="utf-8",
    )
    (schemas_dir / "skills-pack.schema.json").write_text(
        json.dumps({"title": "Skills Pack", "description": "Reusable skills. Extra detail."}),
        encoding="utf-8",
    )
    return packs_dir, schemas_dir


def test_discover_packs_finds_real_lessons_pack() -> None:
    """The real on-disk registry yields the committed lessons pack."""
    packs = packs_slice.discover_packs()
    names = [p["name"] for p in packs]
    assert "lessons" in names
    lessons = next(p for p in packs if p["name"] == "lessons")
    assert lessons["version"] == "0.1"
    assert lessons["pack"] == "lessons-pack-0.1"
    assert lessons["description"]  # one-liner read from the schema
    assert lessons["source"].endswith(".json")


def test_discover_packs_is_registry_driven(tmp_path: Path) -> None:
    """A second pack dropped into the registry appears with NO code change."""
    packs_dir, schemas_dir = _write_fixture_registry(tmp_path)
    packs = packs_slice.discover_packs(packs_dir, schemas_dir)
    names = [p["name"] for p in packs]
    assert names == ["lessons", "skills"]  # sorted, both auto-discovered
    skills = next(p for p in packs if p["name"] == "skills")
    assert skills["version"] == "0.2"
    assert skills["pack"] == "skills-pack-0.2"
    assert skills["description"] == "Reusable skills"  # first sentence only


def test_discover_packs_missing_dir_returns_empty(tmp_path: Path) -> None:
    packs = packs_slice.discover_packs(tmp_path / "nope", tmp_path / "also-nope")
    assert packs == []


def test_discover_packs_skips_dir_without_source(tmp_path: Path) -> None:
    packs_dir = tmp_path / "packs"
    (packs_dir / "empty").mkdir(parents=True)
    packs = packs_slice.discover_packs(packs_dir, tmp_path / "schemas")
    assert packs == []


def test_discover_packs_missing_schema_yields_blank_description(tmp_path: Path) -> None:
    packs_dir = tmp_path / "packs"
    (packs_dir / "rules").mkdir(parents=True)
    (packs_dir / "rules" / "rules-pack-0.1.json").write_text(
        json.dumps({"pack": "rules-pack-0.1", "version": "0.1"}), encoding="utf-8"
    )
    packs = packs_slice.discover_packs(packs_dir, tmp_path / "no-schemas")
    assert packs[0]["name"] == "rules"
    assert packs[0]["description"] == ""


def test_list_packs_text_format(tmp_path: Path) -> None:
    packs_dir, schemas_dir = _write_fixture_registry(tmp_path)
    payload = packs_slice.list_packs(packs_dir, schemas_dir)
    text = packs_slice.format_list_packs_text(payload)
    assert "Available content packs:" in text
    assert "lessons" in text and "skills" in text
    assert "0.1" in text and "0.2" in text


def test_list_packs_text_empty() -> None:
    text = packs_slice.format_list_packs_text({"packs": []})
    assert "No content packs found." in text


def test_one_line_takes_first_sentence() -> None:
    assert packs_slice._one_line("First sentence. Second sentence.") == "First sentence"
    assert packs_slice._one_line("  collapse   whitespace  ") == "collapse whitespace"
    assert packs_slice._one_line("") == ""


def test_main_list_packs_text_exit0(capsys: pytest.CaptureFixture) -> None:
    rc = packs_slice.main(["--list-packs"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "Available content packs:" in out
    assert "lessons" in out


def test_main_list_packs_json_exit0(capsys: pytest.CaptureFixture) -> None:
    rc = packs_slice.main(["--list-packs", "--json"])
    out = capsys.readouterr().out
    assert rc == 0
    payload = json.loads(out)
    names = [p["name"] for p in payload["packs"]]
    assert "lessons" in names
    lessons = next(p for p in payload["packs"] if p["name"] == "lessons")
    assert lessons["version"] == "0.1"
    assert "source" in lessons  # provenance


def test_main_missing_pack_without_list_packs_exit2(capsys: pytest.CaptureFixture) -> None:
    rc = packs_slice.main([])
    err = capsys.readouterr().err
    assert rc == 2
    assert "pack name is required" in err
    assert "--list-packs" in err


# --- errors -----------------------------------------------------------------


def test_unknown_slice_raises_with_suggestion(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    with pytest.raises(packs_slice.UsageError) as exc:
        _slice(source_path, schema_path, "recnt")
    assert exc.value.suggestion == "recent"


def test_unsupported_filter_raises(fixture_pack: tuple[Path, Path]) -> None:
    source_path, schema_path = fixture_pack
    # `recent` does not allow --tag.
    with pytest.raises(packs_slice.UsageError, match="does not support"):
        _slice(source_path, schema_path, "recent", tags=["swarm"])


def test_unknown_pack_raises_with_suggestion(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(packs_slice.UsageError) as exc:
        packs_slice.resolve_pack("lesson")  # typo of 'lessons'
    assert exc.value.suggestion == "lessons"


def test_missing_schema_raises(tmp_path: Path) -> None:
    with pytest.raises(packs_slice.UsageError, match="schema not found"):
        packs_slice.load_registry(tmp_path / "nope.json")


def test_missing_source_raises(tmp_path: Path) -> None:
    with pytest.raises(packs_slice.UsageError, match="source not found"):
        packs_slice.load_source(tmp_path / "nope.json")


# --- dotted-path resolver ---------------------------------------------------


def test_resolve_dotted_path_guards() -> None:
    data = {"a": {"b": [1, 2, 3]}}
    assert packs_slice.resolve_dotted_path(data, "a.b") == [1, 2, 3]
    assert packs_slice.resolve_dotted_path(data, "a.missing") is None
    # Walking into a non-dict short-circuits to None.
    assert packs_slice.resolve_dotted_path(data, "a.b.c") is None


def test_sha256_file(tmp_path: Path) -> None:
    p = tmp_path / "x.txt"
    p.write_text("hello", encoding="utf-8")
    # sha256("hello")
    assert packs_slice.sha256_file(p) == (
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    )


# --- source-read-never-md ---------------------------------------------------


def test_source_read_never_md(tmp_path: Path) -> None:
    """The resolver reads the canonical JSON source even when a (stale or
    bogus) sibling .md exists -- proving slices never round-trip through .md."""
    source_path, schema_path = _write_fixture_pack(tmp_path)
    # Plant a bogus rendered projection next to the source.
    (tmp_path / "lessons.md").write_text("GARBAGE PROJECTION", encoding="utf-8")
    result = _slice(source_path, schema_path, "recent", since="2026-01")
    assert result["source"].endswith(".json")
    assert "GARBAGE" not in json.dumps(result)
    assert result["count"] == 2


# --- main() exit codes ------------------------------------------------------


def test_main_list_exit0(patched_registry, capsys: pytest.CaptureFixture) -> None:
    rc = packs_slice.main(["lessons", "--list"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "recent" in out and "by-tag" in out


def test_main_recent_text(patched_registry, capsys: pytest.CaptureFixture) -> None:
    rc = packs_slice.main(["lessons", "recent", "--since", "2026-05"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "Mid Swarm Lesson" in out
    assert "Old Windows Lesson" not in out


def test_main_by_tag_json(patched_registry, capsys: pytest.CaptureFixture) -> None:
    rc = packs_slice.main(["lessons", "by-tag", "--tag", "windows,debugging", "--json"])
    out = capsys.readouterr().out
    assert rc == 0
    payload = json.loads(out)
    assert payload["slice"] == "by-tag"
    assert {e["id"] for e in payload["results"]} == {"old-windows", "undated-debug"}


def test_main_unknown_slice_exit2(patched_registry, capsys: pytest.CaptureFixture) -> None:
    rc = packs_slice.main(["lessons", "recnt"])
    err = capsys.readouterr().err
    assert rc == 2
    assert "Did you mean 'recent'?" in err


def test_main_missing_name_exit2(patched_registry, capsys: pytest.CaptureFixture) -> None:
    rc = packs_slice.main(["lessons"])
    err = capsys.readouterr().err
    assert rc == 2
    assert "slice name is required" in err


def test_main_unknown_pack_exit2(capsys: pytest.CaptureFixture) -> None:
    rc = packs_slice.main(["lessns", "recent"])
    err = capsys.readouterr().err
    assert rc == 2
    assert "unknown pack" in err


# --- real committed pack (integration confidence) ---------------------------


def test_real_pack_recent_reads_source() -> None:
    """Smoke-check the committed lessons pack resolves through the real
    PACK_REGISTRY and the slice reads the JSON source."""
    source_path, schema_path = packs_slice.resolve_pack("lessons")
    assert source_path.is_file()
    result = _slice(source_path, schema_path, "recent", since="2026-01")
    assert result["pack"] == "lessons-pack-0.1"
    assert result["count"] > 0
    assert result["source"].endswith("lessons-pack-0.1.json")


# --- skills pack: trigger filter + schema-driven display (#1295) -------------


def _write_skills_fixture(tmp_path: Path) -> tuple[Path, Path]:
    """Write a minimal skills-pack fixture schema + source (source, schema)."""
    schema = {
        "x-display": {
            "heading": "id",
            "fields": ["description", "triggers", "path"],
            "body": None,
            "noun": "skills",
        },
        "x-sliceRegistry": {
            "by-trigger": {
                "path": "skills",
                "filters": ["trigger"],
                "description": "Skills whose triggers include any requested --trigger.",
            },
            "list": {
                "path": "skills",
                "filters": [],
                "description": "Every skill with its description, triggers, and path.",
            },
        },
    }
    source = {
        "pack": "skills-pack-0.1",
        "version": "0.1",
        "skills": [
            {
                "id": "deft-directive-cost",
                "description": "Pre-build cost phase.",
                "triggers": ["cost", "budget", "pre-build cost"],
                "path": "skills/deft-directive-cost/SKILL.md",
                "version": "0.1",
                "body": "# Deft Directive Cost\n\nBody.",
            },
            {
                "id": "deft-directive-glossary",
                "description": "Glossary extraction.",
                "triggers": ["glossary", "DDD"],
                "path": "skills/deft-directive-glossary/SKILL.md",
                "version": "0.1",
                "body": None,
            },
            {
                "id": "deft-directive-write-skill",
                "description": "Author a new skill.",
                "triggers": [],
                "path": "skills/deft-directive-write-skill/SKILL.md",
                "version": "0.1",
                "body": None,
            },
        ],
    }
    schema_path = tmp_path / "skills-pack.schema.json"
    source_path = tmp_path / "skills-pack-0.1.json"
    schema_path.write_text(json.dumps(schema), encoding="utf-8")
    source_path.write_text(json.dumps(source), encoding="utf-8")
    return source_path, schema_path


def test_by_trigger_returns_matching_skill(tmp_path: Path) -> None:
    source_path, schema_path = _write_skills_fixture(tmp_path)
    result = _slice(source_path, schema_path, "by-trigger", triggers=["cost"])
    assert [e["id"] for e in result["results"]] == ["deft-directive-cost"]


def test_by_trigger_case_insensitive_and_multiword(tmp_path: Path) -> None:
    source_path, schema_path = _write_skills_fixture(tmp_path)
    result = _slice(
        source_path, schema_path, "by-trigger", triggers=["PRE-BUILD COST"]
    )
    assert [e["id"] for e in result["results"]] == ["deft-directive-cost"]


def test_by_trigger_union_of_triggers(tmp_path: Path) -> None:
    source_path, schema_path = _write_skills_fixture(tmp_path)
    result = _slice(
        source_path, schema_path, "by-trigger", triggers=["budget", "ddd"]
    )
    assert {e["id"] for e in result["results"]} == {
        "deft-directive-cost",
        "deft-directive-glossary",
    }


def test_by_trigger_no_match_is_empty(tmp_path: Path) -> None:
    source_path, schema_path = _write_skills_fixture(tmp_path)
    result = _slice(source_path, schema_path, "by-trigger", triggers=["nope"])
    assert result["count"] == 0


def test_apply_triggers_unit() -> None:
    entries = [
        {"id": "a", "triggers": ["Build", "ship"]},
        {"id": "b", "triggers": []},
    ]
    assert [e["id"] for e in packs_slice.apply_triggers(entries, ["build"])] == ["a"]
    assert packs_slice.apply_triggers(entries, ["missing"]) == []


def test_list_slice_returns_all_skills(tmp_path: Path) -> None:
    source_path, schema_path = _write_skills_fixture(tmp_path)
    result = _slice(source_path, schema_path, "list")
    assert result["count"] == 3
    assert {e["id"] for e in result["results"]} == {
        "deft-directive-cost",
        "deft-directive-glossary",
        "deft-directive-write-skill",
    }


def test_skills_text_display_shows_metadata_not_body(tmp_path: Path) -> None:
    source_path, schema_path = _write_skills_fixture(tmp_path)
    display = packs_slice.load_display(schema_path)
    result = _slice(source_path, schema_path, "by-trigger", triggers=["cost"])
    text = packs_slice.format_slice_text(result, display)
    assert "## deft-directive-cost" in text
    assert "- description: Pre-build cost phase." in text
    assert "- triggers: cost, budget, pre-build cost" in text
    assert "- path: skills/deft-directive-cost/SKILL.md" in text
    # body is NOT shown in the slice surface (x-display body is null).
    assert "Body." not in text


def test_skills_text_display_empty_uses_skills_noun(tmp_path: Path) -> None:
    source_path, schema_path = _write_skills_fixture(tmp_path)
    display = packs_slice.load_display(schema_path)
    result = _slice(source_path, schema_path, "by-trigger", triggers=["none"])
    text = packs_slice.format_slice_text(result, display)
    assert "(no matching skills)" in text


def test_trigger_filter_rejected_on_list_slice(tmp_path: Path) -> None:
    source_path, schema_path = _write_skills_fixture(tmp_path)
    with pytest.raises(packs_slice.UsageError, match="does not support"):
        _slice(source_path, schema_path, "list", triggers=["cost"])


def test_load_display_defaults_when_absent(tmp_path: Path) -> None:
    schema_path = tmp_path / "noop-pack.schema.json"
    schema_path.write_text(json.dumps({"x-sliceRegistry": {}}), encoding="utf-8")
    display = packs_slice.load_display(schema_path)
    assert display == packs_slice._DEFAULT_DISPLAY


def test_load_display_missing_schema_raises(tmp_path: Path) -> None:
    with pytest.raises(packs_slice.UsageError, match="schema not found"):
        packs_slice.load_display(tmp_path / "absent.json")


# --- self-extending resolver: skills resolves with no PACK_REGISTRY entry ----


def test_resolve_pack_skills_via_disk_discovery() -> None:
    """The skills pack resolves through on-disk discovery even though it is NOT
    in PACK_REGISTRY -- the self-extending contract (#1295)."""
    assert "skills" not in packs_slice.PACK_REGISTRY
    source_path, schema_path = packs_slice.resolve_pack("skills")
    assert source_path.name == "skills-pack-0.1.json"
    assert schema_path.name == "skills-pack.schema.json"
    assert source_path.is_file() and schema_path.is_file()


def test_real_skills_by_trigger_reads_source() -> None:
    """The committed skills pack resolves + by-trigger returns the proof skill."""
    source_path, schema_path = packs_slice.resolve_pack("skills")
    result = _slice(source_path, schema_path, "by-trigger", triggers=["cost"])
    assert result["pack"] == "skills-pack-0.1"
    assert "deft-directive-cost" in [e["id"] for e in result["results"]]


def test_list_packs_shows_both_lessons_and_skills() -> None:
    """--list-packs auto-discovers BOTH committed packs (registry-driven)."""
    payload = packs_slice.list_packs()
    names = [p["name"] for p in payload["packs"]]
    assert "lessons" in names
    assert "skills" in names
    skills = next(p for p in payload["packs"] if p["name"] == "skills")
    assert skills["pack"] == "skills-pack-0.1"
    assert skills["version"] == "0.1"
    assert skills["description"]  # one-liner read from the skills schema


# --- rules pack: tier + domain scalar filters (#1296) -----------------------


def _write_rules_fixture(tmp_path: Path) -> tuple[Path, Path]:
    """Write a minimal rules-pack fixture schema + source (source, schema)."""
    schema = {
        "x-display": {
            "heading": "id",
            "fields": ["tier", "domain", "text", "path"],
            "body": None,
            "noun": "rules",
        },
        "x-sliceRegistry": {
            "by-tier": {
                "path": "rules",
                "filters": ["tier"],
                "description": "Rules whose tier matches any requested --tier.",
            },
            "by-domain": {
                "path": "rules",
                "filters": ["domain"],
                "description": "Rules from any requested --domain source doc.",
            },
            "list": {
                "path": "rules",
                "filters": [],
                "description": "Every rule with its tier, domain, text, and path.",
            },
        },
    }
    source = {
        "pack": "rules-pack-0.1",
        "version": "0.1",
        "rules": [
            {
                "id": "testing-001",
                "tier": "MUST",
                "domain": "testing",
                "text": "Achieve high coverage",
                "path": "coding/testing.md",
                "body": None,
            },
            {
                "id": "testing-002",
                "tier": "MUST_NOT",
                "domain": "testing",
                "text": "Skip tests",
                "path": "coding/testing.md",
                "body": None,
            },
            {
                "id": "security-001",
                "tier": "MUST",
                "domain": "security",
                "text": "Validate untrusted input",
                "path": "coding/security.md",
                "body": None,
            },
        ],
    }
    schema_path = tmp_path / "rules-pack.schema.json"
    source_path = tmp_path / "rules-pack-0.1.json"
    schema_path.write_text(json.dumps(schema), encoding="utf-8")
    source_path.write_text(json.dumps(source), encoding="utf-8")
    return source_path, schema_path


def test_by_tier_filters(tmp_path: Path) -> None:
    source_path, schema_path = _write_rules_fixture(tmp_path)
    result = _slice(source_path, schema_path, "by-tier", tiers=["MUST"])
    assert {e["id"] for e in result["results"]} == {"testing-001", "security-001"}


def test_by_tier_case_insensitive(tmp_path: Path) -> None:
    source_path, schema_path = _write_rules_fixture(tmp_path)
    result = _slice(source_path, schema_path, "by-tier", tiers=["must_not"])
    assert [e["id"] for e in result["results"]] == ["testing-002"]


def test_by_domain_filters(tmp_path: Path) -> None:
    source_path, schema_path = _write_rules_fixture(tmp_path)
    result = _slice(source_path, schema_path, "by-domain", domains=["testing"])
    assert {e["id"] for e in result["results"]} == {"testing-001", "testing-002"}


def test_rules_list_returns_all(tmp_path: Path) -> None:
    source_path, schema_path = _write_rules_fixture(tmp_path)
    result = _slice(source_path, schema_path, "list")
    assert result["count"] == 3


def test_apply_scalar_unit() -> None:
    entries = [
        {"id": "a", "tier": "MUST"},
        {"id": "b", "tier": "SHOULD"},
        {"id": "c", "tier": "must"},
    ]
    out = packs_slice.apply_scalar(entries, "tier", ["MUST"])
    assert {e["id"] for e in out} == {"a", "c"}  # case-insensitive
    assert packs_slice.apply_scalar(entries, "tier", ["MAY"]) == []


def test_tier_filter_rejected_on_list_slice(tmp_path: Path) -> None:
    source_path, schema_path = _write_rules_fixture(tmp_path)
    with pytest.raises(packs_slice.UsageError, match="does not support"):
        _slice(source_path, schema_path, "list", tiers=["MUST"])


def test_domain_filter_rejected_on_by_tier_slice(tmp_path: Path) -> None:
    source_path, schema_path = _write_rules_fixture(tmp_path)
    with pytest.raises(packs_slice.UsageError, match="does not support"):
        _slice(source_path, schema_path, "by-tier", domains=["testing"])


def test_real_rules_by_tier_reads_source() -> None:
    """The committed rules pack resolves + by-tier MUST returns directives."""
    source_path, schema_path = packs_slice.resolve_pack("rules")
    result = _slice(source_path, schema_path, "by-tier", tiers=["MUST"])
    assert result["pack"] == "rules-pack-0.1"
    assert result["count"] > 0
    assert all(e["tier"] == "MUST" for e in result["results"])


def test_real_rules_by_domain_testing() -> None:
    source_path, schema_path = packs_slice.resolve_pack("rules")
    result = _slice(source_path, schema_path, "by-domain", domains=["testing"])
    assert result["count"] > 0
    assert all(e["domain"] == "testing" for e in result["results"])


# --- strategies pack: list + by-trigger (#1296) -----------------------------


def test_real_strategies_list_reads_source() -> None:
    source_path, schema_path = packs_slice.resolve_pack("strategies")
    result = _slice(source_path, schema_path, "list")
    assert result["pack"] == "strategies-pack-0.1"
    assert result["count"] > 0
    assert all(e.get("path", "").startswith("strategies/") for e in result["results"])


def test_real_strategies_by_trigger_yolo() -> None:
    source_path, schema_path = packs_slice.resolve_pack("strategies")
    result = _slice(source_path, schema_path, "by-trigger", triggers=["yolo"])
    assert "yolo" in [e["id"] for e in result["results"]]


# --- --list-packs now lists all four committed packs (#1296) ----------------


def test_list_packs_includes_rules_and_strategies() -> None:
    """--list-packs auto-discovers all FOUR committed packs (registry-driven)."""
    payload = packs_slice.list_packs()
    names = {p["name"] for p in payload["packs"]}
    assert {"lessons", "skills", "rules", "strategies"} <= names
    rules = next(p for p in payload["packs"] if p["name"] == "rules")
    assert rules["pack"] == "rules-pack-0.1"
    assert rules["version"] == "0.1"
    strategies = next(p for p in payload["packs"] if p["name"] == "strategies")
    assert strategies["pack"] == "strategies-pack-0.1"


def test_resolve_pack_rules_and_strategies_via_disk_discovery() -> None:
    """rules + strategies resolve through on-disk discovery (self-extending,
    NOT hardcoded in PACK_REGISTRY) -- the #1295/#1296 registry contract."""
    assert "rules" not in packs_slice.PACK_REGISTRY
    assert "strategies" not in packs_slice.PACK_REGISTRY
    r_src, r_schema = packs_slice.resolve_pack("rules")
    s_src, s_schema = packs_slice.resolve_pack("strategies")
    assert r_src.name == "rules-pack-0.1.json"
    assert r_schema.name == "rules-pack.schema.json"
    assert s_src.name == "strategies-pack-0.1.json"
    assert s_schema.name == "strategies-pack.schema.json"
