"""tests/cli/test_gh_rest.py -- per-helper coverage for scripts/gh_rest.py (#961).

Test surfaces (per issue #961 acceptance criteria):

1. ``TestSplitRepo`` -- ``"owner/repo"`` parser; valid inputs return tuple,
   malformed inputs raise :class:`InvalidRepoError`.
2. ``TestRunGhApiSeam`` -- the module-private subprocess seam delegates
   to ``scm.resolve_binary`` and constructs the canonical
   ``[binary, "api", *args]`` argv.
3. ``TestWriteJsonPayload`` -- the JSON-payload tempfile is built via
   pathlib + UTF-8 and round-trips non-ASCII content (regression for
   #798 PS 5.1 mojibake hazard chain).
4. ``TestExec`` -- the ``_exec`` helper wraps the seam, parses JSON on
   success, raises :class:`GhRestError` with structured attributes on
   failure / non-JSON / non-object responses.
5. ``TestRestCreateIssue``, ``TestRestPostComment``, ``TestRestCloseIssue``,
   ``TestRestOpenPr``, ``TestRestMergePr`` -- mutation helpers; each
   pinned on argv shape (REST endpoint, --method, --input flag), JSON
   payload shape on disk, success returns parsed dict, failure raises
   :class:`GhRestError`.
6. ``TestRestIssueView``, ``TestRestPrView`` -- read helpers; argv shape
   + success/failure paths.
7. ``TestPublicSurfaceContract`` -- pins the seven helper names exported
   from the module so a future rename / accidental drop / accidental
   addition fails CI immediately.

Hermetic: every test mocks ``gh_rest._run_gh_api`` (and ``scm.resolve_binary``
on the seam-level test) -- no live subprocess, no live API call.

Refs #961, #798, #884.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

gh_rest = importlib.import_module("gh_rest")
scm = importlib.import_module("scm")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ok_completed(stdout: str = "{}") -> SimpleNamespace:
    """Build a fake ``subprocess.CompletedProcess`` with zero exit + stdout."""
    return SimpleNamespace(returncode=0, stdout=stdout, stderr="")


def _err_completed(
    stderr: str = "boom", returncode: int = 1, stdout: str = ""
) -> SimpleNamespace:
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def _record_seam(
    monkeypatch: pytest.MonkeyPatch, completed: SimpleNamespace
) -> dict[str, Any]:
    """Record arguments passed to ``_run_gh_api`` and return ``completed``."""
    captured: dict[str, Any] = {}

    def fake_seam(args: list[str], **kwargs: Any) -> SimpleNamespace:
        captured["args"] = list(args)
        captured["kwargs"] = dict(kwargs)
        return completed

    monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
    return captured


def _input_payload_path(args: list[str]) -> Path:
    """Extract the value following ``--input`` in a captured argv list."""
    idx = args.index("--input")
    return Path(args[idx + 1])


# ---------------------------------------------------------------------------
# _split_repo
# ---------------------------------------------------------------------------


class TestSplitRepo:
    """``"owner/repo"`` parser invariants."""

    @pytest.mark.parametrize(
        "repo,expected",
        [
            ("deftai/directive", ("deftai", "directive")),
            ("octocat/hello-world", ("octocat", "hello-world")),
            ("a/b", ("a", "b")),
        ],
    )
    def test_valid_owner_repo_split(
        self, repo: str, expected: tuple[str, str]
    ) -> None:
        assert gh_rest._split_repo(repo) == expected

    @pytest.mark.parametrize(
        "bad",
        [
            "",
            "owner",
            "owner/",
            "/repo",
            "owner/repo/extra",
            "/",
            "//",
            "owner//repo",
        ],
    )
    def test_malformed_repo_raises(self, bad: str) -> None:
        with pytest.raises(gh_rest.InvalidRepoError):
            gh_rest._split_repo(bad)

    @pytest.mark.parametrize("bad", [None, 42, ("owner", "repo"), ["owner", "repo"]])
    def test_non_string_raises(self, bad: object) -> None:
        with pytest.raises(gh_rest.InvalidRepoError):
            gh_rest._split_repo(bad)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# _run_gh_api seam
# ---------------------------------------------------------------------------


class TestRunGhApiSeam:
    """The single subprocess seam delegates to scm.resolve_binary."""

    def test_argv_shape_and_binary_resolution(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(scm, "resolve_binary", lambda: "ghx")
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> SimpleNamespace:
            captured["cmd"] = list(cmd)
            captured["kwargs"] = dict(kwargs)
            return _ok_completed(stdout='{"ok": true}')

        monkeypatch.setattr(gh_rest.subprocess, "run", fake_run)
        result = gh_rest._run_gh_api(["repos/owner/name/issues/1"])

        # First two argv slots are pinned: [binary, "api", ...]; the rest
        # is the verbatim args list passed in. This is the load-bearing
        # contract every helper relies on.
        assert captured["cmd"][0] == "ghx"
        assert captured["cmd"][1] == "api"
        assert captured["cmd"][2:] == ["repos/owner/name/issues/1"]
        # capture_output / text / check=False are required so the helper
        # forwards stdout + stderr without raising on non-zero exit.
        assert captured["kwargs"]["capture_output"] is True
        assert captured["kwargs"]["text"] is True
        assert captured["kwargs"]["check"] is False
        # The returned object is whatever subprocess.run returned -- the
        # seam does NOT post-process.
        assert result.returncode == 0

    def test_falls_back_to_gh_when_ghx_absent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The seam re-uses scm.resolve_binary which already exercises the
        # ghx -> gh ladder; this test pins that gh_rest does not bypass it.
        monkeypatch.setattr(scm, "resolve_binary", lambda: "gh")
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> SimpleNamespace:
            captured["cmd"] = list(cmd)
            return _ok_completed()

        monkeypatch.setattr(gh_rest.subprocess, "run", fake_run)
        gh_rest._run_gh_api(["repos/owner/name/pulls/2"])
        assert captured["cmd"][0] == "gh"


# ---------------------------------------------------------------------------
# _write_json_payload (PS 5.1 / #798 regression)
# ---------------------------------------------------------------------------


class TestWriteJsonPayload:
    """JSON payload tempfile is UTF-8 round-trip safe for non-ASCII content."""

    def test_roundtrip_ascii(self) -> None:
        path = gh_rest._write_json_payload({"title": "hello"})
        try:
            data = path.read_text(encoding="utf-8")
            assert json.loads(data) == {"title": "hello"}
        finally:
            path.unlink(missing_ok=True)

    def test_roundtrip_non_ascii_em_dash(self) -> None:
        # Em dash is the canonical PS 5.1 mojibake regression glyph
        # (#798 / PR #795). The payload MUST round-trip as canonical
        # UTF-8 bytes so `gh api --input <file>` reads the literal
        # character, not a mojibake replacement. The body uses the
        # actual U+2014 (em dash) and U+2192 (rightwards arrow) code
        # points -- ASCII placeholders (`--` / `->`) would not exercise
        # the multi-byte UTF-8 encoding path that originally regressed.
        body = "Title \u2014 with em dash and arrow \u2192"
        path = gh_rest._write_json_payload({"body": body})
        try:
            raw_bytes = path.read_bytes()
            # U+2014 and U+2192 each encode to three bytes in UTF-8
            # (E2 80 94 / E2 86 92); we assert the file is parsable as
            # UTF-8 AND that round-trip preserves the original string
            # byte-for-byte. We also pin the raw UTF-8 byte sequences
            # in the file so a future regression that silently writes
            # cp1252 (em dash -> 0x97) or '?' replacements would fail.
            assert b"\xe2\x80\x94" in raw_bytes  # em dash
            assert b"\xe2\x86\x92" in raw_bytes  # rightwards arrow
            data = path.read_text(encoding="utf-8")
            assert json.loads(data)["body"] == body
            # Defence-in-depth: ensure no UTF-8 BOM was written (the BOM
            # is the other documented PS 5.1 corruption mode).
            assert not raw_bytes.startswith(b"\xef\xbb\xbf")
        finally:
            path.unlink(missing_ok=True)

    def test_roundtrip_unicode_token_glyphs(self) -> None:
        # The deft project uses several unicode rule-tokens (fullwidth
        # circle X, check, ellipses) in prose; payloads carrying these
        # MUST round-trip safely or downstream gh api calls would
        # mojibake the issue/PR body.
        body = "Tokens: \u2297 (cross), \u2713 (check), ... (ellipsis)"
        path = gh_rest._write_json_payload({"body": body})
        try:
            data = path.read_text(encoding="utf-8")
            assert json.loads(data)["body"] == body
        finally:
            path.unlink(missing_ok=True)

    def test_payload_is_json_object(self) -> None:
        path = gh_rest._write_json_payload({"a": 1, "b": [2, 3]})
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            assert data == {"a": 1, "b": [2, 3]}
        finally:
            path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# _exec
# ---------------------------------------------------------------------------


class TestExec:
    """Success / failure paths through the central exec helper."""

    def test_success_parses_json_object(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _record_seam(monkeypatch, _ok_completed(stdout='{"number": 42}'))
        result = gh_rest._exec(
            ["repos/owner/name/issues/42"],
            endpoint="repos/owner/name/issues/42",
            payload=None,
        )
        assert result == {"number": 42}

    def test_empty_stdout_returns_empty_dict(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A 204 No Content (empty stdout, zero exit) is treated as
        # success-with-no-body so callers do not need to special-case
        # endpoints that legitimately return no body.
        _record_seam(monkeypatch, _ok_completed(stdout=""))
        result = gh_rest._exec(
            ["repos/owner/name/pulls/1/merge"],
            endpoint="repos/owner/name/pulls/1/merge",
            payload={"merge_method": "squash"},
        )
        assert result == {}

    def test_non_zero_exit_raises_with_structured_attributes(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _record_seam(monkeypatch, _err_completed(stderr="HTTP 401: bad creds"))
        with pytest.raises(gh_rest.GhRestError) as exc:
            gh_rest._exec(
                ["repos/owner/name/issues"],
                endpoint="repos/owner/name/issues",
                payload={"title": "t", "body": "b"},
                hint="check auth",
            )
        # Structured attributes on the exception support test introspection
        # AND callers programmatically classifying failures (auth vs
        # rate-limit vs not-found) without parsing message strings.
        assert exc.value.exit_code == 1
        assert exc.value.endpoint == "repos/owner/name/issues"
        assert exc.value.payload == {"title": "t", "body": "b"}
        assert "bad creds" in exc.value.stderr
        assert exc.value.hint == "check auth"
        # str(exc) carries the message form for log-only callers.
        assert "endpoint='repos/owner/name/issues'" in str(exc.value)
        assert "check auth" in str(exc.value)

    def test_non_json_response_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _record_seam(monkeypatch, _ok_completed(stdout="<html>500</html>"))
        with pytest.raises(gh_rest.GhRestError) as exc:
            gh_rest._exec(
                ["repos/owner/name/issues/1"],
                endpoint="repos/owner/name/issues/1",
                payload=None,
            )
        assert "non-JSON" in exc.value.stderr

    def test_non_object_response_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # GitHub REST endpoints we wrap return objects, never bare lists
        # at the top level. A list response indicates a wrong endpoint
        # OR a gh version mismatch; we raise so callers do not silently
        # mishandle.
        _record_seam(monkeypatch, _ok_completed(stdout="[1, 2, 3]"))
        with pytest.raises(gh_rest.GhRestError) as exc:
            gh_rest._exec(
                ["repos/owner/name/issues/1"],
                endpoint="repos/owner/name/issues/1",
                payload=None,
            )
        # The stderr field carries the diagnostic; the hint field carries
        # the recovery guidance. Both surfaces are visible to callers.
        assert "unexpected top-level type list" in exc.value.stderr
        assert "non-object" in exc.value.hint


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


class TestRestCreateIssue:
    def test_argv_and_payload_shape(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured = _record_seam(monkeypatch, _ok_completed(stdout='{"number": 7}'))
        result = gh_rest.rest_create_issue(
            "deftai/directive",
            title="title with em dash --",
            body="body with arrow ->",
            labels=("bug", "p0"),
        )
        assert result == {"number": 7}
        args = captured["args"]
        # Endpoint at position 0; method/input flags follow.
        assert args[0] == "repos/deftai/directive/issues"
        assert "--method" in args
        assert args[args.index("--method") + 1] == "POST"
        assert "--input" in args
        # The JSON payload was written via Python pathlib + UTF-8 and
        # carries the supplied non-ASCII content byte-for-byte.
        # (We read it during the seam call so the helper's finally
        # clause has not yet unlinked it -- but to keep the test
        # hermetic we do not rely on the file existing post-call;
        # instead assert the file ended up with the right body via a
        # capture-and-read seam.)

    def test_payload_round_trips_via_pathlib(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Capture the payload file's contents BEFORE the helper unlinks
        # it: monkeypatch the seam to read the input path on the way in.
        captured_payload: dict[str, Any] = {}

        def fake_seam(args: list[str], **_kwargs: Any) -> SimpleNamespace:
            payload_path = _input_payload_path(args)
            captured_payload["text"] = payload_path.read_text(encoding="utf-8")
            captured_payload["bytes"] = payload_path.read_bytes()
            return _ok_completed(stdout='{"number": 1}')

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        gh_rest.rest_create_issue(
            "deftai/directive",
            title="title -- non-ASCII",
            body="body with \u2192 arrow",
        )
        parsed = json.loads(captured_payload["text"])
        assert parsed["title"] == "title -- non-ASCII"
        assert parsed["body"] == "body with \u2192 arrow"
        # No BOM (PS 5.1 corruption surface).
        assert not captured_payload["bytes"].startswith(b"\xef\xbb\xbf")

    def test_labels_omitted_when_empty(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured_payload: dict[str, Any] = {}

        def fake_seam(args: list[str], **_kwargs: Any) -> SimpleNamespace:
            captured_payload["text"] = _input_payload_path(args).read_text(
                encoding="utf-8"
            )
            return _ok_completed(stdout='{"number": 1}')

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        gh_rest.rest_create_issue("deftai/directive", title="t", body="b")
        parsed = json.loads(captured_payload["text"])
        # Empty labels MUST be omitted (not serialised as an empty list)
        # so callers do not accidentally wipe labels.
        assert "labels" not in parsed

    def test_failure_raises_with_endpoint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _record_seam(monkeypatch, _err_completed(stderr="HTTP 422: bad title"))
        with pytest.raises(gh_rest.GhRestError) as exc:
            gh_rest.rest_create_issue("deftai/directive", title="", body="b")
        assert exc.value.endpoint == "repos/deftai/directive/issues"
        assert exc.value.payload is not None and exc.value.payload["title"] == ""

    def test_invalid_repo_raises(self) -> None:
        with pytest.raises(gh_rest.InvalidRepoError):
            gh_rest.rest_create_issue("not-a-repo", title="t", body="b")


class TestRestPostComment:
    def test_argv_shape(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured = _record_seam(monkeypatch, _ok_completed(stdout='{"id": 99}'))
        gh_rest.rest_post_comment("deftai/directive", 961, "comment body")
        args = captured["args"]
        assert args[0] == "repos/deftai/directive/issues/961/comments"
        assert args[args.index("--method") + 1] == "POST"

    def test_failure_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _record_seam(monkeypatch, _err_completed(stderr="HTTP 404"))
        with pytest.raises(gh_rest.GhRestError):
            gh_rest.rest_post_comment("deftai/directive", 9999999, "b")


class TestRestCloseIssue:
    def test_payload_state_closed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured_payload: dict[str, Any] = {}

        def fake_seam(args: list[str], **_kwargs: Any) -> SimpleNamespace:
            captured_payload["text"] = _input_payload_path(args).read_text(
                encoding="utf-8"
            )
            return _ok_completed(stdout='{"state": "closed"}')

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        gh_rest.rest_close_issue("deftai/directive", 100)
        parsed = json.loads(captured_payload["text"])
        assert parsed == {"state": "closed", "state_reason": "completed"}

    def test_custom_reason(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured_payload: dict[str, Any] = {}

        def fake_seam(args: list[str], **_kwargs: Any) -> SimpleNamespace:
            captured_payload["text"] = _input_payload_path(args).read_text(
                encoding="utf-8"
            )
            return _ok_completed(stdout='{}')

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        gh_rest.rest_close_issue("deftai/directive", 100, reason="not_planned")
        assert json.loads(captured_payload["text"])["state_reason"] == "not_planned"

    def test_endpoint_method_is_patch(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured = _record_seam(monkeypatch, _ok_completed(stdout='{}'))
        gh_rest.rest_close_issue("deftai/directive", 100)
        args = captured["args"]
        assert args[0] == "repos/deftai/directive/issues/100"
        assert args[args.index("--method") + 1] == "PATCH"

    def test_reason_none_is_accepted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Greptile P2-3 (#961): rest_close_issue.reason accepts None per
        # its docstring (the GitHub REST API takes ``state_reason: null``
        # to clear the field). Pre-fix the type annotation said ``str``
        # only, so callers passing ``None`` would trip strict type
        # checkers despite the runtime support. This test pins the
        # None-passing path: payload serialises ``state_reason: null``
        # and the call returns the parsed REST response without raising.
        captured_payload: dict[str, Any] = {}

        def fake_seam(args: list[str], **_kwargs: Any) -> SimpleNamespace:
            captured_payload["text"] = _input_payload_path(args).read_text(
                encoding="utf-8"
            )
            return _ok_completed(stdout='{"state": "closed"}')

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        result = gh_rest.rest_close_issue("deftai/directive", 100, reason=None)
        # Helper returns the parsed REST response shape, not the payload.
        assert result == {"state": "closed"}
        # Payload on disk serialises ``state_reason`` as JSON null.
        parsed = json.loads(captured_payload["text"])
        assert parsed == {"state": "closed", "state_reason": None}


class TestRestOpenPr:
    def test_argv_and_payload_shape(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured_payload: dict[str, Any] = {}
        captured_args: list[str] = []

        def fake_seam(args: list[str], **_kwargs: Any) -> SimpleNamespace:
            captured_args.extend(args)
            captured_payload["text"] = _input_payload_path(args).read_text(
                encoding="utf-8"
            )
            return _ok_completed(stdout='{"number": 100, "draft": true}')

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        result = gh_rest.rest_open_pr(
            "deftai/directive",
            head="feat/961-gh-rest-helpers",
            base="master",
            title="feat(scripts): gh_rest.py REST-fallback helpers (#961)",
            body="Closes #961.",
            draft=True,
        )
        assert result == {"number": 100, "draft": True}
        assert captured_args[0] == "repos/deftai/directive/pulls"
        assert "POST" in captured_args
        parsed = json.loads(captured_payload["text"])
        assert parsed == {
            "title": "feat(scripts): gh_rest.py REST-fallback helpers (#961)",
            "head": "feat/961-gh-rest-helpers",
            "base": "master",
            "body": "Closes #961.",
            "draft": True,
        }

    def test_default_draft_false(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured_payload: dict[str, Any] = {}

        def fake_seam(args: list[str], **_kwargs: Any) -> SimpleNamespace:
            captured_payload["text"] = _input_payload_path(args).read_text(
                encoding="utf-8"
            )
            return _ok_completed(stdout='{"number": 1}')

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        gh_rest.rest_open_pr("o/r", head="h", base="b", title="t", body="b")
        assert json.loads(captured_payload["text"])["draft"] is False


class TestRestMergePr:
    def test_default_squash_method(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured_payload: dict[str, Any] = {}

        def fake_seam(args: list[str], **_kwargs: Any) -> SimpleNamespace:
            captured_payload["text"] = _input_payload_path(args).read_text(
                encoding="utf-8"
            )
            return _ok_completed(stdout='{"merged": true}')

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        result = gh_rest.rest_merge_pr("deftai/directive", 100)
        assert result == {"merged": True}
        parsed = json.loads(captured_payload["text"])
        assert parsed == {"merge_method": "squash"}

    def test_method_put(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured = _record_seam(monkeypatch, _ok_completed(stdout='{"merged": true}'))
        gh_rest.rest_merge_pr("deftai/directive", 100)
        args = captured["args"]
        assert args[0] == "repos/deftai/directive/pulls/100/merge"
        assert args[args.index("--method") + 1] == "PUT"

    def test_optional_commit_overrides(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured_payload: dict[str, Any] = {}

        def fake_seam(args: list[str], **_kwargs: Any) -> SimpleNamespace:
            captured_payload["text"] = _input_payload_path(args).read_text(
                encoding="utf-8"
            )
            return _ok_completed(stdout='{}')

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        gh_rest.rest_merge_pr(
            "deftai/directive",
            100,
            method="merge",
            commit_title="custom title",
            commit_message="custom message",
        )
        parsed = json.loads(captured_payload["text"])
        assert parsed == {
            "merge_method": "merge",
            "commit_title": "custom title",
            "commit_message": "custom message",
        }


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


class TestRestIssueView:
    def test_argv_and_success(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured = _record_seam(
            monkeypatch,
            _ok_completed(stdout='{"number": 961, "state": "open"}'),
        )
        result = gh_rest.rest_issue_view("deftai/directive", 961)
        assert result == {"number": 961, "state": "open"}
        # Reads do NOT pass --method or --input; just the endpoint.
        assert captured["args"] == ["repos/deftai/directive/issues/961"]

    def test_failure_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _record_seam(monkeypatch, _err_completed(stderr="HTTP 404: not found"))
        with pytest.raises(gh_rest.GhRestError) as exc:
            gh_rest.rest_issue_view("deftai/directive", 9999999)
        assert exc.value.endpoint == "repos/deftai/directive/issues/9999999"
        assert exc.value.payload is None  # reads carry no payload


class TestRestPrView:
    def test_argv_and_success(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured = _record_seam(
            monkeypatch,
            _ok_completed(stdout='{"number": 100, "draft": true}'),
        )
        result = gh_rest.rest_pr_view("deftai/directive", 100)
        assert result == {"number": 100, "draft": True}
        assert captured["args"] == ["repos/deftai/directive/pulls/100"]


# ---------------------------------------------------------------------------
# Public surface contract
# ---------------------------------------------------------------------------


class TestPublicSurfaceContract:
    """Pin the exported helper names per issue #961 acceptance criteria.

    Adding a helper requires updating ``PUBLIC_HELPERS`` AND ``__all__``
    in lockstep. Removing or renaming a helper here is a contract break
    that callers (skills, swarm, triage) rely on; the test fails so
    the rename is surfaced before merge.
    """

    EXPECTED_HELPERS: tuple[str, ...] = (
        "rest_create_issue",
        "rest_post_comment",
        "rest_close_issue",
        "rest_open_pr",
        "rest_merge_pr",
        "rest_issue_view",
        "rest_pr_view",
    )

    def test_public_helpers_constant_matches_expected(self) -> None:
        assert gh_rest.PUBLIC_HELPERS == self.EXPECTED_HELPERS

    @pytest.mark.parametrize("name", EXPECTED_HELPERS)
    def test_helper_is_callable(self, name: str) -> None:
        assert callable(getattr(gh_rest, name))

    def test_dunder_all_includes_helpers_and_errors(self) -> None:
        for name in self.EXPECTED_HELPERS:
            assert name in gh_rest.__all__
        assert "GhRestError" in gh_rest.__all__
        assert "InvalidRepoError" in gh_rest.__all__

    def test_no_release_helpers_exported(self) -> None:
        # Per issue #961 body, releases are explicitly out of scope --
        # owned by task release / #74. A helper named rest_*_release
        # leaking into the surface is a scope-creep regression.
        leaked = [n for n in dir(gh_rest) if "release" in n.lower()]
        assert leaked == [], f"unexpected release-related symbols: {leaked}"


# ---------------------------------------------------------------------------
# GhRestError dataclass invariants
# ---------------------------------------------------------------------------


class TestGhRestErrorAttributes:
    """Construction-time invariants on the typed exception."""

    def test_attributes_round_trip(self) -> None:
        exc = gh_rest.GhRestError(
            stderr="boom",
            exit_code=2,
            endpoint="repos/o/r/issues",
            payload={"title": "t"},
            hint="check auth",
        )
        assert exc.stderr == "boom"
        assert exc.exit_code == 2
        assert exc.endpoint == "repos/o/r/issues"
        assert exc.payload == {"title": "t"}
        assert exc.hint == "check auth"
        assert "endpoint='repos/o/r/issues'" in str(exc)
        assert "exit=2" in str(exc)

    def test_hint_optional(self) -> None:
        exc = gh_rest.GhRestError(
            stderr="x", exit_code=1, endpoint="e", payload=None
        )
        assert exc.hint == ""
        # Message string omits the hint suffix when hint is empty.
        assert "hint:" not in str(exc)

    def test_is_runtime_error_subclass(self) -> None:
        # Subclassing RuntimeError keeps callers' broad except blocks
        # working AND lets new typed callers pin GhRestError specifically.
        exc = gh_rest.GhRestError(
            stderr="x", exit_code=1, endpoint="e", payload=None
        )
        assert isinstance(exc, RuntimeError)


# ---------------------------------------------------------------------------
# Integration smoke: every mutation helper unlinks its tempfile
# ---------------------------------------------------------------------------


class TestMutationTempfileCleanup:
    """Mutations create a payload tempfile; the finally clause must unlink it."""

    @pytest.mark.parametrize(
        "helper,args,kwargs",
        [
            (
                "rest_create_issue",
                ("o/r",),
                {"title": "t", "body": "b"},
            ),
            (
                "rest_post_comment",
                ("o/r", 1, "body"),
                {},
            ),
            (
                "rest_close_issue",
                ("o/r", 1),
                {},
            ),
            (
                "rest_open_pr",
                ("o/r",),
                {"head": "h", "base": "b", "title": "t", "body": "b"},
            ),
            (
                "rest_merge_pr",
                ("o/r", 1),
                {},
            ),
        ],
    )
    def test_tempfile_unlinked_on_success(
        self,
        monkeypatch: pytest.MonkeyPatch,
        helper: str,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
    ) -> None:
        seen_paths: list[Path] = []

        def fake_seam(argv: list[str], **_kwargs: Any) -> SimpleNamespace:
            seen_paths.append(_input_payload_path(argv))
            return _ok_completed(stdout='{}')

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        getattr(gh_rest, helper)(*args, **kwargs)
        assert seen_paths, "seam was not invoked"
        # File MUST be unlinked by the helper's finally clause.
        assert not seen_paths[0].exists()

    def test_tempfile_unlinked_on_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen_paths: list[Path] = []

        def fake_seam(argv: list[str], **_kwargs: Any) -> SimpleNamespace:
            seen_paths.append(_input_payload_path(argv))
            return _err_completed(stderr="boom")

        monkeypatch.setattr(gh_rest, "_run_gh_api", fake_seam)
        with pytest.raises(gh_rest.GhRestError):
            gh_rest.rest_create_issue("o/r", title="t", body="b")
        assert seen_paths and not seen_paths[0].exists()
