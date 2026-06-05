"""test_resolve_changelog_unreleased.py -- union-merge CHANGELOG conflicts (#911).

Coverage (per the #911 vBRIEF acceptance criteria):

- HEAD-only existing entries: no branch entry, conflict resolves to HEAD-only.
- Branch-only new entry: no HEAD entry, conflict resolves to branch-only.
- Both sides have entries: union of HEAD + branch, branch prepended.
- Branch entry already in HEAD by ``(#NNN)``: deduplicated, branch dropped.
- Multi-section conflict (Added + Fixed simultaneously inside one block):
  each subsection union-merged independently.
- Corrupted markers (mismatched / missing / nested): exit 1.
- No markers: exit 0 no-op (file unchanged byte-for-byte).
- Atomic-write integrity: file content matches the in-memory render exactly.
- Non-ASCII content round-trip: em dashes, arrows, smart quotes survive a
  resolve cycle (regression for #798's recurrence chain).
- ``--dry-run`` does not modify the file.
- Conflicts outside [Unreleased] -> exit 1.
- Path errors -> exit 2.

#1003 follow-up coverage (truncated orphan-header dedup gap):

- Orphan-header detection (``is_orphan_header``) and content-prefix
  normalization (``content_prefix``) unit coverage.
- Orphan stubs on the HEAD side, the branch side, and BOTH sides collapse
  instead of accumulating; a stderr WARN is emitted on every drop.
- Content-prefix dedup fallback collapses issue-numberless duplicates.
- A four-rebase cascade synthetic and a v0.26.2-shaped fixture assert the
  truncated ``gh_rest.py`` stubs collapse to a single canonical entry.

Story: #911 (base) + #1003 (orphan-stub follow-up). Pure stdlib; tests use
``tmp_path`` for isolation.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "resolve_changelog_unreleased",
        scripts_dir / "resolve_changelog_unreleased.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["resolve_changelog_unreleased"] = module
    spec.loader.exec_module(module)
    return module


resolver = _load_module()


# ---------------------------------------------------------------------------
# resolve_changelog -- pure-function branch coverage
# ---------------------------------------------------------------------------


CHANGELOG_HEADER = (
    "# Changelog\n"
    "\n"
    "All notable changes to this project will be documented in this file.\n"
    "\n"
)


def _build_changelog(unreleased_body: str, *, tail: str = "") -> str:
    """Helper: assemble a CHANGELOG with the given Unreleased body."""
    return (
        CHANGELOG_HEADER
        + "## [Unreleased]\n\n"
        + unreleased_body
        + ("\n" if not unreleased_body.endswith("\n") else "")
        + tail
    )


class TestNoMarkers:
    def test_no_unreleased_no_markers_is_noop(self):
        content = "# Changelog\n\nNo unreleased section here.\n"
        new, msg = resolver.resolve_changelog(content)
        assert new == content
        assert "no-op" in msg

    def test_unreleased_without_conflict_is_noop(self):
        content = _build_changelog(
            "### Added\n- existing entry (#100)\n\n### Fixed\n- another (#200)\n"
        )
        new, msg = resolver.resolve_changelog(content)
        assert new == content
        assert "no-op" in msg


class TestHeadOnlyEntries:
    def test_head_has_entries_branch_empty(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- entry from master (#100)\n"
            "- second entry from master (#101)\n"
            "=======\n"
            ">>>>>>> abc1234\n"
            "\n"
            "### Fixed\n"
            "- existing fixed entry (#50)\n"
        )
        content = _build_changelog(body)
        new, msg = resolver.resolve_changelog(content)
        assert new is not None
        assert "<<<<<<<" not in new
        assert "=======" not in new
        assert ">>>>>>>" not in new
        assert "entry from master (#100)" in new
        assert "second entry from master (#101)" in new
        assert "existing fixed entry (#50)" in new
        assert "resolved" in msg


class TestBranchOnlyEntry:
    def test_branch_new_entry_head_empty(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "=======\n"
            "- new entry from branch (#911)\n"
            ">>>>>>> deadbeef\n"
            "\n"
            "### Fixed\n"
            "- existing (#50)\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        assert "new entry from branch (#911)" in new
        assert "<<<<<<<" not in new


class TestBothSidesHaveEntries:
    def test_union_branch_prepended_above_head(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master entry (#100)\n"
            "- earlier master entry (#99)\n"
            "=======\n"
            "- branch entry (#911)\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        # Branch entry must be prepended -- appear before master entry.
        assert new.index("branch entry (#911)") < new.index("master entry (#100)")
        # All three entries present.
        assert "branch entry (#911)" in new
        assert "master entry (#100)" in new
        assert "earlier master entry (#99)" in new


class TestDedupByIssueNumber:
    def test_branch_entry_already_in_head_dropped(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- canonical entry for issue 911 (#911)\n"
            "=======\n"
            "- duplicate branch entry for issue 911 (#911)\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        assert "canonical entry for issue 911" in new
        assert "duplicate branch entry for issue 911" not in new

    def test_no_issue_number_branch_entry_always_prepended(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master entry (#100)\n"
            "=======\n"
            "- branch entry without issue number\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        assert "branch entry without issue number" in new
        assert "master entry (#100)" in new


class TestMultiSectionConflict:
    def test_added_and_fixed_simultaneously(self):
        body = (
            "<<<<<<< HEAD\n"
            "### Added\n"
            "- master added (#100)\n"
            "\n"
            "### Fixed\n"
            "- master fixed (#200)\n"
            "=======\n"
            "### Added\n"
            "- branch added (#911)\n"
            "\n"
            "### Fixed\n"
            "- branch fixed (#912)\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        assert "master added (#100)" in new
        assert "branch added (#911)" in new
        assert "master fixed (#200)" in new
        assert "branch fixed (#912)" in new
        # Branch entries prepended in their respective subsections.
        assert new.index("branch added (#911)") < new.index("master added (#100)")
        assert new.index("branch fixed (#912)") < new.index("master fixed (#200)")


class TestCorruptedMarkers:
    def test_missing_separator_returns_unresolvable(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- entry\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, msg = resolver.resolve_changelog(content)
        assert new is None
        assert "unresolvable" in msg

    def test_missing_tail_returns_unresolvable(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- entry\n"
            "=======\n"
            "- branch\n"
        )
        content = _build_changelog(body)
        new, msg = resolver.resolve_changelog(content)
        assert new is None
        assert "unresolvable" in msg

    def test_orphan_separator_returns_unresolvable(self):
        body = (
            "### Added\n"
            "- entry one\n"
            "=======\n"
            "- entry two\n"
        )
        content = _build_changelog(body)
        new, msg = resolver.resolve_changelog(content)
        assert new is None
        assert "unresolvable" in msg

    def test_nested_head_marker_returns_unresolvable(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "<<<<<<< HEAD\n"
            "- inner\n"
            "=======\n"
            "- branch\n"
            ">>>>>>> sha2\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, msg = resolver.resolve_changelog(content)
        assert new is None
        assert "unresolvable" in msg


class TestConflictsOutsideUnreleased:
    def test_marker_in_released_section_returns_unresolvable(self):
        content = (
            CHANGELOG_HEADER
            + "## [Unreleased]\n\n"
            + "### Added\n- clean unreleased entry (#100)\n\n"
            + "## [0.26.0] - 2026-05-06\n\n"
            + "### Fixed\n"
            + "<<<<<<< HEAD\n"
            + "- a (#1)\n"
            + "=======\n"
            + "- b (#2)\n"
            + ">>>>>>> sha\n"
        )
        new, msg = resolver.resolve_changelog(content)
        assert new is None
        assert "unresolvable" in msg
        assert "outside" in msg.lower()


class TestAtomicWrite:
    def test_round_trip_preserves_byte_content(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master (#100)\n"
            "=======\n"
            "- branch (#911)\n"
            ">>>>>>> sha\n"
        )
        content = _build_changelog(body)
        path.write_text(content, encoding="utf-8")
        rc = resolver.main(["--changelog-path", str(path)])
        assert rc == 0
        # File rewritten in place; byte content must equal the resolved content.
        on_disk = path.read_text(encoding="utf-8")
        assert "<<<<<<<" not in on_disk
        assert "branch (#911)" in on_disk
        assert "master (#100)" in on_disk

    def test_dry_run_does_not_modify_file(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master (#100)\n"
            "=======\n"
            "- branch (#911)\n"
            ">>>>>>> sha\n"
        )
        content = _build_changelog(body)
        path.write_text(content, encoding="utf-8")
        rc = resolver.main(["--changelog-path", str(path), "--dry-run"])
        assert rc == 0
        # File unchanged on disk.
        on_disk = path.read_text(encoding="utf-8")
        assert "<<<<<<<" in on_disk
        assert on_disk == content


class TestNonAsciiContent:
    """Regression for #798: em dashes / arrows / smart quotes survive resolve."""

    def test_em_dash_arrow_round_trip(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        # Non-ASCII glyphs in BOTH sides of the conflict and in the surrounding
        # body. The atomic-write path MUST preserve every codepoint.
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master entry — uses em dash and → arrow (#100)\n"
            "=======\n"
            "- branch entry — uses smart quotes \u201chello\u201d and ellipsis \u2026 (#911)\n"
            ">>>>>>> sha\n"
        )
        content = _build_changelog(body)
        path.write_text(content, encoding="utf-8")
        rc = resolver.main(["--changelog-path", str(path)])
        assert rc == 0
        on_disk = path.read_text(encoding="utf-8")
        assert "—" in on_disk
        assert "→" in on_disk
        assert "\u201chello\u201d" in on_disk
        assert "\u2026" in on_disk
        # Ensure NO U+FFFD replacement chars leaked in.
        assert "\ufffd" not in on_disk

    def test_pure_function_preserves_non_ascii(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- α master β (#100)\n"
            "=======\n"
            "- γ branch δ (#911)\n"
            ">>>>>>> sha\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        assert "α master β" in new
        assert "γ branch δ" in new


# ---------------------------------------------------------------------------
# main() exit codes
# ---------------------------------------------------------------------------


class TestMainExitCodes:
    def test_resolved_exits_zero(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- a (#1)\n"
            "=======\n"
            "- b (#2)\n"
            ">>>>>>> sha\n"
        )
        path.write_text(_build_changelog(body), encoding="utf-8")
        assert resolver.main(["--changelog-path", str(path)]) == 0

    def test_no_op_exits_zero(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        path.write_text(
            _build_changelog("### Added\n- clean (#100)\n"), encoding="utf-8"
        )
        assert resolver.main(["--changelog-path", str(path)]) == 0

    def test_corrupted_exits_one(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        body = "### Added\n<<<<<<< HEAD\n- a\n>>>>>>> sha\n"
        path.write_text(_build_changelog(body), encoding="utf-8")
        assert resolver.main(["--changelog-path", str(path)]) == 1

    def test_missing_path_exits_two(self, tmp_path):
        missing = tmp_path / "does-not-exist.md"
        assert resolver.main(["--changelog-path", str(missing)]) == 2

    def test_directory_path_exits_two(self, tmp_path):
        # Pass a directory, not a file -> config error.
        rc = resolver.main(["--changelog-path", str(tmp_path)])
        assert rc == 2

    def test_unresolvable_prefix_not_doubled_in_stderr(self, tmp_path, capsys):
        """Greptile P2 (PR #999): the inner message from ``resolve_changelog``
        already carries the ``unresolvable:`` prefix; ``evaluate()`` must NOT
        re-prefix or operators see ``unresolvable: unresolvable: ...`` on
        stderr for every exit-1 path.
        """
        path = tmp_path / "CHANGELOG.md"
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- entry\n"
            ">>>>>>> sha\n"
        )
        path.write_text(_build_changelog(body), encoding="utf-8")
        rc = resolver.main(["--changelog-path", str(path)])
        assert rc == 1
        err = capsys.readouterr().err
        # The diagnostic carries exactly ONE ``unresolvable:`` prefix.
        assert err.count("unresolvable:") == 1, (
            f"prefix doubled in stderr: {err!r}"
        )


# ---------------------------------------------------------------------------
# Internal helpers -- finer-grained coverage
# ---------------------------------------------------------------------------


class TestParseSide:
    def test_entries_attached_to_ambient(self):
        sections = resolver.parse_side(
            ["- one (#1)", "- two (#2)"], ambient_subsection="Added"
        )
        assert sections == [("Added", ["- one (#1)", "- two (#2)"])]

    def test_subsection_header_starts_new_section(self):
        sections = resolver.parse_side(
            ["- ambient (#1)", "### Fixed", "- fix one (#2)"],
            ambient_subsection="Added",
        )
        assert sections == [
            ("Added", ["- ambient (#1)"]),
            ("Fixed", ["- fix one (#2)"]),
        ]

    def test_blank_line_ends_entry(self):
        sections = resolver.parse_side(
            ["- one (#1)", "", "- two (#2)"], ambient_subsection="Added"
        )
        assert sections == [("Added", ["- one (#1)", "- two (#2)"])]

    def test_indented_continuation_kept(self):
        sections = resolver.parse_side(
            ["- entry (#1)", "  continuation line"],
            ambient_subsection="Added",
        )
        assert sections == [
            ("Added", ["- entry (#1)\n  continuation line"]),
        ]


class TestUnionMerge:
    def test_dedup_by_issue_number(self):
        head = [("Added", ["- e (#1)"])]
        branch = [("Added", ["- duplicate (#1)"])]
        merged = resolver.union_merge(head, branch)
        assert merged == [("Added", ["- e (#1)"])]

    def test_branch_subsection_only_appended(self):
        head = [("Added", ["- e (#1)"])]
        branch = [("Fixed", ["- fix (#2)"])]
        merged = resolver.union_merge(head, branch)
        assert merged == [
            ("Added", ["- e (#1)"]),
            ("Fixed", ["- fix (#2)"]),
        ]

    def test_branch_entries_prepended(self):
        head = [("Added", ["- master (#1)"])]
        branch = [("Added", ["- branch (#2)"])]
        merged = resolver.union_merge(head, branch)
        assert merged == [("Added", ["- branch (#2)", "- master (#1)"])]


class TestIssueNumbers:
    def test_extracts_all_parenthesized(self):
        # Per the #911 contract the heuristic is strict ``(#NNN)`` -- only
        # explicitly parenthesized issue references count toward dedup.
        assert resolver.issue_numbers("- entry (#100) text (#200) end (#300)") == {
            "100",
            "200",
            "300",
        }

    def test_unparenthesized_reference_ignored(self):
        # Bare ``#NNN`` (e.g. ``Closes #911`` in commit messages) is NOT a
        # CHANGELOG-style closing reference; the heuristic intentionally skips
        # it so commit-message close-tokens do not pollute the dedup set.
        assert resolver.issue_numbers("- entry referencing #100 inline") == set()

    def test_no_issue_returns_empty(self):
        assert resolver.issue_numbers("- entry without issue") == set()


# ---------------------------------------------------------------------------
# #1003 -- truncated orphan-header dedup gap
# ---------------------------------------------------------------------------


#: The truncated orphan header shape that shipped twice in v0.26.2: an
#: entry-start that opens a bold span but never closes it and carries no
#: ``(#NNN)`` reference. It is a strict text prefix of ``VALID_GH_REST``.
ORPHAN_STUB = "- **feat(scripts): `gh_rest.py` REST-fallback helpers"

#: The canonical, well-formed entry the orphan stubs partially duplicate
#: (released line 30 of the v0.26.2 CHANGELOG).
VALID_GH_REST = (
    "- **feat(scripts): `gh_rest.py` REST-fallback helpers for "
    "`gh` mutations and reads (#961)** -- REST helpers for gh."
)


class TestOrphanHeaderDetection:
    def test_truncated_header_is_orphan(self):
        assert resolver.is_orphan_header(ORPHAN_STUB) is True

    def test_full_entry_with_close_and_issue_is_not_orphan(self):
        assert resolver.is_orphan_header(VALID_GH_REST) is False

    def test_closed_bold_without_issue_is_not_orphan(self):
        # A closing ``**`` means the header is not truncated, even with no
        # ``(#NNN)`` -- such an entry is handled by the content-prefix path.
        assert (
            resolver.is_orphan_header("- **feat: shipped a thing** -- did it")
            is False
        )

    def test_plain_bullet_without_bold_is_not_orphan(self):
        assert resolver.is_orphan_header("- plain entry without bold") is False

    def test_open_bold_with_issue_is_not_orphan(self):
        # An issue number is a valid dedup key, so an unclosed bold span that
        # still carries ``(#NNN)`` is NOT treated as an orphan.
        assert resolver.is_orphan_header("- **feat: thing (#42)") is False

    def test_content_prefix_strips_bullet_bold_and_issue_ref(self):
        # The ``(#5)`` token is stripped so a cross-parity duplicate (HEAD with
        # the ref, branch without) still shares a prefix.
        assert (
            resolver.content_prefix("- **feat: cool thing** -- body (#5)")
            == "feat: cool thing -- body"
        )

    def test_content_prefix_collapses_whitespace_and_lowercases(self):
        assert (
            resolver.content_prefix("-   **FEAT:   Spaced   Out**")
            == "feat: spaced out"
        )


class TestOrphanStubDedup:
    def test_orphan_on_head_side_dropped(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            + ORPHAN_STUB + "\n"
            + VALID_GH_REST + "\n"
            "=======\n"
            "- branch new entry (#999)\n"
            ">>>>>>> sha\n"
        )
        new, _ = resolver.resolve_changelog(_build_changelog(body))
        assert new is not None
        lines = new.split("\n")
        # The standalone truncated header line is gone ...
        assert ORPHAN_STUB not in lines
        # ... but the canonical full entry and the branch entry survive.
        assert VALID_GH_REST in lines
        assert "- branch new entry (#999)" in new
        # The truncated prefix now appears only inside the full entry.
        assert new.count(ORPHAN_STUB) == 1

    def test_orphan_on_branch_side_dropped(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            + VALID_GH_REST + "\n"
            "=======\n"
            + ORPHAN_STUB + "\n"
            ">>>>>>> sha\n"
        )
        new, _ = resolver.resolve_changelog(_build_changelog(body))
        assert new is not None
        assert ORPHAN_STUB not in new.split("\n")
        assert VALID_GH_REST in new.split("\n")
        assert new.count(ORPHAN_STUB) == 1

    def test_orphan_on_both_sides_collapse_to_single_header(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            + ORPHAN_STUB + "\n"
            + VALID_GH_REST + "\n"
            "=======\n"
            + ORPHAN_STUB + "\n"
            ">>>>>>> sha\n"
        )
        new, _ = resolver.resolve_changelog(_build_changelog(body))
        assert new is not None
        # At most one occurrence of the header prefix remains.
        assert new.count(ORPHAN_STUB) == 1
        assert ORPHAN_STUB not in new.split("\n")
        assert VALID_GH_REST in new.split("\n")

    def test_orphan_drop_emits_stderr_warning(self, capsys):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            + ORPHAN_STUB + "\n"
            + VALID_GH_REST + "\n"
            "=======\n"
            ">>>>>>> sha\n"
        )
        new, _ = resolver.resolve_changelog(_build_changelog(body))
        assert new is not None
        err = capsys.readouterr().err
        assert "WARN" in err
        assert "orphan" in err.lower()

    def test_clean_resolve_emits_no_warning(self, capsys):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master (#100)\n"
            "=======\n"
            "- branch (#911)\n"
            ">>>>>>> sha\n"
        )
        new, _ = resolver.resolve_changelog(_build_changelog(body))
        assert new is not None
        assert "WARN" not in capsys.readouterr().err


class TestContentPrefixFallback:
    def test_issue_numberless_duplicate_collapsed(self):
        entry = "- **chore: tidy up the build pipeline** -- housekeeping"
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            + entry + "\n"
            "=======\n"
            + entry + "\n"
            ">>>>>>> sha\n"
        )
        new, _ = resolver.resolve_changelog(_build_changelog(body))
        assert new is not None
        # The duplicate issue-numberless entry collapses to a single copy.
        assert new.count(entry) == 1

    def test_distinct_issue_numberless_entries_both_kept(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- **chore: alpha task** -- first\n"
            "=======\n"
            "- **chore: beta task** -- second\n"
            ">>>>>>> sha\n"
        )
        new, _ = resolver.resolve_changelog(_build_changelog(body))
        assert new is not None
        assert "alpha task" in new
        assert "beta task" in new

    def test_cross_parity_duplicate_collapsed(self):
        # HEAD carries the issue ref; the branch re-adds the same entry without
        # it. Stripping ``(#NNN)`` from the prefix lets the numberless branch
        # near-duplicate collapse against the HEAD entry (Greptile P2 / AC-2).
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- **chore: tidy build** -- cleanup (#123)\n"
            "=======\n"
            "- **chore: tidy build** -- cleanup\n"
            ">>>>>>> sha\n"
        )
        new, _ = resolver.resolve_changelog(_build_changelog(body))
        assert new is not None
        assert new.count("chore: tidy build") == 1


class TestUnionMergeOrphanAndPrefix:
    def test_orphan_dropped_from_head_with_warning(self):
        head = [("Added", [ORPHAN_STUB, VALID_GH_REST])]
        warnings: list[str] = []
        merged = resolver.union_merge(head, [], warnings=warnings)
        assert merged == [("Added", [VALID_GH_REST])]
        assert len(warnings) == 1
        assert "HEAD" in warnings[0]

    def test_orphan_dropped_from_branch_with_warning(self):
        head = [("Added", [VALID_GH_REST])]
        branch = [("Added", [ORPHAN_STUB])]
        warnings: list[str] = []
        merged = resolver.union_merge(head, branch, warnings=warnings)
        assert merged == [("Added", [VALID_GH_REST])]
        assert len(warnings) == 1
        assert "branch" in warnings[0]

    def test_content_prefix_dedup_in_union_merge(self):
        entry = "- **chore: same** -- body"
        merged = resolver.union_merge([("Added", [entry])], [("Added", [entry])])
        assert merged == [("Added", [entry])]

    def test_warnings_optional_when_not_supplied(self):
        # No ``warnings`` kwarg -> orphans still dropped, no crash.
        merged = resolver.union_merge([("Added", [ORPHAN_STUB])], [])
        assert merged == [("Added", [])]


class TestCascadingRebaseSynthetic:
    @staticmethod
    def _extract_added_block(changelog: str) -> str:
        """Return the body of the resolved ``### Added`` subsection."""
        out: list[str] = []
        in_added = False
        for ln in changelog.split("\n"):
            if ln.strip() == "### Added":
                in_added = True
                continue
            if in_added:
                if ln.startswith(("## ", "### ")):
                    break
                out.append(ln)
        block = "\n".join(out).strip("\n")
        return block + "\n" if block else ""

    def test_four_rebase_cascade_collapses_orphans(self):
        # Round 0 master state: just the canonical full entry.
        head_block = VALID_GH_REST + "\n"
        for _ in range(4):
            # Each rebase re-introduces a truncated orphan stub on the branch.
            body = (
                "### Added\n"
                "<<<<<<< HEAD\n"
                + head_block
                + "=======\n"
                + ORPHAN_STUB + "\n"
                + ">>>>>>> sha\n"
            )
            new, _ = resolver.resolve_changelog(_build_changelog(body))
            assert new is not None
            # Orphans never accumulate: no standalone stub line, and the
            # prefix appears only inside the single canonical entry.
            assert ORPHAN_STUB not in new.split("\n")
            assert new.count(ORPHAN_STUB) == 1
            head_block = self._extract_added_block(new)
        # After the cascade the resolved Added block holds exactly one entry.
        assert head_block.strip() == VALID_GH_REST


class TestV0262PublishedFixture:
    def test_v0262_orphan_stubs_collapse(self):
        # Mirrors the v0.26.2 published shape: two truncated gh_rest.py stubs
        # (released lines 26 and 28) interleaved with valid entries plus the
        # canonical full entry (line 30), wrapped in a conflict so the helper
        # processes the section (AC-4).
        head_block = (
            ORPHAN_STUB + "\n"  # line-26 orphan
            "- **perf(tests,tasks): mark watchdog tests slow (#975)** -- slow.\n"
            + ORPHAN_STUB + "\n"  # line-28 orphan
            "- **feat(scripts): CHANGELOG union-merge helper (#911)** -- helper.\n"
            + VALID_GH_REST + "\n"  # line-30 canonical full entry
        )
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            + head_block
            + "=======\n"
            "- **feat(scripts): rebasing branch entry (#1001)** -- new work.\n"
            ">>>>>>> sha\n"
        )
        new, _ = resolver.resolve_changelog(_build_changelog(body))
        assert new is not None
        # Both truncated stubs collapse: no standalone orphan line remains.
        assert ORPHAN_STUB not in new.split("\n")
        # The prefix survives only inside the single canonical full entry.
        assert new.count(ORPHAN_STUB) == 1
        # Every valid entry is preserved.
        for ref in ("(#975)", "(#911)", "(#961)", "(#1001)"):
            assert ref in new
