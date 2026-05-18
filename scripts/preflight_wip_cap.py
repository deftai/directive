#!/usr/bin/env python3
"""preflight_wip_cap.py -- ``task verify:wip-cap`` re-validation gate (#1124 / D4 of #1119).

CI-level re-validation that the consumer's ``pending/ + active/`` count
is within the typed ``plan.policy.wipCap`` (default 10 per umbrella
#1119 Current Shape v3). Catches three drift scenarios that
``task scope:promote``'s own cap check cannot:

1. **Stale-branch merge** -- a PR was within cap at PR-open but master
   advanced past the cap before merge. ``scope:promote`` ran on the PR
   branch (within cap); the merged combination is over cap.
2. **Force-merge bypass** -- an operator opened a PR with ``scope:promote
   --force`` (audit-logged, but still merged); the merge surfaces the
   override on the base branch.
3. **Out-of-band edits** -- a vBRIEF was moved into ``pending/`` via
   filesystem operations (``git mv``, IDE drag) without going through
   ``scope:promote``; the cap was never enforced.

Behaviour contract:

* Three-state exit (mirrors ``scripts/preflight_branch.py`` / #747):
  ``0`` -- count within cap; ``1`` -- count >= cap (over cap); ``2`` --
  config error (PROJECT-DEFINITION malformed). All paths print
  diagnostic to stderr with the canonical relief verbs.
* ``--allow-over-cap`` -- escape hatch for the framework's own
  ``task check`` so deft's own landing-day overage (currently
  ``pending/+active/`` >> 10 -- see umbrella v3 "Landing-day overage
  handled via D1 ``scope:demote --batch``") does not break framework
  self-check. Consumer projects MUST NOT pass this; their ``task check``
  fails loudly when over cap. Mirrors ``verify:cache-fresh``'s
  ``--allow-missing-bootstrap`` shape.
* ``--project-root`` -- consumer project root; defaults to CWD. Mirrors
  the existing preflight scripts.

Pure stdlib so the gate runs from a fresh git hook or minimal CI runner
without ``uv sync``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make sibling ``policy`` importable when run as ``__main__``.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()


def _format_refusal(count: int, cap: int, project_root: Path) -> str:
    return (
        f"\u274c verify:wip-cap: {count}/{cap} in pending/+active/ "
        f"(over cap; project_root={project_root}).\n"
        "   Drain the WIP set before merging:\n"
        "     task scope:demote <existing>                       # return one to proposed/\n"
        "     task scope:demote --batch --older-than-days 30     # bulk relief\n"
        "   Or open a follow-up PR with --force-merge intent (audit-logged).\n"
        "   (#1124 / D4 of #1119; see plan.policy.wipCap in "
        "vbrief/PROJECT-DEFINITION.vbrief.json.)"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="preflight_wip_cap.py",
        description=(
            "Re-validate plan.policy.wipCap on the base branch (#1124 / D4 of #1119). "
            "Catches stale-branch merges, --force overrides, and out-of-band edits."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Consumer project root (default: CWD).",
    )
    parser.add_argument(
        "--allow-over-cap",
        action="store_true",
        help=(
            "Print an INFO line + exit 0 even when over cap. Reserved for "
            "the framework's own task check during landing-day overage; "
            "consumer projects MUST NOT pass this."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the success / over-cap-allowed banner; refusal stays loud.",
    )
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()

    # Lazy import so a partial install can still produce a sensible
    # error (mirrors the scope_lifecycle.py pattern).
    try:
        from policy import count_vbrief_wip, resolve_wip_cap  # noqa: I001
    except ImportError as exc:  # pragma: no cover -- D4 not present
        print(
            f"\u274c verify:wip-cap: scripts.policy not importable: {exc}",
            file=sys.stderr,
        )
        return 2

    cap_result = resolve_wip_cap(project_root)
    if cap_result.source == "default-on-error" and cap_result.error:
        print(
            f"\u274c verify:wip-cap: PROJECT-DEFINITION malformed: {cap_result.error}",
            file=sys.stderr,
        )
        return 2

    cap = cap_result.cap
    count = count_vbrief_wip(project_root)

    if count < cap:
        if not args.quiet:
            print(
                f"\u2713 verify:wip-cap: {count}/{cap} in pending/+active/ "
                f"(within cap; source={cap_result.source})."
            )
        return 0

    # Over cap (count >= cap).
    if args.allow_over_cap:
        if not args.quiet:
            # Stderr so it surfaces alongside other warnings in CI logs;
            # banner is informational, not a failure.
            print(
                (
                    f"\u26a0 verify:wip-cap: {count}/{cap} in pending/+active/ "
                    "is OVER cap, but --allow-over-cap was passed (framework "
                    "landing-day grace; consumers MUST NOT use this flag).\n"
                    "  Drain via task scope:demote / task scope:demote --batch "
                    "--older-than-days 30 (#1119 umbrella v3)."
                ),
                file=sys.stderr,
            )
        return 0

    print(_format_refusal(count, cap, project_root), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
