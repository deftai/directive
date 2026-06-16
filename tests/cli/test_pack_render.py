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
import pack_migrate_skills  # type: ignore[import-not-found]  # noqa: E402
import pack_render  # type: ignore[import-not-found]  # noqa: E402

_REAL_SOURCE = _REPO_ROOT / "packs" / "lessons" / "lessons-pack-0.1.json"
_REAL_OUTPUT = _REPO_ROOT / "meta" / "lessons.md"
_REAL_SCHEMA = _REPO_ROOT / "vbrief" / "schemas" / "lessons-pack.schema.json"

_REAL_SKILLS_SOURCE = _REPO_ROOT / "packs" / "skills" / "skills-pack-0.1.json"
_REAL_SKILLS_SCHEMA = _REPO_ROOT / "vbrief" / "schemas" / "skills-pack.schema.json"
_PROOF_SKILL_PATH = "skills/deft-directive-cost/SKILL.md"


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
    # #1637 added the by-issue + anti-patterns deeper slices; the #1294 pilot
    # slices remain (superset check, not equality).
    assert {"recent", "by-tag", "by-issue", "anti-patterns"} <= set(registry)
    assert registry["recent"]["filters"] == ["since"]
    assert registry["by-tag"]["filters"] == ["tag"]
    assert registry["recent"]["path"] == "lessons"
    assert registry["by-issue"]["filters"] == ["issue"]
    # anti-patterns is argument-less: a fixed select predicate, no user filters.
    assert registry["anti-patterns"]["filters"] == []
    assert "select" in registry["anti-patterns"]


# ===========================================================================
# Skills pack (#1295): generalized machinery -- migration, schema, renderer,
# round-trip, and multi-pack drift. Lessons coverage above must NOT regress.
# ===========================================================================

# A small skills fixture: a routed proof skill (folded description + body), a
# routed metadata-only skill, an unrouted skill, and a deprecated redirect stub
# without YAML frontmatter (which must be skipped).
_FIXTURE_AGENTS_MD = """# Heading

## Skill Routing

When user input matches a trigger keyword, read the corresponding skill:

- "alpha" / "do alpha" \u2192 `skills/deft-alpha/SKILL.md` -- a note with `backticks`
- "beta" / "second beta" \u2192 `skills/deft-beta/SKILL.md`
- "alpha again" \u2192 `skills/deft-alpha/SKILL.md`
- "welcome" \u2192 invokes `task triage:welcome --onboard`

## Next Section

Not part of routing.
"""

_FIXTURE_ALPHA_MD = """---
name: deft-alpha
description: >
  Alpha skill that does alpha things. It spans
  multiple folded lines for realism.
---

# Alpha

Alpha body with an em dash \u2014 and content.
"""

_FIXTURE_BETA_MD = """---
name: deft-beta
version: "0.3"
description: >-
  Beta skill metadata only.
triggers:
  - beta
  - second beta
---

# Beta

Beta body that is NOT captured (metadata-only).
"""

_FIXTURE_STUB_MD = """<!-- deft:deprecated-skill-redirect -->

# Deprecated stub -- no frontmatter, must be skipped.
"""


def _write_skills_tree(tmp_path: Path) -> tuple[Path, Path]:
    """Write a fixture skills/ tree + AGENTS.md; return (skills_dir, agents_md)."""
    skills_dir = tmp_path / "skills"
    for name, text in (
        ("deft-alpha", _FIXTURE_ALPHA_MD),
        ("deft-beta", _FIXTURE_BETA_MD),
        ("deft-stub", _FIXTURE_STUB_MD),
    ):
        d = skills_dir / name
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(text, encoding="utf-8")
    agents_md = tmp_path / "AGENTS.md"
    agents_md.write_text(_FIXTURE_AGENTS_MD, encoding="utf-8")
    return skills_dir, agents_md


# --- routing-table parsing --------------------------------------------------


def test_parse_routing_maps_paths_to_triggers() -> None:
    routing = pack_migrate_skills.parse_routing(_FIXTURE_AGENTS_MD)
    # alpha accumulates both bullets; backtick note after the arrow is ignored.
    assert routing["skills/deft-alpha/SKILL.md"] == ["alpha", "do alpha", "alpha again"]
    assert routing["skills/deft-beta/SKILL.md"] == ["beta", "second beta"]
    # The task-only "welcome" bullet (no SKILL.md path) is skipped.
    assert all("triage:welcome" not in p for p in routing)


def test_parse_routing_handles_real_agents_md() -> None:
    routing = pack_migrate_skills.parse_routing(
        (_REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8")
    )
    assert "cost" in routing["skills/deft-directive-cost/SKILL.md"]
    assert "review cycle" in routing["skills/deft-directive-review-cycle/SKILL.md"]


# --- frontmatter parsing ----------------------------------------------------


def test_split_frontmatter_returns_none_for_stub() -> None:
    fm, body = pack_migrate_skills.split_frontmatter(_FIXTURE_STUB_MD)
    assert fm is None
    assert body == _FIXTURE_STUB_MD


def test_split_frontmatter_splits_body() -> None:
    fm, body = pack_migrate_skills.split_frontmatter(_FIXTURE_ALPHA_MD)
    assert fm is not None
    assert "name: deft-alpha" in fm
    assert body.lstrip().startswith("# Alpha")


def test_parse_frontmatter_folds_description() -> None:
    fm, _ = pack_migrate_skills.split_frontmatter(_FIXTURE_ALPHA_MD)
    assert fm is not None
    fields = pack_migrate_skills.parse_frontmatter_fields(fm)
    assert fields["name"] == "deft-alpha"
    assert fields["description"] == (
        "Alpha skill that does alpha things. It spans multiple folded lines "
        "for realism."
    )


def test_parse_frontmatter_skips_triggers_list_and_reads_version() -> None:
    fm, _ = pack_migrate_skills.split_frontmatter(_FIXTURE_BETA_MD)
    assert fm is not None
    fields = pack_migrate_skills.parse_frontmatter_fields(fm)
    assert fields["name"] == "deft-beta"
    assert fields["version"] == "0.3"
    assert fields["description"] == "Beta skill metadata only."


def test_strip_leading_banner_is_idempotent() -> None:
    body = "# Alpha\n\nContent.\n"
    banner = "\n".join(pack_render._SKILLS_BANNER) + "\n"
    bannered = banner + "\n" + body
    assert pack_migrate_skills.strip_leading_banner(bannered) == body
    # Idempotent: stripping a banner-free body is a no-op modulo leading blanks.
    assert pack_migrate_skills.strip_leading_banner(body) == body


def test_strip_leading_banner_preserves_unrelated_comment() -> None:
    body = "<!-- not our banner -->\n# Alpha\n"
    assert pack_migrate_skills.strip_leading_banner(body) == body


# --- migration end-to-end ---------------------------------------------------


def test_migrate_skills_builds_expected_pack(tmp_path: Path) -> None:
    skills_dir, agents_md = _write_skills_tree(tmp_path)
    out = tmp_path / "out" / "skills-pack-0.1.json"
    pack = pack_migrate_skills.migrate(
        skills_dir, agents_md, out, proof_skill="deft-alpha"
    )
    assert pack["pack"] == "skills-pack-0.1"
    assert pack["version"] == "0.1"
    # Stub without frontmatter is skipped: only alpha + beta remain.
    ids = [s["id"] for s in pack["skills"]]
    assert ids == ["deft-alpha", "deft-beta"]

    alpha = next(s for s in pack["skills"] if s["id"] == "deft-alpha")
    assert alpha["triggers"] == ["alpha", "do alpha", "alpha again"]
    assert alpha["path"] == "skills/deft-alpha/SKILL.md"
    assert alpha["version"] == "0.1"  # default
    assert alpha["body"] is not None and "Alpha body" in alpha["body"]

    beta = next(s for s in pack["skills"] if s["id"] == "deft-beta")
    assert beta["version"] == "0.3"
    assert beta["body"] is None  # metadata-only
    assert beta["triggers"] == ["beta", "second beta"]

    # Written file round-trips.
    assert json.loads(out.read_text(encoding="utf-8")) == pack


def test_migrate_skills_missing_dir_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        pack_migrate_skills.migrate(
            tmp_path / "nope", tmp_path / "AGENTS.md", tmp_path / "o.json",
            proof_skill="x",
        )


def test_migrate_skills_missing_agents_raises(tmp_path: Path) -> None:
    skills_dir, _ = _write_skills_tree(tmp_path)
    with pytest.raises(FileNotFoundError):
        pack_migrate_skills.migrate(
            skills_dir, tmp_path / "absent.md", tmp_path / "o.json",
            proof_skill="deft-alpha",
        )


def test_migrate_skills_no_frontmatter_skills_raises(tmp_path: Path) -> None:
    skills_dir = tmp_path / "skills" / "deft-stub"
    skills_dir.mkdir(parents=True)
    (skills_dir / "SKILL.md").write_text(_FIXTURE_STUB_MD, encoding="utf-8")
    agents_md = tmp_path / "AGENTS.md"
    agents_md.write_text(_FIXTURE_AGENTS_MD, encoding="utf-8")
    with pytest.raises(ValueError, match="no skills"):
        pack_migrate_skills.migrate(
            tmp_path / "skills", agents_md, tmp_path / "o.json",
            proof_skill="deft-alpha",
        )


def test_migrate_skills_main_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    skills_dir, agents_md = _write_skills_tree(tmp_path)
    out = tmp_path / "pack.json"
    rc = pack_migrate_skills.main(
        [
            "--skills-dir", str(skills_dir),
            "--agents-md", str(agents_md),
            "--proof-skill", "deft-alpha",
            "--out", str(out),
        ]
    )
    assert rc == 0
    assert "Migrated 2 skills (1 with body)" in capsys.readouterr().out
    rc_missing = pack_migrate_skills.main(
        ["--skills-dir", str(tmp_path / "nope"), "--agents-md", str(agents_md)]
    )
    assert rc_missing == 1


# --- skills renderer + round-trip ------------------------------------------


def test_render_skill_document_shape() -> None:
    cfg = pack_render.RENDER_REGISTRY["skills"]
    entry = {
        "id": "deft-alpha",
        "description": "Alpha does things.",
        "path": "skills/deft-alpha/SKILL.md",
        "version": "0.1",
        "body": "# Alpha\n\nBody.\n",
    }
    text = pack_render.render_skill_document(entry, cfg)
    lines = text.splitlines()
    assert lines[0] == "---"
    assert lines[1] == "name: deft-alpha"
    assert lines[2] == "description: >-"
    assert "---" in lines  # closing fence
    assert "<!-- AUTO-GENERATED by task packs:render" in text
    assert "<!-- Purpose: rendered skill -->" in text
    assert text.rstrip().endswith("Body.")


def test_skills_proof_skill_round_trips() -> None:
    """Rendering the committed proof skill entry reproduces exactly the committed
    SKILL.md -- the invariant the drift gate asserts (ADR-001)."""
    pack = json.loads(_REAL_SKILLS_SOURCE.read_text(encoding="utf-8"))
    cfg = pack_render.RENDER_REGISTRY["skills"]
    proof = next(s for s in pack["skills"] if s["path"] == _PROOF_SKILL_PATH)
    assert proof["body"] is not None
    rendered = pack_render.render_skill_document(proof, cfg)
    committed = (_REPO_ROOT / _PROOF_SKILL_PATH).read_text(encoding="utf-8")
    assert rendered == committed


def test_every_skill_has_body() -> None:
    """packs:slice v2 (#1637): EVERY skill entry carries a non-null body so every
    skills/*/SKILL.md is a banner-marked, drift-checked projection (not just the
    cost proof skill)."""
    pack = json.loads(_REAL_SKILLS_SOURCE.read_text(encoding="utf-8"))
    assert pack["skills"], "skills pack must not be empty"
    bodyless = [s["path"] for s in pack["skills"] if s["body"] is None]
    assert bodyless == [], f"skills missing a captured body: {bodyless}"
    # The cost proof skill remains present and bodied (regression guard).
    assert any(s["path"] == _PROOF_SKILL_PATH for s in pack["skills"])


def test_lossless_frontmatter_extra_preserves_triggers_and_metadata() -> None:
    """packs:slice v2 (#1637): regenerating every SKILL.md must be LOSSLESS --
    hand-authored frontmatter keys beyond name/description (triggers:, the
    clawdbot metadata block) survive the round-trip via frontmatter_extra."""
    pack = json.loads(_REAL_SKILLS_SOURCE.read_text(encoding="utf-8"))
    by_path = {s["path"]: s for s in pack["skills"]}
    article = by_path["skills/deft-directive-article-review/SKILL.md"]
    assert article["frontmatter_extra"] is not None
    assert "triggers:" in article["frontmatter_extra"]
    assert "clawdbot" in article["frontmatter_extra"]
    # The cost proof skill carries only name + description (no extra block).
    assert by_path[_PROOF_SKILL_PATH]["frontmatter_extra"] is None


# --- multi-pack drift gate (covers BOTH packs) ------------------------------


def test_collect_targets_covers_both_packs() -> None:
    targets = pack_render.collect_targets()
    names = {name for name, _path, _text in targets}
    # #1296 added rules + strategies; the #1295 invariant is that lessons +
    # skills remain covered (subset check, not equality).
    assert {"lessons", "skills"} <= names


def test_multipack_check_clean_on_committed(capsys: pytest.CaptureFixture) -> None:
    rc = pack_render.main(["--check"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "in sync" in out


def test_pack_filter_limits_targets() -> None:
    targets = pack_render.collect_targets("skills")
    assert {name for name, _p, _t in targets} == {"skills"}
    assert all(path.name == "SKILL.md" for _n, path, _t in targets)


# --- skills schema validation ----------------------------------------------


def _validate_skills_source(pack: dict, schema: dict) -> list[str]:
    """Minimal structural validator for the skills-pack schema (no jsonschema)."""
    errors: list[str] = []
    props = schema["properties"]
    if pack.get("pack") != props["pack"]["const"]:
        errors.append("pack const mismatch")
    if pack.get("version") != props["version"]["const"]:
        errors.append("version const mismatch")
    if not isinstance(pack.get("skills"), list):
        errors.append("skills must be a list")
        return errors
    item_props = props["skills"]["items"]["properties"]
    required = props["skills"]["items"]["required"]
    id_re = re.compile(item_props["id"]["pattern"])
    path_re = re.compile(item_props["path"]["pattern"])
    for i, entry in enumerate(pack["skills"]):
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


def test_generated_skills_source_validates_against_schema() -> None:
    pack = json.loads(_REAL_SKILLS_SOURCE.read_text(encoding="utf-8"))
    schema = json.loads(_REAL_SKILLS_SCHEMA.read_text(encoding="utf-8"))
    errors = _validate_skills_source(pack, schema)
    assert errors == [], f"skills schema validation errors: {errors}"


def test_skills_schema_display_and_registry() -> None:
    schema = json.loads(_REAL_SKILLS_SCHEMA.read_text(encoding="utf-8"))
    assert schema["x-display"]["heading"] == "id"
    assert schema["x-display"]["body"] is None
    # #1637 added the by-id deeper slice; by-trigger + list remain.
    assert {"by-trigger", "list", "by-id"} <= set(schema["x-sliceRegistry"])
    assert schema["x-sliceRegistry"]["by-trigger"]["filters"] == ["trigger"]
    assert schema["x-sliceRegistry"]["by-id"]["filters"] == ["id"]


def test_lessons_render_still_byte_identical() -> None:
    """Regression guard: generalizing the renderer must keep lessons identical."""
    rendered = pack_render.render_file(_REAL_SOURCE)
    committed = _REAL_OUTPUT.read_text(encoding="utf-8")
    assert rendered == committed


# ===========================================================================
# Rules + strategies packs (#1296): the markdown documents render mode, the
# two new proofs round-trip + drift-check, four-pack coverage, and NO
# regression of the lessons + skills proofs.
# ===========================================================================

_REAL_RULES_SOURCE = _REPO_ROOT / "packs" / "rules" / "rules-pack-0.1.json"
_REAL_RULES_SCHEMA = _REPO_ROOT / "vbrief" / "schemas" / "rules-pack.schema.json"
_RULES_PROOF_PATH = "coding/testing.md"

_REAL_STRATEGIES_SOURCE = _REPO_ROOT / "packs" / "strategies" / "strategies-pack-0.1.json"
_REAL_STRATEGIES_SCHEMA = _REPO_ROOT / "vbrief" / "schemas" / "strategies-pack.schema.json"
_STRATEGIES_PROOF_PATH = "strategies/yolo.md"


def test_render_markdown_document_shape() -> None:
    cfg = pack_render.RENDER_REGISTRY["rules"]
    entry = {"path": "coding/testing.md", "body": "# Testing Standards\n\nBody.\n"}
    text = pack_render.render_markdown_document(entry, cfg)
    lines = text.splitlines()
    assert lines[0].startswith("<!-- AUTO-GENERATED by task packs:render")
    assert lines[1] == "<!-- Purpose: rendered coding rules -->"
    assert lines[2] == "<!-- Source of truth: packs/rules/rules-pack-0.1.json -->"
    # A single blank line separates the banner from the body (idempotent strip).
    assert "<!-- Edit the source" in text
    assert "# Testing Standards" in text
    assert text.rstrip().endswith("Body.")


def test_markdown_document_renderer_dispatched_by_doc_kind() -> None:
    assert pack_render._DOCUMENT_RENDERERS["markdown"] is pack_render.render_markdown_document
    assert pack_render._DOCUMENT_RENDERERS["skill"] is pack_render.render_skill_document
    assert pack_render.RENDER_REGISTRY["rules"]["doc_kind"] == "markdown"
    assert pack_render.RENDER_REGISTRY["strategies"]["doc_kind"] == "markdown"


def test_rules_proof_doc_round_trips() -> None:
    """Rendering the committed coding/testing.md rule entry reproduces exactly
    the committed file -- the invariant the drift gate asserts (ADR-001).

    packs:slice v2 #1637 s4 bodies every coding/*.md doc, so select the
    testing.md entry by path rather than "the first bodied entry"."""
    pack = json.loads(_REAL_RULES_SOURCE.read_text(encoding="utf-8"))
    cfg = pack_render.RENDER_REGISTRY["rules"]
    proof = next(
        r for r in pack["rules"]
        if r["path"] == _RULES_PROOF_PATH and r["body"] is not None
    )
    rendered = pack_render.render_markdown_document(proof, cfg)
    committed = (_REPO_ROOT / _RULES_PROOF_PATH).read_text(encoding="utf-8")
    assert rendered == committed


def test_strategies_proof_doc_round_trips() -> None:
    pack = json.loads(_REAL_STRATEGIES_SOURCE.read_text(encoding="utf-8"))
    cfg = pack_render.RENDER_REGISTRY["strategies"]
    # packs:slice v2 (#1637) bodies every non-redirect strategy, so select the
    # yolo proof by path rather than "the first bodied entry".
    proof = next(
        s for s in pack["strategies"] if s["path"] == _STRATEGIES_PROOF_PATH
    )
    assert proof["body"] is not None
    rendered = pack_render.render_markdown_document(proof, cfg)
    committed = (_REPO_ROOT / _STRATEGIES_PROOF_PATH).read_text(encoding="utf-8")
    assert rendered == committed


def test_rules_every_coding_doc_has_body() -> None:
    """packs:slice v2 #1637 s4: every coding/*.md doc carries a body (one bodied
    entry per doc) so each coding doc is a drift-checked projection."""
    pack = json.loads(_REAL_RULES_SOURCE.read_text(encoding="utf-8"))
    bodied_paths = {r["path"] for r in pack["rules"] if r["body"] is not None}
    coding_docs = {
        f"coding/{p.name}" for p in (_REPO_ROOT / "coding").glob("*.md")
    }
    assert bodied_paths == coding_docs
    assert _RULES_PROOF_PATH in bodied_paths


def test_rules_agents_and_main_are_metadata_only() -> None:
    """#1637 s4 ownership boundary GUARD: AGENTS.md and main.md contribute
    directive metadata only -- NEVER a body -- so packs:render never writes
    them and AGENTS.md stays owned solely by `task agents:refresh`."""
    pack = json.loads(_REAL_RULES_SOURCE.read_text(encoding="utf-8"))
    extra = [r for r in pack["rules"] if r["path"] in ("AGENTS.md", "main.md")]
    assert extra, "expected AGENTS.md / main.md directive entries to be ingested"
    assert {r["domain"] for r in extra} == {"agents", "main"}
    assert all(r["body"] is None for r in extra)
    # And none of them appear as render targets.
    rules_targets = pack_render.collect_targets("rules")
    target_paths = {
        path.relative_to(_REPO_ROOT).as_posix() for _n, path, _t in rules_targets
    }
    assert "AGENTS.md" not in target_paths
    assert "main.md" not in target_paths


def test_strategies_every_non_redirect_has_body() -> None:
    """packs:slice v2 (#1637): every non-redirect strategy carries a body so
    every strategies/*.md is a drift-checked projection; only the pure
    redirect/superseded pointers stay metadata-only (body null)."""
    pack = json.loads(_REAL_STRATEGIES_SOURCE.read_text(encoding="utf-8"))
    assert pack["strategies"], "strategies pack must not be empty"
    bodyless = {s["path"] for s in pack["strategies"] if s["body"] is None}
    assert bodyless == {"strategies/brownfield.md", "strategies/roadmap.md"}
    # The yolo proof strategy remains present and bodied (regression guard).
    assert any(
        s["path"] == _STRATEGIES_PROOF_PATH and s["body"] is not None
        for s in pack["strategies"]
    )


def test_collect_targets_covers_all_six_packs() -> None:
    targets = pack_render.collect_targets()
    names = {name for name, _path, _text in targets}
    # #1637 added the patterns + swarm-spec packs to the #1296 four.
    assert names == {
        "lessons",
        "skills",
        "rules",
        "strategies",
        "patterns",
        "swarm-spec",
    }


def test_multipack_check_clean_covers_six_packs(capsys: pytest.CaptureFixture) -> None:
    rc = pack_render.main(["--check"])
    out = capsys.readouterr().out
    assert rc == 0
    # packs:slice v2 (#1637) captured a body for every skill, every non-redirect
    # strategy, AND (s4) every coding/*.md rule doc, so each renders one
    # projection per source doc: 19 skills + 14 strategies + 8 coding rule docs
    # + lessons + patterns + swarm-spec = 44 projections across six packs.
    # AGENTS.md / main.md are metadata-only (not rendered).
    assert "44 projection(s) in sync" in out


def test_pack_filter_limits_to_rules() -> None:
    targets = pack_render.collect_targets("rules")
    assert {name for name, _p, _t in targets} == {"rules"}
    # packs:slice v2 #1637 s4: the renderer now projects every coding/*.md doc,
    # not just the testing.md proof. The projected set must equal exactly the
    # coding docs on disk (AGENTS.md / main.md are metadata-only, not rendered).
    expected = {p.name for p in (_REPO_ROOT / "coding").glob("*.md")}
    assert {path.name for _n, path, _t in targets} == expected
    assert "testing.md" in expected


def test_pack_filter_limits_to_strategies() -> None:
    targets = pack_render.collect_targets("strategies")
    assert {name for name, _p, _t in targets} == {"strategies"}
    # packs:slice v2 (#1637): the renderer now projects every non-redirect
    # strategy, not just the yolo proof. The projected set must equal exactly
    # the bodied entries in the source pack (redirect stubs excluded).
    pack = json.loads(_REAL_STRATEGIES_SOURCE.read_text(encoding="utf-8"))
    expected = {
        Path(s["path"]).name for s in pack["strategies"] if s["body"] is not None
    }
    assert expected, "expected at least one bodied strategy"
    assert {path.name for _n, path, _t in targets} == expected
    assert "yolo.md" in expected
    assert "brownfield.md" not in expected
    assert "roadmap.md" not in expected


def test_lessons_and_skills_proofs_still_byte_identical() -> None:
    """Regression guard (#1296): adding rules + strategies must keep the
    lessons + skills proofs byte-identical."""
    assert pack_render.render_file(_REAL_SOURCE) == _REAL_OUTPUT.read_text(
        encoding="utf-8"
    )
    skills_pack = json.loads(_REAL_SKILLS_SOURCE.read_text(encoding="utf-8"))
    skills_cfg = pack_render.RENDER_REGISTRY["skills"]
    proof = next(s for s in skills_pack["skills"] if s["path"] == _PROOF_SKILL_PATH)
    rendered = pack_render.render_skill_document(proof, skills_cfg)
    committed = (_REPO_ROOT / _PROOF_SKILL_PATH).read_text(encoding="utf-8")
    assert rendered == committed
