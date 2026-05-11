#!/usr/bin/env python3
"""preflight_gh.py -- detection-bound gate for destructive ``gh`` verbs (#1019).

Pure stdlib, cross-platform. Mirrors :mod:`preflight_branch` (#747) in shape:

- ``0`` -- allowed: command is not destructive, OR an env-var bypass /
  typed policy flag explicitly authorizes the destructive verb.
- ``1`` -- blocked: command classified as one of the destructive categories
  defined by this gate and no bypass is active.
- ``2`` -- config error: malformed input, missing required argument, or
  the operator passed a self-test fixture that disagrees with the
  classifier (the latter is a hard failure for the ``--self-test`` mode).

Destructive categories detected by this gate (see #1019 vBRIEF for
rationale and the real-world recurrence pattern that motivates each):

- ``delete_repo`` -- ``gh repo delete <repo>`` and
  ``gh api -X DELETE repos/<owner>/<repo>[/...]``. Irreversible repo
  deletion via the GitHub API. This is the failure mode that prompted
  the issue (a peer-tool agent deleted every company repo before
  apologising).
- ``force_push_default`` -- ``git push --force`` and
  ``git push --force-with-lease`` to the default branch (master/main).
  The #747 branch gate refuses *commits* to master/main, but a force-push
  from a feature branch that targets ``master`` was uncovered. This gate
  closes the loop.
- ``admin_merge`` -- ``gh pr merge --admin`` (bypass of branch protection
  required reviews). Document the rationale + escape hatch rather than
  silently allow.

Intended call surfaces:

- ``.githooks/pre-push`` -- the hook reads its per-ref stdin lines and
  dispatches to ``preflight_gh.py --pre-push-stdin`` so force-pushes
  targeting the default branch are refused at the git layer before the
  network call.
- ``task verify:destructive-gh-verbs`` -- aggregated into ``task check``.
  Runs ``--self-test`` so a future edit to the classifier table that
  introduces a false negative / false positive fails CI immediately.
- Agent pre-execution hooks -- ``preflight_gh.py --command "<full
  command string>"`` returns three-state exit so an orchestrator can
  refuse the verb before invoking ``gh`` (out of scope for v1; the
  CLI surface is provided so the wiring can land additively).

Escape hatch (operator-implemented): set
``DEFT_ALLOW_DESTRUCTIVE_GH_VERBS=1`` to bypass the gate for a single
shell. Symmetric with ``DEFT_ALLOW_DEFAULT_BRANCH_COMMIT`` (#747).
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

#: Environment variable that lets the operator bypass the destructive-verb
#: gate WITHOUT editing the typed flag. Documented in #1019 as the
#: explicit emergency-escape hatch (e.g. authorised release-cycle
#: ``gh release delete`` runs, hot-fix admin merges). When set to a
#: truthy value, this gate exits 0 with an explicit "policy bypassed"
#: message so the bypass is auditable.
ENV_BYPASS = "DEFT_ALLOW_DESTRUCTIVE_GH_VERBS"

#: Recognised truthy strings for the env-var bypass. Identical to the
#: surface used by :mod:`scripts.policy` for parity with #747.
_TRUTHY = frozenset({"1", "true", "yes", "on"})

#: Default-branch refs treated as protected against force-push by the
#: ``force_push_default`` category. Mirrors the
#: :mod:`scripts.preflight_branch` default-branch set so the two gates
#: agree on what "default" means.
DEFAULT_BRANCHES = frozenset({"master", "main"})


@dataclass(frozen=True)
class Verdict:
    """Result of classifying a candidate command.

    ``category`` is ``None`` when the command is not destructive.
    ``detail`` is a short human-readable reason; ``recovery`` is the
    follow-up text the gate prints to stderr on a block so the operator
    knows how to proceed.
    """

    allowed: bool
    category: str | None
    detail: str
    recovery: str = ""


_OK_VERDICT = Verdict(allowed=True, category=None, detail="not destructive")


# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------


def _env_bypass_active() -> bool:
    """True when ``DEFT_ALLOW_DESTRUCTIVE_GH_VERBS`` is set to a truthy value."""
    raw = os.environ.get(ENV_BYPASS, "")
    return raw.strip().lower() in _TRUTHY


def _tokens_from_string(command: str) -> list[str]:
    """Tokenise a candidate command string into argv-like tokens.

    Uses :func:`shlex.split` with ``posix=True`` -- the gate is invoked
    on the operator side BEFORE the verb executes, so we can assume
    POSIX-style quoting from the dispatching agent. Windows agents
    that pass a literal cmd.exe string get a degraded but conservative
    tokenisation: ``shlex`` falls back to whitespace splits when the
    string contains no quotes, which is the common case for
    ``gh repo delete owner/repo`` style invocations.
    """
    try:
        return shlex.split(command, posix=True)
    except ValueError:
        # Mismatched quotes; treat as raw whitespace tokens so we still
        # match the destructive sub-strings rather than failing open.
        return command.split()


def _is_delete_repo(tokens: list[str]) -> Verdict | None:
    """Detect ``gh repo delete ...`` and ``gh api -X DELETE repos/...``.

    Both forms are irreversible. ``gh api -X DELETE`` is the surface a
    bypass-conscious agent might reach for when ``gh repo delete`` is
    intercepted, so it MUST be detected even when the args are split
    by the equals form (``-X=DELETE`` / ``--method=DELETE``).
    """
    if len(tokens) < 2:
        return None
    head = tokens[0].lower()
    if head not in {"gh", "ghx"}:
        return None

    # gh repo delete <owner/repo>
    if tokens[1].lower() == "repo" and len(tokens) >= 3 and tokens[2].lower() == "delete":
        target = tokens[3] if len(tokens) >= 4 else "<unspecified>"
        return Verdict(
            allowed=False,
            category="delete_repo",
            detail=f"gh repo delete {target}",
            recovery=(
                "  Repo deletion is irreversible. If this is intentional:\n"
                f"    • set the env-var bypass for this shell:  {ENV_BYPASS}=1\n"
                "    • or run the deletion via the GitHub web UI so the\n"
                "      reversible-archive prompt fires (preferred)."
            ),
        )

    # gh api ... DELETE repos/<owner>/<repo>...
    if tokens[1].lower() == "api" and _api_invocation_is_delete(tokens[2:]):
        endpoint = _api_endpoint(tokens[2:])
        if endpoint and _endpoint_is_repo_root(endpoint):
            return Verdict(
                allowed=False,
                category="delete_repo",
                detail=f"gh api -X DELETE {endpoint}",
                recovery=(
                    "  Repo / repo-subresource deletion via the API is\n"
                    "  irreversible. If this is intentional:\n"
                    f"    • set the env-var bypass for this shell:  {ENV_BYPASS}=1"
                ),
            )

    return None


def _api_invocation_is_delete(tokens: Iterable[str]) -> bool:
    """True iff the gh-api token list specifies a DELETE method.

    Handles ``-X DELETE``, ``-XDELETE``, ``--method DELETE``,
    ``-X=DELETE``, ``--method=DELETE`` and equivalent case-insensitive
    forms.
    """
    items = list(tokens)
    for idx, tok in enumerate(items):
        low = tok.lower()
        if (
            low in {"-x", "--method"}
            and idx + 1 < len(items)
            and items[idx + 1].upper() == "DELETE"
        ):
            return True
        if low.startswith(("-x=", "--method=")):
            value = tok.split("=", 1)[1]
            if value.upper() == "DELETE":
                return True
        # -XDELETE / -Xdelete (combined short-flag form)
        if low.startswith("-x") and len(low) > 2 and low[2:].upper() == "DELETE":
            return True
    return False


def _api_endpoint(tokens: Iterable[str]) -> str | None:
    """Return the positional endpoint argument (the path after ``gh api``).

    Skips both flag tokens (``-X`` / ``--method`` / ``-H`` / ``--header`` /
    ``-F`` / ``-f`` / ``--field`` / ``--input``) AND the value that
    follows them when the value is passed space-separated. The set
    enumerated here is the closed set of ``gh api`` flags that take an
    argument; anything else with a leading ``-`` is treated as a boolean
    flag and skipped without consuming the next token.
    """
    # Note: ``gh api`` short flag for ``--raw-field`` is ``-F`` (uppercase).
    # Because the caller lower-cases the token before lookup, ``-F`` is
    # already covered implicitly by the ``-f`` entry, but enumerating ``-F``
    # explicitly makes the contract self-documenting and avoids a duplicate-
    # item ruff finding (B033) when both forms collapse to the same key.
    value_taking = {
        "-x", "--method",
        "-h", "--header",
        "-f", "--field",
        "-F", "--raw-field",
        "--input",
        "--jq", "-q",
        "--template", "-t",
        "--hostname",
        "--cache",
    }
    items = list(tokens)
    idx = 0
    while idx < len(items):
        tok = items[idx]
        low = tok.lower()
        if not tok.startswith("-"):
            return tok
        # Flag-with-attached-value form: -X=DELETE / --method=DELETE -- skip.
        if "=" in tok:
            idx += 1
            continue
        # Combined short-flag form: -XDELETE -- skip the whole token.
        if low.startswith("-x") and len(low) > 2:
            idx += 1
            continue
        # Space-separated value form: consume the next token as the value
        # so it is not mistaken for the endpoint positional.
        if low in value_taking and idx + 1 < len(items):
            idx += 2
            continue
        idx += 1
    return None


def _endpoint_is_repo_root(endpoint: str) -> bool:
    """True when the endpoint targets ``repos/<owner>/<repo>`` or a child.

    Both ``repos/foo/bar`` and ``/repos/foo/bar/contents`` qualify --
    DELETE on any repo-scoped resource is destructive enough that the
    gate refuses it. The narrower case where DELETE on a label or comment
    is legitimate can be escape-hatched via the env-var bypass; the
    default-deny stance mirrors the #747 branch-gate disposition.
    """
    normalised = endpoint.lstrip("/").lower()
    return normalised.startswith("repos/")


def _is_force_push_default(tokens: list[str], default_branches: frozenset[str]) -> Verdict | None:
    """Detect ``git push --force[-with-lease]`` targeting the default branch.

    The default-branch detection looks for ``<remote> <branch>`` form
    (e.g. ``git push origin master --force``) as well as
    ``HEAD:<branch>`` refspecs and ``+<branch>`` "force" refspecs.
    """
    if len(tokens) < 2:
        return None
    if tokens[0].lower() != "git" or tokens[1].lower() != "push":
        return None

    args = tokens[2:]
    is_force = False
    force_flag = ""
    for tok in args:
        low = tok.lower()
        if low in {"-f", "--force"}:
            is_force = True
            force_flag = tok
            break
        if low.startswith("--force-with-lease"):
            is_force = True
            force_flag = tok
            break

    # ``+refspec`` is the "force" form of a refspec. It is destructive
    # in the same way ``--force`` is, so we treat it as force as well.
    plus_refspec_target: str | None = None
    for tok in args:
        if tok.startswith("+") and not tok.startswith("--"):
            plus_refspec_target = tok[1:]
            is_force = True
            if not force_flag:
                force_flag = "+<refspec>"
            break

    if not is_force:
        return None

    # Resolve target branch(es) referenced by the push.
    targets = _resolve_push_targets(args, plus_refspec_target)
    hit = next(
        (b for b in targets if b.lower() in {x.lower() for x in default_branches}),
        None,
    )
    if hit is None:
        return None

    return Verdict(
        allowed=False,
        category="force_push_default",
        detail=f"git push {force_flag} -> default branch '{hit}'",
        recovery=(
            "  Force-pushing the default branch overwrites shared history\n"
            "  and can lose commits. If this is genuinely necessary:\n"
            f"    • set the env-var bypass for this shell:  {ENV_BYPASS}=1\n"
            "    • or push to a feature branch and open a PR.\n"
            "  See scm/github.md (## Destructive gh verbs (#1019))."
        ),
    )


def _resolve_push_targets(args: list[str], plus_refspec: str | None) -> list[str]:
    """Extract the destination ref(s) named by a ``git push`` invocation.

    Recognises three shapes:

    - ``git push <remote> <branch> [...]`` -- positional branch arg
    - ``git push <remote> HEAD:<branch>`` / ``<src>:<dst>`` refspecs
    - ``git push <remote> +<src>:<dst>`` -- the explicit force refspec
    """
    targets: list[str] = []
    positional = [t for t in args if not t.startswith("-")]
    if plus_refspec and plus_refspec not in positional:
        positional.append(plus_refspec)

    if len(positional) >= 2:
        # positional[0] is the remote; positional[1:] are refspecs / branches.
        for token in positional[1:]:
            if token.startswith("+"):
                token = token[1:]
            if ":" in token:
                # src:dst -> we want dst
                _, dst = token.split(":", 1)
                targets.append(dst.removeprefix("refs/heads/"))
            else:
                targets.append(token.removeprefix("refs/heads/"))
    return targets


def _is_admin_merge(tokens: list[str]) -> Verdict | None:
    """Detect ``gh pr merge --admin`` (bypasses branch protection)."""
    if len(tokens) < 3:
        return None
    if tokens[0].lower() not in {"gh", "ghx"}:
        return None
    if tokens[1].lower() != "pr" or tokens[2].lower() != "merge":
        return None
    if not any(tok.lower() == "--admin" for tok in tokens[3:]):
        return None
    return Verdict(
        allowed=False,
        category="admin_merge",
        detail="gh pr merge --admin",
        recovery=(
            "  --admin bypasses branch-protection required reviews.\n"
            "  If this is intentional (release-cycle hot-fix, agreed\n"
            "  rollback, etc.):\n"
            f"    • set the env-var bypass for this shell:  {ENV_BYPASS}=1\n"
            "  Otherwise: request review through the normal flow."
        ),
    )


def classify_command(
    command: str,
    *,
    default_branches: frozenset[str] = DEFAULT_BRANCHES,
) -> Verdict:
    """Classify a candidate command string. Pure function (no env reads).

    Callers that want env-var bypass semantics should consult
    :func:`evaluate_command` (which wraps this) -- this primitive is
    bypass-blind so unit tests can drive every classifier branch
    without juggling environment state.
    """
    tokens = _tokens_from_string(command)
    if not tokens:
        return _OK_VERDICT

    for detector in (
        _is_delete_repo,
        _is_admin_merge,
    ):
        verdict = detector(tokens)
        if verdict is not None:
            return verdict

    force_push = _is_force_push_default(tokens, default_branches)
    if force_push is not None:
        return force_push

    return _OK_VERDICT


def evaluate_command(
    command: str,
    *,
    default_branches: frozenset[str] = DEFAULT_BRANCHES,
) -> tuple[int, str]:
    """Evaluate a candidate command and produce (exit_code, message).

    Honours ``DEFT_ALLOW_DESTRUCTIVE_GH_VERBS`` as the env-var bypass:
    when active, a destructive verdict is downgraded to exit 0 with a
    visible "policy bypassed" message so the operator can audit the
    bypass after the fact.
    """
    if not command.strip():
        return 2, (
            "❌ deft destructive-gh-verb gate: empty command string passed.\n"
            "  Usage: preflight_gh.py --command \"<command>\""
        )

    verdict = classify_command(command, default_branches=default_branches)
    if verdict.allowed:
        return 0, (
            f"✓ deft destructive-gh-verb gate: '{command}' is not "
            "destructive -- proceeding."
        )

    if _env_bypass_active():
        return 0, (
            f"⚠ deft destructive-gh-verb gate: '{verdict.detail}' "
            f"classified as {verdict.category}, but {ENV_BYPASS}=1 is "
            "set -- policy bypassed for this session."
        )

    msg_lines = [
        f"❌ deft destructive-gh-verb gate: refusing to execute "
        f"({verdict.category}).",
        "",
        f"  Detail: {verdict.detail}",
    ]
    if verdict.recovery:
        msg_lines.extend(["", verdict.recovery])
    return 1, "\n".join(msg_lines)


# ---------------------------------------------------------------------------
# Pre-push hook mode -- parse stdin per-ref lines
# ---------------------------------------------------------------------------


def _parse_pre_push_stdin(stream) -> list[tuple[str, str, str, str]]:
    """Yield ``(local_ref, local_oid, remote_ref, remote_oid)`` tuples.

    Tolerant of trailing whitespace and empty lines. Git's pre-push hook
    feeds one such line per ref being pushed.
    """
    out: list[tuple[str, str, str, str]] = []
    for raw in stream:
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 4:
            continue
        out.append((parts[0], parts[1], parts[2], parts[3]))
    return out


_ZERO_OID_RE = re.compile(r"^0+$")


def _is_zero_oid(oid: str) -> bool:
    return bool(_ZERO_OID_RE.match(oid))


def evaluate_pre_push(
    refs: list[tuple[str, str, str, str]],
    *,
    default_branches: frozenset[str] = DEFAULT_BRANCHES,
) -> tuple[int, str]:
    """Evaluate the per-ref data from git pre-push stdin.

    Refuses any push that touches the default branch (creation or
    update). Deletion of the default branch is independently destructive
    and is also refused. Non-default branches are out of scope -- a
    force-push to a feature branch is a normal rebase workflow.
    """
    if not refs:
        return 0, (
            "✓ deft destructive-gh-verb gate (pre-push): no refs in "
            "stdin -- nothing to gate."
        )

    blocked: list[str] = []
    for local_ref, local_oid, remote_ref, remote_oid in refs:
        branch = remote_ref.removeprefix("refs/heads/")
        if branch.lower() not in {b.lower() for b in default_branches}:
            continue
        # Touching the default branch from a hook context. The branch
        # gate (#747) already refuses commits while on the default
        # branch, but force-push from a feature branch targeting
        # master is the case this gate exists to cover.
        if _is_zero_oid(remote_oid):
            blocked.append(f"create {branch} (local={local_ref})")
        elif _is_zero_oid(local_oid):
            # Deletion: local OID is zero (per-ref, not per-batch).
            blocked.append(f"delete {branch}")
        else:
            blocked.append(f"update {branch} (local={local_ref})")

    if not blocked:
        return 0, (
            "✓ deft destructive-gh-verb gate (pre-push): no pushes to "
            "default branches detected -- proceeding."
        )

    if _env_bypass_active():
        return 0, (
            "⚠ deft destructive-gh-verb gate (pre-push): default-branch "
            f"push detected ({'; '.join(blocked)}) but {ENV_BYPASS}=1 "
            "is set -- policy bypassed for this session."
        )

    msg = (
        "❌ deft destructive-gh-verb gate (pre-push): refusing to push "
        "directly to the default branch.\n"
        f"  Detail: {'; '.join(blocked)}\n\n"
        "  How to proceed:\n"
        "    • push to a feature branch and open a PR\n"
        f"    • or set the env-var bypass for this shell:  {ENV_BYPASS}=1\n"
        "  See scm/github.md (## Destructive gh verbs (#1019))."
    )
    return 1, msg


# ---------------------------------------------------------------------------
# Self-test mode -- aggregated into ``task verify:destructive-gh-verbs``
# ---------------------------------------------------------------------------


#: Built-in fixture table. ``expected_category=None`` means "allowed";
#: anything else is a destructive category we expect the classifier to
#: flag. Mutating this table is the load-bearing contract -- any change
#: should be paired with a regression test in ``tests/cli/test_preflight_gh.py``.
_SELF_TEST_CASES: tuple[tuple[str, str | None], ...] = (
    # delete_repo positives
    ("gh repo delete deftai/directive", "delete_repo"),
    ("gh repo delete deftai/directive --yes", "delete_repo"),
    ("gh api -X DELETE repos/deftai/directive", "delete_repo"),
    ("gh api --method DELETE repos/deftai/directive/contents/README.md", "delete_repo"),
    ("gh api -XDELETE repos/deftai/directive", "delete_repo"),
    # admin_merge positives
    ("gh pr merge 123 --admin", "admin_merge"),
    ("gh pr merge --admin --squash 123", "admin_merge"),
    # force_push_default positives
    ("git push --force origin master", "force_push_default"),
    ("git push origin --force-with-lease main", "force_push_default"),
    ("git push origin +master", "force_push_default"),
    ("git push --force origin HEAD:master", "force_push_default"),
    # Negatives -- benign commands MUST classify as allowed.
    ("gh pr merge 123 --squash", None),
    ("gh repo view deftai/directive", None),
    ("gh api repos/deftai/directive", None),
    ("gh api -X PATCH repos/deftai/directive/issues/1", None),
    ("git push origin feat/my-branch", None),
    ("git push --force origin feat/my-branch", None),
    ("git push --force-with-lease origin feat/my-branch", None),
    ("git push", None),
    ("gh pr create --title Test --body foo", None),
)


def run_self_test() -> tuple[int, str]:
    """Drive every fixture through the classifier; report disagreements.

    Returns (exit_code, message). Exit code is 0 when every fixture
    matches, 2 (config error) when any disagreement is found -- a
    disagreement means the classifier table has drifted from the
    contract and a real-world destructive verb might pass the gate.
    """
    failures: list[str] = []
    for command, expected in _SELF_TEST_CASES:
        verdict = classify_command(command)
        observed = None if verdict.allowed else verdict.category
        if observed != expected:
            failures.append(
                f"  ✗ {command!r} -- expected category={expected!r} but "
                f"got category={observed!r} (detail={verdict.detail!r})"
            )

    if failures:
        return 2, (
            "❌ deft destructive-gh-verb gate (self-test): classifier "
            f"disagreement on {len(failures)}/{len(_SELF_TEST_CASES)} "
            "fixture(s).\n" + "\n".join(failures)
        )
    return 0, (
        f"✓ deft destructive-gh-verb gate (self-test): "
        f"{len(_SELF_TEST_CASES)}/{len(_SELF_TEST_CASES)} fixtures "
        "classified as expected."
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="preflight_gh.py",
        description=(
            "Detection-bound gate for destructive gh verbs (#1019). "
            "Classifies a candidate command string as one of "
            "delete_repo / admin_merge / force_push_default, or allowed."
        ),
    )
    mode = parser.add_mutually_exclusive_group(required=False)
    mode.add_argument(
        "--command",
        help="Classify a single candidate command string and exit.",
    )
    mode.add_argument(
        "--pre-push-stdin",
        action="store_true",
        help=(
            "Read git pre-push hook per-ref lines from stdin and refuse "
            "pushes touching the default branch."
        ),
    )
    mode.add_argument(
        "--self-test",
        action="store_true",
        help=(
            "Run the built-in fixture table through the classifier and "
            "exit 0 / 2. Used by `task verify:destructive-gh-verbs`."
        ),
    )
    parser.add_argument(
        "--default-branch",
        action="append",
        default=None,
        help=(
            "Override the default-branch list. Pass multiple times to add. "
            "Defaults to master + main."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the OK message (errors still print).",
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help=argparse.SUPPRESS,  # accepted for parity with preflight_branch.py
    )
    return parser


def main(argv: list[str] | None = None, *, stdin=None) -> int:
    # #814: Force UTF-8 stdout/stderr at hook-script entry. Mirrors
    # ``scripts/preflight_branch.main`` -- see that module for the
    # rationale (Windows git-hook invocations default to cp1252 which
    # has no glyph for U+2713 / U+274C / U+26A0).
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = _build_parser()
    args = parser.parse_args(argv)
    default_branches = (
        frozenset(args.default_branch) if args.default_branch else DEFAULT_BRANCHES
    )

    if args.self_test:
        code, msg = run_self_test()
    elif args.pre_push_stdin:
        refs = _parse_pre_push_stdin(stdin or sys.stdin)
        code, msg = evaluate_pre_push(refs, default_branches=default_branches)
    elif args.command is not None:
        code, msg = evaluate_command(args.command, default_branches=default_branches)
    else:
        parser.error("one of --command / --pre-push-stdin / --self-test required")
        return 2  # unreachable; argparse exits via SystemExit(2)

    if code == 0:
        if not args.quiet:
            print(msg)
    else:
        print(msg, file=sys.stderr)
    return code


# Public API surface -- the names the test module imports.
__all__ = [
    "DEFAULT_BRANCHES",
    "ENV_BYPASS",
    "Verdict",
    "classify_command",
    "evaluate_command",
    "evaluate_pre_push",
    "main",
    "run_self_test",
]


if __name__ == "__main__":
    # Pure path-mod for hook invocation: make ``scripts`` importable
    # when this file is run directly (mirrors preflight_branch.py).
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
