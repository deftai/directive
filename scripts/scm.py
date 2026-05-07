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
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from collections.abc import Sequence

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Allowed ``<namespace>`` argv[1] -- the v1 stub only exposes ``issue``.
#: PR commands (#881 future) and any other namespace are rejected loudly so
#: a typo doesn't silently dispatch unexpected gh subcommands.
_ALLOWED_NAMESPACES: tuple[str, ...] = ("issue",)

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
# Entry point
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns the underlying binary's exit code (or 2 on arg error).

    Argv layout:
        argv[0] = namespace (only ``issue`` in the v1 stub)
        argv[1] = verb (one of list/view/close/edit)
        argv[2:] = pass-through args forwarded to ``ghx|gh``

    No argparse: the stub deliberately avoids capturing ``--help`` / ``--json``
    / etc. flags itself, so they reach the underlying binary untouched. The
    only argv inspection the stub performs is the namespace + verb whitelist
    in :func:`build_command` (which fails loud rather than dispatching unknown
    surfaces).
    """
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 2:
        print(
            "usage: scm.py <namespace> <verb> [pass-through args...]\n"
            "       (v1 stub: namespace=issue, verb=list|view|close|edit)",
            file=sys.stderr,
        )
        return 2
    namespace, verb, *extra = args
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
