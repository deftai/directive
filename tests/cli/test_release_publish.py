"""test_release_publish.py -- Tests for scripts/release_publish.py (#716, #961, #1016).

Covers the four-state machine + the post-edit verification step:

- view_release: returns "draft" / "published" / "not-found" / "gh-error"
- edit_release_publish: invokes the REST PATCH (draft=false) (#961)
- run_publish: dry-run (no gh calls), happy path (draft -> published),
  draft-not-found refusal (exit 1), already-published no-op (exit 0),
  gh failure on view (exit 1), gh failure on edit (exit 1),
  post-edit verification mismatch (exit 1)
- main: invalid version exits 2, --help exits 0

#961 REST refactor regression coverage:
- view_release issues `gh api ...` against the REST core bucket -- the
  legacy GraphQL `gh release view --json` form is no longer used.
- edit_release_publish issues two REST calls under core: a list lookup
  to resolve the id (#1016), then PATCH `releases/<id>` with
  `-F draft=false`.
- ``TestRestRegression961`` pins the GraphQL-exhausted -> REST-succeeds
  path: a mocked subprocess that returns the GraphQL rate-limit error
  on the legacy form would have failed the v0.26.1 publish; under the
  refactor, the same mocked subprocess returning a successful REST
  response succeeds.

#1016 paginated list+filter regression coverage:
- The post-#961 lookup ``gh api repos/<owner>/<repo>/releases/tags/<tag>``
  returned 404 for DRAFT releases (the GitHub REST docs explicitly
  limit ``/releases/tags/{tag}`` to PUBLISHED releases). The fix
  replaces the single-tag GET with a paginated list+filter:
  ``gh api --paginate repos/<owner>/<repo>/releases?per_page=100``
  followed by client-side ``tag_name`` matching. Test fixtures now use
  the list shape (an array of per-release REST objects); the helper
  normalises matched entries to the legacy internal shape (``isDraft``
  / ``tagName`` / ``url`` / ``id``).
- ``TestPaginatedDraftLookup`` pins the draft-found-via-list path (the
  v0.27.0 publish-failure regression) and the no-match-in-list ->
  ``not-found`` path.
- ``TestPaginatedReleasesPagination`` pins iteration correctness across
  a concatenated multi-page response.

Refs #716, #74, #961, #1016.
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


# Per-release REST object as it appears in the paginated list response
# from GET /repos/<owner>/<repo>/releases?per_page=100 (the canonical
# form post-#1016). Helpers iterate the list, match on ``tag_name``,
# and normalise the matched entry to the legacy internal shape (isDraft
# / tagName / url) before returning.
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

# Convenience fixtures: the paginated /releases response is a JSON array
# (single page in the simple cases). Multi-page concatenation is
# exercised in ``TestPaginatedReleasesPagination``.
_REST_DRAFT_LIST = [_REST_DRAFT_RELEASE]
_REST_PUBLISHED_LIST = [_REST_PUBLISHED_RELEASE]


def _make_rest_release(
    *,
    tag: str = "v0.21.0",
    draft: bool = True,
    release_id: int = 1234567,
) -> dict:
    """Construct a REST release fixture with arbitrary tag/draft/id.

    Used by the #1016 tests that need to construct multi-entry list
    payloads with varying tag_name values.
    """
    return {
        "id": release_id,
        "draft": draft,
        "name": tag,
        "tag_name": tag,
        "html_url": f"https://github.com/deftai/directive/releases/tag/{tag}",
    }


class TestViewRelease:
    def test_draft_state(self, monkeypatch):
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            # Pin the REST argv shape (#1016): the paginated list endpoint.
            assert "api" in cmd
            assert "--paginate" in cmd
            assert "repos/deftai/directive/releases?per_page=100" in cmd
            return SimpleNamespace(
                stdout=json.dumps(_REST_DRAFT_LIST), stderr="", returncode=0
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
                stdout=json.dumps(_REST_PUBLISHED_LIST),
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
        # #1016: not-found is now signalled by the absence of a matching
        # tag_name in the paginated list response (the list endpoint
        # returns 200 + [] / 200 + [other releases] rather than 404).
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            other_releases = [
                _make_rest_release(
                    tag="v0.20.0", draft=False, release_id=1
                ),
                _make_rest_release(
                    tag="v0.19.0", draft=False, release_id=2
                ),
            ]
            return SimpleNamespace(
                stdout=json.dumps(other_releases),
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "9.9.9", "deftai/directive"
        )
        assert state == "not-found"
        assert body is None
        assert "not found" in reason
        assert "v9.9.9" in reason

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
        # Regression for #961 + #1016: the legacy GraphQL form was
        #     `gh release view <tag> --repo <repo> --json isDraft,...`
        # which routed through GraphQL and failed under bucket exhaustion.
        # The post-#961 form was
        #     `gh api repos/<owner>/<repo>/releases/tags/<tag>`
        # which 404'd on DRAFT releases (the canonical publish input).
        # The post-#1016 form is
        #     `gh api --paginate repos/<owner>/<repo>/releases?per_page=100`
        # under the core bucket. This test pins the paginated list
        # endpoint and the --paginate flag, and asserts the argv does
        # NOT contain the GraphQL flag, the legacy `release` subcommand,
        # or the post-#961 single-tag /releases/tags/<tag> form.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = list(cmd)
            return SimpleNamespace(
                stdout=json.dumps(_REST_DRAFT_LIST), stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        release_publish.view_release("0.21.0", "deftai/directive")
        cmd = captured["cmd"]
        assert "api" in cmd
        assert "--paginate" in cmd
        assert any(
            arg == "repos/deftai/directive/releases?per_page=100"
            for arg in cmd
        )
        # The legacy GraphQL surface is gone; argv MUST NOT carry the
        # `--json` flag (which would route through GraphQL).
        assert "--json" not in cmd
        # And MUST NOT carry the `release` subcommand (was the GraphQL form).
        assert "release" not in cmd
        # And MUST NOT carry the post-#961 single-tag endpoint that 404s
        # on DRAFT releases (#1016 -- re-introducing this would re-fire
        # the v0.27.0 publish failure).
        assert all(
            "/releases/tags/" not in arg for arg in cmd
        ), (
            f"argv {cmd!r} re-introduces /releases/tags/<tag> which 404s "
            "on DRAFT releases (re-fires #1016)."
        )


# ---------------------------------------------------------------------------
# edit_release_publish
# ---------------------------------------------------------------------------


class TestEditReleasePublish:
    def test_happy_invokes_rest_patch(self, monkeypatch):
        # The REST flow makes two subprocess calls when release_id is not
        # pre-resolved: paginated list lookup to resolve the id (#1016),
        # then PATCH releases/<id> with -F draft=false. Capture both argv
        # lists in order.
        captured_cmds = []

        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            # First call: paginated list -> return the REST list payload.
            if "--paginate" in cmd:
                return SimpleNamespace(
                    stdout=json.dumps(_REST_DRAFT_LIST),
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
        # If the paginated list lookup step fails (e.g. graphql bucket
        # exhausted on the legacy form would have hit here, or the list
        # endpoint returns a server error), the helper returns False
        # with an actionable reason.
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
        # First call (list lookup) succeeds; second call (PATCH) fails.
        # The helper surfaces the PATCH-specific failure so operators
        # can distinguish a permissions / 422 error from a release-not-found.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )
        call_count = {"n": 0}

        def fake_run(cmd, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return SimpleNamespace(
                    stdout=json.dumps(_REST_DRAFT_LIST),
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
# #1016 regression: paginated /releases list+filter surfaces DRAFT releases
# ---------------------------------------------------------------------------


class TestPaginatedDraftLookup:
    """Pin the v0.27.0 publish-failure repro: /releases/tags/<tag> 404'd
    on the DRAFT release, the new paginated list+filter finds it.

    On 2026-05-10 the v0.27.0 publish failed because
    ``gh api repos/deftai/directive/releases/tags/v0.27.0`` returned
    HTTP 404 even though the DRAFT release existed. The GitHub REST
    docs explicitly limit ``/releases/tags/{tag}`` to PUBLISHED
    releases ("This returns the latest published release for the
    specified tag"). The fix replaces the single-tag GET with a
    paginated list+filter against ``/releases?per_page=100``.

    These tests pin three invariants:

    1. A DRAFT release whose ``tag_name`` matches the target resolves
       to ``state == "draft"`` (the load-bearing regression -- pre-fix
       this returned ``state == "not-found"``).
    2. A tag absent from the list response resolves to
       ``state == "not-found"`` (existing semantics preserved).
    3. An end-to-end ``run_publish`` against a DRAFT release succeeds
       (exit 0); the post-edit verification re-read finds the
       now-published release in the list.
    """

    def test_draft_found_via_list_filter(self, monkeypatch):
        # Exact repro of the v0.27.0 failure: a DRAFT release for the
        # target tag is present in the list. Pre-fix the single-tag
        # endpoint 404'd; post-fix the list+filter finds the draft.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            list_payload = [
                _make_rest_release(
                    tag="v0.27.0", draft=True, release_id=200000001
                ),
                _make_rest_release(
                    tag="v0.26.2", draft=False, release_id=200000002
                ),
                _make_rest_release(
                    tag="v0.26.1", draft=False, release_id=200000003
                ),
            ]
            return SimpleNamespace(
                stdout=json.dumps(list_payload),
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "0.27.0", "deftai/directive"
        )
        assert state == "draft", (
            "DRAFT release lookup MUST succeed via the paginated "
            "list+filter form -- the v0.27.0 publish-failure regression."
        )
        assert body is not None and body["isDraft"] is True
        assert body["tagName"] == "v0.27.0"
        assert body["id"] == 200000001
        assert reason == ""

    def test_tag_absent_returns_not_found(self, monkeypatch):
        # Verify the #1016 fix preserves the not-found refusal path: a
        # tag that genuinely doesn't exist still surfaces as not-found
        # rather than masquerading as a successful draft lookup.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            list_payload = [
                _make_rest_release(
                    tag="v0.27.0", draft=True, release_id=1
                ),
                _make_rest_release(
                    tag="v0.26.2", draft=False, release_id=2
                ),
            ]
            return SimpleNamespace(
                stdout=json.dumps(list_payload),
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "9.9.9", "deftai/directive"
        )
        assert state == "not-found"
        assert body is None
        assert "v9.9.9" in reason

    def test_published_release_still_resolves_back_compat(self, monkeypatch):
        # Back-compat: a PUBLISHED release in the list still resolves
        # to state == "published" so the idempotent re-run case is
        # preserved across the refactor.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            list_payload = [
                _make_rest_release(
                    tag="v0.21.0", draft=False, release_id=42
                ),
            ]
            return SimpleNamespace(
                stdout=json.dumps(list_payload),
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, _reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "published"
        assert body is not None and body["isDraft"] is False
        assert body["id"] == 42

    def test_run_publish_succeeds_on_draft_release_end_to_end(
        self, monkeypatch, capsys
    ):
        # End-to-end: a DRAFT release exists for the target tag; the
        # publish flow finds it via list+filter, flips draft=false via
        # PATCH, and verifies via a second list lookup. Pre-#1016 this
        # would have failed at the initial view step with the
        # "release v0.27.0 not found" message.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        call_log: list[list[str]] = []

        def fake_run(cmd, **kwargs):
            call_log.append(list(cmd))
            # Step 1 + Step 3: paginated list lookup (initial draft find,
            # post-edit verification re-read).
            if "--paginate" in cmd:
                # Step 1 returns draft; step 3 returns published (the
                # PATCH between them flipped the draft state).
                is_post_patch = any(
                    "--method" in prev_cmd for prev_cmd in call_log[:-1]
                )
                draft_state = not is_post_patch
                list_payload = [
                    _make_rest_release(
                        tag="v0.27.0",
                        draft=draft_state,
                        release_id=200000001,
                    ),
                ]
                return SimpleNamespace(
                    stdout=json.dumps(list_payload),
                    stderr="",
                    returncode=0,
                )
            # Step 2: PATCH releases/<id>.
            return SimpleNamespace(stdout="{}", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = release_publish.run_publish(
            release_publish.PublishConfig(
                version="0.27.0",
                repo="deftai/directive",
                project_root=Path("."),
                dry_run=False,
            )
        )
        assert rc == release_publish.EXIT_OK, (
            "Publish flow MUST succeed against a DRAFT release "
            "(the v0.27.0 regression case)."
        )
        captured = capsys.readouterr()
        assert "draft found" in captured.err
        assert "is now public" in captured.err
        # Three subprocess calls: list (find draft), PATCH, list (verify).
        assert len(call_log) == 3
        assert "--paginate" in call_log[0]
        assert "--method" in call_log[1]
        assert "--paginate" in call_log[2]


class TestPaginatedReleasesPagination:
    """Pin iteration correctness across a concatenated multi-page response.

    ``gh api --paginate`` follows ``Link: rel="next"`` headers and
    concatenates per-page arrays into a single JSON array. The helper
    iterates the full concatenated list rather than stopping at the
    first page, so a target tag that lives deep in the list still
    resolves correctly.
    """

    def test_argv_carries_paginate_flag(self, monkeypatch):
        # Load-bearing: --paginate is what makes gh follow Link headers.
        # Without it, the helper would only see page 1 and miss target
        # tags on later pages.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = list(cmd)
            return SimpleNamespace(
                stdout=json.dumps(_REST_DRAFT_LIST),
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        release_publish.view_release("0.21.0", "deftai/directive")
        assert "--paginate" in captured["cmd"], (
            "argv MUST carry --paginate so gh follows Link: rel=\"next\" "
            "headers; without it, tags on later pages would not be found."
        )

    def test_match_on_entry_deep_in_concatenated_list(self, monkeypatch):
        # Construct a 150-entry concatenated payload modelling a
        # two-page response at per_page=100. Drop the target tag at the
        # very end of the list (deep into page 2) to verify the helper
        # iterates the full list, not just the first N entries.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            # Generate filler entries with tags that CANNOT collide with
            # the target tag (`v0.21.0`). Using a distinct "v2.X.Y" /
            # "v3.X.Y" namespace keeps the filler unique.
            page_one = [
                _make_rest_release(
                    tag=f"v2.{i}.0",
                    draft=False,
                    release_id=10000 + i,
                )
                for i in range(100)
            ]
            page_two = [
                _make_rest_release(
                    tag=f"v3.{i}.0",
                    draft=False,
                    release_id=20000 + i,
                )
                for i in range(49)
            ]
            # Target tag is the 150th entry (deep into the concatenated
            # page 2). A helper that stops at the first page (or first
            # match against the wrong tag) would miss it.
            target = _make_rest_release(
                tag="v0.21.0", draft=True, release_id=999999
            )
            concatenated = page_one + page_two + [target]
            return SimpleNamespace(
                stdout=json.dumps(concatenated),
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, _reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "draft", (
            "Helper MUST iterate the full concatenated list -- a target "
            "tag on a later page must still be found."
        )
        assert body is not None and body["id"] == 999999

    def test_no_match_across_all_pages_returns_not_found(self, monkeypatch):
        # Negative pagination case: a 150-entry list with no matching
        # tag_name still resolves to not-found (the helper iterates the
        # full list before concluding the tag is absent).
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            # Distinct namespace so the filler cannot collide with the
            # absent-target tag below.
            concatenated = [
                _make_rest_release(
                    tag=f"v2.{i}.0",
                    draft=False,
                    release_id=10000 + i,
                )
                for i in range(150)
            ]
            return SimpleNamespace(
                stdout=json.dumps(concatenated),
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "9.9.9", "deftai/directive"
        )
        assert state == "not-found"
        assert body is None
        assert "v9.9.9" in reason


# ---------------------------------------------------------------------------
# Not-found / gh-error classification under the paginated list endpoint
# (#1016). Greptile P2-1 (#961) originally pinned the 404-on-stdout
# detection on the single-tag ``/releases/tags/<tag>`` endpoint, but that
# endpoint is no longer used: the post-#1016 helper queries the paginated
# ``/releases?per_page=100`` listing instead, which returns 200 + a JSON
# array for any repo (empty or otherwise). "Not found" is now expressed
# as the absence of a matching ``tag_name`` in the list; this class
# preserves the classification-test coverage by exercising the new
# triggers for the same canonical state-machine outputs.
# ---------------------------------------------------------------------------


class TestStdoutNotFoundDetection:
    """Not-found / gh-error classification under the paginated /releases lookup.

    Historical context: the original Greptile P2-1 fix (#961) handled
    404 bodies surfaced on stdout by proxied gh configurations against
    the single-tag ``/releases/tags/<tag>`` endpoint. The post-#1016
    helper no longer queries that endpoint -- it issues a paginated
    list against ``/releases?per_page=100`` which returns 200 + a JSON
    array for any repo. The classification surface (not-found vs
    gh-error) is preserved here against the new endpoint shape: a list
    that does not contain the target ``tag_name`` resolves to
    not-found; a non-list / non-JSON / non-zero-exit response resolves
    to gh-error.
    """

    def test_stdout_json_message_not_found(self, monkeypatch):
        # Adapted post-#1016: a list response that does not contain the
        # target tag resolves to not-found (was: proxied gh routing a
        # JSON 404 body to stdout on the single-tag endpoint).
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            list_payload = [
                _make_rest_release(
                    tag="v0.20.0", draft=False, release_id=1
                ),
                _make_rest_release(
                    tag="v0.19.0", draft=False, release_id=2
                ),
            ]
            return SimpleNamespace(
                stdout=json.dumps(list_payload),
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, body, reason = release_publish.view_release(
            "9.9.9", "deftai/directive"
        )
        assert state == "not-found"
        assert body is None
        # Reason names the missing tag so operators can correlate.
        assert "v9.9.9" in reason

    def test_stdout_plain_text_not_found(self, monkeypatch):
        # Adapted post-#1016: an empty list response (repo with no
        # releases at all) resolves to not-found (was: plain-text 404
        # body on stdout from the single-tag endpoint).
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="[]",
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, _body, _reason = release_publish.view_release(
            "9.9.9", "deftai/directive"
        )
        assert state == "not-found"

    def test_stdout_404_with_published_run_publish_no_op(
        self, monkeypatch, capsys
    ):
        # End-to-end (adapted post-#1016): when the target tag is not
        # present in the paginated list, run_publish MUST exit as a
        # violation (release missing) with a "not found" message. Pre-fix
        # variants of this scenario either returned gh-error (on the
        # legacy #961 stdout-routing path) or 404'd on the single-tag
        # endpoint regardless of draft state (the #1016 root cause).
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="[]",
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = release_publish.run_publish(_make_config())
        assert rc == release_publish.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "not found" in captured.err

    def test_unrelated_500_still_returns_gh_error(self, monkeypatch):
        # Negative case (adapted post-#1016): a non-list response
        # (e.g. server-side error wrapped as a JSON object) MUST
        # classify as gh-error so callers do not silently treat server
        # faults as missing releases. Pre-#1016 the equivalent surface
        # was an Internal-Server-Error JSON body on stdout.
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout=json.dumps({"message": "Internal Server Error"}),
                stderr="",
                returncode=0,
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        state, _body, reason = release_publish.view_release(
            "0.21.0", "deftai/directive"
        )
        assert state == "gh-error"
        assert "non-list" in reason


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
        # No paginated list lookup happened (#1016 -- the post-#1016
        # GET form uses --paginate instead of the single-tag endpoint).
        assert all(
            "--paginate" not in cmd for cmd in captured_cmds
        ), "paginated list lookup should be elided when release_id is supplied"
        assert "flipped v0.21.0" in reason

    def test_release_id_none_falls_back_to_get(self, monkeypatch):
        # Backward compatibility: when release_id is None (the default),
        # the helper performs the paginated list lookup as before. Two
        # subprocess calls (list + PATCH).
        monkeypatch.setattr(
            release_publish.shutil, "which", lambda _: "/usr/bin/gh"
        )
        captured_cmds: list[list[str]] = []

        def fake_run(cmd, **kwargs):
            captured_cmds.append(list(cmd))
            if "--paginate" in cmd:
                return SimpleNamespace(
                    stdout=json.dumps(_REST_DRAFT_LIST),
                    stderr="",
                    returncode=0,
                )
            return SimpleNamespace(stdout="{}", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, _reason = release_publish.edit_release_publish(
            "0.21.0", "deftai/directive"  # no release_id -> default None
        )
        assert ok is True
        assert len(captured_cmds) == 2  # list + PATCH

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
        # Dry-run text MUST describe the post-#1016 REST surface
        # (paginated GET against releases?per_page=100 + PATCH against
        # releases/<id> -F draft=false), NOT the post-#961 single-tag
        # form (which 404s on drafts) and NOT the legacy GraphQL
        # `gh release view` / `gh release edit` subcommands. Pinning
        # the paginated substrings here prevents the dry-run preview
        # from drifting back to commands that no longer exist on the
        # actual code path.
        assert "gh api" in captured.err
        assert "--paginate" in captured.err
        assert "repos/deftai/directive/releases?per_page=100" in captured.err
        assert "tag_name == v0.21.0" in captured.err
        assert "-X PATCH" in captured.err
        assert "draft=false" in captured.err
        # Defence-in-depth: assert the legacy subcommand vocabulary is
        # GONE so a future revert to GraphQL-routed text trips this test,
        # AND the post-#961 single-tag endpoint is GONE so a future
        # revert to /releases/tags/<tag> trips this test (#1016).
        assert "release view" not in captured.err
        assert "release edit" not in captured.err
        assert "/releases/tags/" not in captured.err

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
            if "--paginate" in cmd:
                return SimpleNamespace(
                    stdout=json.dumps(_REST_DRAFT_LIST),
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
            # REST paginated list lookup (#1016).
            if "--paginate" in cmd:
                return SimpleNamespace(
                    stdout=json.dumps(_REST_DRAFT_LIST),
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
