#!/usr/bin/env python3
"""policy_set.py -- write the typed branch policy to PROJECT-DEFINITION.

Backs ``task policy:enforce-branches`` and ``task policy:allow-direct-commits``
(#746). Always writes through :func:`scripts.policy.set_policy` so the legacy
narrative key is migrated in the same pass and an audit-log entry is appended
to ``meta/policy-changes.log``.

Subcommands:

- ``enforce-branches`` -- set ``allowDirectCommitsToMaster=False``.
- ``allow-direct-commits`` -- set ``allowDirectCommitsToMaster=True``. Requires
  ``--confirm`` (capability-cost disclosure: branch-protection turns OFF).

Exit codes:

- ``0`` -- write succeeded (or no-op if value already matched).
- ``1`` -- refusal (e.g. ``allow-direct-commits`` without ``--confirm``).
- ``2`` -- config error (PROJECT-DEFINITION missing / malformed).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from policy import disclosure_line, resolve_policy, set_policy  # noqa: E402

CAPABILITY_COST_DISCLOSURE = (
    "⚠ Capability-cost disclosure -- enabling direct commits to the default "
    "branch turns OFF the deft branch-protection policy.\n"
    "  • Pre-commit + pre-push hooks will no longer block default-branch "
    "commits.\n"
    "  • verify:branch will pass on the default branch.\n"
    "  • The CI sanity check (head_ref != base_ref) is still independent and "
    "will continue to flag master->master PRs.\n"
    "  • This change is reversible: run `task policy:enforce-branches` to "
    "re-enable the gate.\n"
    "  • The change is recorded to meta/policy-changes.log for auditability."
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="policy_set.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    enforce = sub.add_parser(
        "enforce-branches",
        help="Set allowDirectCommitsToMaster=False (enforce feature branches).",
    )
    enforce.add_argument("--actor", default="task policy:enforce-branches")
    enforce.add_argument("--note", default="")
    enforce.add_argument("--project-root", default=".")

    allow = sub.add_parser(
        "allow-direct-commits",
        help="Set allowDirectCommitsToMaster=True. Requires --confirm.",
    )
    allow.add_argument(
        "--confirm",
        action="store_true",
        help=(
            "Required to actually apply the change. Without it, the command "
            "prints the capability-cost disclosure and exits 1."
        ),
    )
    allow.add_argument("--actor", default="task policy:allow-direct-commits")
    allow.add_argument("--note", default="")
    allow.add_argument("--project-root", default=".")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()

    if args.cmd == "enforce-branches":
        target = False
    elif args.cmd == "allow-direct-commits":
        if not args.confirm:
            print(CAPABILITY_COST_DISCLOSURE)
            print()
            print(
                "Re-run with --confirm to apply: "
                "task policy:allow-direct-commits -- --confirm"
            )
            return 1
        target = True
    else:  # pragma: no cover -- argparse enforces one of the above
        parser.print_help()
        return 2

    try:
        changed, audit_entry = set_policy(
            project_root,
            allow_direct_commits=target,
            actor=args.actor,
            note=args.note,
        )
    except FileNotFoundError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        print(
            "  Recovery: run `task setup` to generate "
            "vbrief/PROJECT-DEFINITION.vbrief.json.",
            file=sys.stderr,
        )
        return 2
    except (ValueError, OSError) as exc:
        print(f"❌ Config error: {exc}", file=sys.stderr)
        return 2

    state = "ON" if not target else "OFF"
    print(
        f"✓ plan.policy.allowDirectCommitsToMaster={'true' if target else 'false'} "
        f"(branch-protection {state})."
    )
    if changed:
        print(f"  audit: meta/policy-changes.log :: {audit_entry}")
    else:
        print("  no-op: value already matched (audit entry still appended for trail).")

    # Print resolved disclosure for completeness.
    print(disclosure_line(resolve_policy(project_root)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
