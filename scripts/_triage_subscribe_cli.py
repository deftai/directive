"""CLI helpers for ``scripts/triage_subscribe.py`` (D14 / #1133)."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

_RECONCILE_HINT = (
    "  Reconciliation: run `task triage:bootstrap -- --resume` to "
    "backfill / mark out-of-scope cached entries."
)


def build_parser(op: str) -> argparse.ArgumentParser:
    """Build the subscribe / unsubscribe arg parser. ``op`` is one of the two."""
    if op not in {"subscribe", "unsubscribe"}:
        raise ValueError(f"unknown op {op!r}")
    parser = argparse.ArgumentParser(
        prog=f"triage_subscribe.py {op}",
        description=(
            f"{op.capitalize()} a rule on plan.policy.triageScope[]. "
            "Exactly one of --label / --milestone / --issue is required. "
            "Atomic; idempotent; appends a subscription-change record to "
            "vbrief/.eval/subscription-history.jsonl (D14 / #1133)."
        ),
    )
    parser.add_argument(
        "op",
        choices=["subscribe", "unsubscribe"],
        help="The operation to perform (positional discriminator).",
    )
    parser.add_argument(
        "--project-root",
        default=os.environ.get("DEFT_PROJECT_ROOT", "."),
        help=(
            "Consumer project root (default: $DEFT_PROJECT_ROOT or cwd)."
        ),
    )
    parser.add_argument(
        "--label",
        default=None,
        help="Label name to (un)subscribe (mutually exclusive with --milestone/--issue).",
    )
    parser.add_argument(
        "--milestone",
        default=None,
        help="Milestone name to (un)subscribe (mutually exclusive).",
    )
    parser.add_argument(
        "--issue",
        type=int,
        default=None,
        help="Issue number to (un)subscribe via explicit-watch (mutually exclusive).",
    )
    parser.add_argument(
        "--issue-note",
        default="added via task triage:subscribe",
        help=(
            "Note attached to a new explicit-watch entry (subscribe only; "
            "ignored on unsubscribe). Required for future-operator legibility "
            "per #1131 Decision 4."
        ),
    )
    parser.add_argument(
        "--actor",
        default=None,
        help=(
            "Override the audit-log actor field (default: $DEFT_TRIAGE_ACTOR "
            "or 'user:<login>')."
        ),
    )
    return parser


def run_cli(argv: list[str] | None, module: Any) -> int:
    """Dispatch the subscribe / unsubscribe CLI."""
    raw = list(argv) if argv is not None else sys.argv[1:]
    if not raw or raw[0] not in {"subscribe", "unsubscribe"}:
        print(
            "triage:subscribe: first positional arg must be 'subscribe' or "
            "'unsubscribe'; e.g. task triage:subscribe -- --label=bug",
            file=sys.stderr,
        )
        return 2
    op = raw[0]
    parser = build_parser(op)
    args = parser.parse_args(raw)

    project_root = Path(args.project_root).resolve()
    if not project_root.exists() or not project_root.is_dir():
        print(
            f"triage:{op}: --project-root {project_root} does not exist "
            "or is not a directory.",
            file=sys.stderr,
        )
        return 2

    chosen = sum(
        1 for v in (args.label, args.milestone, args.issue) if v is not None
    )
    if chosen != 1:
        print(
            f"triage:{op}: exactly one of --label / --milestone / --issue "
            "is required.",
            file=sys.stderr,
        )
        return 2

    try:
        if op == "subscribe":
            changed, message = module.subscribe(
                project_root,
                label=args.label,
                milestone=args.milestone,
                issue=args.issue,
                issue_note=args.issue_note,
                actor=args.actor,
            )
        else:
            changed, message = module.unsubscribe(
                project_root,
                label=args.label,
                milestone=args.milestone,
                issue=args.issue,
                actor=args.actor,
            )
    except Exception as exc:  # pylint: disable=broad-except
        print(f"triage:{op}: {exc}", file=sys.stderr)
        return 1

    if not changed:
        print(f"triage:{op}: {message} (no-op).", file=sys.stderr)
        return 0

    print(f"triage:{op}: {message}.")
    print(_RECONCILE_HINT, file=sys.stderr)
    return 0
