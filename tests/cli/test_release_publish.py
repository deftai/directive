"""test_release_publish.py -- Tests for scripts/release_publish.py (#716, #961).

Covers the four-state machine + the post-edit verification step:

- view_release: returns "draft" / "published" / "not-found" / "gh-error"
- edit_release_publish: invokes the REST PATCH (draft=false) (#961)
- run_publish: dry-run (no gh calls), happy path (draft -> published),
  draft-not-found refusal (exit 1), already-published no-op (exit 0),
  gh failure on view (exit 1), gh failure on edit (exit 1),
  post-edit verification mismatch (exit 1)
- main: invalid version exits 2, --help exits 0

#961 REST refactor regression coverage:
- view_release issues `gh api repos/<owner>/<repo>/releases/tags/<tag>`
  (REST core bucket) -- the legacy GraphQL `gh release view --json` form
  is no longer used. Test fixtures use the REST shape (`draft` /
  `tag_name` / `html_url` / `id`); the helper normalises them to the
  legacy internal shape (`isDraft` / `tagName` / `url`).
- edit_release_publish issues two REST calls under core: GET
  `releases/tags/<tag>` to resolve id, then PATCH `releases/<id>` with
  `-F draft=false`.
- ``TestRestRegression961`` pins the GraphQL-exhausted -> REST-succeeds
  path: a mocked subprocess that returns the GraphQL rate-limit error
  on the legacy form would have failed the v0.26.1 publish; under the
  refactor, the same mocked subprocess returning a successful REST
  response on `gh api releases/tags/<tag>` succeeds.

Refs #716, #74, #961.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load scripts/release_publish.py in-process, alongside release.py."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    # Ensure release is loaded first (release_publish imports it).
    if "release" not in sys.modules:
        spec_r = importlib.util.spec_from_file_location(
            "release", scripts_dir / "release.py"
        )
        assert spec_r is not None and spec_r.loader is not None
        mod_r = importlib.util.module_from_spec(spec_r)
        sys.modules["release"] = mod_r
        spec_r.loader.exec_module(mod_r)
    spec = importlib.util.spec_from_file_location(
        "release_publish",
        scripts_dir / "release_publish.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["release_publish"] = module
    spec.loader.exec_module(module)
    return module


release_publish = _load_module()


# ---------------------------------------------------------------------------
# view_release
# ---------------------------------------------------------------------------


# REST shape returned by GET /repos/<owner>/<repo>/releases/tags/<tag>
# (the canonical form post-#961). Helpers normalise this to the legacy
# internal shape (isDraft / tagName / url) before returning.
_REST_DRAFT_RELEASE = {
    "id": 1234567,
    "draft": True,
    "name": "v0.21.0",
    "tag_name": "v0.21.0",
    "html_url": "https://github.com/deftai/directive/releases/tag/v0.21.0",
}

_REST_PUBLISHED_RELEASE = {
    "id": 1234567,
    "draft": False,
    "name": "v0.21.0",
    "tag_name": "v0.21.0",
    "html_url": "https://github.com/deftai/directive/releases/tag/v0.21.0",
}


class TestViewRelease:
    def test_draft_state(self, monkeypatch):
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            # Pin the REST argv shape (#961): `gh api repos/.../releases/tags/<tag>`.
            assert "api" in cmd
            assert "repos/deftai/directive/releases/tags/v0.21.0" in cmd
            return SimpleNamespace(
                stdout=json.dumps(_REST_DRAFT_RELEASE), stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "draft"
        # The internal payload shape is normalised to the legacy keys
        # (isDraft / tagName / url) regardless of the REST transport.
        assert body is not None and body["isDraft"] is True
        assert body["tagName"] == "v0.21.0"
        assert body["url"].startswith("https://github.com/")
        assert body["id"] == 1234567
        assert reason == ""

    def test_published_state(self, monkeypatch):
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout=json.dumps(_REST_PUBLISHED_RELEASE),
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "published"
        assert body is not None and body["isDraft"] is False

    def test_not_found(self, monkeypatch):
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="",
                stderr="release not found",
                returncode=1,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "9.9.9", "deftai/directive"
        )
        assert state == "not-found"
        assert body is None
        assert "not found" in reason

    def test_gh_error_other_than_not_found(self, monkeypatch):
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="",
                stderr="auth required",
                returncode=4,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "gh-error"
        assert "auth required" in reason

    def test_gh_missing_returns_gh_error(self, monkeypatch):
        monkeypatch.setattr(release_publish.shutil, "which", lambda _: None)
        state, _body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "gh-error"
        assert "gh CLI not found" in reason

    def test_non_json_response_returns_gh_error(self, monkeypatch):
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="not json", stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, _body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "gh-error"
        assert "non-JSON" in reason

    def test_uses_rest_endpoint_not_graphql(self, monkeypatch):
        # Regression for #961: the legacy form was
        #     `gh release view <tag> --repo <repo> --json isDraft,...`
        # which routed through GraphQL and failed under bucket exhaustion.
        # The REST form is `gh api repos/<owner>/<repo>/releases/tags/<tag>`
        # under the core bucket. This test pins that the argv contains
        # the REST endpoint and does NOT contain the GraphQL flag.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = list(cmd)
            return SimpleNamespace(
                stdout=json.dumps(_REST_DRAFT_RELEASE), stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        release_publish.view_release("0.21.0", "deftai/directive")
        cmd = captured["cmd"]
        assert "api" in cmd
        assert any(
            arg == "repos/deftai/directive/releases/tags/v0.21.0"
            for arg in cmd
        )
        # The legacy GraphQL surface is gone; argv MUST NOT carry the
        # `--json` flag (which would route through GraphQL).
        assert "--json" not in cmd
        # And MUST NOT carry the `release` subcommand (was the GraphQL form).
        assert "release" not in cmd


# ---------------------------------------------------------------------------
# edit_release_publish
# ---------------------------------------------------------------------------


class TestEditReleasePublish:
    def test_happy_invokes_rest_patch(self, monkeypatch):
        # The REST flow makes two subprocess calls: GET releases/tags/<tag>
        # to resolve the id, then PATCH releases/<id> with -F draft=false.
        # Capture both argv lists in order.
        captured_cmds = []

        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            # First call: GET releases/tags/<tag> -> return the REST payload.
            if any("releases/tags/" in arg for arg in cmd):
                return SimpleNamespace(
                    stdout=json.dumps(_REST_DRAFT_RELEASE),
                    stderr="",
                    returncode=0,
                )
            # Second call: PATCH releases/<id> -> success.
            return SimpleNamespace(stdout="{}", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_publish.edit_release_publish(
            "0.21.0", "deftai/directive"
        )
        assert ok is True
        assert "flipped v0.21.0" in reason
        # Two REST calls were issued.
        assert len(captured_cmds) == 2
        # Second call carries --method PATCH and -F draft=false on the REST endpoint.
        patch_cmd = captured_cmds[1]
        assert "--method" in patch_cmd
        assert patch_cmd[patch_cmd.index("--method") + 1] == "PATCH"
        assert "-F" in patch_cmd
        assert "draft=false" in patch_cmd
        # The endpoint URL embeds the resolved release id, not the tag.
        assert any(
            arg == "repos/deftai/directive/releases/1234567"
            for arg in patch_cmd
        )

    def test_failure_on_id_resolve_returns_false(self, monkeypatch):
        # If the GET releases/tags/<tag> step fails (e.g. graphql bucket
        # exhausted on the legacy form would have hit here), the helper
        # returns False with an actionable reason.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="", stderr="server error", returncode=1
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_publish.edit_release_publish(
            "0.21.0", "deftai/directive"
        )
        assert ok is False
        assert "could not resolve release id" in reason

    def test_failure_on_patch_returns_false(self, monkeypatch):
        # First call (GET) succeeds; second call (PATCH) fails. The
        # helper surfaces the PATCH-specific failure so operators can
        # distinguish a permissions / 422 error from a release-not-found.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )
        call_count = {"n": 0}

        def fake_run(cmd, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return SimpleNamespace(
                    stdout=json.dumps(_REST_DRAFT_RELEASE),
                    stderr="",
                    returncode=0,
                )
            return SimpleNamespace(
                stdout="", stderr="permission denied", returncode=1
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_publish.edit_release_publish(
            "0.21.0", "deftai/directive"
        )
        assert ok is False
        assert "permission denied" in reason
        assert "PATCH" in reason


# ---------------------------------------------------------------------------
# Greptile P2-1: 404 detection on stdout (some gh proxy configs route the
# REST 404 JSON body to stdout instead of stderr). Pre-fix the helper only
# inspected stderr and returned "gh-error" in this configuration.
# ---------------------------------------------------------------------------


class TestStdoutNotFoundDetection:
    """Greptile P2-1 (#961): 404 may surface on stdout, not stderr.

    Some gh CLI proxy configurations (notably ghx and corporate proxies)
    forward the REST error body (``{"message": "Not Found", ...}``) to
    stdout while leaving stderr empty. The original helper inspected
    stderr only and returned ``gh-error`` in that case, masking the
    idempotent no-op the caller relies on. Each test below pins one of
    the surface shapes (JSON body / plain text / both streams) and
    asserts the helper returns the canonical ``not-found`` state.
    """

    def test_stdout_json_message_not_found(self, monkeypatch):
        # Proxied gh: JSON 404 body on stdout, empty stderr, exit != 0.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout=json.dumps(
                    {
                        "message": "Not Found",
                        "documentation_url": (
                            "https://docs.github.com/rest/releases/releases"
                            "#get-a-release-by-tag-name"
                        ),
                    }
                ),
                stderr="",
                returncode=1,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "9.9.9", "deftai/directive"
        )
        assert state == "not-found"
        assert body is None
        # Reason carries the JSON body so operators can correlate to the API.
        assert "Not Found" in reason

    def test_stdout_plain_text_not_found(self, monkeypatch):
        # Some proxies emit plain text (not JSON) for 404; substring fallback.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="HTTP 404 Not Found: release does not exist",
                stderr="",
                returncode=22,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, _body, _reason = release_publish.view_release(
            "9.9.9", "deftai/directive"
        )
        assert state == "not-found"

    def test_stdout_404_with_published_run_publish_no_op(
        self, monkeypatch, capsys
    ):
        # End-to-end: when the proxy routes 404 to stdout, run_publish
        # MUST NOT report "gh-error" -- the not-found state surfaces and
        # exits as a violation (release missing) rather than gh-error.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout=json.dumps({"message": "Not Found"}),
                stderr="",
                returncode=1,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_VIOLATION
        captured = capsys.readouterr()
        # The script reports the canonical "not found" message; pre-fix
        # this would have been "gh-error" because stderr was empty.
        assert "not found" in captured.err

    def test_unrelated_500_still_returns_gh_error(self, monkeypatch):
        # Negative case: a non-404 stdout body MUST still classify as
        # gh-error so callers do not silently treat server faults as
        # missing releases.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout=json.dumps({"message": "Internal Server Error"}),
                stderr="",
                returncode=1,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, _body, _reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "gh-error"


# ---------------------------------------------------------------------------
# Greptile P2-2: edit_release_publish optional release_id param elides the
# redundant GET when the caller already has the id from a prior view call.
# ---------------------------------------------------------------------------


class TestEditReleasePublishIdElision:
    """Greptile P2-2 (#961): supplying ``release_id`` skips the redundant GET.

    Pre-fix, ``edit_release_publish`` always issued a GET to resolve the
    id even when the caller (``run_publish``) had just fetched the same
    release object. The optional ``release_id`` kwarg lets callers elide
    the second GET; ``run_publish`` now passes it from the step-1 view
    payload.
    """

    def test_release_id_provided_skips_get(self, monkeypatch):
        # Caller passes release_id directly -> exactly ONE subprocess
        # call (the PATCH). No GET issued.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )
        captured_cmds: list[list[str]] = []

        def fake_run(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            return SimpleNamespace(stdout="{}", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release_publish.edit_release_publish(
            "0.21.0", "deftai/directive", release_id=1234567
        )
        assert ok is True
        # ONE call -- the GET is elided.
        assert len(captured_cmds) == 1
        patch_cmd = captured_cmds[0]
        assert "--method" in patch_cmd
        assert patch_cmd[patch_cmd.index("--method") + 1] == "PATCH"
        # Endpoint embeds the supplied id directly.
        assert any(
            arg == "repos/deftai/directive/releases/1234567"
            for arg in patch_cmd
        )
        # No GET to releases/tags/<tag> happened.
        assert all(
            "releases/tags/" not in arg
            for cmd in captured_cmds
            for arg in cmd
        ), "GET releases/tags/<tag> should be elided when release_id is supplied"
        assert "flipped v0.21.0" in reason

    def test_release_id_none_falls_back_to_get(self, monkeypatch):
        # Backward compatibility: when release_id is None (the default),
        # the helper performs the GET as before. Two subprocess calls.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )
        captured_cmds: list[list[str]] = []

        def fake_run(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            if any("releases/tags/" in arg for arg in cmd):
                return SimpleNamespace(
                    stdout=json.dumps(_REST_DRAFT_RELEASE),
                    stderr="",
                    returncode=0,
                )
            return SimpleNamespace(stdout="{}", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, _reason = release_publish.edit_release_publish(
            "0.21.0", "deftai/directive"  # no release_id -> default None
        )
        assert ok is True
        assert len(captured_cmds) == 2  # GET + PATCH

    def test_run_publish_passes_release_id_to_edit(self, monkeypatch):
        # End-to-end: run_publish forwards the id from step-1 view so
        # edit_release_publish does not re-GET. Pin the kwarg propagation.
        seen_kwargs: dict[str, object] = {}

        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: (
                "draft" if not seen_kwargs.get("called") else "published",
                {"url": "https://example.com/r", "id": 4242},
                "",
            ),
        )

        def fake_edit(version, repo, release_id=None):
            seen_kwargs["called"] = True
            seen_kwargs["release_id"] = release_id
            return True, f"flipped v{version}"

        monkeypatch.setattr(release_publish, "edit_release_publish", fake_edit)
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_OK
        assert seen_kwargs["release_id"] == 4242


# ---------------------------------------------------------------------------
# run_publish
# ---------------------------------------------------------------------------


def _make_config(**overrides):
    defaults = {
        "version": "0.21.0",
        "repo": "deftai/directive",
        "project_root": Path("."),
        "dry_run": False,
    }
    defaults.update(overrides)
    return release_publish.PublishConfig(**defaults)


class TestRunPublish:
    def test_dry_run_invokes_no_gh(self, monkeypatch, capsys):
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("gh helpers must not run in dry-run mode")

        monkeypatch.setattr(release_publish, "view_release", boom)
        monkeypatch.setattr(release_publish, "edit_release_publish", boom)
        rc = release_publish.run_publish(_make_config(dry_run=True))
        assert rc == release_publish.EXIT_OK
        captured = capsys.readouterr()
        assert "DRYRUN" in captured.err
        # Dry-run text MUST describe the post-#961 REST surface (GET
        # releases/tags/<tag> + PATCH releases/<id> -F draft=false), NOT
        # the legacy GraphQL `gh release view` / `gh release edit`
        # subcommands which were removed in the refactor. Pinning the
        # REST substrings here prevents the dry-run preview from drifting
        # back to commands that no longer exist on the actual code path.
        assert "gh api" in captured.err
        assert "repos/deftai/directive/releases/tags/v0.21.0" in captured.err
        assert "-X PATCH" in captured.err
        assert "draft=false" in captured.err
        # Defence-in-depth: assert the legacy subcommand vocabulary is
        # GONE so a future revert to GraphQL-routed text trips this test.
        assert "release view" not in captured.err
        assert "release edit" not in captured.err

    def test_happy_path_draft_to_published(self, monkeypatch, capsys):
        sequence = iter(
            [
                ("draft", {"url": "https://example.com/r", "id": 42}, ""),
                (
                    "published",
                    {"url": "https://example.com/r", "id": 42},
                    "",
                ),
            ]
        )

        monkeypatch.setattr(
            release_publish, "view_release",
            lambda version, repo: next(sequence),
        )
        monkeypatch.setattr(
            release_publish,
            "edit_release_publish",
            lambda version, repo, release_id=None: (
                True, f"flipped v{version} to published"
            ),
        )
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_OK
        captured = capsys.readouterr()
        assert "draft found" in captured.err
        assert "is now public" in captured.err

    def test_draft_not_found_refusal(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: ("not-found", None, "release not found"),
        )

        def boom_edit(*_a, **_kw):  # pragma: no cover
            raise AssertionError(
                "edit_release_publish must not be called when release is missing"
            )

        monkeypatch.setattr(release_publish, "edit_release_publish", boom_edit)
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "not found" in captured.err

    def test_already_published_no_op(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: (
                "published",
                {"url": "https://example.com/r"},
                "",
            ),
        )

        def boom_edit(*_a, **_kw):  # pragma: no cover
            raise AssertionError(
                "edit_release_publish must not be called when already published "
                "(idempotent no-op)"
            )

        monkeypatch.setattr(release_publish, "edit_release_publish", boom_edit)
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_OK
        captured = capsys.readouterr()
        assert "NOOP" in captured.err
        assert "already published" in captured.err

    def test_gh_failure_on_view_exits_violation(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: ("gh-error", None, "auth required"),
        )

        def boom_edit(*_a, **_kw):  # pragma: no cover
            raise AssertionError("edit_release_publish must not be called on gh-error")

        monkeypatch.setattr(release_publish, "edit_release_publish", boom_edit)
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "auth required" in captured.err

    def test_gh_failure_on_edit_exits_violation(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: (
                "draft",
                {"url": "https://example.com/r", "id": 7},
                "",
            ),
        )
        monkeypatch.setattr(
            release_publish,
            "edit_release_publish",
            lambda version, repo, release_id=None: (
                False, "gh release edit failed: 404"
            ),
        )
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "gh release edit failed" in captured.err

    def test_post_edit_verification_mismatch_exits_violation(
        self, monkeypatch, capsys
    ):
        # First view returns draft (proceed), edit succeeds, second view
        # still reports draft (verification mismatch) -> exit 1.
        sequence = iter(
            [
                ("draft", {"url": "https://example.com/r", "id": 9}, ""),
                ("draft", {"url": "https://example.com/r", "id": 9}, ""),
            ]
        )

        monkeypatch.setattr(
            release_publish,
            "view_release",
            lambda version, repo: next(sequence),
        )
        monkeypatch.setattr(
            release_publish,
            "edit_release_publish",
            lambda version, repo, release_id=None: (
                True, "flipped (apparently)"
            ),
        )
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "post-edit state is 'draft'" in captured.err


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


class TestMain:
    def test_invalid_version_exits_2(self, capsys):
        rc = release_publish.main(["not-a-version"])
        assert rc == release_publish.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "Invalid version" in captured.err

    def test_help_exits_0(self):
        with pytest.raises(SystemExit) as exc:
            release_publish.main(["--help"])
        assert exc.value.code == 0

    def test_dry_run_via_main(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run_publish(config):
            captured["config"] = config
            return release_publish.EXIT_OK

        monkeypatch.setattr(release_publish, "run_publish", fake_run_publish)
        rc = release_publish.main(
            [
                "0.21.0",
                "--dry-run",
                "--repo",
                "deftai/directive",
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == release_publish.EXIT_OK
        assert captured["config"].dry_run is True
        assert captured["config"].repo == "deftai/directive"
        assert captured["config"].version == "0.21.0"


# ---------------------------------------------------------------------------
# Subprocess smoke
# ---------------------------------------------------------------------------


class TestSubprocessSmoke:
    def test_help_via_subprocess(self):
        if shutil.which("python") is None:
            pytest.skip("python not on PATH")
        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "release_publish.py"),
                "--help",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0
        assert "release_publish" in result.stdout
        assert "--dry-run" in result.stdout


# ---------------------------------------------------------------------------
# #961 regression: GraphQL exhausted -> REST succeeds
# ---------------------------------------------------------------------------


class TestRestRegression961:
    """Pin the v0.26.1 publish-failure repro: the legacy GraphQL path failed,
    the new REST path succeeds.

    On 2026-05-07 the v0.26.1 publish failed at
    ``scripts/release_publish.py`` line 144 (``gh release view --json ...``,
    GraphQL) and line 182 (``gh release edit ... --draft=false``, GraphQL)
    when the GraphQL bucket exhausted (``gh api rate_limit`` reported
    ``graphql: 0/5000`` while ``core: 4996/5000``). Per the canonical
    preamble (``templates/agent-prompt-preamble.md`` S5) and lessons.md,
    the fix is to route releases through ``gh api`` (REST core).

    These tests pin two invariants:

    1. The legacy GraphQL argv shape is GONE -- ``--json`` and the
       ``gh release view`` / ``gh release edit`` subcommand forms must
       not appear in the dispatched command line.
    2. A subprocess that simulates the bucket-exhausted GraphQL failure
       on the LEGACY argv WHILE returning a successful REST response on
       the new argv leaves the helper succeeding (the same conditions
       that failed v0.26.1 would now succeed).
    """

    def test_legacy_graphql_argv_is_gone(self, monkeypatch):
        # Defence-in-depth: aggregate the argv across both view + edit
        # paths and confirm none of the legacy GraphQL-routing tokens
        # appear. A future refactor that re-introduces `gh release view
        # --json ...` would re-fire the v0.26.1 incident.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )
        captured_cmds = []

        def fake_run(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            if any("releases/tags/" in arg for arg in cmd):
                return SimpleNamespace(
                    stdout=json.dumps(_REST_DRAFT_RELEASE),
                    stderr="",
                    returncode=0,
                )
            return SimpleNamespace(stdout="{}", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        release_publish.view_release("0.21.0", "deftai/directive")
        release_publish.edit_release_publish("0.21.0", "deftai/directive")

        for cmd in captured_cmds:
            # Legacy GraphQL form was: gh release view <tag> --json isDraft,...
            # New REST form is:        gh api repos/<owner>/<repo>/releases/...
            assert "--json" not in cmd, (
                f"Legacy GraphQL --json flag re-introduced in argv {cmd!r}; "
                "this would re-fire the v0.26.1 publish failure."
            )
            # 'release' as a standalone subcommand was the GraphQL form.
            # The REST form has 'releases/...' embedded in the endpoint URL
            # but not as a bare argv element.
            assert "release" not in cmd, (
                f"Legacy `gh release ...` subcommand re-introduced in argv {cmd!r}; "
                "the REST refactor removed this surface."
            )
            # Every issued command MUST go through `gh api`.
            assert "api" in cmd, (
                f"argv {cmd!r} bypasses gh api; REST routing requires it."
            )

    def test_graphql_exhaustion_repro_succeeds_via_rest(self, monkeypatch):
        # The simulated subprocess models the v0.26.1 conditions:
        # - Legacy GraphQL paths (`gh release view --json ...` /
        #   `gh release edit ... --draft=false`) would have failed with
        #   the rate-limit error documented in lessons.md.
        # - The new REST paths (`gh api repos/.../releases/tags/<tag>` /
        #   `gh api repos/.../releases/<id> --method PATCH -F draft=false`)
        #   succeed under the same conditions because they bill the core
        #   bucket (which had 4996 remaining, not 0).
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            # Defensive: if any test scaffolding ever invoked the legacy
            # GraphQL form, simulate the v0.26.1 failure mode so the
            # regression is caught.
            if "--json" in cmd or any(
                arg == "release" for arg in cmd
            ):
                return SimpleNamespace(
                    stdout="",
                    stderr=(
                        "GraphQL: API rate limit already exceeded for "
                        "user ID; graphql: 0/5000 remaining"
                    ),
                    returncode=1,
                )
            # REST GET releases/tags/<tag>.
            if any("releases/tags/" in arg for arg in cmd):
                return SimpleNamespace(
                    stdout=json.dumps(_REST_DRAFT_RELEASE),
                    stderr="",
                    returncode=0,
                )
            # REST PATCH releases/<id>.
            return SimpleNamespace(stdout="{}", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        # The same v0.26.1 conditions; the REST refactor turns the failure
        # path into success.
        state, body, _reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "draft"
        assert body is not None and body["id"] == 1234567

        ok, reason = release_publish.edit_release_publish(
            "0.21.0", "deftai/directive"
        )
        assert ok is True
        assert "flipped v0.21.0" in reason
