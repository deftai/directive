#!/usr/bin/env python3
"""scripts/gh_rest.py -- REST-fallback helpers for gh mutations and reads (#961).

Why this module exists
----------------------
Mid-session 2026-05-07 the ``graphql`` bucket exhausted (`gh api rate_limit`
reported `graphql: 0/5000`, `core: 4996/5000`). `gh issue create`, `gh issue
close`, `gh issue comment`, `gh pr ready`, `gh pr merge`, `gh pr view --json`,
and `gh issue view --json` all routed through GraphQL and failed hard, even
though every operation has a working REST equivalent. The session worked
around it by inlining `gh api repos/.../<endpoint> --method POST/PATCH/PUT
--input <payload.json>` calls per call site. That ad-hoc pattern is
documented as prose in ``meta/lessons.md`` (`## gh CLI GraphQL Bucket
Exhaustion + REST Fallback + UTF-8 Payload Pattern (2026-05)`) but lived
nowhere in code.

This module reifies the pattern as seven typed Python helpers so skills,
swarm, triage, and ad-hoc scripts can call structured functions instead of
inlining the JSON-payload incantation per call site. The REST routing also
fixes the recurring PowerShell 5.1 mojibake hazard (#236 / #240 / #283 /
PR #795 / #798) at one site rather than N sites: every helper builds the
JSON wrapper via Python ``pathlib`` UTF-8.

Public surface
--------------
Mutations (5):
    rest_create_issue(repo, title, body, labels=()) -> dict
        POST /repos/{owner}/{repo}/issues
    rest_post_comment(repo, n, body) -> dict
        POST /repos/{owner}/{repo}/issues/{n}/comments
    rest_close_issue(repo, n, *, reason="completed") -> dict
        PATCH /repos/{owner}/{repo}/issues/{n}
    rest_open_pr(repo, head, base, title, body, *, draft=False) -> dict
        POST /repos/{owner}/{repo}/pulls
    rest_merge_pr(repo, n, *, method="squash", commit_title=None,
                  commit_message=None) -> dict
        PUT /repos/{owner}/{repo}/pulls/{n}/merge

Reads (2):
    rest_issue_view(repo, n) -> dict
        GET /repos/{owner}/{repo}/issues/{n}
    rest_pr_view(repo, n) -> dict
        GET /repos/{owner}/{repo}/pulls/{n}

Each helper returns the raw GitHub REST response dict (parsed JSON). On
non-zero ``gh`` exit, every helper raises :class:`GhRestError` carrying
``stderr``, ``exit_code``, ``endpoint``, ``payload``, and a human-readable
``hint``. ``InvalidRepoError`` is raised when the ``"owner/repo"`` argument
is malformed.

Design notes
------------
- **Repo string format**: ``"owner/repo"`` (matches gh CLI ergonomics).
  Helpers split internally for the REST URL template via ``_split_repo``.
- **Binary routing**: helpers invoke ``<binary> api ...`` where
  ``<binary>`` comes from ``scripts.scm.resolve_binary`` (ghx -> gh ladder
  per #884). For mutations, ``ghx`` is semantically a no-op (it forwards
  mutations and invalidates cache; no benefit) but routing through the
  ladder anyway preserves consistency with the existing
  ``_BINARY_PREFERENCE`` chain. For reads, ``ghx`` provides genuine
  within-session dedup benefit per the lessons.md
  ``## ghx Within-Session Cache vs deft-cache Cross-Session Persistence
  (2026-05)`` entry.
- **JSON payload UTF-8 safety**: every mutation payload is built via
  Python ``pathlib.Path.write_text(text, encoding="utf-8")`` then passed
  to ``gh api --input <path>``. No PowerShell 5.1 inline-string operations
  anywhere in this module. Closes the recurring mojibake hazard chain
  (#236 / #240 / #283 / PR #795 / #798) at the gh-mutation call sites.
- **Return shape**: each helper returns the raw GitHub REST response dict.
  It does NOT mimic ``gh ...``'s GraphQL-augmented shape -- ``gh issue
  view --json closingIssuesReferences`` returns fields that REST
  ``GET /issues/{n}`` does not have. Callers needing those fields compose
  explicitly.
- **Test seam**: the module-level ``_run_gh_api`` indirection is the
  single subprocess seam. Tests monkeypatch this one function rather than
  ``subprocess.run`` for each helper.

Out of scope (per issue #961, by design)
----------------------------------------
- **Releases** (``POST /releases``, ``PATCH /releases/<id>``). Different
  concern -- ``task release`` (#74) owns release creation via
  ``gh release create``. The companion ``scripts/release_publish.py`` (#716)
  uses inline ``gh api`` REST calls directly for its draft->public flip;
  releases are intentionally NOT wrapped by this module.
- **Branch operations** (delete, protect, etc.). Existing direct
  ``gh api`` invocations in ``scripts/release.py`` and ``scripts/policy.py``
  remain.
- **Label / assignee / reviewer mutations**. Add when first call site
  needs them.
- **rest_pr_checks** (CI check-runs polling). Candidate for v2.

Known limitations (REST-impossible mutations)
---------------------------------------------
Two mutations CANNOT be REST-fallback'd because they are GraphQL-only on
the GitHub side:

- ``gh pr ready`` (mark draft -> ready). GitHub's GraphQL
  ``markPullRequestReadyForReview`` has no REST equivalent. When GraphQL
  is exhausted, draft PRs CANNOT be promoted to ready without waiting for
  the bucket reset. Workaround: open PRs non-draft when possible.
- ``gh pr review --approve`` / ``--request-changes``. GraphQL-only
  mutation ``addPullRequestReview``. Workaround: post a comment via
  :func:`rest_post_comment` (no approval semantics, but unblocks
  conversation).

Cross-references
----------------
- meta/lessons.md ``## gh CLI GraphQL Bucket Exhaustion + REST Fallback
  + UTF-8 Payload Pattern (2026-05)``
- meta/lessons.md ``## REST-fallback module surface (2026-05)``
  (deterministic-tier follow-up cross-reference for this module)
- templates/agent-prompt-preamble.md S5 (REST-by-default rule)
- AGENTS.md ``## Multi-agent orchestration discipline (#954)``
- scripts/scm.py::resolve_binary (binary ladder)

Refs #961, #884, #74, #798.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Make sibling scripts importable so we can re-use scm.resolve_binary
# without duplicating the ghx -> gh ladder.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import scm  # noqa: E402

#: Default subprocess timeout. Mirrors scripts/release_publish.py and
#: scripts/release.py (60s) so a hung gh process never wedges the caller.
DEFAULT_TIMEOUT_S: int = 60

#: Public surface -- the seven helpers exported by this module per the
#: issue #961 acceptance criteria. The module-level test
#: TestPublicSurfaceContract pins this set; adding a helper requires
#: updating the test in lockstep.
PUBLIC_HELPERS: tuple[str, ...] = (
    "rest_create_issue",
    "rest_post_comment",
    "rest_close_issue",
    "rest_open_pr",
    "rest_merge_pr",
    "rest_issue_view",
    "rest_pr_view",
)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class InvalidRepoError(ValueError):
    """Raised when the ``"owner/repo"`` argument is malformed.

    Examples that raise:
        ``""``, ``"owner"``, ``"owner/"``, ``"/repo"``,
        ``"owner/repo/extra"``, non-string arguments.
    """


@dataclass
class GhRestError(RuntimeError):
    """Raised on non-zero ``gh api`` exit or non-JSON success response.

    Attributes:
        stderr: Captured stderr from the ``gh api`` invocation, stripped.
        exit_code: Process exit code (0 for non-JSON success cases).
        endpoint: REST endpoint path (e.g. ``"repos/owner/name/issues"``).
        payload: Mutation payload that was POSTed/PATCHed/PUT, or ``None``
            for read operations.
        hint: Actionable recovery hint (auth, permissions, rate-limit, etc.).

    The dataclass form gives callers a structured error surface (test
    assertions can introspect ``exc.endpoint``, ``exc.exit_code``, etc.)
    without parsing the message string.
    """

    stderr: str
    exit_code: int
    endpoint: str
    payload: dict[str, Any] | None
    hint: str = ""

    def __post_init__(self) -> None:
        # Build the human-readable message once so callers can either
        # inspect the structured attributes OR fall back to str(exc).
        msg = (
            f"gh api failed: endpoint={self.endpoint!r} "
            f"exit={self.exit_code} stderr={self.stderr!r}"
        )
        if self.hint:
            msg += f"; hint: {self.hint}"
        # RuntimeError.__init__ takes *args; pass the assembled message.
        super().__init__(msg)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _split_repo(repo: str) -> tuple[str, str]:
    """Split a ``"owner/repo"`` string into ``(owner, repo)`` components.

    Raises:
        InvalidRepoError: On any malformed input -- empty string, missing
            slash, multiple slashes, empty owner/repo segments, non-string
            arguments. The error message echoes the offending value so
            operators can correlate it to the call site.
    """
    if not isinstance(repo, str) or not repo:
        raise InvalidRepoError(
            f"repo must be a non-empty string of the form 'owner/repo'; "
            f"got {repo!r}"
        )
    parts = repo.split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise InvalidRepoError(
            f"repo must match 'owner/repo' (single slash, both segments "
            f"non-empty); got {repo!r}"
        )
    return parts[0], parts[1]


def _run_gh_api(
    args: list[str], *, timeout: int = DEFAULT_TIMEOUT_S
) -> subprocess.CompletedProcess[str]:
    """Single subprocess seam invoked by every helper.

    Tests monkeypatch this function (``gh_rest._run_gh_api``) instead of
    patching ``subprocess.run`` for each helper -- one seam, hermetic
    coverage of all seven helpers.

    The binary is resolved via ``scm.resolve_binary`` (ghx -> gh ladder
    per #884). The argv passed in is ``["api", *args]`` -- callers do NOT
    include the binary name.
    """
    binary = scm.resolve_binary()
    cmd = [binary, "api", *args]
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=os.environ.copy(),
    )


def _write_json_payload(payload: dict[str, Any]) -> Path:
    """Serialise ``payload`` to a tempfile via Python pathlib UTF-8.

    The two-step (write_text + utf-8 encoding) approach is the
    PowerShell-5.1-safe canonical form documented in
    ``meta/lessons.md`` ``## gh CLI GraphQL Bucket Exhaustion + REST
    Fallback + UTF-8 Payload Pattern (2026-05)``. ``ensure_ascii=False``
    preserves non-ASCII glyphs (em dashes, arrows, smart quotes) as
    canonical UTF-8 bytes -- the alternative escapes them to ``\\uXXXX``
    which round-trips correctly but bloats the payload and obscures the
    bytes operators see when debugging.

    Caller is responsible for unlinking the file after the gh call
    completes (mutations always do this in a ``try/finally``).
    """
    fd, name = tempfile.mkstemp(suffix=".json", prefix="gh_rest_payload_")
    os.close(fd)
    path = Path(name)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def _exec(
    args: list[str],
    *,
    endpoint: str,
    payload: dict[str, Any] | None,
    hint: str = "",
) -> dict[str, Any]:
    """Run ``gh api`` and parse the JSON response, raising on failure.

    All seven helpers funnel through this one function so the error-path
    semantics (typed exception with structured attributes) are uniform.
    """
    result = _run_gh_api(args)
    if result.returncode != 0:
        raise GhRestError(
            stderr=(result.stderr or "").strip(),
            exit_code=int(result.returncode),
            endpoint=endpoint,
            payload=payload,
            hint=hint,
        )
    stdout = (result.stdout or "").strip()
    if not stdout:
        # Some PUT/PATCH responses may return 204 No Content; ``gh api``
        # surfaces this as empty stdout + zero exit. Treat as success
        # with an empty dict so callers do not need to special-case.
        return {}
    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise GhRestError(
            stderr=f"non-JSON response: {exc}; raw={stdout!r}",
            exit_code=0,
            endpoint=endpoint,
            payload=payload,
            hint="REST endpoint returned non-JSON; check gh / ghx version",
        ) from exc
    if not isinstance(parsed, dict):
        # All seven endpoints return a top-level object on success. A
        # list response would indicate a bug (wrong endpoint) or a gh
        # version mismatch; raise so callers do not silently mishandle.
        raise GhRestError(
            stderr=f"unexpected top-level type {type(parsed).__name__}",
            exit_code=0,
            endpoint=endpoint,
            payload=payload,
            hint="REST endpoint returned non-object; expected dict",
        )
    return parsed


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def rest_create_issue(
    repo: str,
    title: str,
    body: str,
    labels: tuple[str, ...] = (),
) -> dict[str, Any]:
    """``POST /repos/{owner}/{repo}/issues`` -- create a new issue.

    Args:
        repo: ``"owner/repo"`` slug.
        title: Issue title.
        body: Issue body (markdown). UTF-8 round-trip safe via
            ``_write_json_payload``.
        labels: Optional iterable of label names to apply on creation.
            Empty tuple (default) creates the issue with no labels.

    Returns:
        Parsed JSON response dict (the GitHub REST issue object: number,
        title, body, state, html_url, user, labels, ...).

    Raises:
        InvalidRepoError: Malformed ``repo`` argument.
        GhRestError: Non-zero ``gh api`` exit (auth, permissions,
            label-not-found, rate-limit, ...).
    """
    owner, name = _split_repo(repo)
    payload: dict[str, Any] = {"title": title, "body": body}
    if labels:
        payload["labels"] = list(labels)
    payload_path = _write_json_payload(payload)
    try:
        endpoint = f"repos/{owner}/{name}/issues"
        return _exec(
            [endpoint, "--method", "POST", "--input", str(payload_path)],
            endpoint=endpoint,
            payload=payload,
            hint=(
                "verify repo permissions, label existence, and that the "
                "core REST bucket has remaining quota"
            ),
        )
    finally:
        with contextlib.suppress(OSError):
            payload_path.unlink()


def rest_post_comment(repo: str, n: int, body: str) -> dict[str, Any]:
    """``POST /repos/{owner}/{repo}/issues/{n}/comments`` -- post a comment.

    Works for both issues AND pull requests (PRs are issues in the GitHub
    REST data model; ``/issues/{n}/comments`` is the canonical comment
    endpoint for both).

    Args:
        repo: ``"owner/repo"`` slug.
        n: Issue or PR number.
        body: Comment body (markdown). UTF-8 round-trip safe.

    Returns:
        Parsed REST comment object (id, body, html_url, user, ...).

    Raises:
        InvalidRepoError: Malformed ``repo``.
        GhRestError: Non-zero ``gh api`` exit.
    """
    owner, name = _split_repo(repo)
    payload: dict[str, Any] = {"body": body}
    payload_path = _write_json_payload(payload)
    try:
        endpoint = f"repos/{owner}/{name}/issues/{n}/comments"
        return _exec(
            [endpoint, "--method", "POST", "--input", str(payload_path)],
            endpoint=endpoint,
            payload=payload,
            hint=(
                "verify repo permissions, that the issue/PR is open or "
                "lockable, and core REST bucket quota"
            ),
        )
    finally:
        with contextlib.suppress(OSError):
            payload_path.unlink()


def rest_close_issue(
    repo: str, n: int, *, reason: str | None = "completed"
) -> dict[str, Any]:
    """``PATCH /repos/{owner}/{repo}/issues/{n}`` -- close an issue.

    Args:
        repo: ``"owner/repo"`` slug.
        n: Issue number.
        reason: ``state_reason`` per the GitHub REST API. Allowed values
            are ``"completed"`` (default), ``"not_planned"``,
            ``"reopened"``, or ``None`` for unset. The default mirrors
            ``gh issue close --reason completed``. Greptile P2-3 (#961):
            the type annotation is ``str | None`` because the docstring
            documents ``None`` as a supported value (the GitHub REST
            API accepts ``"state_reason": null`` to clear it); the
            annotation now matches that contract.

    Returns:
        Parsed REST issue object reflecting the post-close state.

    Raises:
        InvalidRepoError: Malformed ``repo``.
        GhRestError: Non-zero ``gh api`` exit.
    """
    owner, name = _split_repo(repo)
    payload: dict[str, Any] = {"state": "closed", "state_reason": reason}
    payload_path = _write_json_payload(payload)
    try:
        endpoint = f"repos/{owner}/{name}/issues/{n}"
        return _exec(
            [endpoint, "--method", "PATCH", "--input", str(payload_path)],
            endpoint=endpoint,
            payload=payload,
            hint=(
                "verify repo permissions and that the issue is open "
                "(closing a closed issue is idempotent server-side)"
            ),
        )
    finally:
        with contextlib.suppress(OSError):
            payload_path.unlink()


def rest_open_pr(
    repo: str,
    head: str,
    base: str,
    title: str,
    body: str,
    *,
    draft: bool = False,
) -> dict[str, Any]:
    """``POST /repos/{owner}/{repo}/pulls`` -- open a pull request.

    Args:
        repo: ``"owner/repo"`` slug.
        head: Source branch (``"feature/..."``); for cross-fork PRs use
            ``"forkowner:branch"``.
        base: Target branch (typically ``"master"`` or ``"main"``).
        title: PR title.
        body: PR description (markdown). UTF-8 round-trip safe.
        draft: When ``True``, creates the PR in draft state. The
            companion ``gh pr ready`` (mark-ready-for-review) mutation
            is GraphQL-only -- see module docstring known limitations.

    Returns:
        Parsed REST pull request object (number, html_url, head, base,
        draft, user, ...).

    Raises:
        InvalidRepoError: Malformed ``repo``.
        GhRestError: Non-zero ``gh api`` exit (no diff between head and
            base, branch missing, repo permissions, ...).
    """
    owner, name = _split_repo(repo)
    payload: dict[str, Any] = {
        "title": title,
        "head": head,
        "base": base,
        "body": body,
        "draft": draft,
    }
    payload_path = _write_json_payload(payload)
    try:
        endpoint = f"repos/{owner}/{name}/pulls"
        return _exec(
            [endpoint, "--method", "POST", "--input", str(payload_path)],
            endpoint=endpoint,
            payload=payload,
            hint=(
                "verify branch exists on origin, head/base differ, repo "
                "permissions, and core REST bucket quota"
            ),
        )
    finally:
        with contextlib.suppress(OSError):
            payload_path.unlink()


def rest_merge_pr(
    repo: str,
    n: int,
    *,
    method: str = "squash",
    commit_title: str | None = None,
    commit_message: str | None = None,
) -> dict[str, Any]:
    """``PUT /repos/{owner}/{repo}/pulls/{n}/merge`` -- merge a pull request.

    Args:
        repo: ``"owner/repo"`` slug.
        n: PR number.
        method: One of ``"squash"`` (default), ``"merge"``, ``"rebase"``.
            Mirrors the GitHub REST ``merge_method`` field.
        commit_title: Optional override for the merge commit title.
        commit_message: Optional override for the merge commit body.

    Returns:
        Parsed REST merge response (sha, merged, message).

    Raises:
        InvalidRepoError: Malformed ``repo``.
        GhRestError: Non-zero ``gh api`` exit (PR not mergeable, branch
            protection refusal, draft PR, ...).
    """
    owner, name = _split_repo(repo)
    payload: dict[str, Any] = {"merge_method": method}
    if commit_title is not None:
        payload["commit_title"] = commit_title
    if commit_message is not None:
        payload["commit_message"] = commit_message
    payload_path = _write_json_payload(payload)
    try:
        endpoint = f"repos/{owner}/{name}/pulls/{n}/merge"
        return _exec(
            [endpoint, "--method", "PUT", "--input", str(payload_path)],
            endpoint=endpoint,
            payload=payload,
            hint=(
                "verify PR is non-draft, mergeable, branch-protection "
                "checks pass, and required reviews are satisfied"
            ),
        )
    finally:
        with contextlib.suppress(OSError):
            payload_path.unlink()


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def rest_issue_view(repo: str, n: int) -> dict[str, Any]:
    """``GET /repos/{owner}/{repo}/issues/{n}`` -- read a single issue.

    Note: REST does NOT return the ``closingIssuesReferences`` /
    ``timelineItems`` fields that ``gh issue view --json`` (GraphQL)
    does. Callers needing those fields must use a separate path.

    Args:
        repo: ``"owner/repo"`` slug.
        n: Issue number.

    Returns:
        Parsed REST issue object.

    Raises:
        InvalidRepoError: Malformed ``repo``.
        GhRestError: Non-zero ``gh api`` exit (404 not found, 403 auth,
            ...).
    """
    owner, name = _split_repo(repo)
    endpoint = f"repos/{owner}/{name}/issues/{n}"
    return _exec(
        [endpoint],
        endpoint=endpoint,
        payload=None,
        hint="verify repo and issue number; check gh auth status",
    )


def rest_pr_view(repo: str, n: int) -> dict[str, Any]:
    """``GET /repos/{owner}/{repo}/pulls/{n}`` -- read a single pull request.

    Note: REST does NOT return ``mergeStateStatus``, ``reviewDecision``,
    or ``isDraft`` field naming that the GraphQL ``gh pr view --json``
    surface uses. The REST ``draft`` field is the canonical equivalent
    of the GraphQL ``isDraft`` field; ``mergeable_state`` is the
    closest REST equivalent of the GraphQL ``mergeStateStatus``.

    Args:
        repo: ``"owner/repo"`` slug.
        n: PR number.

    Returns:
        Parsed REST pull request object.

    Raises:
        InvalidRepoError: Malformed ``repo``.
        GhRestError: Non-zero ``gh api`` exit.
    """
    owner, name = _split_repo(repo)
    endpoint = f"repos/{owner}/{name}/pulls/{n}"
    return _exec(
        [endpoint],
        endpoint=endpoint,
        payload=None,
        hint="verify repo and PR number; check gh auth status",
    )


__all__ = [
    "DEFAULT_TIMEOUT_S",
    "GhRestError",
    "InvalidRepoError",
    "PUBLIC_HELPERS",
    "rest_close_issue",
    "rest_create_issue",
    "rest_issue_view",
    "rest_merge_pr",
    "rest_open_pr",
    "rest_post_comment",
    "rest_pr_view",
]
