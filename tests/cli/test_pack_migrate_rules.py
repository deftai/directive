"""test_pack_migrate_rules.py -- in-process tests for the rules pack migration (#1296).

Covers (per the new-source test mandate):
- parse_rules: each strength glyph maps to its normalized tier, prose RFC2119
  bullets are recognized, non-directive lines are ignored, ids are stable.
- migrate: parse -> source round-trip; domain classification from the doc stem;
  exactly the designated proof doc carries a body (others null).
- schema: the generated source validates against the rules-pack schema
  (lightweight in-test validator -- no jsonschema dependency).

All tests drive the module functions directly so coverage attributes to
pack_migrate_rules.py.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

import pack_migrate_rules  # type: ignore[import-not-found]  # noqa: E402

_REAL_SOURCE = _REPO_ROOT / "packs" / "rules" / "rules-pack-0.1.json"
_REAL_SCHEMA = _REPO_ROOT / "vbrief" / "schemas" / "rules-pack.schema.json"
_PROOF_DOC = "coding/testing.md"

# Glyphs from the coding/* RFC2119 legend.
_SHOULD_NOT = "\u2249"
_MUST_NOT = "\u2297"

# A fixture coding doc exercising every marker + a prose bullet + noise lines.
FIXTURE_TESTING_MD = f"""# Testing Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, {_SHOULD_NOT}=SHOULD NOT, {_MUST_NOT}=MUST NOT, ?=MAY.

## Universal Requirements

- ! Achieve high coverage
- ~ Have integration tests
- {_SHOULD_NOT} Rely on execution order
- {_MUST_NOT} Skip tests
- ? Use a fuzzing tool
- A plain bullet that MUST be recognized as prose
- A plain bullet with no keyword
- Tools: JMeter, k6

Some prose paragraph, not a bullet, that mentions MUST inline.
"""

FIXTURE_OTHER_MD = """# Security Standards

Legend (from RFC2119): !=MUST.

- ! Validate all untrusted input
"""


def _build(tmp_path: Path, extra_sources: tuple[Path, ...] = ()) -> dict:
    coding = tmp_path / "coding"
    coding.mkdir()
    (coding / "testing.md").write_text(FIXTURE_TESTING_MD, encoding="utf-8")
    (coding / "security.md").write_text(FIXTURE_OTHER_MD, encoding="utf-8")
    return pack_migrate_rules.build_pack(coding, extra_sources=extra_sources)


# --- parse_rules ------------------------------------------------------------


def test_parse_rules_maps_every_glyph_to_tier() -> None:
    rules = pack_migrate_rules.parse_rules(FIXTURE_TESTING_MD, "testing")
    tiers = {r["text"]: r["tier"] for r in rules}
    assert tiers["Achieve high coverage"] == "MUST"
    assert tiers["Have integration tests"] == "SHOULD"
    assert tiers["Rely on execution order"] == "SHOULD_NOT"
    assert tiers["Skip tests"] == "MUST_NOT"
    assert tiers["Use a fuzzing tool"] == "MAY"


def test_parse_rules_recognizes_prose_bullet() -> None:
    rules = pack_migrate_rules.parse_rules(FIXTURE_TESTING_MD, "testing")
    prose = next(
        r for r in rules if r["text"] == "A plain bullet that MUST be recognized as prose"
    )
    assert prose["tier"] == "MUST"


def test_parse_rules_ignores_non_directive_lines() -> None:
    rules = pack_migrate_rules.parse_rules(FIXTURE_TESTING_MD, "testing")
    texts = [r["text"] for r in rules]
    # Plain keyword-free bullets, "Tools:" bullets and prose paragraphs excluded.
    assert "A plain bullet with no keyword" not in texts
    assert "Tools: JMeter, k6" not in texts
    assert not any("Some prose paragraph" in t for t in texts)
    # Exactly the 6 directive lines (5 glyph + 1 prose).
    assert len(rules) == 6


def test_parse_rules_ids_stable_and_sequential() -> None:
    rules = pack_migrate_rules.parse_rules(FIXTURE_TESTING_MD, "testing")
    ids = [r["id"] for r in rules]
    assert ids[0] == "testing-001"
    assert ids[-1] == "testing-006"
    assert len(ids) == len(set(ids))
    assert all(re.match(r"^[a-z0-9][a-z0-9-]*$", i) for i in ids)


def test_prose_tier_longest_match_first() -> None:
    assert pack_migrate_rules._prose_tier("this MUST NOT happen") == "MUST_NOT"
    assert pack_migrate_rules._prose_tier("this SHOULD NOT happen") == "SHOULD_NOT"
    assert pack_migrate_rules._prose_tier("this MUST happen") == "MUST"
    assert pack_migrate_rules._prose_tier("no keyword here") is None
    # A substring like "MUSTard" must NOT be mistaken for a rule.
    assert pack_migrate_rules._prose_tier("add MUSTard to the list") is None


# --- migrate / build_pack ---------------------------------------------------


def test_build_pack_classifies_domain_from_stem(tmp_path: Path) -> None:
    pack = _build(tmp_path)
    domains = {r["domain"] for r in pack["rules"]}
    assert domains == {"testing", "security"}
    sec = [r for r in pack["rules"] if r["domain"] == "security"]
    assert len(sec) == 1
    assert sec[0]["path"] == "coding/security.md"


def test_build_pack_every_coding_doc_first_rule_bodied(tmp_path: Path) -> None:
    """#1637 s4: every coding doc carries a body on its FIRST rule (one bodied
    entry per doc); every other entry stays metadata-only."""
    pack = _build(tmp_path)
    bodied = [r for r in pack["rules"] if r["body"] is not None]
    assert {r["path"] for r in bodied} == {"coding/testing.md", "coding/security.md"}
    # Exactly one bodied entry per coding doc (the first rule).
    assert len(bodied) == 2
    testing_body = next(r for r in bodied if r["path"] == "coding/testing.md")
    assert testing_body["body"].startswith("# Testing Standards")


def test_build_pack_body_is_first_rule_per_doc(tmp_path: Path) -> None:
    pack = _build(tmp_path)
    for domain in ("testing", "security"):
        doc_rules = [r for r in pack["rules"] if r["domain"] == domain]
        assert doc_rules[0]["body"] is not None
        assert all(r["body"] is None for r in doc_rules[1:])


def test_strip_managed_section_removes_block() -> None:
    """#1637 s4: the AGENTS.md managed-section mirror is stripped before
    extraction so mirrored directives are not ingested twice."""
    text = (
        "# AGENTS\n\n! Maintainer rule above the mirror\n\n"
        "<!-- deft:managed-section v3 sha=abc refreshed=2026-01-01 -->\n"
        "! Mirrored rule that must NOT be ingested\n"
        "<!-- /deft:managed-section -->\n\n"
        "~ Maintainer rule below the mirror\n"
    )
    stripped = pack_migrate_rules.strip_managed_section(text)
    assert "Mirrored rule that must NOT be ingested" not in stripped
    assert "Maintainer rule above the mirror" in stripped
    assert "Maintainer rule below the mirror" in stripped
    rules = pack_migrate_rules.parse_rules(stripped, "agents")
    texts = [r["text"] for r in rules]
    assert "Maintainer rule above the mirror" in texts
    assert "Maintainer rule below the mirror" in texts
    assert "Mirrored rule that must NOT be ingested" not in texts


def test_strip_managed_section_noop_without_block() -> None:
    text = "# main\n\n! A canonical rule\n"
    assert pack_migrate_rules.strip_managed_section(text) == text


def test_build_pack_extra_sources_metadata_only(tmp_path: Path) -> None:
    """#1637 s4 ownership boundary: extra sources (AGENTS.md / main.md) are
    ingested as directive metadata only -- domain from stem, body always null,
    and AGENTS.md's managed section excluded."""
    agents = tmp_path / "AGENTS.md"
    agents.write_text(
        "# AGENTS\n\n! Canonical maintainer rule\n\n"
        "<!-- deft:managed-section v3 sha=abc -->\n"
        "! Mirror rule\n"
        "<!-- /deft:managed-section -->\n",
        encoding="utf-8",
    )
    main_md = tmp_path / "main.md"
    main_md.write_text("# main\n\n~ A guideline rule\n", encoding="utf-8")
    pack = _build(tmp_path, extra_sources=(agents, main_md))
    extra = [r for r in pack["rules"] if r["path"] in ("AGENTS.md", "main.md")]
    assert {r["domain"] for r in extra} == {"agents", "main"}
    assert all(r["body"] is None for r in extra)
    extra_texts = [r["text"] for r in extra]
    assert "Canonical maintainer rule" in extra_texts
    assert "A guideline rule" in extra_texts
    # Managed-section mirror excluded.
    assert "Mirror rule" not in extra_texts


def test_build_pack_skips_missing_extra_source(tmp_path: Path) -> None:
    pack = _build(tmp_path, extra_sources=(tmp_path / "nope.md",))
    assert all(r["path"].startswith("coding/") for r in pack["rules"])


def test_migrate_writes_and_round_trips(tmp_path: Path) -> None:
    coding = tmp_path / "coding"
    coding.mkdir()
    (coding / "testing.md").write_text(FIXTURE_TESTING_MD, encoding="utf-8")
    out = tmp_path / "out" / "rules-pack-0.1.json"
    pack = pack_migrate_rules.migrate(coding, out, extra_sources=())
    assert out.is_file()
    assert pack["pack"] == "rules-pack-0.1"
    assert pack["version"] == "0.1"
    assert json.loads(out.read_text(encoding="utf-8")) == pack


def test_strip_leading_banner_idempotent() -> None:
    body = "# Testing Standards\n\nContent.\n"
    banner = (
        "<!-- AUTO-GENERATED by task packs:render -- DO NOT EDIT MANUALLY -->\n"
        "<!-- Purpose: rendered coding rules -->\n"
    )
    bannered = banner + "\n" + body
    assert pack_migrate_rules.strip_leading_banner(bannered) == body
    assert pack_migrate_rules.strip_leading_banner(body) == body


def test_migrate_missing_dir_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        pack_migrate_rules.migrate(
            tmp_path / "nope", tmp_path / "o.json", extra_sources=()
        )


def test_migrate_no_directives_raises(tmp_path: Path) -> None:
    coding = tmp_path / "coding"
    coding.mkdir()
    (coding / "empty.md").write_text("# Empty\n\nNo directives here.\n", encoding="utf-8")
    with pytest.raises(ValueError, match="no directives"):
        pack_migrate_rules.migrate(coding, tmp_path / "o.json", extra_sources=())


def test_migrate_main_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    coding = tmp_path / "coding"
    coding.mkdir()
    (coding / "testing.md").write_text(FIXTURE_TESTING_MD, encoding="utf-8")
    out = tmp_path / "pack.json"
    # Point --extra-source at a non-existent file so main() ingests no real
    # repo AGENTS.md/main.md (build_pack skips missing sources).
    rc = pack_migrate_rules.main(
        [
            "--coding-dir",
            str(coding),
            "--extra-source",
            str(tmp_path / "none.md"),
            "--out",
            str(out),
        ]
    )
    assert rc == 0
    assert "with body" in capsys.readouterr().out
    rc_missing = pack_migrate_rules.main(["--coding-dir", str(tmp_path / "nope")])
    assert rc_missing == 1


# --- schema validation (lightweight) ----------------------------------------


def _validate_rules_source(pack: dict, schema: dict) -> list[str]:
    errors: list[str] = []
    props = schema["properties"]
    if pack.get("pack") != props["pack"]["const"]:
        errors.append("pack const mismatch")
    if pack.get("version") != props["version"]["const"]:
        errors.append("version const mismatch")
    if not isinstance(pack.get("rules"), list):
        errors.append("rules must be a list")
        return errors
    item_props = props["rules"]["items"]["properties"]
    required = props["rules"]["items"]["required"]
    id_re = re.compile(item_props["id"]["pattern"])
    path_re = re.compile(item_props["path"]["pattern"])
    tier_enum = set(item_props["tier"]["enum"])
    for i, entry in enumerate(pack["rules"]):
        for key in required:
            if key not in entry:
                errors.append(f"entry {i} missing required key {key}")
        if not id_re.match(entry.get("id", "")):
            errors.append(f"entry {i} id pattern: {entry.get('id')!r}")
        if not path_re.match(entry.get("path", "")):
            errors.append(f"entry {i} path pattern: {entry.get('path')!r}")
        if entry.get("tier") not in tier_enum:
            errors.append(f"entry {i} tier not in enum: {entry.get('tier')!r}")
        body = entry.get("body")
        if body is not None and not isinstance(body, str):
            errors.append(f"entry {i} body must be str or null")
    return errors


def test_generated_source_validates_against_schema() -> None:
    pack = json.loads(_REAL_SOURCE.read_text(encoding="utf-8"))
    schema = json.loads(_REAL_SCHEMA.read_text(encoding="utf-8"))
    errors = _validate_rules_source(pack, schema)
    assert errors == [], f"schema validation errors: {errors}"


def test_real_pack_every_coding_doc_bodied() -> None:
    """#1637 s4: the real pack bodies every coding/*.md doc (one entry each)."""
    pack = json.loads(_REAL_SOURCE.read_text(encoding="utf-8"))
    bodied_paths = {r["path"] for r in pack["rules"] if r["body"] is not None}
    coding_docs = {f"coding/{p.name}" for p in (_REPO_ROOT / "coding").glob("*.md")}
    assert bodied_paths == coding_docs
    assert _PROOF_DOC in bodied_paths


def test_real_pack_agents_main_ingested_metadata_only() -> None:
    """#1637 s4 ownership boundary GUARD on the real pack: AGENTS.md + main.md
    contribute directive metadata (domains agents/main) but NEVER a body."""
    pack = json.loads(_REAL_SOURCE.read_text(encoding="utf-8"))
    extra = [r for r in pack["rules"] if r["path"] in ("AGENTS.md", "main.md")]
    assert extra, "expected AGENTS.md / main.md directives in the real pack"
    assert {r["domain"] for r in extra} == {"agents", "main"}
    assert all(r["body"] is None for r in extra)


def test_schema_tier_enum_matches_migration_glyph_map() -> None:
    schema = json.loads(_REAL_SCHEMA.read_text(encoding="utf-8"))
    enum = set(schema["properties"]["rules"]["items"]["properties"]["tier"]["enum"])
    assert enum == set(pack_migrate_rules.GLYPH_TIER.values())
    assert set(schema["x-tierVocabulary"]) == enum
