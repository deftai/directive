#!/usr/bin/env python3
"""preflight_branch.py -- detection-bound branch-protection gate (#747).

Pure stdlib, cross-platform. Invoked from:

- ``.githooks/pre-commit`` and ``.githooks/pre-push`` (mechanical T3 enforcement)
- ``task verify:branch`` (aggregated into ``task check``)
- ``task setup`` (idempotent ``git config core.hooksPath .githooks`` + run)

Resolves the policy via :mod:`scripts.policy` so the typed
``plan.policy.allowDirectCommitsToMaster`` field (#746 part A) and the legacy
narrative fallback share a single source of truth. Pure stdlib means the script
can run from a fresh git hook without ``uv`` having to be on PATH.

Exit codes (three-state, mirrors ``scripts/release.py`` and friends):

- ``0`` -- allowed: feature branch, detached HEAD, opted-out, env-var bypass,
  or setup-interview exemption hook.
- ``1`` -- blocked: on default branch (master/main) and the project does NOT
  opt out. Helpful message tells the user how to recover.
- ``2`` -- config error: PROJECT-DEFINITION missing AND env-var bypass not
  active AND ``--allow-missing-project-definition`` not passed (the bootstrap
  fallback path documented in #746 acceptance criterion E).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# Make ``scripts`` importable when this file is invoked via ``python
# scripts/preflight_branch.py`` from a git hook.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from policy import (  # noqa: E402  -- intentional sys.path-tweaked import
    ENV_BYPASS,
    PolicyResult,
    disclosure_line,
    resolve_policy,
)

DEFAULT_BRANCHES = frozenset({"master", "main"})

#: When the setup-interview is mid-flight on the default branch (e.g. the
#: very first ``task setup`` call before any feature branch exists), we need
#: an exemption. Setting ``DEFT_SETUP_INTERVIEW=1`` activates it. This
#: surface is intentionally distinct from the production-time env-var bypass.
ENV_SETUP_EXEMPTION = "DEFT_SETUP_INTERVIEW"


def _git(args: list[str], project_root: Path) -> tuple[int, str, str]:
    """Run ``git`` with the given args. Returns (rc, stdout, stderr) trimmed."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return 127, "", "git executable not found on PATH"
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


class GitNotFoundError(RuntimeError):
    """Raised when ``git`` is not on PATH (#777 Greptile P2 fix)."""


def _current_branch(project_root: Path) -> tuple[str, bool]:
    """Return (branch_name, is_detached). ``branch_name`` is empty when detached.

    Raises :class:`GitNotFoundError` when the ``git`` executable is not on
    PATH -- previously this was silently treated as a detached HEAD,
    which let the gate pass (exit 0) on environments where git itself was
    missing (Greptile P2 review on PR #777).
    """
    rc, out, err = _git(["symbolic-ref", "--quiet", "--short", "HEAD"], project_root)
    if rc == 127 and "git executable not found" in err:
        raise GitNotFoundError(err)
    if rc == 0 and out:
        return out, False
    # Detached HEAD (e.g. CI checkout of a tag, mid-rebase) -- never blocked.
    return "", True


def _is_default_branch(name: str, default_branches: frozenset[str]) -> bool:
    return name.lower() in {b.lower() for b in default_branches}


def _build_block_message(branch: str, result: PolicyResult) -> str:
    parts = [
        "❌ deft branch-protection: refusing to commit/push directly to the "
        f"default branch '{branch}' (#747).",
        "",
        f"  Source: policy={result.source}",
    ]
    if result.error:
        parts.append(f"  Error: {result.error}")
    if result.deprecation_warning:
        parts.append(f"  Note: {result.deprecation_warning}")
    parts.extend(
        [
            "",
            "  How to proceed:",
            "    • Create a feature branch:  git switch -c feat/<name>",
            "    • Or opt out via the typed surface:",
            "        task policy:allow-direct-commits -- --confirm",
            f"    • Or set the emergency-escape env-var:  {ENV_BYPASS}=1",
            "",
            "  See README.md (Branch policy) and skills/deft-directive-setup/",
            "  Phase 2 Step 9 (capability-cost disclosure).",
        ]
    )
    return "\n".join(parts)


def _setup_exemption_active() -> bool:
    raw = os.environ.get(ENV_SETUP_EXEMPTION, "")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def evaluate(
    project_root: Path,
    *,
    default_branches: frozenset[str] = DEFAULT_BRANCHES,
    allow_missing_project_definition: bool = False,
) -> tuple[int, str]:
    """Pure function returning ``(exit_code, human_message)``.

    Separated from :func:`main` so tests can drive every state without
    ``capsys`` plumbing or env-var leak.
    """
    if _setup_exemption_active():
        return 0, (
            "✓ deft branch-protection: setup-interview exemption active "
            f"({ENV_SETUP_EXEMPTION}=1) -- proceeding without policy lookup."
        )

    try:
        branch, detached = _current_branch(project_root)
    except GitNotFoundError as exc:
        return 2, (
            "❌ deft branch-protection: cannot determine current branch -- "
            f"{exc}\n"
            "  Recovery: install git (https://git-scm.com/) or set DEFT_PYTHON "
            "so the hook can dispatch correctly."
        )
    if detached:
        return 0, (
            "✓ deft branch-protection: detached HEAD detected -- nothing to gate."
        )

    if not _is_default_branch(branch, default_branches):
        return 0, (
            f"✓ deft branch-protection: feature branch '{branch}' -- proceeding."
        )

    # On default branch -- consult the policy.
    result = resolve_policy(project_root)
    if result.allow_direct_commits:
        msg = (
            f"⚠ deft branch-protection: on default branch '{branch}', but "
            f"policy allows it ({disclosure_line(result)})."
        )
        return 0, msg

    # Blocked. Disambiguate config-error vs policy-says-no (Greptile P1 fix):
    # ANY ``default-fail-closed`` source with a non-empty ``error`` is a
    # config error (malformed JSON, non-bool typed field, plan-not-object,
    # missing file, ...). The previous narrower ``"not found" in error``
    # check misclassified malformed-config cases as policy blocks (exit 1)
    # with a misleading "create a feature branch" message.
    if result.source == "default-fail-closed" and result.error:
        if allow_missing_project_definition and "not found" in result.error:
            # Bootstrap shortcut: only the explicit missing-file case is
            # treated as a setup-interview-state pass. Other config errors
            # (malformed JSON, type mismatches) still fail loudly even
            # under the bootstrap flag because they require human action.
            return 0, (
                "✓ deft branch-protection: PROJECT-DEFINITION missing AND "
                "--allow-missing-project-definition was passed -- treating as "
                "bootstrap state (the setup interview will write the typed flag)."
            )
        if "not found" in result.error:
            recovery = (
                "  Recovery: run `task setup` to create vbrief/"
                "PROJECT-DEFINITION.vbrief.json, OR set the env-var bypass:\n"
                f"      {ENV_BYPASS}=1\n"
                "  Or pass --allow-missing-project-definition to this script "
                "(setup-interview hook only)."
            )
        else:
            recovery = (
                "  Recovery: fix the malformed PROJECT-DEFINITION (e.g. ensure "
                "`plan.policy.allowDirectCommitsToMaster` is a boolean and "
                "`plan` is an object), then re-run."
            )
        return 2, (
            "❌ deft branch-protection: PROJECT-DEFINITION cannot be resolved.\n"
            f"  Detail: {result.error}\n"
            f"{recovery}"
        )

    return 1, _build_block_message(branch, result)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="preflight_branch.py",
        description=(
            "Detection-bound branch-protection gate (#747). Reads "
            "plan.policy.allowDirectCommitsToMaster from "
            "vbrief/PROJECT-DEFINITION.vbrief.json (typed; #746) with "
            "legacy-narrative fallback + deprecation warning."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root path (default: current working directory).",
    )
    parser.add_argument(
        "--allow-missing-project-definition",
        action="store_true",
        help=(
            "Treat a missing PROJECT-DEFINITION as bootstrap state "
            "(setup-interview hook). Without this flag, missing "
            "PROJECT-DEFINITION is a config error (exit 2)."
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
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    default_branches = (
        frozenset(args.default_branch) if args.default_branch else DEFAULT_BRANCHES
    )
    code, msg = evaluate(
        project_root,
        default_branches=default_branches,
        allow_missing_project_definition=args.allow_missing_project_definition,
    )
    if code == 0:
        if not args.quiet:
            print(msg)
    else:
        print(msg, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
