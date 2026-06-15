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
