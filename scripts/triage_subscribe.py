#!/usr/bin/env python3
"""triage_subscribe.py -- subscribe / unsubscribe mutation verbs (D14 / #1133).

Two operations:

* :func:`subscribe` -- atomically appends a rule (or merges into an
  existing one) on ``plan.policy.triageScope[]``. Supports
  ``--label=<L>`` (merges into an existing ``labels.any-of`` rule when
  one exists, otherwise creates a new one), ``--milestone=<M>``
  (appends a new ``{rule: "milestone", name: M}`` entry), and
  ``--issue=<N>`` (appends to the first ``explicit-watch`` rule's
  ``issues`` list).
* :func:`unsubscribe` -- atomically removes a rule entry. The reverse
  of the operations above; out-of-scope cached issues are NOT deleted
  from ``.deft-cache/`` (the existing scanner v2 cache pattern is
  append-only at the framework level; lifecycle pruning is a separate
  reconciliation step the operator triggers explicitly).

Every mutation writes a ``subscription-change`` audit record to a
NEW sidecar at ``vbrief/.eval/subscription-history.jsonl`` (mirrors
the D2 ``summary-history.jsonl`` precedent). The canonical
``candidates.jsonl`` schema (#845 Story 2) is FROZEN -- it requires a
``decision`` from a fixed vocabulary and a per-issue ``issue_number``
+ ``repo`` pair, neither of which fit a subscription-level mutation.
Using a sidecar keeps the frozen schema intact while preserving the
"audit entry on every mutation" contract from the issue body.

Verbs are idempotent: re-subscribing to an already-subscribed signal
returns ``(False, "<reason>")`` without touching the file or the
audit log. After a mutating call, the CLI prints a reconciliation
hint pointing the operator at ``task triage:bootstrap -- --resume``
to backfill / mark out-of-scope cached entries.

CLI shim lives at ``scripts/_triage_subscribe_cli.py`` (1000-line cap).
"""

from __future__ import annotations

import contextlib
import getpass
import json
import os
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Sibling imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


SUBSCRIPTION_HISTORY_REL_PATH = "vbrief/.eval/subscription-history.jsonl"
SUBSCRIPTION_HISTORY_SCHEMA = "deft.triage.subscription-change.v1"

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def subscribe(
    project_root: Path,
    *,
    label: str | None = None,
    milestone: str | None = None,
    issue: int | None = None,
    issue_note: str = "added via task triage:subscribe",
    actor: str | None = None,
) -> tuple[bool, str]:
    """Add a rule (or merge into an existing one) on ``plan.policy.triageScope[]``.

    Exactly one of ``label``, ``milestone``, ``issue`` MUST be set.
    Returns ``(changed, message)``. Idempotent: re-subscribing to an
    already-covered signal is a no-op with informational ``message``.

    On a successful mutation, atomically writes PROJECT-DEFINITION and
    appends a ``subscription-change`` record to
    ``vbrief/.eval/subscription-history.jsonl``.
    """
    return _mutate(
        project_root,
        op="subscribe",
        label=label,
        milestone=milestone,
        issue=issue,
        issue_note=issue_note,
        actor=actor,
    )


def unsubscribe(
    project_root: Path,
    *,
    label: str | None = None,
    milestone: str | None = None,
    issue: int | None = None,
    actor: str | None = None,
) -> tuple[bool, str]:
    """Remove a rule entry from ``plan.policy.triageScope[]``.

    Idempotent: removing an already-absent signal is a no-op. Returns
    ``(changed, message)`` mirroring :func:`subscribe`.
    """
    return _mutate(
        project_root,
        op="unsubscribe",
        label=label,
        milestone=milestone,
        issue=issue,
        actor=actor,
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _mutate(
    project_root: Path,
    *,
    op: str,
    label: str | None,
    milestone: str | None,
    issue: int | None,
    issue_note: str = "added via task triage:subscribe",
    actor: str | None = None,
) -> tuple[bool, str]:
    """Shared subscribe/unsubscribe core."""
    chosen = [
        name
        for name, val in (("label", label), ("milestone", milestone), ("issue", issue))
        if val is not None
    ]
    if len(chosen) != 1:
        raise ValueError(
            f"{op}() requires exactly one of --label / --milestone / --issue; "
            f"got {chosen}"
        )

    from _project_definition_io import (
        atomic_write_project_definition,
        load_project_definition_for_mutation,
    )

    data, path = load_project_definition_for_mutation(project_root)
    plan = data.setdefault("plan", {})
    if not isinstance(plan, dict):
        raise ValueError(f"PROJECT-DEFINITION at {path} has a non-object 'plan' key")
    policy = plan.setdefault("policy", {})
    if not isinstance(policy, dict):
        raise ValueError(f"PROJECT-DEFINITION at {path} has a non-object 'plan.policy' key")
    rules = policy.setdefault("triageScope", [])
    if not isinstance(rules, list):
        raise ValueError(
            f"PROJECT-DEFINITION at {path} has a non-list 'plan.policy.triageScope'"
        )

    before = _snapshot_rules(rules)
    if op == "subscribe":
        changed, message = _apply_subscribe(rules, label, milestone, issue, issue_note)
    elif op == "unsubscribe":
        changed, message = _apply_unsubscribe(rules, label, milestone, issue)
    else:  # pragma: no cover -- defensive
        raise ValueError(f"unknown op {op!r}")

    if not changed:
        return False, message

    atomic_write_project_definition(path, data)
    after = _snapshot_rules(rules)
    record_subscription_change(
        project_root,
        op=op,
        label=label,
        milestone=milestone,
        issue=issue,
        before=before,
        after=after,
        actor=actor,
    )
    return True, message


def _apply_subscribe(
    rules: list[Any],
    label: str | None,
    milestone: str | None,
    issue: int | None,
    issue_note: str,
) -> tuple[bool, str]:
    if label is not None:
        # Find or create a labels rule (any-of). When an existing labels
        # rule uses all-of we leave it alone and append a new any-of rule
        # so we don't silently weaken the operator's all-of intent.
        for rule in rules:
            if (
                isinstance(rule, dict)
                and rule.get("rule") == "labels"
                and isinstance(rule.get("any-of"), list)
            ):
                if label in rule["any-of"]:
                    return False, f"already-subscribed (labels.any-of contains {label!r})"
                rule["any-of"].append(label)
                return True, f"added {label!r} to existing labels.any-of"
        rules.append({"rule": "labels", "any-of": [label]})
        return True, f"created new labels.any-of rule for {label!r}"

    if milestone is not None:
        for rule in rules:
            if (
                isinstance(rule, dict)
                and rule.get("rule") == "milestone"
                and rule.get("name") == milestone
            ):
                return False, f"already-subscribed (milestone {milestone!r})"
        rules.append({"rule": "milestone", "name": milestone})
        return True, f"added milestone rule for {milestone!r}"

    if issue is not None:
        for rule in rules:
            if (
                isinstance(rule, dict)
                and rule.get("rule") == "explicit-watch"
                and isinstance(rule.get("issues"), list)
            ):
                if any(isinstance(e, dict) and e.get("n") == issue for e in rule["issues"]):
                    return False, f"already-subscribed (explicit-watch issue #{issue})"
                rule["issues"].append({"n": issue, "note": issue_note})
                return True, f"added #{issue} to existing explicit-watch"
        rules.append(
            {
                "rule": "explicit-watch",
                "issues": [{"n": issue, "note": issue_note}],
            }
        )
        return True, f"created new explicit-watch rule for #{issue}"

    return False, "no-op"  # pragma: no cover -- guarded by _mutate


def _apply_unsubscribe(
    rules: list[Any],
    label: str | None,
    milestone: str | None,
    issue: int | None,
) -> tuple[bool, str]:
    if label is not None:
        for i, rule in enumerate(rules):
            if not isinstance(rule, dict) or rule.get("rule") != "labels":
                continue
            for key in ("any-of", "all-of"):
                items = rule.get(key)
                if isinstance(items, list) and label in items:
                    items.remove(label)
                    if not items:
                        # Drop the whole rule when the last label is gone.
                        rules.pop(i)
                    return True, f"removed {label!r} from labels.{key}"
        return False, f"not-subscribed (no labels rule mentions {label!r})"

    if milestone is not None:
        for i, rule in enumerate(rules):
            if (
                isinstance(rule, dict)
                and rule.get("rule") == "milestone"
                and rule.get("name") == milestone
            ):
                rules.pop(i)
                return True, f"removed milestone rule for {milestone!r}"
        return False, f"not-subscribed (no milestone rule for {milestone!r})"

    if issue is not None:
        for i, rule in enumerate(rules):
            if not isinstance(rule, dict) or rule.get("rule") != "explicit-watch":
                continue
            items = rule.get("issues")
            if not isinstance(items, list):
                continue
            new_items = [e for e in items if not (isinstance(e, dict) and e.get("n") == issue)]
            if len(new_items) != len(items):
                if not new_items:
                    rules.pop(i)
                else:
                    rule["issues"] = new_items
                return True, f"removed #{issue} from explicit-watch"
        return False, f"not-subscribed (no explicit-watch entry for #{issue})"

    return False, "no-op"  # pragma: no cover


def _snapshot_rules(rules: list[Any]) -> list[Any]:
    """Return a JSON-safe deep copy of the rules list for audit diffing."""
    return json.loads(json.dumps(rules))


def _utc_iso(dt: datetime | None = None) -> str:
    return (dt or datetime.now(UTC)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _resolve_actor(actor: str | None) -> str:
    if isinstance(actor, str) and actor.strip():
        return actor
    env_actor = os.environ.get("DEFT_TRIAGE_ACTOR")
    if isinstance(env_actor, str) and env_actor.strip():
        return env_actor
    try:
        return f"user:{getpass.getuser()}"
    except (KeyError, OSError):
        return "user:unknown"


def record_subscription_change(
    project_root: Path,
    *,
    op: str,
    label: str | None = None,
    milestone: str | None = None,
    issue: int | None = None,
    author: str | None = None,
    before: list[Any] | None = None,
    after: list[Any] | None = None,
    actor: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Append one JSONL record to ``vbrief/.eval/subscription-history.jsonl``.

    Public since D14c (#1182): the ignore-list mutation surface
    (``scripts/triage_scope_drift.add_ignore``) and the new
    ``task triage:scope`` wrapper verbs need to write the same audit
    trail subscribe / unsubscribe already write. ``op`` carries the
    verb-name discriminator (``subscribe``, ``unsubscribe``,
    ``ignore-label``, ``ignore-milestone``, ``ignore-author``);
    schema field names mirror the discriminator (``label`` /
    ``milestone`` / ``issue`` / ``author``).

    ``extra`` is a per-op opaque blob (e.g. ``{"any-of": [...]}`` for
    ignore-author) preserved verbatim in the JSONL record so consumers
    can audit the structured payload.

    Pure-stdlib append. Failures are silenced via ``contextlib.suppress``
    because the sidecar is observability, not load-bearing for the
    mutation itself.
    """
    history_path = project_root / SUBSCRIPTION_HISTORY_REL_PATH
    record: dict[str, Any] = {
        "schema": SUBSCRIPTION_HISTORY_SCHEMA,
        "change_id": str(uuid.uuid4()),
        "timestamp": _utc_iso(),
        "actor": _resolve_actor(actor),
        "op": op,
        "label": label,
        "milestone": milestone,
        "issue": issue,
        "author": author,
        "before": before if before is not None else [],
        "after": after if after is not None else [],
    }
    if extra:
        record["extra"] = extra
    line = json.dumps(record, sort_keys=True, ensure_ascii=False)
    with contextlib.suppress(OSError):
        history_path.parent.mkdir(parents=True, exist_ok=True)
        with open(history_path, "a", encoding="utf-8", newline="") as fh:
            fh.write(line + "\n")
            fh.flush()
            with contextlib.suppress(OSError):
                os.fsync(fh.fileno())


# Backward-compat alias for the private name retained for callers that
# imported the leading-underscore form before D14c (#1182).
_append_subscription_change = record_subscription_change


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Delegates to :mod:`_triage_subscribe_cli`."""
    import sys as _sys

    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_subscribe", argv)
    if rc is not None:
        return rc

    from _triage_subscribe_cli import run_cli

    return run_cli(argv, _sys.modules[__name__])


if __name__ == "__main__":
    sys.exit(main())
