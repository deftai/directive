"""test_pack_migrate_strategies.py -- in-process tests for the strategies pack migration (#1296).

Covers (per the new-source test mandate):
- extract_title / extract_description: leading H1 + leading paragraph, with
  chrome (Legend, See-also, HTML comments) skipped and blockquote redirects
  yielding a readable description.
- is_redirect_stub: leading-blockquote + deprecation-marker detection so pure
  redirect/superseded pointers are excluded from body capture (packs:slice v2).
- migrate: parse -> source round-trip; one entry per strategies/*.md; the
  default capture-all path bodies every non-redirect strategy (#1637) while the
  back-compat --proof-strategy flag restricts capture to one; stem-derived
  triggers.
- schema: the generated source validates against the strategies-pack schema
  (lightweight in-test validator -- no jsonschema dependency).

All tests drive the module functions directly so coverage attributes to
pack_migrate_strategies.py.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

import pack_migrate_strategies  # type: ignore[import-not-found]  # noqa: E402

_REAL_SOURCE = _REPO_ROOT / "packs" / "strategies" / "strategies-pack-0.1.json"
_REAL_SCHEMA = _REPO_ROOT / "vbrief" / "schemas" / "strategies-pack.schema.json"
_PROOF_STRATEGY = "strategies/yolo.md"

FIXTURE_YOLO_MD = """# Yolo Strategy

Auto-pilot interview: the agent plays both sides, always picking the
recommended option.

Legend (from RFC2119): !=MUST, ~=SHOULD.

**See also**: [other.md](./other.md)

---

## When to Use

- ~ Quick prototyping
"""

FIXTURE_REDIRECT_MD = """# Brownfield Strategy (Redirect)

> **This file is a legacy alias.** See map.md for the canonical strategy.
"""

FIXTURE_NO_DESC_MD = """# Bare Strategy

## Section

Body.
"""


def _build(tmp_path: Path, proof: str | None = "strategies/yolo.md") -> dict:
    sdir = tmp_path / "strategies"
    sdir.mkdir()
    (sdir / "yolo.md").write_text(FIXTURE_YOLO_MD, encoding="utf-8")
    (sdir / "brownfield.md").write_text(FIXTURE_REDIRECT_MD, encoding="utf-8")
    return pack_migrate_strategies.build_pack(sdir, proof_strategy=proof)


# --- title / description extraction -----------------------------------------


def test_extract_title() -> None:
    assert pack_migrate_strategies.extract_title(FIXTURE_YOLO_MD) == "Yolo Strategy"
    assert pack_migrate_strategies.extract_title("no heading") == ""


def test_extract_description_folds_paragraph_and_skips_chrome() -> None:
    desc = pack_migrate_strategies.extract_description(FIXTURE_YOLO_MD)
    assert desc == (
        "Auto-pilot interview: the agent plays both sides, always picking the "
        "recommended option."
    )
    # Legend / See-also chrome is NOT captured as the description.
    assert "Legend" not in desc
    assert "See also" not in desc


def test_extract_description_strips_blockquote_redirect() -> None:
    desc = pack_migrate_strategies.extract_description(FIXTURE_REDIRECT_MD)
    assert desc.startswith("**This file is a legacy alias.**")
    assert not desc.startswith(">")


def test_extract_description_empty_when_only_sections() -> None:
    assert pack_migrate_strategies.extract_description(FIXTURE_NO_DESC_MD) == ""


# --- migrate / build_pack ---------------------------------------------------


def test_build_pack_one_entry_per_doc(tmp_path: Path) -> None:
    pack = _build(tmp_path)
    ids = sorted(s["id"] for s in pack["strategies"])
    assert ids == ["brownfield", "yolo"]
    yolo = next(s for s in pack["strategies"] if s["id"] == "yolo")
    assert yolo["path"] == "strategies/yolo.md"
    assert yolo["title"] == "Yolo Strategy"
    assert yolo["triggers"] == ["yolo"]


def test_build_pack_proof_carries_body_others_null(tmp_path: Path) -> None:
    pack = _build(tmp_path)
    bodied = [s for s in pack["strategies"] if s["body"] is not None]
    assert len(bodied) == 1
    assert bodied[0]["id"] == "yolo"
    assert bodied[0]["body"].startswith("# Yolo Strategy")


def test_build_pack_capture_all_bodies_non_redirect_skips_stub(tmp_path: Path) -> None:
    """packs:slice v2 (#1637): the default (proof_strategy=None) captures a body
    for EVERY non-redirect strategy while the redirect stub stays body=null."""
    pack = _build(tmp_path, proof=None)
    by_id = {s["id"]: s for s in pack["strategies"]}
    assert by_id["yolo"]["body"] is not None
    assert by_id["yolo"]["body"].startswith("# Yolo Strategy")
    # brownfield.md is a pure redirect pointer -> metadata-only, NOT rendered.
    assert by_id["brownfield"]["body"] is None


# --- redirect-stub detection ------------------------------------------------


def test_is_redirect_stub_detects_legacy_alias() -> None:
    assert pack_migrate_strategies.is_redirect_stub(FIXTURE_REDIRECT_MD) is True


def test_is_redirect_stub_false_for_real_strategy() -> None:
    assert pack_migrate_strategies.is_redirect_stub(FIXTURE_YOLO_MD) is False
    assert pack_migrate_strategies.is_redirect_stub(FIXTURE_NO_DESC_MD) is False


def test_is_redirect_stub_matches_real_pack_stubs() -> None:
    """The two committed pure-pointer stubs (brownfield -> map, the superseded
    roadmap strategy) are detected; the proof strategy is not."""
    sdir = _REPO_ROOT / "strategies"
    assert pack_migrate_strategies.is_redirect_stub(
        (sdir / "brownfield.md").read_text(encoding="utf-8")
    )
    assert pack_migrate_strategies.is_redirect_stub(
        (sdir / "roadmap.md").read_text(encoding="utf-8")
    )
    assert not pack_migrate_strategies.is_redirect_stub(
        (sdir / "yolo.md").read_text(encoding="utf-8")
    )


def test_migrate_writes_and_round_trips(tmp_path: Path) -> None:
    sdir = tmp_path / "strategies"
    sdir.mkdir()
    (sdir / "yolo.md").write_text(FIXTURE_YOLO_MD, encoding="utf-8")
    out = tmp_path / "out" / "strategies-pack-0.1.json"
    pack = pack_migrate_strategies.migrate(
        sdir, out, proof_strategy="strategies/yolo.md"
    )
    assert out.is_file()
    assert pack["pack"] == "strategies-pack-0.1"
    assert pack["version"] == "0.1"
    assert json.loads(out.read_text(encoding="utf-8")) == pack


def test_strip_leading_banner_idempotent() -> None:
    body = "# Yolo Strategy\n\nContent.\n"
    banner = (
        "<!-- AUTO-GENERATED by task packs:render -- DO NOT EDIT MANUALLY -->\n"
        "<!-- Purpose: rendered strategy -->\n"
    )
    bannered = banner + "\n" + body
    assert pack_migrate_strategies.strip_leading_banner(bannered) == body
    assert pack_migrate_strategies.strip_leading_banner(body) == body


def test_migrate_missing_dir_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        pack_migrate_strategies.migrate(
            tmp_path / "nope", tmp_path / "o.json", proof_strategy="strategies/yolo.md"
        )


def test_migrate_no_strategies_raises(tmp_path: Path) -> None:
    sdir = tmp_path / "strategies"
    sdir.mkdir()
    with pytest.raises(ValueError, match="no strategies"):
        pack_migrate_strategies.migrate(
            sdir, tmp_path / "o.json", proof_strategy="strategies/yolo.md"
        )


def test_migrate_main_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    sdir = tmp_path / "strategies"
    sdir.mkdir()
    (sdir / "yolo.md").write_text(FIXTURE_YOLO_MD, encoding="utf-8")
    out = tmp_path / "pack.json"
    rc = pack_migrate_strategies.main(
        [
            "--strategies-dir", str(sdir),
            "--proof-strategy", "strategies/yolo.md",
            "--out", str(out),
        ]
    )
    assert rc == 0
    assert "with body" in capsys.readouterr().out
    rc_missing = pack_migrate_strategies.main(
        ["--strategies-dir", str(tmp_path / "nope")]
    )
    assert rc_missing == 1


# --- schema validation (lightweight) ----------------------------------------


def _validate_strategies_source(pack: dict, schema: dict) -> list[str]:
    errors: list[str] = []
    props = schema["properties"]
    if pack.get("pack") != props["pack"]["const"]:
        errors.append("pack const mismatch")
    if pack.get("version") != props["version"]["const"]:
        errors.append("version const mismatch")
    if not isinstance(pack.get("strategies"), list):
        errors.append("strategies must be a list")
        return errors
    item_props = props["strategies"]["items"]["properties"]
    required = props["strategies"]["items"]["required"]
    id_re = re.compile(item_props["id"]["pattern"])
    path_re = re.compile(item_props["path"]["pattern"])
    for i, entry in enumerate(pack["strategies"]):
        for key in required:
            if key not in entry:
                errors.append(f"entry {i} missing required key {key}")
        if not id_re.match(entry.get("id", "")):
            errors.append(f"entry {i} id pattern: {entry.get('id')!r}")
        if not path_re.match(entry.get("path", "")):
            errors.append(f"entry {i} path pattern: {entry.get('path')!r}")
        if not isinstance(entry.get("triggers"), list):
            errors.append(f"entry {i} triggers must be a list")
        body = entry.get("body")
        if body is not None and not isinstance(body, str):
            errors.append(f"entry {i} body must be str or null")
    return errors


def test_generated_source_validates_against_schema() -> None:
    pack = json.loads(_REAL_SOURCE.read_text(encoding="utf-8"))
    schema = json.loads(_REAL_SCHEMA.read_text(encoding="utf-8"))
    errors = _validate_strategies_source(pack, schema)
    assert errors == [], f"schema validation errors: {errors}"


def test_real_pack_every_non_redirect_has_body() -> None:
    """packs:slice v2 (#1637): every non-redirect strategy carries a non-null
    body so every projected strategies/*.md is a drift-checked projection; the
    pure redirect/superseded pointers stay metadata-only (body null)."""
    pack = json.loads(_REAL_SOURCE.read_text(encoding="utf-8"))
    assert pack["strategies"], "strategies pack must not be empty"
    sdir = _REPO_ROOT / "strategies"
    for entry in pack["strategies"]:
        md_text = (_REPO_ROOT / entry["path"]).read_text(encoding="utf-8")
        if pack_migrate_strategies.is_redirect_stub(md_text):
            assert entry["body"] is None, (
                f"redirect stub {entry['path']} must stay body=null"
            )
        else:
            assert entry["body"] is not None, (
                f"non-redirect strategy {entry['path']} must carry a body"
            )
    # The yolo proof strategy remains present and bodied (regression guard).
    assert any(
        s["path"] == _PROOF_STRATEGY and s["body"] is not None
        for s in pack["strategies"]
    )
    # The two committed redirect stubs are excluded from body capture.
    bodyless = {s["path"] for s in pack["strategies"] if s["body"] is None}
    assert bodyless == {"strategies/brownfield.md", "strategies/roadmap.md"}
    # The stub files still physically live under strategies/ (not deleted).
    assert (sdir / "brownfield.md").is_file()
    assert (sdir / "roadmap.md").is_file()


def test_real_pack_all_bodies_round_trip_through_renderer() -> None:
    """Every captured strategy body reproduces its committed projection exactly
    via the markdown renderer (the invariant the drift gate asserts)."""
    import pack_render  # type: ignore[import-not-found]

    pack = json.loads(_REAL_SOURCE.read_text(encoding="utf-8"))
    cfg = pack_render.RENDER_REGISTRY["strategies"]
    bodied = [s for s in pack["strategies"] if s["body"] is not None]
    assert len(bodied) >= 2, "expected the full non-redirect strategy set"
    for entry in bodied:
        rendered = pack_render.render_markdown_document(entry, cfg)
        committed = (_REPO_ROOT / entry["path"]).read_text(encoding="utf-8")
        assert rendered == committed, f"projection drift for {entry['path']}"


def test_schema_display_and_registry() -> None:
    schema = json.loads(_REAL_SCHEMA.read_text(encoding="utf-8"))
    assert schema["x-display"]["heading"] == "id"
    assert schema["x-display"]["body"] is None
    # #1637 added the by-id deeper slice; by-trigger + list remain.
    assert {"by-trigger", "list", "by-id"} <= set(schema["x-sliceRegistry"])
    assert schema["x-sliceRegistry"]["by-trigger"]["filters"] == ["trigger"]
