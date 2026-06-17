#!/usr/bin/env python3
"""scripts/scm.py -- minimal scm:* stub wrapper for #883 v1 cache layer (Story 1).

DO NOT EXTEND. The full scm:* namespace lives at #881; this script is replaced
wholesale when #881 lands. The stub exposes only the four ``issue:*`` commands
the v1 cache consumer (Story 2 ``cache:fetch-all``) needs:

    scm.py issue list   <pass-through args>
    scm.py issue view   <pass-through args>
    scm.py issue close  <pass-through args>
    scm.py issue edit   <pass-through args>

Each command is a thin pass-through to ``ghx <namespace> <verb> ...`` when
``ghx`` is on PATH, falling back to ``gh <namespace> <verb> ...`` otherwise.
This mirrors the #884 ``ghx-as-standard-gh-proxy`` recommendation while
keeping the stub functional on machines where only ``gh`` is installed.

The JSON-shape contract Story 2 consumes is pinned independently by the
``tests/test_scm_contract.py`` contract test against
``tests/fixtures/scm_issue_view.json`` -- this script does NOT validate or
transform the JSON; it forwards stdout/stderr/exit-code from the underlying
binary verbatim.

REST opt-in mode (#976)
-----------------------
A new ``--rest`` flag is recognised on ``issue view`` and ``issue list``
invocations. When present, the stub routes the read through the REST
helpers in :mod:`scripts.gh_rest` (``rest_issue_view`` /
``rest_issue_list``) instead of forwarding ``gh issue view|list`` to the
underlying binary. This sidesteps the GraphQL bucket entirely so a
depleted ``graphql.remaining`` (a recurring failure mode -- see #976,
#961, #884) no longer fails read-only smoke / cache flows.

The REST shape differs from the gh ``--json`` GraphQL shape (e.g. REST
emits ``user`` not ``author``, ``created_at`` not ``createdAt``, lower-
case ``state``). Story 2 ``cache:fetch-all`` continues to consume the
legacy GraphQL shape via the default code path; only callers that
opt in via ``--rest`` see the REST shape. The smoke test
(``tests/integration/test_scm_smoke.py``) and any other non-cache
reader can opt in safely. Mutations (``close``, ``edit``) still
forward to ``gh`` -- they have non-trivial flag surfaces (--body-file,
--add-label, --remove-label, ...) that this stub deliberately does not
re-implement; #881 owns the full surface.

GraphQL-only operations (cannot be REST-migrated)
--------------------------------------------------
GitHub exposes two PR-state mutations only via GraphQL; they have NO
REST equivalent and remain budgeted GraphQL spend wherever they appear:

- ``markPullRequestReadyForReview`` (``gh pr ready``). Used by the
  release/PR flow; documented in
  :mod:`scripts.gh_rest` module docstring known limitations.
- ``addPullRequestReview`` (``gh pr review --approve|--request-changes``).
  Required for formal review verdicts; ``rest_post_comment`` is the
  REST-budget alternative when no approval semantics are needed.

Future agents touching this stub: those two surfaces are accidental-drain-free
and legitimate GraphQL spend. Every OTHER GraphQL-backed gh invocation in
this stub's surface is candidate for REST migration -- the ``--rest`` flag
is the v1 wedge.
"""

from __future__ import annotations

import importlib
import json
import shutil
import subprocess
import sys
from collections.abc import Sequence
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Allowed ``<namespace>`` argv[1] -- the v1 stub only exposes ``issue``.
#: PR commands (#881 future) and any other namespace are rejected loudly so
#: a typo doesn't silently dispatch unexpected gh subcommands.
_ALLOWED_NAMESPACES: tuple[str, ...] = ("issue",)

#: Source-aware shim (#1145 / N5) supported sources. v1 ships with only
#: ``github-issue``; ``gitlab`` / ``gitea`` / ``local`` are placeholders for
#: #445 / #935 Workstream 6 and raise :class:`NotImplementedError` with the
#: canonical message documented on issue #1145. Adding a source here without
#: a matching backend implementation in :func:`call` is a bug -- the verifier
#: :mod:`scripts.verify_scm_boundary` does not enforce backend coverage, but
#: the unit test ``tests/test_scm_call.py::test_unknown_source_raises`` pins
#: the exhaustive-source contract.
_SUPPORTED_CALL_SOURCES: tuple[str, ...] = ("github-issue",)

#: Allowed ``<verb>`` argv[2] for the ``issue`` namespace. Mirrors the four
#: AC-1 commands in vbrief/active/2026-05-05-883-story-1-scm-stub.vbrief.json.
_ALLOWED_ISSUE_VERBS: tuple[str, ...] = ("list", "view", "close", "edit")

#: Binary preference order. ``ghx`` is the #884 standard proxy; ``gh`` is the
#: canonical fallback. Tests parametrise this via subprocess + shutil.which
#: mocks so the fallback path is exercised independent of the host PATH.
_BINARY_PREFERENCE: tuple[str, ...] = ("ghx", "gh")


class ScmStubError(RuntimeError):
    """Raised on argv-validation or binary-resolution failures."""


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def resolve_binary() -> str:
    """Return ``"ghx"`` if on PATH, else ``"gh"``; raise if neither is present.

    The fallback order is fixed by :data:`_BINARY_PREFERENCE` so a regression
    that re-orders or shadows a binary fails the unit test in
    ``tests/test_scm_stub.py`` rather than silently dispatching to the wrong
    proxy. Both binaries accept identical ``issue list/view/close/edit``
    surfaces for the v1 stub's purposes.
    """
    for candidate in _BINARY_PREFERENCE:
        if shutil.which(candidate) is not None:
            return candidate
    raise ScmStubError(
        "neither 'ghx' nor 'gh' found on PATH; install GitHub CLI "
        "(https://cli.github.com/) or the ghx proxy (#884)"
    )


# ---------------------------------------------------------------------------
# Argv shaping
# ---------------------------------------------------------------------------


def build_command(
    namespace: str, verb: str, extra: Sequence[str], *, binary: str | None = None
) -> list[str]:
    """Construct the underlying ``[binary, namespace, verb, *extra]`` argv.

    Args:
        namespace: One of :data:`_ALLOWED_NAMESPACES`. Anything else raises
            :class:`ScmStubError` -- the stub deliberately refuses unknown
            namespaces so a typo (``isue``) doesn't get forwarded to gh and
            produce a confusing native-error message.
        verb: For ``issue``, one of :data:`_ALLOWED_ISSUE_VERBS`. Same loud-
            failure rationale as namespace validation.
        extra: Pass-through positional / option args. Forwarded verbatim;
            this stub does NOT inspect or rewrite them.
        binary: Optional override for the resolved binary. When ``None``,
            :func:`resolve_binary` is consulted. Tests pass an explicit
            value so they don't depend on the host PATH.

    Returns:
        The argv list ready for :func:`subprocess.run`.
    """
    if namespace not in _ALLOWED_NAMESPACES:
        raise ScmStubError(
            f"unknown scm namespace {namespace!r}; expected one of "
            f"{_ALLOWED_NAMESPACES}. The full scm:* namespace lives at #881."
        )
    if namespace == "issue" and verb not in _ALLOWED_ISSUE_VERBS:
        raise ScmStubError(
            f"unknown scm:issue verb {verb!r}; expected one of "
            f"{_ALLOWED_ISSUE_VERBS}. The v1 stub only exposes these four; "
            "additional scm:issue:* commands belong on #881."
        )
    resolved = binary if binary is not None else resolve_binary()
    return [resolved, namespace, verb, *extra]


# ---------------------------------------------------------------------------
# Source-aware call shim (#1145 / N5)
# ---------------------------------------------------------------------------


def call(
    source: str,
    verb: str,
    args: Sequence[str] | None = None,
    *,
    check: bool = False,
    capture_output: bool = True,
    text: bool = True,
    timeout: float | None = None,
    cwd: str | None = None,
    binary: str | None = None,
    **kwargs: Any,
) -> subprocess.CompletedProcess[str]:
    """Source-aware SCM invocation -- partial down-payment on #445 / #935 Workstream 6.

    This is the single seam through which the deft framework's verb layer
    (``scripts/triage_*.py``, ``scripts/scope_*.py``, ``scripts/slice_*.py``,
    ``scripts/issue_ingest.py``, ...) invokes the underlying SCM CLI.
    Pre-N5, every consumer called ``subprocess.run(["gh", ...])`` directly;
    the first non-GitHub consumer would have hit an undocumented coupling
    deep in the call stack. The shim relocates that coupling to one
    indirection point so the full SCM abstraction (#445 / #935 Workstream 6)
    has a single seam to extend.

    Routing (v1):

    - ``source="github-issue"`` -- forwards to ``[binary, verb, *args]``
      where ``binary`` comes from :func:`resolve_binary` (the #884
      ``ghx`` -> ``gh`` preference ladder). This is the only source v1
      implements.
    - Any other source (``"gitlab"``, ``"gitea"``, ``"local"``, ...)
      raises :class:`NotImplementedError` with the canonical message
      ``"source=<x> not yet supported; see #445 / #935 Workstream 6 for
      the abstraction."`` so a consumer on a non-GitHub forge sees the
      deferred abstraction immediately instead of an obscure
      ``"gh: command not found"`` deep in the call stack.

    Args:
        source: Forge identity for the invocation. Currently only
            ``"github-issue"`` is implemented; see
            :data:`_SUPPORTED_CALL_SOURCES` for the contract.
        verb: The CLI verb passed to the resolved binary (e.g. ``"issue"``,
            ``"api"``, ``"pr"``). Forwarded verbatim as the first argv
            element after the binary; this shim deliberately does NOT
            validate the verb so callers can use any surface the
            underlying binary supports.
        args: Pass-through positional / option args appended after
            ``verb``. Defaults to an empty sequence.
        check: Forwarded to :func:`subprocess.run`. Defaults to ``False``
            so callers can inspect non-zero exits without an exception;
            mutation call sites that want loud failures opt in via
            ``check=True``.
        capture_output / text: Forwarded to :func:`subprocess.run`.
            Defaults to capture+text so the common "parse stdout" usage
            works without extra plumbing.
        timeout: Optional wall-clock cap forwarded to
            :func:`subprocess.run`. Mirrors the existing per-call-site
            timeouts (e.g. ``issue_ingest._fetch_single_issue`` uses
            30s).
        cwd: Optional working directory forwarded to
            :func:`subprocess.run`.
        binary: Optional override for the resolved binary. Tests pass
            this so they don't depend on the host PATH.
        **kwargs: Additional :func:`subprocess.run` keyword args
            (``env``, ``input``, ``stdin``, ...).

    Returns:
        The :class:`subprocess.CompletedProcess` from the underlying
        invocation -- the shim does not parse or transform stdout /
        stderr / returncode.

    Raises:
        NotImplementedError: When ``source`` is not in
            :data:`_SUPPORTED_CALL_SOURCES`. The error message points at
            #445 / #935 Workstream 6 so consumers on GitLab / Gitea /
            local backends see the deferred abstraction immediately.
        ScmStubError: When neither ``gh`` nor ``ghx`` is on PATH and no
            explicit ``binary`` override was provided.

    Notes on the verifier (`scripts/verify_scm_boundary.py`):
        The companion deterministic gate scans tracked Python files in
        the verb-layer scope (``scripts/triage_*.py``,
        ``scripts/scope_*.py``, ``scripts/slice_*.py``,
        ``scripts/_triage_*.py``, ``scripts/_scope_*.py``,
        ``scripts/resume_conditions.py``, ``scripts/issue_ingest.py``)
        for subprocess / Popen / os.system invocations whose first
        argv element is the literal ``"gh"`` or ``"ghx"``. Any such
        call in those files is a violation because it bypasses this
        shim. The verifier deliberately scopes by file glob rather
        than scanning every tracked Python file so release tooling,
        REST helpers (:mod:`scripts.gh_rest`), and the ghx installer
        (:mod:`scripts.setup_ghx`) -- which have legitimate direct-gh
        responsibilities -- are not flagged.
    """
    if source not in _SUPPORTED_CALL_SOURCES:
        raise NotImplementedError(
            f"source={source!r} not yet supported; "
            "see #445 / #935 Workstream 6 for the abstraction."
        )
    resolved = binary if binary is not None else resolve_binary()
    argv = [resolved, verb, *(args if args is not None else ())]
    return subprocess.run(
        argv,
        check=check,
        capture_output=capture_output,
        text=text,
        timeout=timeout,
        cwd=cwd,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# REST opt-in (#976)
# ---------------------------------------------------------------------------

#: Verbs that support the ``--rest`` opt-in. Only read paths -- mutations
#: (close, edit) keep forwarding to gh in the v1 stub.
_REST_OPT_IN_VERBS: tuple[str, ...] = ("view", "list")


def _extract_flag(extra: list[str], flag: str) -> tuple[bool, list[str]]:
    """Return ``(present, remainder)`` after removing every occurrence of ``flag``.

    Used to peel off the ``--rest`` opt-in flag before the remaining argv
    is consumed by the REST dispatcher (or, in the legacy path, forwarded
    to ``ghx|gh``).
    """
    present = flag in extra
    remainder = [a for a in extra if a != flag]
    return present, remainder


def _extract_value_flag(
    extra: list[str], flag: str, default: str | None = None
) -> tuple[str | None, list[str]]:
    """Return ``(value, remainder)`` for ``--flag VALUE`` or ``--flag=VALUE``.

    Removes the consumed tokens from ``extra``. Mirrors the small subset of
    argv parsing the stub does so it can extract ``--repo`` / ``--json`` /
    ``--state`` etc. from the pass-through args without pulling in argparse.
    The first occurrence wins; a missing flag returns ``default``.
    """
    out: list[str] = []
    value = default
    seen = False
    i = 0
    while i < len(extra):
        token = extra[i]
        if not seen and token == flag and i + 1 < len(extra):
            value = extra[i + 1]
            seen = True
            i += 2
            continue
        if not seen and token.startswith(flag + "="):
            value = token.split("=", 1)[1]
            seen = True
            i += 1
            continue
        out.append(token)
        i += 1
    return value, out


def _filter_json_fields(obj: Any, fields: Sequence[str]) -> Any:
    """Project ``obj`` (dict or list[dict]) onto ``fields``.

    Mirrors gh's ``--json field1,field2`` semantics for the REST shape:
    only the named keys survive. Unknown fields are silently dropped
    rather than raised, matching gh's own behaviour. Empty ``fields``
    returns ``obj`` unchanged so callers that omit ``--json`` get the
    full REST response.
    """
    if not fields:
        return obj
    field_set = list(fields)
    if isinstance(obj, list):
        return [_filter_json_fields(item, field_set) for item in obj]
    if isinstance(obj, dict):
        return {k: obj[k] for k in field_set if k in obj}
    return obj


def _run_rest_view(extra: list[str]) -> int:
    """Dispatch ``scm.py issue view --rest <N> --repo X [--json fields]``.

    Routes through :func:`scripts.gh_rest.rest_issue_view` so the read
    never touches GraphQL. Emits the REST response (filtered to
    ``--json`` fields if provided) to stdout as JSON, mirroring the
    legacy gh stdout contract callers consume.

    Unknown flags (anything beginning with ``-`` after stripping the
    consumed ``--repo`` / ``--json``) are rejected loudly so an
    operator-side typo (e.g. ``--state closed`` accidentally passed to
    ``issue view``) surfaces immediately rather than being silently
    ignored. Greptile P2 (#976 review): the prior implementation kept
    these tokens in ``extra`` after extraction and never inspected
    them again; the user got an unrelated successful response.
    """
    repo, extra = _extract_value_flag(extra, "--repo")
    json_spec, extra = _extract_value_flag(extra, "--json")
    if not repo:
        print("error: --rest issue view requires --repo OWNER/NAME", file=sys.stderr)
        return 2
    # The remaining positional arg (after stripping --repo/--json) is the
    # issue number. Reject extra unknown flags loudly so a typo is caught.
    positionals = [t for t in extra if not t.startswith("-")]
    leftover_flags = [t for t in extra if t.startswith("-")]
    if leftover_flags:
        print(
            f"error: --rest issue view does not recognise these flags: "
            f"{leftover_flags!r}. Supported flags are --repo, --json. "
            "Mutations / additional read filters belong on #881.",
            file=sys.stderr,
        )
        return 2
    if len(positionals) != 1:
        print(
            "error: --rest issue view expects exactly one positional issue "
            f"number; got {positionals!r}",
            file=sys.stderr,
        )
        return 2
    try:
        issue_n = int(positionals[0])
    except ValueError:
        print(
            f"error: issue number must be an integer; got {positionals[0]!r}",
            file=sys.stderr,
        )
        return 2
    gh_rest = importlib.import_module("gh_rest")
    try:
        response = gh_rest.rest_issue_view(repo, issue_n)
    except gh_rest.InvalidRepoError as exc:
        # InvalidRepoError is a ValueError subclass raised by
        # gh_rest._split_repo when --repo lacks the OWNER/NAME shape
        # (e.g. ``--repo directive`` instead of ``--repo deftai/directive``).
        # Treat it as an arg-validation failure (exit 2) so the user
        # sees a clean error rather than an uncaught traceback.
        # Greptile P1 #998 review at 367748e.
        print(f"error: invalid --repo value: {exc}", file=sys.stderr)
        return 2
    except gh_rest.GhRestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    fields = [f.strip() for f in json_spec.split(",")] if json_spec else []
    filtered = _filter_json_fields(response, fields)
    print(json.dumps(filtered, ensure_ascii=False))
    return 0


def _run_rest_list(extra: list[str]) -> int:
    """Dispatch ``scm.py issue list --rest --repo X [...flags]``.

    Supported flags: ``--state {open|closed|all}`` (default open),
    ``--label NAME[,NAME...]`` (comma-separated label filter; multi-flag
    repetition `--label A --label B` is also accepted and merged into
    the same filter set), ``--author LOGIN`` (#1055 -- filter by issue
    creator; maps to the REST ``creator`` param and composes with
    ``--label`` via AND), ``--limit N`` (REST per_page, default 30),
    ``--json field1,field2`` (project the response onto the named keys,
    list-aware).

    Unknown flags after stripping the consumed flag set are rejected
    loudly (Greptile P2 #976 review): the prior implementation silently
    dropped any leftover ``--foo`` token, which produced subtly wrong
    behaviour (e.g. a typo'd ``--label-name`` was ignored without error).

    The list verb takes NO positional arguments; any leftover positional
    token is rejected loudly so a caller who typo'd `issue list --rest 123
    --repo o/r` (meaning `issue view`) sees the mistake immediately
    instead of receiving the full open-issues collection silently
    (Greptile P1 #976 second-pass review). Mirrors the parallel guard
    in ``_run_rest_view`` for symmetry.

    Routes through :func:`scripts.gh_rest.rest_issue_list`.
    """
    repo, extra = _extract_value_flag(extra, "--repo")
    state, extra = _extract_value_flag(extra, "--state", default="open")
    json_spec, extra = _extract_value_flag(extra, "--json")
    author, extra = _extract_value_flag(extra, "--author")
    # --label may appear multiple times; collect all occurrences and
    # merge with comma-separated values from any single occurrence.
    label_values: list[str] = []
    while True:
        label_part, extra = _extract_value_flag(extra, "--label")
        if label_part is None:
            break
        label_values.append(label_part)
    limit_str, extra = _extract_value_flag(extra, "--limit", default="30")
    leftover_flags = [t for t in extra if t.startswith("-")]
    if leftover_flags:
        print(
            f"error: --rest issue list does not recognise these flags: "
            f"{leftover_flags!r}. Supported flags are --repo, --state, "
            "--label, --author, --limit, --json. Additional filters "
            "belong on #881.",
            file=sys.stderr,
        )
        return 2
    leftover_positionals = [t for t in extra if not t.startswith("-")]
    if leftover_positionals:
        print(
            f"error: --rest issue list takes no positional arguments; "
            f"got {leftover_positionals!r}. Did you mean "
            f"`scm.py issue view --rest {leftover_positionals[0]} --repo OWNER/NAME`?",
            file=sys.stderr,
        )
        return 2
    if not repo:
        print("error: --rest issue list requires --repo OWNER/NAME", file=sys.stderr)
        return 2
    try:
        per_page = int(limit_str) if limit_str is not None else 30
    except ValueError:
        print(
            f"error: --limit must be an integer; got {limit_str!r}",
            file=sys.stderr,
        )
        return 2
    labels: tuple[str, ...] = tuple(
        item.strip()
        for value in label_values
        for item in value.split(",")
        if item.strip()
    )
    gh_rest = importlib.import_module("gh_rest")
    assert state is not None  # default ensures non-None
    try:
        response = gh_rest.rest_issue_list(
            repo, state=state, labels=labels, author=author, per_page=per_page
        )
    except gh_rest.InvalidRepoError as exc:
        # See _run_rest_view for rationale; same gap (Greptile P1 #998
        # review at 367748e) -- _split_repo validation must surface as
        # exit 2 with a clean message, not an uncaught traceback.
        print(f"error: invalid --repo value: {exc}", file=sys.stderr)
        return 2
    except gh_rest.GhRestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    fields = [f.strip() for f in json_spec.split(",")] if json_spec else []
    filtered = _filter_json_fields(response, fields)
    print(json.dumps(filtered, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns the underlying binary's exit code (or 2 on arg error).

    Argv layout:
        argv[0] = namespace (only ``issue`` in the v1 stub)
        argv[1] = verb (one of list/view/close/edit)
        argv[2:] = pass-through args forwarded to ``ghx|gh`` (legacy path)
                   OR consumed by the REST dispatcher when ``--rest`` is
                   present (#976).

    No argparse: the stub deliberately avoids capturing ``--help`` / ``--json``
    / etc. flags itself in the legacy path, so they reach the underlying
    binary untouched. The only argv inspection the stub performs is:

    1. The namespace + verb whitelist in :func:`build_command` (which fails
       loud rather than dispatching unknown surfaces).
    2. The ``--rest`` opt-in extraction (#976) -- when present on a
       supported read verb (``view``, ``list``), routes the read through
       :mod:`scripts.gh_rest` REST helpers instead of forwarding to
       ``ghx|gh``. The flag is stripped before any forwarding so the
       legacy path is unaffected on calls that don't opt in.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 2:
        print(
            "usage: scm.py <namespace> <verb> [pass-through args...]\n"
            "       (v1 stub: namespace=issue, verb=list|view|close|edit)\n"
            "       --rest opt-in is supported on issue view/list (#976)",
            file=sys.stderr,
        )
        return 2
    namespace, verb, *extra = args
    # #976: detect and consume the --rest opt-in BEFORE any gh forwarding.
    # The flag is stripped from extra so the legacy path stays argv-pure.
    rest_mode, extra = _extract_flag(extra, "--rest")
    if rest_mode:
        if namespace != "issue" or verb not in _REST_OPT_IN_VERBS:
            print(
                f"error: --rest is only supported on 'issue {{view|list}}'; "
                f"got 'scm.py {namespace} {verb}'. Mutations (close, edit) "
                "still forward to gh in the v1 stub; #881 owns the full "
                "REST migration.",
                file=sys.stderr,
            )
            return 2
        if verb == "view":
            return _run_rest_view(extra)
        return _run_rest_list(extra)

    try:
        cmd = build_command(namespace, verb, extra)
    except ScmStubError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    # subprocess.run with check=False so we forward the underlying exit code
    # rather than raising; gh's non-zero exits (e.g. issue not found) carry
    # actionable stderr that the caller already handles.
    proc = subprocess.run(cmd, check=False)
    return int(proc.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
