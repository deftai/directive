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

from policy import (  # noqa: E402
    DEFAULT_WIP_CAP,
    disclosure_line,
    resolve_policy,
    resolve_wip_cap,
    set_policy,
    set_wip_cap,
)

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

    # ---------------------------------------------------------------
    # wip-cap subcommand (#1124 / D4 of #1119)
    # ---------------------------------------------------------------
    wip = sub.add_parser(
        "wip-cap",
        help=(
            "Set plan.policy.wipCap=<N>. Default cap is "
            f"{DEFAULT_WIP_CAP} per umbrella #1119 Current Shape v3."
        ),
    )
    wip.add_argument(
        "--set",
        dest="cap",
        type=int,
        required=True,
        help="New WIP cap value (>= 0; 0 freezes promotion entirely).",
    )
    wip.add_argument(
        "--confirm",
        action="store_true",
        help=(
            "Required to actually apply the change. Without it, the "
            "command prints the capability-cost disclosure and exits 1."
        ),
    )
    wip.add_argument("--actor", default="task policy:wip-cap")
    wip.add_argument("--note", default="")
    wip.add_argument("--project-root", default=".")
    return parser


_WIP_CAP_DISCLOSURE = (
    "\u26a0 Capability-cost disclosure -- changing plan.policy.wipCap "
    "alters the refusal threshold on task scope:promote (#1124 / D4 of #1119).\n"
    "  \u2022 Raising the cap lets more vBRIEFs sit in pending/+active/ "
    "before promotion is refused.\n"
    "  \u2022 Lowering the cap may put the project over cap immediately; "
    "use `task scope:demote` / `task scope:demote --batch --older-than-days 30` "
    "to drain.\n"
    "  \u2022 cap=0 freezes promotion entirely (useful for code-freeze "
    "windows; restore by setting a positive value).\n"
    "  \u2022 This change is reversible and recorded to "
    "meta/policy-changes.log for auditability."
)


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
    elif args.cmd == "wip-cap":
        return _apply_wip_cap(args, project_root)
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
        print(f"\u274c {exc}", file=sys.stderr)
        print(
            "  Recovery: run `task setup` to generate "
            "vbrief/PROJECT-DEFINITION.vbrief.json.",
            file=sys.stderr,
        )
        return 2
    except (ValueError, OSError) as exc:
        print(f"\u274c Config error: {exc}", file=sys.stderr)
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


def _apply_wip_cap(args, project_root: Path) -> int:
    """Handle the ``wip-cap`` subcommand (#1124 / D4 of #1119)."""
    if args.cap < 0:
        print(
            f"\u274c --set must be >= 0; got {args.cap}.",
            file=sys.stderr,
        )
        return 1
    if not args.confirm:
        print(_WIP_CAP_DISCLOSURE)
        print()
        print(
            "Re-run with --confirm to apply: "
            f"task policy:wip-cap -- --set {args.cap} --confirm"
        )
        return 1
    try:
        changed, audit_entry = set_wip_cap(
            project_root,
            cap=int(args.cap),
            actor=args.actor,
            note=args.note,
        )
    except FileNotFoundError as exc:
        print(f"\u274c {exc}", file=sys.stderr)
        print(
            "  Recovery: run `task setup` to generate "
            "vbrief/PROJECT-DEFINITION.vbrief.json.",
            file=sys.stderr,
        )
        return 2
    except (ValueError, OSError) as exc:
        print(f"\u274c Config error: {exc}", file=sys.stderr)
        return 2

    print(f"\u2713 plan.policy.wipCap={args.cap}.")
    if changed:
        print(f"  audit: meta/policy-changes.log :: {audit_entry}")
    else:
        print("  no-op: value already matched (audit entry still appended for trail).")
    result = resolve_wip_cap(project_root)
    print(
        f"[deft policy] plan.policy.wipCap={result.cap} (source: {result.source})."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
