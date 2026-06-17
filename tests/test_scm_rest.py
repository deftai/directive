"""tests/test_scm_rest.py -- unit coverage for scm.py ``--rest`` opt-in (#976).

Test surfaces:

1. ``TestRestFlagExtraction`` -- the small argv parsers (``_extract_flag``,
   ``_extract_value_flag``) that strip ``--rest`` / ``--repo`` / ``--json``
   from the legacy pass-through argv before forwarding.
2. ``TestRestViewDispatch`` -- ``main([\"issue\", \"view\", \"--rest\", \"1\",
   \"--repo\", ...])`` invokes ``gh_rest.rest_issue_view`` and emits the
   filtered JSON to stdout. Mock the helper to keep the test hermetic.
3. ``TestRestListDispatch`` -- ``main([\"issue\", \"list\", \"--rest\",
   \"--repo\", ...])`` invokes ``gh_rest.rest_issue_list`` with the
   parsed flags and emits filtered JSON to stdout.
4. ``TestRestRejectsMutations`` -- ``--rest`` on ``close`` / ``edit``
   exits 2 with a clear error; the v1 stub keeps mutations on gh.
5. ``TestRestFallsBackOnGraphqlExhaustion`` -- the regression test
   required by issue #976. With a fake ``gh`` that exhausts the GraphQL
   bucket (``rate_limit`` -> ``graphql.remaining = 0``) but leaves
   ``core.remaining`` healthy, the ``--rest`` dispatcher MUST succeed
   because it never touches GraphQL. The legacy (no ``--rest``) path
   would fail because gh CLI's ``issue view --json`` routes through
   GraphQL; this test pins the migration's behavioural difference.

Hermetic: tests mock ``gh_rest.rest_issue_view`` /
``gh_rest.rest_issue_list`` (pure function seam) and
``gh_rest._run_gh_api`` (subprocess seam) -- no live network, no live
gh process.

Refs #976, #961, #884, #954.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

scm = importlib.import_module("scm")
gh_rest = importlib.import_module("gh_rest")


# ---------------------------------------------------------------------------
# Argv parser helpers
# ---------------------------------------------------------------------------


class TestRestFlagExtraction:
    """``_extract_flag`` and ``_extract_value_flag`` argv parsers."""

    def test_extract_flag_present(self) -> None:
        present, remainder = scm._extract_flag(
            ["--rest", "1", "--repo", "o/r"], "--rest"
        )
        assert present is True
        assert remainder == ["1", "--repo", "o/r"]

    def test_extract_flag_absent(self) -> None:
        present, remainder = scm._extract_flag(
            ["1", "--repo", "o/r"], "--rest"
        )
        assert present is False
        assert remainder == ["1", "--repo", "o/r"]

    def test_extract_flag_strips_all_occurrences(self) -> None:
        # Defensive: a duplicated flag should not survive the strip --
        # forwarding `--rest` to gh would either be silently ignored or
        # fail loudly; either way we don't want it leaking.
        present, remainder = scm._extract_flag(
            ["--rest", "1", "--rest"], "--rest"
        )
        assert present is True
        assert remainder == ["1"]

    def test_extract_value_flag_space_separated(self) -> None:
        value, remainder = scm._extract_value_flag(
            ["1", "--repo", "deftai/directive", "--json", "number,title"],
            "--repo",
        )
        assert value == "deftai/directive"
        assert remainder == ["1", "--json", "number,title"]

    def test_extract_value_flag_equals_form(self) -> None:
        value, remainder = scm._extract_value_flag(
            ["1", "--repo=deftai/directive", "--json=number"],
            "--repo",
        )
        assert value == "deftai/directive"
        assert remainder == ["1", "--json=number"]

    def test_extract_value_flag_default_when_absent(self) -> None:
        value, remainder = scm._extract_value_flag(
            ["1", "--repo", "o/r"], "--state", default="open"
        )
        assert value == "open"
        assert remainder == ["1", "--repo", "o/r"]

    def test_extract_value_flag_first_wins(self) -> None:
        # gh CLI takes the last occurrence; we deliberately take the first
        # to keep the parser dead-simple. Document the difference here so
        # the next reader doesn't expect gh-compatible last-wins semantics.
        value, _ = scm._extract_value_flag(
            ["--state", "open", "--state", "closed"], "--state"
        )
        assert value == "open"


# ---------------------------------------------------------------------------
# scm.main([..., "--rest", ...])
# ---------------------------------------------------------------------------


class TestRestViewDispatch:
    """``main([\"issue\", \"view\", \"--rest\", ...])`` invokes the REST helper."""

    def test_main_rest_view_invokes_helper_and_filters_json(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        captured: dict[str, Any] = {}

        def fake_view(repo: str, n: int) -> dict[str, Any]:
            captured["repo"] = repo
            captured["n"] = n
            # Realistic REST shape: snake_case, lowercase state, user
            # (not author). Story 2 contract uses GraphQL shape; --rest
            # callers see REST shape per the module docstring.
            return {
                "number": n,
                "title": "REST migration smoke",
                "state": "open",
                "user": {"login": "octocat"},
                "labels": [{"name": "epic"}],
            }

        with mock.patch.object(scm.importlib, "import_module") as imp:
            fake_module = SimpleNamespace(
                rest_issue_view=fake_view,
                GhRestError=gh_rest.GhRestError,
            )
            imp.return_value = fake_module
            rc = scm.main([
                "issue", "view", "--rest", "1",
                "--repo", "deftai/directive",
                "--json", "number,title",
            ])
        assert rc == 0
        assert captured == {"repo": "deftai/directive", "n": 1}
        out = capsys.readouterr().out.strip()
        parsed = json.loads(out)
        # --json filters to the requested fields; the rest of the REST
        # response is dropped (mirroring gh's --json semantics).
        assert parsed == {"number": 1, "title": "REST migration smoke"}

    def test_main_rest_view_without_repo_errors(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        rc = scm.main(["issue", "view", "--rest", "1"])
        assert rc == 2
        assert "--repo OWNER/NAME" in capsys.readouterr().err

    def test_main_rest_view_without_positional_errors(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        rc = scm.main([
            "issue", "view", "--rest",
            "--repo", "deftai/directive",
        ])
        assert rc == 2
        assert "exactly one positional issue" in capsys.readouterr().err

    def test_main_rest_view_non_integer_errors(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        rc = scm.main([
            "issue", "view", "--rest", "abc",
            "--repo", "deftai/directive",
        ])
        assert rc == 2
        assert "must be an integer" in capsys.readouterr().err

    def test_main_rest_view_unknown_flag_rejected(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Greptile P2 (#976 review): unknown flags beyond --repo/--json
        # are now rejected loudly. Pre-fix, `--state closed` accidentally
        # passed to `issue view` was silently dropped and the user got
        # an unrelated successful response.
        rc = scm.main([
            "issue", "view", "--rest", "1",
            "--repo", "deftai/directive",
            "--state", "closed",
        ])
        assert rc == 2
        err = capsys.readouterr().err
        assert "does not recognise these flags" in err
        assert "--state" in err

    def test_main_rest_view_helper_error_returns_1(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # GhRestError surfaces as exit-1 with the message on stderr; the
        # smoke / cache caller can distinguish hard failure (1) from
        # arg-validation failure (2) by exit code alone.
        def boom(repo: str, n: int) -> dict[str, Any]:
            raise gh_rest.GhRestError(
                stderr="HTTP 404",
                exit_code=1,
                endpoint=f"repos/{repo}/issues/{n}",
                payload=None,
                hint="check issue number",
            )

        with mock.patch.object(scm.importlib, "import_module") as imp:
            imp.return_value = SimpleNamespace(
                rest_issue_view=boom,
                GhRestError=gh_rest.GhRestError,
                InvalidRepoError=gh_rest.InvalidRepoError,
            )
            rc = scm.main([
                "issue", "view", "--rest", "9999999",
                "--repo", "deftai/directive",
            ])
        assert rc == 1
        assert "HTTP 404" in capsys.readouterr().err

    def test_main_rest_view_invalid_repo_error_returns_2(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Greptile P1 (#998 review at 367748e): InvalidRepoError is a
        # ValueError subclass raised by gh_rest._split_repo when --repo
        # lacks the OWNER/NAME shape. Pre-fix the dispatcher only caught
        # GhRestError so a malformed --repo (e.g. missing the owner
        # prefix) produced an unhandled traceback. The fix is to ALSO
        # catch InvalidRepoError and return exit 2 with a clean error.
        def boom(repo: str, n: int) -> dict[str, Any]:
            raise gh_rest.InvalidRepoError(repo)

        with mock.patch.object(scm.importlib, "import_module") as imp:
            imp.return_value = SimpleNamespace(
                rest_issue_view=boom,
                GhRestError=gh_rest.GhRestError,
                InvalidRepoError=gh_rest.InvalidRepoError,
            )
            rc = scm.main([
                "issue", "view", "--rest", "1",
                "--repo", "directive",  # missing owner prefix
            ])
        assert rc == 2
        assert "invalid --repo value" in capsys.readouterr().err


class TestRestListDispatch:
    """``main([\"issue\", \"list\", \"--rest\", ...])`` invokes the REST helper."""

    def test_main_rest_list_invokes_helper_with_parsed_flags(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        captured: dict[str, Any] = {}

        def fake_list(
            repo: str,
            *,
            state: str = "open",
            labels: tuple[str, ...] = (),
            author: str | None = None,
            per_page: int = 30,
        ) -> list[dict[str, Any]]:
            captured["repo"] = repo
            captured["state"] = state
            captured["labels"] = labels
            captured["per_page"] = per_page
            return [
                {"number": 1, "title": "first", "state": "open"},
                {"number": 2, "title": "second", "state": "open"},
            ]

        with mock.patch.object(scm.importlib, "import_module") as imp:
            imp.return_value = SimpleNamespace(
                rest_issue_list=fake_list,
                GhRestError=gh_rest.GhRestError,
            )
            rc = scm.main([
                "issue", "list", "--rest",
                "--repo", "deftai/directive",
                "--state", "closed",
                "--label", "epic,cache",
                "--limit", "50",
                "--json", "number,title",
            ])
        assert rc == 0
        assert captured == {
            "repo": "deftai/directive",
            "state": "closed",
            "labels": ("epic", "cache"),
            "per_page": 50,
        }
        out = capsys.readouterr().out.strip()
        parsed = json.loads(out)
        assert parsed == [
            {"number": 1, "title": "first"},
            {"number": 2, "title": "second"},
        ]

    def test_main_rest_list_author_only(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # #1055: --author flows through to rest_issue_list(author=...).
        captured: dict[str, Any] = {}

        def fake_list(
            repo: str,
            *,
            state: str = "open",
            labels: tuple[str, ...] = (),
            author: str | None = None,
            per_page: int = 30,
        ) -> list[dict[str, Any]]:
            captured["repo"] = repo
            captured["labels"] = labels
            captured["author"] = author
            return [{"number": 7, "title": "by-octocat", "state": "open"}]

        with mock.patch.object(scm.importlib, "import_module") as imp:
            imp.return_value = SimpleNamespace(
                rest_issue_list=fake_list,
                GhRestError=gh_rest.GhRestError,
            )
            rc = scm.main([
                "issue", "list", "--rest",
                "--repo", "deftai/directive",
                "--author", "octocat",
            ])
        assert rc == 0
        assert captured["author"] == "octocat"
        assert captured["labels"] == ()
        capsys.readouterr()

    def test_main_rest_list_label_and_author_compose(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # #1033 + #1055: --label and --author compose (AND). The scm stub
        # forwards both to the REST helper, which appends both query params.
        captured: dict[str, Any] = {}

        def fake_list(
            repo: str,
            *,
            state: str = "open",
            labels: tuple[str, ...] = (),
            author: str | None = None,
            per_page: int = 30,
        ) -> list[dict[str, Any]]:
            captured["labels"] = labels
            captured["author"] = author
            return []

        with mock.patch.object(scm.importlib, "import_module") as imp:
            imp.return_value = SimpleNamespace(
                rest_issue_list=fake_list,
                GhRestError=gh_rest.GhRestError,
            )
            rc = scm.main([
                "issue", "list", "--rest",
                "--repo", "deftai/directive",
                "--label", "bug",
                "--author", "octocat",
            ])
        assert rc == 0
        assert captured["labels"] == ("bug",)
        assert captured["author"] == "octocat"
        capsys.readouterr()

    def test_main_rest_list_author_defaults_none(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # No --author => helper receives author=None (no filter).
        captured: dict[str, Any] = {}

        def fake_list(
            repo: str,
            *,
            state: str = "open",
            labels: tuple[str, ...] = (),
            author: str | None = None,
            per_page: int = 30,
        ) -> list[dict[str, Any]]:
            captured["author"] = author
            return []

        with mock.patch.object(scm.importlib, "import_module") as imp:
            imp.return_value = SimpleNamespace(
                rest_issue_list=fake_list,
                GhRestError=gh_rest.GhRestError,
            )
            rc = scm.main([
                "issue", "list", "--rest",
                "--repo", "deftai/directive",
            ])
        assert rc == 0
        assert captured["author"] is None
        capsys.readouterr()

    def test_main_rest_list_non_integer_limit_errors(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        rc = scm.main([
            "issue", "list", "--rest",
            "--repo", "deftai/directive",
            "--limit", "many",
        ])
        assert rc == 2
        assert "--limit must be an integer" in capsys.readouterr().err

    def test_main_rest_list_invalid_repo_error_returns_2(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Greptile P1 (#998 review at 367748e): mirror of the
        # _run_rest_view InvalidRepoError test -- _run_rest_list
        # also calls _split_repo and must surface InvalidRepoError
        # as a clean exit 2 instead of an uncaught traceback.
        def boom(
            repo: str,
            *,
            state: str = "open",
            labels: tuple[str, ...] = (),
            author: str | None = None,
            per_page: int = 30,
        ) -> list[dict[str, Any]]:
            raise gh_rest.InvalidRepoError(repo)

        with mock.patch.object(scm.importlib, "import_module") as imp:
            imp.return_value = SimpleNamespace(
                rest_issue_list=boom,
                GhRestError=gh_rest.GhRestError,
                InvalidRepoError=gh_rest.InvalidRepoError,
            )
            rc = scm.main([
                "issue", "list", "--rest",
                "--repo", "directive",  # missing owner prefix
            ])
        assert rc == 2
        assert "invalid --repo value" in capsys.readouterr().err

    def test_main_rest_list_unknown_flag_rejected(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Greptile P2 (#976 review): unknown flags after stripping the
        # consumed flag set are rejected loudly so a typo'd `--label-name`
        # does not silently produce wrong filter results.
        rc = scm.main([
            "issue", "list", "--rest",
            "--repo", "deftai/directive",
            "--unknown-flag", "x",
        ])
        assert rc == 2
        err = capsys.readouterr().err
        assert "does not recognise these flags" in err
        assert "--unknown-flag" in err

    def test_main_rest_list_leftover_positional_rejected(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Greptile P1 (#976 second-pass review): `_run_rest_list` previously
        # validated leftover flag-shaped tokens but never inspected leftover
        # positionals. A caller who typo'd `scm.py issue list --rest 123
        # --repo o/r` (meaning `issue view`) silently received the entire
        # open-issues collection instead of an error. The list verb takes
        # NO positional arguments; this guard surfaces the typo with a
        # `Did you mean ... issue view ...?` hint.
        rc = scm.main([
            "issue", "list", "--rest", "123",
            "--repo", "deftai/directive",
        ])
        assert rc == 2
        err = capsys.readouterr().err
        assert "takes no positional arguments" in err
        assert "'123'" in err
        assert "issue view --rest 123" in err

    def test_main_rest_list_leftover_positional_rejected_before_helper(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Belt-and-suspenders: positional rejection MUST short-circuit
        # before the REST helper is invoked so a stray token never
        # consumes a REST-bucket request. We assert via a fake helper
        # that records every call: zero invocations means the guard
        # fired before dispatch.
        invocations: list[tuple[str, dict[str, Any]]] = []

        def fake_list(
            repo: str,
            *,
            state: str = "open",
            labels: tuple[str, ...] = (),
            author: str | None = None,
            per_page: int = 30,
        ) -> list[dict[str, Any]]:
            invocations.append(
                (repo, {"state": state, "labels": labels, "per_page": per_page})
            )
            return []

        with mock.patch.object(scm.importlib, "import_module") as imp:
            imp.return_value = SimpleNamespace(
                rest_issue_list=fake_list,
                GhRestError=gh_rest.GhRestError,
            )
            rc = scm.main([
                "issue", "list", "--rest", "42",
                "--repo", "deftai/directive",
            ])
        assert rc == 2
        assert invocations == []  # helper was never called

    def test_main_rest_list_repeated_label_flags_merge(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Greptile P2 (#976 review): repeated --label flags now merge
        # into a single labels filter instead of silently dropping all
        # but the first occurrence. Mirrors gh CLI's multi-flag
        # convention (`gh issue list --label A --label B`).
        captured: dict[str, Any] = {}

        def fake_list(
            repo: str,
            *,
            state: str = "open",
            labels: tuple[str, ...] = (),
            author: str | None = None,
            per_page: int = 30,
        ) -> list[dict[str, Any]]:
            captured["labels"] = labels
            return []

        with mock.patch.object(scm.importlib, "import_module") as imp:
            imp.return_value = SimpleNamespace(
                rest_issue_list=fake_list,
                GhRestError=gh_rest.GhRestError,
            )
            rc = scm.main([
                "issue", "list", "--rest",
                "--repo", "deftai/directive",
                "--label", "bug",
                "--label", "enhancement",
            ])
        assert rc == 0
        # All three repeated --label values flow through; comma-form
        # values still split per existing contract.
        assert captured["labels"] == ("bug", "enhancement")
        capsys.readouterr()  # drain stdout

    def test_main_rest_list_mixed_repeated_and_comma_label(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Belt-and-suspenders: repeated --label AND comma-separated
        # values within one --label compose; documented behaviour of
        # the new merge logic.
        captured: dict[str, Any] = {}

        def fake_list(
            repo: str,
            *,
            state: str = "open",
            labels: tuple[str, ...] = (),
            author: str | None = None,
            per_page: int = 30,
        ) -> list[dict[str, Any]]:
            captured["labels"] = labels
            return []

        with mock.patch.object(scm.importlib, "import_module") as imp:
            imp.return_value = SimpleNamespace(
                rest_issue_list=fake_list,
                GhRestError=gh_rest.GhRestError,
            )
            scm.main([
                "issue", "list", "--rest",
                "--repo", "deftai/directive",
                "--label", "bug,p0",
                "--label", "enhancement",
            ])
        assert captured["labels"] == ("bug", "p0", "enhancement")
        capsys.readouterr()


class TestRestRejectsMutations:
    """``--rest`` on close/edit is rejected -- v1 stub keeps mutations on gh."""

    @pytest.mark.parametrize("verb", ["close", "edit"])
    def test_rest_rejected_on_mutations(
        self, capsys: pytest.CaptureFixture[str], verb: str
    ) -> None:
        rc = scm.main([
            "issue", verb, "--rest", "1",
            "--repo", "deftai/directive",
        ])
        assert rc == 2
        err = capsys.readouterr().err
        assert "--rest is only supported on 'issue {view|list}'" in err


# ---------------------------------------------------------------------------
# Regression test (#976): GraphQL exhaustion does not block --rest path
# ---------------------------------------------------------------------------


class TestRestFallsBackOnGraphqlExhaustion:
    """With GraphQL bucket exhausted, --rest still succeeds.

    Simulates a fake ``gh`` whose ``rate_limit`` reports
    ``graphql.remaining = 0`` but ``core.remaining`` healthy. The
    ``rest_issue_view`` helper goes through ``gh api repos/.../issues/N``
    which hits the REST ``core`` bucket -- so the smoke MUST succeed
    against a depleted GraphQL bucket. This is the regression scope of
    issue #976: pre-migration the smoke shelled out to
    ``gh issue view --json`` (GraphQL) and would fail; post-migration
    it routes through REST and is unaffected.
    """

    def test_rest_view_succeeds_when_graphql_zero_but_core_healthy(
        self,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # Track which endpoints get called so we can assert the REST
        # path was taken (no GraphQL endpoint touched).
        endpoints_called: list[str] = []

        def fake_run_gh_api(
            args: list[str], **_kwargs: Any
        ) -> SimpleNamespace:
            # First positional arg is the endpoint path. The REST helpers
            # never call /graphql; if we ever see "graphql" here it means
            # something regressed and we are draining the bucket.
            endpoint = args[0] if args else ""
            endpoints_called.append(endpoint)
            assert "graphql" not in endpoint, (
                "REST migration regression: --rest path hit GraphQL endpoint"
            )
            if endpoint == "rate_limit":
                # The fake gh reports graphql exhausted, core healthy.
                rate_body: dict[str, Any] = {
                    "resources": {
                        "core": {"remaining": 4998, "limit": 5000},
                        "graphql": {"remaining": 0, "limit": 5000},
                    }
                }
                return SimpleNamespace(
                    returncode=0, stdout=json.dumps(rate_body), stderr=""
                )
            # GET /repos/.../issues/N -- REST issue view shape.
            if endpoint.startswith("repos/") and "/issues/" in endpoint:
                issue_body: dict[str, Any] = {
                    "number": 1,
                    "title": "REST migration smoke",
                    "state": "open",
                    "user": {"login": "octocat"},
                }
                return SimpleNamespace(
                    returncode=0, stdout=json.dumps(issue_body), stderr=""
                )
            return SimpleNamespace(
                returncode=1, stdout="", stderr=f"unexpected endpoint: {endpoint}"
            )

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_run_gh_api)
        # resolve_binary is consulted by gh_rest._run_gh_api (real one
        # only; ours doesn't call it). Pin it so any code path that
        # does call resolve_binary returns deterministically.
        monkeypatch.setattr(scm, "resolve_binary", lambda: "gh")

        rc = scm.main([
            "issue", "view", "--rest", "1",
            "--repo", "deftai/directive",
            "--json", "number,title",
        ])
        assert rc == 0, (
            f"--rest path failed with GraphQL exhausted; "
            f"stderr={capsys.readouterr().err!r}"
        )
        out = capsys.readouterr().out.strip()
        parsed = json.loads(out)
        assert parsed == {"number": 1, "title": "REST migration smoke"}
        # Defensive: assert the only endpoint hit was the REST issue
        # endpoint -- not /graphql, not /search, etc.
        assert endpoints_called == ["repos/deftai/directive/issues/1"]
