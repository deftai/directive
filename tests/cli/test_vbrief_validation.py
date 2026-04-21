"""Unit tests for ``scripts/_vbrief_validation.py`` (Agent D, #498).

Covers the public API of the new validation/slug module so regressions
show up in the module's own tests before surfacing through the integration
tests in ``tests/cli/test_migrate_vbrief.py``.

Story: #498 (migrate:vbrief self-validation + slug-safe IDs + golden tests).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from _vbrief_validation import (  # noqa: E402, I001
    HASH_SUFFIX_LENGTH,
    ID_MAX_LENGTH,
    RECOVERY_HINT,
    finalize_migration,
    isolate_invalid_output,
    slug_fallback_id,
    slugify_id,
    validate_migration_output,
)

# Schema-locked ID regex from #506 Shared Conventions.
ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$")
# Lifecycle-folder filename regex from scripts/vbrief_validate.py (D7).
FILENAME_SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


# ---------------------------------------------------------------------------
# slugify_id
# ---------------------------------------------------------------------------


class TestSlugifyIdBasics:
    """Single sanitiser that must conform to both schema and filename rules."""

    def test_lowercase_alpha_preserved(self):
        assert slugify_id("hello") == "hello"

    def test_uppercase_folded_to_lowercase(self):
        assert slugify_id("HELLO") == "hello"

    def test_spaces_become_hyphens(self):
        assert slugify_id("hello world") == "hello-world"

    def test_runs_of_spaces_collapse(self):
        assert slugify_id("foo    bar") == "foo-bar"

    def test_strips_leading_trailing_hyphens(self):
        assert slugify_id("  -foo-  ") == "foo"

    def test_punctuation_collapses_to_hyphen(self):
        # The exact failure modes listed in issue #498: scope ids containing
        # spaces, dots, slashes, `@`, `<`, `>`, `-`.
        assert slugify_id("scope-docker compose up -d") == "scope-docker-compose-up-d"
        assert slugify_id("@slizard dismiss") == "slizard-dismiss"
        assert slugify_id("GET /health") == "get-health"
        assert slugify_id("task update-index -- --repo <id>") == (
            "task-update-index-repo-id"
        )
        assert slugify_id("LESSONS.vbrief.json") == "lessons-vbrief-json"

    def test_empty_input_returns_untitled(self):
        assert slugify_id("") == "untitled"

    def test_none_input_returns_untitled(self):
        # Explicit None-safety so callers do not need to pre-guard.
        assert slugify_id(None) == "untitled"  # type: ignore[arg-type]

    def test_whitespace_only_returns_untitled(self):
        assert slugify_id("   ") == "untitled"

    def test_only_punctuation_returns_untitled(self):
        assert slugify_id("!@#$%^&*()") == "untitled"

    def test_truncates_to_80_chars(self):
        result = slugify_id("a" * 200)
        assert len(result) <= ID_MAX_LENGTH

    def test_truncation_strips_trailing_hyphen(self):
        # The 80th character lands on a hyphen -- verify the rstrip runs.
        raw = "a" * 79 + " bar"  # 84 chars; pos 80 is space -> hyphen
        result = slugify_id(raw)
        assert not result.endswith("-")
        assert len(result) <= ID_MAX_LENGTH


class TestSlugifyIdSchemaConformance:
    """Every slug must satisfy BOTH #506 ID regex AND D7 filename regex."""

    def test_conforms_to_id_regex(self):
        samples = [
            "hello world",
            "scope-docker compose up -d",
            "task update-index -- --repo <id>",
            "a" * 200,
            "   ",
        ]
        for raw in samples:
            slug = slugify_id(raw)
            assert ID_PATTERN.match(slug), f"{slug!r} (from {raw!r}) fails ID regex"

    def test_conforms_to_filename_slug_regex(self):
        samples = [
            "Add widget (v2)!",
            "Multi  word  -  title",
            "@slizard dismiss",
            "LESSONS.vbrief.json",
        ]
        for raw in samples:
            slug = slugify_id(raw)
            assert FILENAME_SLUG_PATTERN.match(slug), (
                f"{slug!r} (from {raw!r}) fails filename regex"
            )


class TestSlugifyIdCollisionDisambiguation:
    """Collisions within an emitted-set get a stable 6-char hash suffix."""

    def test_first_insertion_is_registered(self):
        existing: set[str] = set()
        result = slugify_id("hello", existing)
        assert result == "hello"
        assert "hello" in existing

    def test_second_insertion_gets_hash_suffix(self):
        existing: set[str] = {"hello"}
        result = slugify_id("hello", existing)
        # Format: base-HEXHEX6
        assert result.startswith("hello-")
        suffix = result.removeprefix("hello-")
        assert len(suffix) == HASH_SUFFIX_LENGTH
        assert all(c in "0123456789abcdef" for c in suffix)
        assert result in existing

    def test_hash_suffix_is_stable_across_runs(self):
        # Same input -> same hash suffix (stable, not random).
        existing1: set[str] = {"hello"}
        existing2: set[str] = {"hello"}
        assert slugify_id("hello", existing1) == slugify_id("hello", existing2)

    def test_different_inputs_get_different_hashes(self):
        existing: set[str] = {"hello"}
        r1 = slugify_id("hello", existing)
        existing2: set[str] = {"hello"}
        r2 = slugify_id("HELLO", existing2)
        for r in (r1, r2):
            assert r.startswith("hello-")
            assert len(r.removeprefix("hello-")) == HASH_SUFFIX_LENGTH

    def test_triple_collision_still_unique(self):
        existing: set[str] = set()
        a = slugify_id("hello world", existing)
        b = slugify_id("hello world", existing)
        assert a == "hello-world"
        assert b != a
        assert b.startswith("hello-world-")

    def test_none_existing_skips_collision_tracking(self):
        # When existing is None we still return the canonical slug but do
        # NOT attempt collision disambiguation.
        assert slugify_id("hello", None) == "hello"
        assert slugify_id("hello", None) == "hello"  # second call, no change

    def test_hash_suffix_perturbs_on_double_collision(self):
        """If the base+hash candidate itself collides, the loop perturbs the
        seed with ``|1|2...`` suffixes until a unique candidate is found.
        Seeds the existing set with the canonical slug AND its first hash
        candidate so the else-branch runs."""
        import hashlib

        raw = "collision me"
        text = raw.strip()
        base_slug = "collision-me"
        first_hash = hashlib.sha1(text.encode("utf-8")).hexdigest()[:6]
        first_candidate = f"{base_slug}-{first_hash}"
        existing: set[str] = {base_slug, first_candidate}

        result = slugify_id(raw, existing)
        # Must not be the canonical slug nor the first candidate
        assert result != base_slug
        assert result != first_candidate
        # But must still start with the base prefix
        assert result.startswith(f"{base_slug}-")
        # And be registered in the set
        assert result in existing

    def test_truncated_slug_still_disambiguates(self):
        # A slug already at the 80-char ceiling that collides must shrink to
        # make room for the hash suffix without exceeding the ceiling.
        raw = "a" * 100
        existing: set[str] = set()
        first = slugify_id(raw, existing)
        assert len(first) == ID_MAX_LENGTH
        second = slugify_id(raw, existing)
        assert len(second) <= ID_MAX_LENGTH
        assert second != first
        assert second.endswith(second[-HASH_SUFFIX_LENGTH:])
        assert FILENAME_SLUG_PATTERN.match(second)


# ---------------------------------------------------------------------------
# slug_fallback_id
# ---------------------------------------------------------------------------


class TestSlugFallbackId:
    """Preference order mirrors Step 4 / Step 4b filename construction."""

    def test_prefers_number(self):
        item = {"number": "42", "task_id": "1.1", "title": "foo"}
        assert slug_fallback_id(item) == "42"

    def test_falls_back_to_task_id(self):
        item = {"number": "", "task_id": "1.1.2", "title": "foo"}
        assert slug_fallback_id(item) == "1.1.2"

    def test_falls_back_to_synthetic_id(self):
        item = {"number": "", "task_id": "", "synthetic_id": "roadmap-3", "title": "foo"}
        assert slug_fallback_id(item) == "roadmap-3"

    def test_falls_back_to_title(self):
        item = {"title": "Fix login bug"}
        assert slug_fallback_id(item) == "Fix login bug"

    def test_returns_untitled_when_nothing_provided(self):
        assert slug_fallback_id({}) == "untitled"


# ---------------------------------------------------------------------------
# validate_migration_output
# ---------------------------------------------------------------------------


def _write_valid_project_definition(vbrief_dir: Path) -> None:
    data = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": "PROJECT-DEFINITION",
            "status": "running",
            "narratives": {
                "Overview": "Test overview narrative.",
                "tech stack": "Python 3.12",
            },
            "items": [],
        },
    }
    (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").write_text(
        json.dumps(data), encoding="utf-8"
    )


class TestValidateMigrationOutput:
    def test_missing_directory_yields_error(self, tmp_path):
        errors, warnings = validate_migration_output(tmp_path / "nonexistent")
        assert errors
        assert warnings == []

    def test_empty_vbrief_dir_passes(self, tmp_path):
        vbrief = tmp_path / "vbrief"
        vbrief.mkdir()
        errors, _warnings = validate_migration_output(vbrief)
        assert errors == []

    def test_valid_project_definition_passes(self, tmp_path):
        vbrief = tmp_path / "vbrief"
        vbrief.mkdir()
        _write_valid_project_definition(vbrief)
        errors, _warnings = validate_migration_output(vbrief)
        assert errors == []

    def test_invalid_status_fails(self, tmp_path):
        vbrief = tmp_path / "vbrief"
        vbrief.mkdir()
        bad = {
            "vBRIEFInfo": {"version": "0.5"},
            "plan": {
                "title": "Bad",
                "status": "in_progress",  # not in enum -- must fail
                "items": [],
            },
        }
        (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps(bad), encoding="utf-8"
        )
        errors, _warnings = validate_migration_output(vbrief)
        assert any("status" in e for e in errors)


# ---------------------------------------------------------------------------
# isolate_invalid_output
# ---------------------------------------------------------------------------


class TestIsolateInvalidOutput:
    def test_renames_vbrief_to_vbrief_invalid(self, tmp_path):
        vbrief = tmp_path / "vbrief"
        vbrief.mkdir()
        (vbrief / "sentinel.txt").write_text("marker", encoding="utf-8")

        target = isolate_invalid_output(tmp_path, vbrief)
        assert target is not None
        assert target == tmp_path / "vbrief.invalid"
        assert target.is_dir()
        assert not vbrief.exists()
        assert (target / "sentinel.txt").read_text(encoding="utf-8") == "marker"

    def test_numeric_suffix_on_collision(self, tmp_path):
        vbrief = tmp_path / "vbrief"
        vbrief.mkdir()
        # Pre-create vbrief.invalid from a prior failed run.
        (tmp_path / "vbrief.invalid").mkdir()
        (tmp_path / "vbrief.invalid.2").mkdir()

        target = isolate_invalid_output(tmp_path, vbrief)
        assert target == tmp_path / "vbrief.invalid.3"
        assert target.is_dir()

    def test_returns_none_when_vbrief_missing(self, tmp_path):
        assert isolate_invalid_output(tmp_path, tmp_path / "vbrief") is None


class TestFinalizeMigrationCrossVolume:
    """Covers the rel_invalid ValueError fallback in finalize_migration.

    When ``vbrief.invalid/`` lives outside ``project_root`` (e.g. different
    volume on a scratch setup) ``Path.relative_to`` raises ``ValueError`` and
    we fall through to the absolute-path string. This guards that fallback.
    """

    def test_failure_path_uses_absolute_path_when_not_relative(
        self, tmp_path, monkeypatch, capsys
    ):
        import scripts._vbrief_validation as mod  # type: ignore[import-not-found]

        vbrief = tmp_path / "vbrief"
        vbrief.mkdir()
        (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps({"vBRIEFInfo": {"version": "0.5"}, "plan": {}}),
            encoding="utf-8",
        )

        # Patch isolate_invalid_output to return a path that is NOT a
        # subpath of project_root so relative_to raises ValueError.
        external = tmp_path.parent / "external-vbrief.invalid"
        external.mkdir(exist_ok=True)
        monkeypatch.setattr(
            mod, "isolate_invalid_output", lambda _root, _vbrief: external
        )

        ok, actions = mod.finalize_migration(tmp_path, vbrief, ["seed"])
        assert ok is False
        # The absolute external path surfaces in the MOVE action line.
        assert any(str(external) in a for a in actions)

        captured = capsys.readouterr()
        assert str(external) in captured.err


# ---------------------------------------------------------------------------
# finalize_migration
# ---------------------------------------------------------------------------


class TestFinalizeMigration:
    def test_success_returns_unchanged_actions(self, tmp_path):
        vbrief = tmp_path / "vbrief"
        vbrief.mkdir()
        _write_valid_project_definition(vbrief)

        actions = ["CREATE vbrief/PROJECT-DEFINITION.vbrief.json"]
        ok, returned = finalize_migration(tmp_path, vbrief, actions)
        assert ok is True
        # Return value is the exact same list instance on success.
        assert returned is actions

    def test_failure_isolates_and_appends_hint(self, tmp_path, capsys):
        vbrief = tmp_path / "vbrief"
        vbrief.mkdir()
        # Bogus file that fails schema validation.
        (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps({"vBRIEFInfo": {"version": "0.5"}, "plan": {}}),
            encoding="utf-8",
        )

        actions = ["CREATE vbrief/PROJECT-DEFINITION.vbrief.json"]
        ok, returned = finalize_migration(tmp_path, vbrief, actions)
        assert ok is False
        assert returned is not actions  # defensive copy, not mutated
        assert any(a == RECOVERY_HINT for a in returned)
        assert any("schema validation error" in a for a in returned)
        assert any("vbrief.invalid" in a for a in returned)
        assert not vbrief.exists()
        assert (tmp_path / "vbrief.invalid").is_dir()

        captured = capsys.readouterr()
        assert "ERROR: Migration produced invalid output" in captured.err
        assert RECOVERY_HINT in captured.err
