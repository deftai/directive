"""tests/test_scm_stub.py -- unit tests for scripts/scm.py (#883 Story 1).

Covers AC-4 (unit tests) and AC-6 (JSON-shape contract test) from
``vbrief/active/2026-05-05-883-story-1-scm-stub.vbrief.json``.

Two test surfaces in one file (per AC-6 "or extension to tests/test_scm_stub.py"):

1. Unit tests on the wrapper (``TestBuildCommand``, ``TestResolveBinary``,
   ``TestMain``) -- mock ``shutil.which`` + ``subprocess.run`` and assert
   per-command argv shape, ghx-then-gh fallback, and pass-through of
   downstream flags (``--json``, ``--repo``, etc.).

2. Contract test on the cache:fetch-all consumer shape
   (``TestScmIssueViewContract`` / ``TestScmIssueListContract``) -- pinned
   against ``tests/fixtures/scm_issue_view.json``. Both Story 1 (this test)
   AND Story 2's cache:fetch-all unit tests reference this fixture verbatim;
   the contract pins are the Story 1 -> Story 2 handoff guard against
   integration-time drift.

The fixture lives under ``tests/fixtures/scm_issue_view.json`` so it is
discoverable by both stories without import-path gymnastics. ``scm:issue:list``
returns a list of items each carrying the {number, title, state, updatedAt}
subset; the contract test reuses the single-issue fixture for the list-subset
assertion to avoid duplicating fixture data.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

scm = importlib.import_module("scm")

FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "scm_issue_view.json"


# ---------------------------------------------------------------------------
# build_command argv shape (AC-4)
# ---------------------------------------------------------------------------


class TestBuildCommand:
    """Per-command argv shape: [binary, namespace, verb, *extra]."""

    @pytest.mark.parametrize("verb", ["list", "view", "close", "edit"])
    def test_issue_verbs_emit_canonical_argv(self, verb: str) -> None:
        cmd = scm.build_command("issue", verb, ["--repo", "deftai/directive"], binary="gh")
        assert cmd == ["gh", "issue", verb, "--repo", "deftai/directive"]

    def test_json_flag_forwarded_verbatim(self) -> None:
        # AC-4: --json forwarded. The stub MUST NOT inspect or rewrite the
        # --json flag -- Story 2's cache:fetch-all relies on the underlying
        # gh JSON shape; a stub-side rewrite would break the contract.
        extra = ["883", "--repo", "deftai/directive", "--json", "number,title,body"]
        cmd = scm.build_command("issue", "view", extra, binary="gh")
        assert cmd == [
            "gh", "issue", "view", "883",
            "--repo", "deftai/directive",
            "--json", "number,title,body",
        ]

    def test_extra_args_passed_through_verbatim(self) -> None:
        # An unusual but valid edit invocation: arbitrary flags reach gh
        # untouched (the stub does not rewrite --add-label, --remove-label, etc.).
        extra = ["883", "--add-label", "epic", "--remove-label", "stale", "--body-file", "-"]
        cmd = scm.build_command("issue", "edit", extra, binary="gh")
        assert cmd == ["gh", "issue", "edit", *extra]

    def test_unknown_namespace_rejected_loudly(self) -> None:
        # Typo / future-namespace probe: should fail with the stub's loud
        # error rather than silently dispatching to gh and producing a
        # confusing native error.
        with pytest.raises(scm.ScmStubError, match="unknown scm namespace"):
            scm.build_command("isue", "list", [], binary="gh")

    def test_unknown_issue_verb_rejected_loudly(self) -> None:
        # PR-style verbs ("merge", "review") and typos must not silently
        # dispatch -- they belong on #881, not the v1 stub.
        with pytest.raises(scm.ScmStubError, match="unknown scm:issue verb"):
            scm.build_command("issue", "merge", [], binary="gh")

    def test_binary_override_used_when_provided(self) -> None:
        # The binary= kwarg lets tests parametrise without depending on PATH.
        cmd = scm.build_command("issue", "list", [], binary="ghx")
        assert cmd[0] == "ghx"


# ---------------------------------------------------------------------------
# resolve_binary fallback ladder (AC-4: ghx-then-gh)
# ---------------------------------------------------------------------------


class TestResolveBinary:
    """ghx preferred when on PATH; gh fallback when ghx absent; loud failure when neither."""

    def test_ghx_preferred_when_on_path(self) -> None:
        # ``shutil.which`` returns a non-None value for ghx -> resolve_binary
        # picks ghx without consulting gh. The order is fixed by
        # _BINARY_PREFERENCE so a future re-order is caught here.
        def _which_ghx_only(name: str) -> str | None:
            return f"/usr/local/bin/{name}" if name == "ghx" else None

        with mock.patch.object(scm.shutil, "which", side_effect=_which_ghx_only):
            assert scm.resolve_binary() == "ghx"

    def test_gh_fallback_when_ghx_absent(self) -> None:
        # Mirror image: ghx missing, gh present -> fallback to gh. This is
        # the canonical machine state on hosts where the operator hasn't
        # installed the #884 ghx proxy yet.
        def _which_gh_only(name: str) -> str | None:
            return f"/usr/local/bin/{name}" if name == "gh" else None

        with mock.patch.object(scm.shutil, "which", side_effect=_which_gh_only):
            assert scm.resolve_binary() == "gh"

    def test_neither_binary_raises(self) -> None:
        # On a host with neither binary, the stub fails loudly so the
        # operator gets actionable installation guidance rather than a
        # silent FileNotFoundError mid-pipeline.
        with (
            mock.patch.object(scm.shutil, "which", return_value=None),
            pytest.raises(scm.ScmStubError, match="neither 'ghx' nor 'gh'"),
        ):
            scm.resolve_binary()

    def test_preference_order_pinned(self) -> None:
        # If both are present, ghx wins -- the #884 proxy is the documented
        # standard and a regression that flipped the order would be invisible
        # without this assertion (both binaries succeed for the v1 stub's
        # surface).
        with mock.patch.object(scm.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"):
            assert scm.resolve_binary() == "ghx"


# ---------------------------------------------------------------------------
# main() entry point (AC-4: argv plumbing + exit-code forwarding)
# ---------------------------------------------------------------------------


class TestMain:
    """End-to-end argv -> subprocess.run dispatch."""

    def test_main_dispatches_with_expected_argv(self) -> None:
        # Mock subprocess.run so we can capture the exact argv the wrapper
        # would have run, then assert the [binary, namespace, verb, *extra]
        # shape matches AC-1.
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], check: bool = False, **kwargs: object) -> object:
            captured["cmd"] = cmd
            captured["check"] = check
            return mock.Mock(returncode=0)

        # `which` mock returns a path for `gh` only -- ghx absent forces the
        # fallback ladder to land on gh, mirroring the host most operators have.
        def _which_gh_only(name: str) -> str | None:
            return "/usr/local/bin/gh" if name == "gh" else None

        with mock.patch.object(scm.shutil, "which", side_effect=_which_gh_only), \
             mock.patch.object(scm.subprocess, "run", side_effect=fake_run):
            rc = scm.main([
                "issue", "view", "883",
                "--repo", "deftai/directive",
                "--json", "number,title",
            ])

        assert rc == 0
        assert captured["cmd"] == [
            "gh", "issue", "view", "883",
            "--repo", "deftai/directive",
            "--json", "number,title",
        ]
        # AC-4: subprocess.run must be invoked with check=False so the
        # underlying exit code is forwarded rather than raised.
        assert captured["check"] is False

    def test_main_forwards_exit_code(self) -> None:
        # Non-zero exit from gh (e.g. issue not found) MUST surface to the
        # caller untouched -- Story 2 cache:fetch-all relies on accurate
        # error propagation to discriminate transient vs hard failures.
        def _which_gh_only(name: str) -> str | None:
            return "/usr/local/bin/gh" if name == "gh" else None

        with mock.patch.object(scm.shutil, "which", side_effect=_which_gh_only), \
             mock.patch.object(scm.subprocess, "run", return_value=mock.Mock(returncode=1)):
            assert scm.main([
                "issue", "view", "999999", "--repo", "deftai/directive",
            ]) == 1

    def test_main_argv_too_short_returns_2(self, capsys: pytest.CaptureFixture[str]) -> None:
        rc = scm.main([])
        assert rc == 2
        assert "usage:" in capsys.readouterr().err

    def test_main_unknown_namespace_returns_2(self, capsys: pytest.CaptureFixture[str]) -> None:
        rc = scm.main(["isue", "list"])
        assert rc == 2
        assert "unknown scm namespace" in capsys.readouterr().err

    def test_main_uses_ghx_when_available(self) -> None:
        # AC-4: ghx-then-gh fallback verified end-to-end via main(). When
        # ghx is on PATH, the dispatched argv MUST start with ghx.
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], check: bool = False, **kwargs: object) -> object:
            captured["cmd"] = cmd
            return mock.Mock(returncode=0)

        def _which_ghx_only(name: str) -> str | None:
            return f"/usr/local/bin/{name}" if name == "ghx" else None

        with mock.patch.object(scm.shutil, "which", side_effect=_which_ghx_only), \
             mock.patch.object(scm.subprocess, "run", side_effect=fake_run):
            scm.main(["issue", "list", "--repo", "deftai/directive"])

        assert captured["cmd"][0] == "ghx"


# ---------------------------------------------------------------------------
# JSON-shape contract (AC-6) -- Story 1 -> Story 2 handoff guard
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def fixture_data() -> dict[str, object]:
    """Load the canonical scm:issue:view fixture exactly once per session.

    The fixture is the contract artifact between Story 1 (produces the wrapper
    + the fixture) and Story 2 (consumes the fixture verbatim from its own
    cache:fetch-all unit tests). Mutating fields here without coordinating
    with Story 2 is a contract break.
    """
    assert FIXTURE_PATH.exists(), (
        f"contract fixture missing at {FIXTURE_PATH}; the AC-6 handoff guard "
        "between Story 1 (#883) and Story 2 cannot run"
    )
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


class TestScmIssueViewContract:
    """Pin the {number, title, body, state, author, createdAt, updatedAt, labels, comments} shape.

    These are the keys Story 2's ``cache:fetch-all`` consumes from
    ``scm:issue:view --json ...``. Adding a key to this set without updating
    the fixture is fine; removing or renaming a key is a Story 1 -> Story 2
    contract break and MUST fail this test.
    """

    REQUIRED_VIEW_KEYS_AND_TYPES: tuple[tuple[str, type | tuple[type, ...]], ...] = (
        ("number", int),
        ("title", str),
        ("body", str),
        ("state", str),
        ("author", dict),
        ("createdAt", str),
        ("updatedAt", str),
        ("labels", list),
        ("comments", list),
    )

    @pytest.mark.parametrize("key,expected_type", REQUIRED_VIEW_KEYS_AND_TYPES)
    def test_required_view_key_present_with_correct_type(
        self, fixture_data: dict[str, object], key: str, expected_type: type
    ) -> None:
        assert key in fixture_data, (
            f"contract violation: scm:issue:view --json must emit key {key!r}; "
            "Story 2 cache:fetch-all parses this verbatim"
        )
        assert isinstance(fixture_data[key], expected_type), (
            f"contract violation: scm:issue:view {key!r} expected {expected_type.__name__}, "
            f"got {type(fixture_data[key]).__name__}"
        )

    def test_author_is_object_with_login(self, fixture_data: dict[str, object]) -> None:
        # The author field is gh's user-object shape, not a bare string.
        # Story 2 reads author.login for the audit log; pinning the nested
        # shape here prevents a regression that flattened it to a string.
        author = fixture_data["author"]
        assert isinstance(author, dict)
        assert "login" in author
        assert isinstance(author["login"], str) and author["login"]

    def test_labels_are_objects_with_name(self, fixture_data: dict[str, object]) -> None:
        # gh emits labels as [{"name": "...", "color": "...", ...}], NOT as
        # bare strings. Story 2 reads label.name for filter logic; the test
        # asserts the nested shape so a regression to ["epic", "cache"]
        # would fail here.
        labels = fixture_data["labels"]
        assert isinstance(labels, list)
        assert labels, "labels list must not be empty in the fixture (need a real-shape sample)"
        for entry in labels:
            assert isinstance(entry, dict)
            assert isinstance(entry.get("name"), str) and entry["name"]

    def test_comments_carry_body_and_author(self, fixture_data: dict[str, object]) -> None:
        # Comment shape pin: each comment is an object with at least
        # body (str) + author (dict with login). Story 2's cache layer
        # may surface comment bodies through the quarantine scanner;
        # the nested shape is part of the contract.
        comments = fixture_data["comments"]
        assert isinstance(comments, list)
        assert comments, "comments list must contain at least one sample"
        for entry in comments:
            assert isinstance(entry, dict)
            assert isinstance(entry.get("body"), str)
            assert isinstance(entry.get("author"), dict)
            assert isinstance(entry["author"].get("login"), str) and entry["author"]["login"]


class TestScmIssueListContract:
    """Pin the {number, title, state, updatedAt} subset for ``scm:issue:list``.

    ``gh issue list --json number,title,state,updatedAt`` returns a list
    where each item carries this subset. Story 2's cache:fetch-all calls
    list FIRST to enumerate candidates, then view per-issue to populate
    the cache; the list-subset is the discovery contract.
    """

    REQUIRED_LIST_KEYS_AND_TYPES: tuple[tuple[str, type], ...] = (
        ("number", int),
        ("title", str),
        ("state", str),
        ("updatedAt", str),
    )

    @pytest.mark.parametrize("key,expected_type", REQUIRED_LIST_KEYS_AND_TYPES)
    def test_list_subset_keys_satisfied_by_view_fixture(
        self, fixture_data: dict[str, object], key: str, expected_type: type
    ) -> None:
        # The list-shape contract is a strict subset of the view-shape
        # contract -- if the view fixture carries (number, title, state,
        # updatedAt) at the right types, the list contract is satisfied.
        # Reusing the single fixture avoids duplicating sample data
        # between view + list and keeps the Story 1 -> Story 2 handoff
        # to one canonical artifact.
        assert key in fixture_data, (
            f"contract violation: scm:issue:list --json must emit key {key!r}"
        )
        assert isinstance(fixture_data[key], expected_type), (
            f"contract violation: scm:issue:list {key!r} expected {expected_type.__name__}, "
            f"got {type(fixture_data[key]).__name__}"
        )

    def test_fixture_is_valid_json(self) -> None:
        # Defensive: regardless of fixture content, the file MUST parse as
        # JSON. A trailing-comma typo would otherwise show up as a confusing
        # KeyError in unrelated tests; this asserts the parse error early
        # with a clear message.
        try:
            json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            pytest.fail(f"fixture {FIXTURE_PATH} failed to parse: {exc}")
