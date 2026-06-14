#!/usr/bin/env python3
"""verify_investigation.py -- deterministic validator for forensic investigation ledgers (#1621).

Promotes the prose validator from the vendored ``forensic-research`` reference
design (``docs/reference/forensic-research/references/investigation-profile.md``
section "Validator pass") into a deterministic gate. An investigation ledger is
the thin vBRIEF 0.6 profile (``forensic-research-v1``) written under
``.tmp/investigations/<id>/investigation.vbrief.json``; this gate is the
"before Wave 5 / before any causal chat" close check.

Run it against a specific ledger -- it is intentionally NOT part of the
``task check`` aggregate (like ``verify:story-ready``), because a generic
``task check`` run has no investigation path to supply:

    task verify:investigation -- --ledger .tmp/investigations/<id>/investigation.vbrief.json
    uv run python scripts/verify_investigation.py --ledger <path> [--json]

Hard failures (the close is refused -- exit 1):

- ``HF-WAVES``   -- ``metadata.x-investigation.wavesCompleted`` is missing any of
  waves 1-4 set to ``true`` (falsifier + red-team skipped -- the #1 forensic
  discipline failure).
- ``HF-STATUS``  -- ``plan.status`` is still ``running`` (cannot close an
  investigation that is still in flight).
- ``HF-FAILED-CLAIM`` -- a claim with ``status: failed`` is missing
  ``ruledOutReason`` or ``evidenceRefs`` (proof-required disproval).
- ``HF-COMPLETED-CLAIM`` -- a claim with ``status: completed`` is missing
  ``evidenceRefs`` (evidence before narrative).
- ``HF-DANGLING-EV`` -- a claim cites an ``EV-*`` ref that is absent from
  ``plan.references``.
- ``HF-BRANCH-NO-EDGE`` -- a branch with ``status: failed`` has no
  ``invalidates`` edge targeting it (a branch is ruled out only by a falsified
  child claim).

Soft warnings (printed, do not fail -- the close proceeds):

- ``SW-BLOCKED`` -- a live branch carries ``blocked`` (unknown) claims.
- ``SW-MULTI-SURVIVOR`` -- more than one branch is ``completed`` (multiple
  surviving theories).

Exit codes (three-state, mirrors ``scripts/verify_encoding.py``):

- ``0`` -- ledger passes the validator (close-ready / clean).
- ``1`` -- one or more hard failures (close refused).
- ``2`` -- config error: ledger path missing / unreadable, malformed JSON,
  missing required keys, or not a ``forensic-research`` profile ledger.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REQUIRED_WAVES = ("1", "2", "3", "4")


@dataclass
class Finding:
    code: str
    message: str


@dataclass
class ValidationResult:
    hard_failures: list[Finding] = field(default_factory=list)
    soft_warnings: list[Finding] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.hard_failures


class LedgerConfigError(Exception):
    """Raised when the ledger cannot be parsed into a validatable shape."""


def _iter_claims(items: list[dict[str, Any]]) -> list[tuple[dict[str, Any], dict[str, Any] | None]]:
    """Flatten branch -> claim items.

    Returns a list of ``(claim, parent_branch)`` tuples for every nested item
    (depth >= 1). Top-level items are treated as branches; their children are
    claims. Deeper nesting is flattened with the nearest top-level branch as
    parent.
    """
    out: list[tuple[dict[str, Any], dict[str, Any] | None]] = []

    def walk(node: dict[str, Any], branch: dict[str, Any] | None) -> None:
        for child in node.get("items", []) or []:
            if not isinstance(child, dict):
                continue
            out.append((child, branch))
            walk(child, branch)

    for top in items:
        if not isinstance(top, dict):
            continue
        walk(top, top)
    return out


def _claim_meta(claim: dict[str, Any]) -> dict[str, Any]:
    meta = claim.get("metadata") or {}
    xclaim = meta.get("x-claim") or {}
    return xclaim if isinstance(xclaim, dict) else {}


def _evidence_refs(xclaim: dict[str, Any]) -> list[str]:
    refs = xclaim.get("evidenceRefs") or []
    return [str(r) for r in refs] if isinstance(refs, list) else []


def load_ledger(path: Path) -> dict[str, Any]:
    """Load + structurally validate a ledger file. Raises LedgerConfigError."""
    if not path.is_file():
        raise LedgerConfigError(f"ledger not found: {path}")
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:  # pragma: no cover - unreadable file
        raise LedgerConfigError(f"ledger unreadable: {path}: {exc}") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LedgerConfigError(f"ledger is not valid JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise LedgerConfigError(f"ledger root is not an object: {path}")
    plan = data.get("plan")
    if not isinstance(plan, dict):
        raise LedgerConfigError(f"ledger missing 'plan' object: {path}")
    if not isinstance(plan.get("items"), list):
        raise LedgerConfigError(f"ledger missing 'plan.items' array: {path}")
    meta = plan.get("metadata") or {}
    xinv = meta.get("x-investigation") or {}
    profile = xinv.get("profile") if isinstance(xinv, dict) else None
    if profile != "forensic-research-v1":
        raise LedgerConfigError(
            f"ledger is not a forensic-research-v1 profile (got {profile!r}): {path}"
        )
    return data


def validate_ledger(data: dict[str, Any]) -> ValidationResult:
    """Apply the validator checklist to an already-loaded ledger dict."""
    result = ValidationResult()
    plan = data["plan"]
    items = plan["items"]
    meta = plan.get("metadata") or {}
    xinv = meta.get("x-investigation") or {}

    # HF-WAVES: falsifier + red-team must not be skipped.
    waves = xinv.get("wavesCompleted") or {}
    if not isinstance(waves, dict):
        waves = {}
    missing = [w for w in REQUIRED_WAVES if waves.get(w) is not True]
    if missing:
        result.hard_failures.append(
            Finding(
                "HF-WAVES",
                f"wavesCompleted is missing {missing} -- falsifier (3) + "
                "red-team (4) MUST run before close",
            )
        )

    # HF-STATUS: cannot close a running investigation.
    status = plan.get("status")
    if status == "running":
        result.hard_failures.append(
            Finding(
                "HF-STATUS",
                "plan.status is still 'running' -- set it to completed/failed "
                "before close",
            )
        )

    # Build the reference id set for dangling-EV detection. Only the
    # structured `id` counts -- admitting `title` would let a claim cite a
    # reference's human-readable label and bypass HF-DANGLING-EV (Greptile P1).
    ref_ids: set[str] = set()
    for ref in plan.get("references", []) or []:
        if isinstance(ref, dict):
            val = ref.get("id")
            if isinstance(val, str):
                ref_ids.add(val)

    claims = _iter_claims(items)
    for claim, _branch in claims:
        cid = claim.get("id", "<no-id>")
        cstatus = claim.get("status")
        # Only leaf claims (no children) carry evidence obligations.
        is_branch = bool(claim.get("items"))
        if is_branch:
            continue
        xclaim = _claim_meta(claim)
        refs = _evidence_refs(xclaim)

        if cstatus == "failed":
            if not xclaim.get("ruledOutReason") or not refs:
                result.hard_failures.append(
                    Finding(
                        "HF-FAILED-CLAIM",
                        f"claim {cid} is 'failed' but missing ruledOutReason "
                        "and/or evidenceRefs (proof-required disproval)",
                    )
                )
        elif cstatus == "completed":
            if not refs:
                result.hard_failures.append(
                    Finding(
                        "HF-COMPLETED-CLAIM",
                        f"claim {cid} is 'completed' but cites no evidenceRefs "
                        "(evidence before narrative)",
                    )
                )
        elif cstatus == "blocked":
            result.soft_warnings.append(
                Finding(
                    "SW-BLOCKED",
                    f"claim {cid} is 'blocked' (unknown) -- residual "
                    "uncertainty on a live branch",
                )
            )

        # HF-DANGLING-EV: every cited ref must exist in plan.references.
        for ref in refs:
            if ref not in ref_ids:
                result.hard_failures.append(
                    Finding(
                        "HF-DANGLING-EV",
                        f"claim {cid} cites evidence ref {ref!r} not present "
                        "in plan.references",
                    )
                )

    # HF-BRANCH-NO-EDGE: a failed branch needs an invalidates edge.
    invalidates_targets: set[str] = set()
    for edge in plan.get("edges", []) or []:
        if isinstance(edge, dict) and edge.get("type") == "invalidates":
            tgt = edge.get("to")
            if isinstance(tgt, str):
                invalidates_targets.add(tgt)

    completed_branches = 0
    for top in items:
        if not isinstance(top, dict):
            continue
        bid = top.get("id", "<no-id>")
        bstatus = top.get("status")
        if bstatus == "failed" and bid not in invalidates_targets:
            result.hard_failures.append(
                Finding(
                    "HF-BRANCH-NO-EDGE",
                    f"branch {bid} is 'failed' but has no invalidates edge -- "
                    "a branch is ruled out only by a falsified child claim",
                )
            )
        if bstatus == "completed":
            completed_branches += 1

    if completed_branches > 1:
        result.soft_warnings.append(
            Finding(
                "SW-MULTI-SURVIVOR",
                f"{completed_branches} branches are 'completed' -- multiple "
                "surviving theories; note in Outcome",
            )
        )

    return result


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate a forensic investigation ledger (#1621).",
    )
    parser.add_argument(
        "--ledger",
        dest="ledger",
        help="Path to investigation.vbrief.json (the forensic-research-v1 ledger).",
    )
    parser.add_argument(
        "ledger_positional",
        nargs="?",
        help="Positional ledger path (alternative to --ledger).",
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root for resolving a relative --ledger path.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a machine-readable JSON result.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    ledger_arg = args.ledger or args.ledger_positional
    if not ledger_arg:
        print("config error: no ledger path given (--ledger <path>)", file=sys.stderr)
        return 2

    path = Path(ledger_arg)
    if not path.is_absolute():
        path = (Path(args.project_root) / path).resolve()

    try:
        data = load_ledger(path)
    except LedgerConfigError as exc:
        if args.json:
            print(json.dumps({"exit": 2, "error": str(exc)}))
        else:
            print(f"config error: {exc}", file=sys.stderr)
        return 2

    result = validate_ledger(data)

    if args.json:
        print(
            json.dumps(
                {
                    "exit": 0 if result.ok else 1,
                    "hard_failures": [
                        {"code": f.code, "message": f.message}
                        for f in result.hard_failures
                    ],
                    "soft_warnings": [
                        {"code": f.code, "message": f.message}
                        for f in result.soft_warnings
                    ],
                }
            )
        )
        return 0 if result.ok else 1

    for warn in result.soft_warnings:
        print(f"warning [{warn.code}]: {warn.message}")

    if result.ok:
        print(
            f"OK investigation ledger passes the validator: {path} "
            f"({len(result.soft_warnings)} soft warning(s))"
        )
        return 0

    print(f"investigation ledger NOT close-ready: {path}", file=sys.stderr)
    for fail in result.hard_failures:
        print(f"  hard failure [{fail.code}]: {fail.message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
