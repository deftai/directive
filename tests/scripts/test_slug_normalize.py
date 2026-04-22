"""Unit tests for ``scripts/slug_normalize.py`` (#532).

Covers the rules documented in the module:

1. Unicode NFKD + non-ASCII drop
2. Lowercase
3. Markdown checkbox marker stripping (``[x]`` / ``[ ]``)
4. Non-alphanumeric collapse to single hyphen
5. Leading/trailing hyphen strip
6. Word-boundary truncation at ``max_len`` (default 60)
7. Empty-after-normalization fallback -> ``"untitled"``
8. Windows-reserved name suffixing (``-scope``)

Plus collision-suffix behaviour for :func:`disambiguate_slug`.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from slug_normalize import (  # noqa: E402
    DEFAULT_MAX_LEN,
    WINDOWS_RESERVED,
    disambiguate_slug,
    normalize_slug,
)


class TestNormalizeSlugBasics:
    def test_lowercases_and_hyphenates(self):
        assert normalize_slug("Hello World") == "hello-world"

    def test_strips_punctuation(self):
        assert normalize_slug("Add widget (v2)!") == "add-widget-v2"

    def test_collapses_multiple_separators(self):
        assert (
            normalize_slug("foo   bar---baz___qux")
            == "foo-bar-baz-qux"
        )

    def test_strips_leading_trailing_hyphens(self):
        assert normalize_slug("---foo-bar---") == "foo-bar"

    def test_preserves_digits(self):
        assert normalize_slug("migrate to v0.20.0") == "migrate-to-v0-20-0"


class TestNormalizeSlugEmpty:
    def test_empty_string_returns_untitled(self):
        assert normalize_slug("") == "untitled"

    def test_none_returns_untitled(self):
        assert normalize_slug(None) == "untitled"  # type: ignore[arg-type]

    def test_whitespace_only_returns_untitled(self):
        assert normalize_slug("   \t   ") == "untitled"

    def test_punctuation_only_returns_untitled(self):
        assert normalize_slug("!!! --- ???") == "untitled"

    def test_non_ascii_only_returns_untitled(self):
        # All characters drop after NFKD + ASCII encode-ignore.
        assert normalize_slug("日本語") == "untitled"


class TestNormalizeSlugUnicode:
    def test_nfkd_strips_diacritics(self):
        # "café" -> NFKD -> "cafe\u0301" -> strip combining -> "cafe"
        assert normalize_slug("café latte") == "cafe-latte"

    def test_mixed_latin_supplement(self):
        assert normalize_slug("El Niño Año") == "el-nino-ano"

    def test_mixed_ascii_and_cjk(self):
        # Non-ASCII characters are dropped; the ASCII portion survives.
        assert normalize_slug("deploy 部署 pipeline") == "deploy-pipeline"

    def test_fullwidth_digits_collapse(self):
        # NFKD maps fullwidth digits to ASCII digits.
        assert normalize_slug("issue １２３") == "issue-123"


class TestNormalizeSlugCheckboxMarkers:
    def test_leading_x_marker_stripped(self):
        assert (
            normalize_slug("[x] Confirm support space name")
            == "confirm-support-space-name"
        )

    def test_leading_empty_marker_stripped(self):
        assert (
            normalize_slug("[ ] Review agent prompt changes")
            == "review-agent-prompt-changes"
        )

    def test_uppercase_marker_stripped(self):
        assert normalize_slug("[X] Done-ish task") == "done-ish-task"

    def test_marker_after_whitespace_stripped(self):
        assert normalize_slug("- [x] nested list item") == "nested-list-item"

    def test_mid_sentence_checkbox_marker_also_stripped(self):
        # The regex matches ``[x]`` preceded by whitespace OR start-of-string,
        # so a mid-sentence ``[x]`` (preceded by a space) is also treated as a
        # checkbox marker and removed. This is the intentional simple rule:
        # bracketed single-character markers are almost always checkboxes in
        # practice, and the false-positive on prose like ``add [x]-axis`` is
        # accepted as the cost of not leaking checkboxes as literal ``x-``.
        assert normalize_slug("add [x]-axis scaling") == "add-axis-scaling"


class TestNormalizeSlugTruncation:
    def test_short_input_not_truncated(self):
        slug = normalize_slug("short title", max_len=60)
        assert slug == "short-title"

    def test_default_max_len_is_60(self):
        assert DEFAULT_MAX_LEN == 60

    def test_long_title_truncates_at_word_boundary(self):
        title = (
            "task update index repo id builds codebase graph vbrief "
            "json and lancedb index for a real repo"
        )
        slug = normalize_slug(title, max_len=60)
        assert len(slug) <= 60
        # Must end on a word boundary (not a partial token).
        assert not slug.endswith("-")
        # Must not slice a word in half: the last token must be a complete
        # word from the input.
        last_token = slug.rsplit("-", 1)[-1]
        assert last_token in title.replace(",", "").lower().split()

    def test_truncation_hard_cap_when_no_word_boundary(self):
        # No hyphens past max_len // 2 -- falls back to hard cut + rstrip.
        slug = normalize_slug("a" * 100, max_len=60)
        assert len(slug) <= 60
        assert slug == "a" * 60

    def test_truncation_preserves_word_when_exact_hit(self):
        slug = normalize_slug(
            "exactly sixty characters in this deterministic test input here",
            max_len=60,
        )
        assert len(slug) <= 60

    def test_custom_max_len(self):
        slug = normalize_slug("some longer descriptive title", max_len=20)
        assert len(slug) <= 20

    def test_max_len_below_one_falls_back_to_default(self):
        slug = normalize_slug("hello world", max_len=0)
        # Treated as DEFAULT_MAX_LEN.
        assert slug == "hello-world"


class TestNormalizeSlugWindowsReserved:
    def test_con_gets_scope_suffix(self):
        assert normalize_slug("con") == "con-scope"

    def test_case_insensitive_match(self):
        assert normalize_slug("CON") == "con-scope"

    def test_com1_through_com9(self):
        for n in range(1, 10):
            assert normalize_slug(f"com{n}") == f"com{n}-scope"

    def test_lpt1_through_lpt9(self):
        for n in range(1, 10):
            assert normalize_slug(f"lpt{n}") == f"lpt{n}-scope"

    def test_aux_prn_nul(self):
        for name in ("aux", "prn", "nul"):
            assert normalize_slug(name) == f"{name}-scope"

    def test_composite_names_not_reserved(self):
        # ``con-something`` is not reserved.
        assert normalize_slug("con something") == "con-something"

    def test_reserved_set_shape(self):
        # Sanity: the exported set carries the documented names.
        assert "con" in WINDOWS_RESERVED
        assert "lpt9" in WINDOWS_RESERVED
        assert "com1" in WINDOWS_RESERVED
        assert "nul" in WINDOWS_RESERVED


class TestDisambiguateSlug:
    def test_returns_unchanged_when_not_colliding(self):
        assert disambiguate_slug("foo", set()) == "foo"
        assert disambiguate_slug("foo", {"bar", "baz"}) == "foo"

    def test_appends_numeric_suffix_on_collision(self):
        assert disambiguate_slug("foo", {"foo"}) == "foo-2"

    def test_increments_suffix_until_unique(self):
        assert disambiguate_slug("foo", {"foo", "foo-2", "foo-3"}) == "foo-4"

    def test_trims_base_when_suffix_exceeds_max_len(self):
        slug = "a" * 60
        result = disambiguate_slug(slug, {slug}, max_len=60)
        # Result must be within max_len and end with -2.
        assert len(result) <= 60
        assert result.endswith("-2")

    def test_never_emits_double_hyphen(self):
        # Pathological base ending with hyphen after trim should be rstripped.
        slug = "a" * 58 + "-b"
        result = disambiguate_slug(slug, {slug}, max_len=60)
        assert "--" not in result

    def test_does_not_mutate_existing(self):
        existing = {"foo"}
        disambiguate_slug("foo", existing)
        assert existing == {"foo"}


class TestMigratorSymptomFromIssue:
    """Regression tests mirroring the concrete symptoms reported in #532."""

    def test_checkbox_marker_does_not_leak_as_literal_x(self):
        # From #532 examples: ``[x] Confirm support space/board name ...``
        # used to become ``roadmap-11-x-confirm-...``. After stripping the
        # leading checkbox marker the ``x`` must no longer lead.
        slug = normalize_slug(
            "[x] Confirm support space/board name in deftai/evolution "
            "for ticket thread resolution",
            max_len=60,
        )
        assert not slug.startswith("x-")

    def test_long_title_truncates_cleanly(self):
        # From #532 examples: the historic slug ended mid-word at ``...fo``.
        # Current rules must land on a word boundary.
        slug = normalize_slug(
            "task update-index --repo <id> builds CODEBASE-GRAPH.vbrief.json "
            "and LanceDB index for a real repo",
            max_len=60,
        )
        assert len(slug) <= 60
        assert not slug.endswith("-")
        # The bug used to produce ``...lancedb-index-fo`` or ``...for-ticket-thr``.
        # Neither fragment should appear as a trailing token.
        last_token = slug.rsplit("-", 1)[-1]
        assert last_token not in ("fo", "thr")

    def test_repeated_runs_are_deterministic(self):
        title = "Support é/ñ/日本"
        assert normalize_slug(title) == normalize_slug(title)
