#!/usr/bin/env python3
"""verify_judgment_gates.py -- risk-tiered judgment-gate engine (#1419 Slice 3).

Surfaced via the ADVISORY ``task verify:judgment-gates`` target. Evaluates a
candidate change (diff paths / labels / body) against the configured
``plan.policy.judgmentGates`` plus four DEFAULT-ON universal safety gates, and
reports which gates fired, which are cleared, and which carry a stale clearance.

Posture (advise vs enforce)
---------------------------
The engine supports a fail-closed exit, but the directive-side wiring is
ADVISORY. The default posture is ``advise``: ``evaluate`` ALWAYS exits 0, so it
is safe to run anywhere and is deliberately NOT wired into the ``task check``
aggregate -- a judgment-gate finding MUST NOT fail-closed and wedge the
framework's own master. The opt-in ``--enforce`` flag (or ``posture="enforce"``)
flips on the fail-closed behaviour for projects that have rolled out from
advise -> observe -> block.

Gate classes (fail-closed vs fail-open)
---------------------------------------
* ``mechanical`` -- the risky condition is mechanically detectable (a secrets
  path in the diff, an infra label). On DETECTION without a valid clearance the
  gate fails CLOSED: under ``enforce`` a fired mechanical block-tier gate exits
  1. The four universal gates are mechanical / block-tier.
* ``declared`` -- the risky condition depends on a human declaration that the
  framework cannot detect. On OMISSION (no clearance) the gate fails OPEN: it
  emits an advisory requirement but never blocks. When a clearance IS recorded
  the gate validates it (and re-triggers on scope creep).

Clearance binding
-----------------
A clearance binds to a ``cleared_scope`` fingerprint (a sha256 over the sorted
matched paths + labels). When the cleared scope later changes (scope creep adds
or removes a matched path) the recomputed fingerprint no longer matches, the
stale clearance is rejected, and the gate re-triggers. Clearances are recorded
to the durable audit log at ``vbrief/.audit/judgment-gate-clearances.jsonl``.

Exit codes (three-state, mirrors the other deft verify gates):

* ``0`` -- within targets, OR advisory posture (the only state reachable on the
  framework's own advise-default tree).
* ``1`` -- ``enforce`` posture with at least one fired mechanical block-tier gate.
* ``2`` -- config error (``--project-root`` is not a directory).

Scope boundary (#1419): this engine does NOT integrate clearances into Gate 0 /
story-start / swarm:launch -- that is Slice 7. It owns the gate logic, the
universal gates, and the clearance audit log only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Make sibling helpers importable both as __main__ and when imported by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _pathspec import match_any  # noqa: E402
from _safe_subprocess import run_text  # noqa: E402
from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from policy import (  # noqa: E402
    JudgmentGate,
    JudgmentGatesPolicy,
    resolve_judgment_gates,
)

# Reuse the triageAutoClassify match DSL (labels / body-text / state / age-days)
# verbatim -- the engine only adds the new `paths` glob predicate on top.
from triage_classify import _consumer_rule_matches  # noqa: E402

reconfigure_stdio()

#: Durable, operator-private clearance audit log location (#1419 Slice 3).
AUDIT_DIR_REL = "vbrief/.audit"
CLEARANCE_LOG_NAME = "judgment-gate-clearances.jsonl"

UNIVERSAL_SOURCE = "universal"
CONSUMER_SOURCE = "consumer"

#: Four DEFAULT-ON universal safety gates. All are ``mechanical`` /
#: ``block``-tier: a diff that touches any of these surfaces fails closed under
#: an ``enforce`` posture unless a clearance is recorded. Each can be switched
#: off per-project via ``plan.policy.judgmentGatesDisabled`` (by id).
UNIVERSAL_GATES: tuple[dict[str, Any], ...] = (
    {
        "id": "secrets-and-credentials",
        "class": "mechanical",
        "tier": "block",
        "requiredHumanReviewers": 1,
        "reason": "Touches secrets / credential material; requires human sign-off.",
        "source": UNIVERSAL_SOURCE,
        "match": {
            "paths": {
                "any-of": [
                    "secrets/**",
                    "**/secrets/**",
                    ".env",
                    "**/.env",
                    "**/*.env",
                    "**/*.pem",
                    "**/*.key",
                    "**/*.p12",
                    "**/*.pfx",
                    "**/id_rsa",
                    "**/id_rsa.*",
                    "**/*.keystore",
                    "**/credentials",
                    "**/credentials.*",
                    "**/.npmrc",
                    "**/.pypirc",
                ]
            }
        },
    },
    {
        "id": "production-infrastructure",
        "class": "mechanical",
        "tier": "block",
        "requiredHumanReviewers": 1,
        "reason": "Touches production infrastructure / deploy config; requires sign-off.",
        "source": UNIVERSAL_SOURCE,
        "match": {
            "paths": {
                "any-of": [
                    "**/*.tf",
                    "**/*.tfvars",
                    "**/*.tfstate",
                    "terraform/**",
                    "infra/**",
                    "**/Dockerfile",
                    "**/Dockerfile.*",
                    "**/docker-compose*.yml",
                    "**/docker-compose*.yaml",
                    "**/k8s/**",
                    "**/kubernetes/**",
                    "**/helm/**",
                    "**/.github/workflows/**",
                ]
            }
        },
    },
    {
        "id": "agents-md-and-skills",
        "class": "mechanical",
        "tier": "block",
        "requiredHumanReviewers": 1,
        "reason": "Touches agent directives (AGENTS.md / skills); requires sign-off.",
        "source": UNIVERSAL_SOURCE,
        "match": {
            "paths": {
                "any-of": [
                    "AGENTS.md",
                    "**/AGENTS.md",
                    "skills/**",
                    "**/skills/**",
                    "templates/agents-entry.md",
                ]
            }
        },
    },
    {
        "id": "installer-and-bootstrap",
        "class": "mechanical",
        "tier": "block",
        "requiredHumanReviewers": 1,
        "reason": "Touches installer / bootstrap surface; requires sign-off.",
        "source": UNIVERSAL_SOURCE,
        "match": {
            "paths": {
                "any-of": [
                    "install.ps1",
                    "install.sh",
                    "**/install.ps1",
                    "**/install.sh",
                    "installer/**",
                    "**/installer/**",
                    "scripts/setup*.py",
                    "**/deft-install*",
                    "bootstrap",
                    "**/bootstrap",
                    "**/bootstrap.*",
                ]
            }
        },
    },
)


@dataclass(frozen=True)
class Candidate:
    """The change being evaluated: changed paths, labels, body, state, age."""

    paths: tuple[str, ...] = ()
    labels: tuple[str, ...] = ()
    body: str = ""
    state: str = "open"
    updated_at: str | None = None

    def as_issue(self) -> dict[str, Any]:
        """Shape the candidate as a GitHub-issue-ish dict for the triage DSL."""
        return {
            "labels": list(self.labels),
            "body": self.body,
            "state": self.state,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class GateOutcome:
    """The result of evaluating one matched gate against a candidate."""

    gate_id: str
    gate_class: str
    tier: str
    reason: str
    required_human_reviewers: int
    source: str  # 'universal' | 'consumer'
    matched_paths: tuple[str, ...]
    matched_labels: tuple[str, ...]
    cleared_scope: str
    clearance: dict[str, Any] | None
    stale_clearance: dict[str, Any] | None

    @property
    def cleared(self) -> bool:
        """True when a clearance bound to the current cleared_scope exists."""
        return self.clearance is not None

    @property
    def fired(self) -> bool:
        """True when the gate matched but has no valid (fresh) clearance."""
        return self.clearance is None

    @property
    def blocking(self) -> bool:
        """True when this fired gate is a fail-closed mechanical block gate."""
        return self.fired and self.gate_class == "mechanical" and self.tier == "block"


@dataclass(frozen=True)
class JudgmentGateReport:
    """Aggregate of every matched-gate outcome for a candidate."""

    posture: str
    outcomes: tuple[GateOutcome, ...]
    policy_error: str | None = None

    @property
    def fired(self) -> tuple[GateOutcome, ...]:
        return tuple(o for o in self.outcomes if o.fired)

    @property
    def blocking(self) -> tuple[GateOutcome, ...]:
        return tuple(o for o in self.outcomes if o.blocking)

    @property
    def block_tier_requirements(self) -> tuple[GateOutcome, ...]:
        """Every matched block-tier gate (the a4 default-on universal surface)."""
        return tuple(o for o in self.outcomes if o.tier == "block")

    def outcome_for(self, gate_id: str) -> GateOutcome | None:
        for outcome in self.outcomes:
            if outcome.gate_id == gate_id:
                return outcome
        return None


# ---------------------------------------------------------------------------
# Clearance audit log (vbrief/.audit/judgment-gate-clearances.jsonl)
# ---------------------------------------------------------------------------


def clearance_log_path(project_root: Path) -> Path:
    """Resolve the durable clearance audit log path under *project_root*."""
    return project_root / AUDIT_DIR_REL / CLEARANCE_LOG_NAME


def _utc_now_iso(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_clearances(
    project_root: Path, *, log_path: Path | None = None
) -> list[dict[str, Any]]:
    """Return every well-formed clearance record in insertion order.

    Tolerant of malformed lines (skips them) so a torn write never crashes a
    gate evaluation.
    """
    path = log_path or clearance_log_path(project_root)
    if not path.is_file():
        return []
    out: list[dict[str, Any]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def record_clearance(
    project_root: Path,
    *,
    gate_id: str,
    cleared_scope: str,
    reviewers: list[str] | None = None,
    actor: str = "operator",
    reason: str = "",
    now: datetime | None = None,
    log_path: Path | None = None,
) -> dict[str, Any]:
    """Append a clearance record to the durable audit log and return it.

    The record binds the sign-off to *cleared_scope* so that a later scope
    change rejects the now-stale clearance (the gate re-triggers).
    """
    path = log_path or clearance_log_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry: dict[str, Any] = {
        "clearance_id": str(uuid.uuid4()),
        "timestamp": _utc_now_iso(now),
        "gate_id": gate_id,
        "cleared_scope": cleared_scope,
        "reviewers": list(reviewers or []),
        "actor": actor,
        "reason": reason,
    }
    line = json.dumps(entry, sort_keys=True, ensure_ascii=False)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    return entry


def fingerprint_scope(evidence: dict[str, Any]) -> str:
    """Return a stable sha256 fingerprint of the cleared-scope *evidence*.

    *evidence* is the per-predicate matched evidence dict produced by
    :func:`match_evidence` -- it carries a key for EVERY predicate the gate
    matched on (``paths`` / ``labels`` / ``body-text`` / ``state`` /
    ``age-days``), not just paths + labels. Binding the clearance to the full
    evidence means a change to ANY matched dimension (a new matched path, an
    edited body, a state flip, the issue ageing) yields a different
    fingerprint, so the stale clearance is rejected and the gate re-triggers.
    """
    payload = json.dumps(evidence, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _lookup_clearance(
    clearances: list[dict[str, Any]], gate_id: str, scope: str
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Return ``(valid, stale)`` clearance records for *gate_id* / *scope*.

    ``valid`` is the most recent clearance bound to the current *scope*;
    ``stale`` is the most recent clearance for the gate bound to a DIFFERENT
    scope (the scope-creep / sign-off-then-changed case). Both default to None.
    """
    valid: dict[str, Any] | None = None
    stale: dict[str, Any] | None = None
    for entry in clearances:
        if entry.get("gate_id") != gate_id:
            continue
        if entry.get("cleared_scope") == scope:
            valid = entry
        else:
            stale = entry
    return valid, stale


# ---------------------------------------------------------------------------
# Gate matching + report
# ---------------------------------------------------------------------------


def _consumer_gate_to_dict(gate: JudgmentGate) -> dict[str, Any]:
    return {
        "id": gate.gate_id,
        "class": gate.gate_class,
        "tier": gate.tier,
        "reason": gate.reason,
        "requiredHumanReviewers": gate.required_human_reviewers,
        "match": gate.match,
        "source": CONSUMER_SOURCE,
    }


def effective_gates(
    project_root: Path, *, policy: JudgmentGatesPolicy | None = None
) -> list[dict[str, Any]]:
    """Return the universal + consumer gates with disabled ids removed."""
    resolved = policy if policy is not None else resolve_judgment_gates(project_root)
    disabled = set(resolved.disabled)
    gates = [g for g in UNIVERSAL_GATES if g["id"] not in disabled]
    gates.extend(
        _consumer_gate_to_dict(g) for g in resolved.gates if g.gate_id not in disabled
    )
    return gates


def _matched_labels(match: dict[str, Any], candidate: Candidate) -> tuple[str, ...]:
    labels_pred = match.get("labels")
    if not isinstance(labels_pred, dict):
        return ()
    names = set(candidate.labels)
    selected = labels_pred.get("any-of")
    if selected is None:
        selected = labels_pred.get("all-of")
    if not isinstance(selected, list):
        return ()
    return tuple(sorted(label for label in selected if label in names))


#: Triage-DSL predicate keys handled by ``triage_classify._consumer_rule_matches``
#: (the ``paths`` glob predicate is owned by this engine, not the triage DSL).
_TRIAGE_PREDICATES: frozenset[str] = frozenset(
    {"labels", "body-text", "state", "age-days"}
)


def match_evidence(
    match: dict[str, Any], candidate: Candidate, matched_paths: tuple[str, ...]
) -> dict[str, Any]:
    """Build the per-predicate matched-evidence dict for a matched gate.

    Only the predicates the gate actually declares contribute a key, and each
    key carries the candidate dimension that determined the match: the sorted
    matched paths, the sorted matched labels, the FULL candidate body (any
    edit re-triggers a body-text gate), the candidate state, and the
    candidate's age basis (``updated_at``). This is the input to
    :func:`fingerprint_scope`.
    """
    evidence: dict[str, Any] = {}
    if "paths" in match:
        evidence["paths"] = sorted(matched_paths)
    if "labels" in match:
        evidence["labels"] = list(_matched_labels(match, candidate))
    if "body-text" in match:
        evidence["body-text"] = candidate.body
    if "state" in match:
        evidence["state"] = candidate.state
    if "age-days" in match:
        evidence["age-days"] = candidate.updated_at or ""
    return evidence


def _gate_match(
    gate: dict[str, Any], candidate: Candidate, *, now: datetime
) -> tuple[bool, dict[str, Any], tuple[str, ...], tuple[str, ...]]:
    """Return ``(matched, evidence, matched_paths, matched_labels)`` for *gate*."""
    match = gate.get("match")
    if not isinstance(match, dict):
        return False, {}, (), ()
    matched_paths: tuple[str, ...] = ()
    if "paths" in match:
        paths_pred = match["paths"]
        globs = paths_pred.get("any-of") if isinstance(paths_pred, dict) else None
        hits = tuple(p for p in candidate.paths if match_any(globs, p))
        if not hits:
            return False, {}, (), ()
        matched_paths = hits
    # Only delegate to the triage DSL matcher when the gate actually declares a
    # triage predicate. A path-only gate (e.g. all four universals) must NOT
    # depend on `_consumer_rule_matches` returning True for an empty predicate
    # set -- an upstream triage_classify change would otherwise silently stop
    # every path-only gate from firing.
    if (set(match) & _TRIAGE_PREDICATES) and not _consumer_rule_matches(
        gate, candidate.as_issue(), now=now
    ):
        return False, {}, (), ()
    evidence = match_evidence(match, candidate, matched_paths)
    return True, evidence, matched_paths, _matched_labels(match, candidate)


def build_report(
    project_root: Path,
    candidate: Candidate,
    *,
    posture: str = "advise",
    clearances: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> JudgmentGateReport:
    """Evaluate *candidate* against every effective gate; pure (no exit)."""
    now_dt = now or datetime.now(UTC)
    policy = resolve_judgment_gates(project_root)
    records = clearances if clearances is not None else read_clearances(project_root)
    outcomes: list[GateOutcome] = []
    for gate in effective_gates(project_root, policy=policy):
        matched, evidence, matched_paths, matched_labels = _gate_match(
            gate, candidate, now=now_dt
        )
        if not matched:
            continue
        scope = fingerprint_scope(evidence)
        valid, stale = _lookup_clearance(records, gate["id"], scope)
        outcomes.append(
            GateOutcome(
                gate_id=gate["id"],
                gate_class=gate["class"],
                tier=gate["tier"],
                reason=gate.get("reason", ""),
                required_human_reviewers=int(gate.get("requiredHumanReviewers", 0)),
                source=gate.get("source", CONSUMER_SOURCE),
                matched_paths=matched_paths,
                matched_labels=matched_labels,
                cleared_scope=scope,
                clearance=valid,
                stale_clearance=stale,
            )
        )
    return JudgmentGateReport(
        posture=posture, outcomes=tuple(outcomes), policy_error=policy.error
    )


def render_report(report: JudgmentGateReport) -> str:
    lines = [
        f"judgment-gates ({len(report.outcomes)} matched; posture={report.posture}):"
    ]
    if report.policy_error:
        lines.append(f"  ! policy self-healed to defaults: {report.policy_error}")
    if not report.outcomes:
        lines.append("  (no gates matched the candidate)")
        return "\n".join(lines)
    for outcome in report.outcomes:
        if outcome.cleared:
            status = "cleared"
        elif outcome.stale_clearance is not None:
            status = "STALE-CLEARANCE re-triggered"
        else:
            status = "fired"
        evidence: list[str] = []
        if outcome.matched_paths:
            evidence.append(f"paths={list(outcome.matched_paths)}")
        if outcome.matched_labels:
            evidence.append(f"labels={list(outcome.matched_labels)}")
        suffix = (" :: " + ", ".join(evidence)) if evidence else ""
        lines.append(
            f"  - [{outcome.tier}/{outcome.gate_class}/{outcome.source}] "
            f"{outcome.gate_id}: {status} ({outcome.reason}){suffix}"
        )
    return "\n".join(lines)


def evaluate(
    project_root: Path,
    candidate: Candidate | None = None,
    *,
    posture: str = "advise",
    clearances: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> tuple[int, str]:
    """Pure entry point: returns ``(exit_code, message)`` (three-state).

    The ``advise`` default ALWAYS returns 0 -- the engine reports and defers.
    Only ``enforce`` with a fired mechanical block-tier gate returns 1.
    """
    if not project_root.is_dir():
        return 2, (
            f"verify_judgment_gates: --project-root is not a directory: {project_root}\n"
            "  Recovery: pass an existing project root."
        )
    cand = candidate or Candidate()
    report = build_report(
        project_root, cand, posture=posture, clearances=clearances, now=now
    )
    rendered = render_report(report)

    if posture == "enforce" and report.blocking:
        ids = ", ".join(o.gate_id for o in report.blocking)
        return 1, (
            f"{rendered}\n"
            f"verify_judgment_gates: BLOCKED -- {len(report.blocking)} mechanical "
            f"block-tier gate(s) fired without clearance: {ids}. Record a clearance "
            "(`verify_judgment_gates.py clear --gate-id <id> ...`) or drop the change."
        )

    note = (
        "advisory posture; deferring to ordering"
        if posture != "enforce"
        else "enforce posture; no blocking gates fired"
    )
    return 0, f"{rendered}\nverify_judgment_gates: OK -- {note}."


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _diff_paths(project_root: str, base_ref: str) -> list[str]:
    """Return changed paths from ``git diff --name-only <base_ref>`` (best effort)."""
    try:
        result = run_text(
            ["git", "-C", str(project_root), "diff", "--name-only", base_ref]
        )
    except (OSError, ValueError):
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _build_candidate_from_args(args: argparse.Namespace) -> Candidate:
    paths: list[str] = list(args.path or [])
    if args.base_ref:
        paths.extend(_diff_paths(args.project_root, args.base_ref))
    seen: set[str] = set()
    unique: list[str] = []
    for path in paths:
        if path and path not in seen:
            seen.add(path)
            unique.append(path)
    return Candidate(
        paths=tuple(unique),
        labels=tuple(args.label or []),
        body=args.body or "",
        state=args.state or "open",
    )


def _outcome_to_json(outcome: GateOutcome) -> dict[str, Any]:
    return {
        "gate_id": outcome.gate_id,
        "class": outcome.gate_class,
        "tier": outcome.tier,
        "source": outcome.source,
        "reason": outcome.reason,
        "matched_paths": list(outcome.matched_paths),
        "matched_labels": list(outcome.matched_labels),
        "cleared_scope": outcome.cleared_scope,
        "cleared": outcome.cleared,
        "fired": outcome.fired,
        "blocking": outcome.blocking,
        "stale_clearance": outcome.stale_clearance is not None,
        "required_human_reviewers": outcome.required_human_reviewers,
    }


def _eval_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_judgment_gates.py",
        description=(
            "Risk-tiered judgment-gate engine (#1419 Slice 3). Advisory by "
            "default (always exits 0); pass --enforce to fail closed (exit 1) "
            "when a mechanical block-tier gate fires without clearance. Exit 2 "
            "on config error. NOT wired into `task check`."
        ),
    )
    parser.add_argument("--project-root", default=".", help="Project root (default: cwd).")
    parser.add_argument(
        "--enforce",
        action="store_true",
        help="Opt-in fail-closed posture (default is advisory; always exits 0).",
    )
    parser.add_argument(
        "--base-ref",
        default=None,
        help="Git ref to diff against for candidate paths (git diff --name-only).",
    )
    parser.add_argument(
        "--path", action="append", default=[], help="Candidate changed path (repeatable)."
    )
    parser.add_argument(
        "--label", action="append", default=[], help="Candidate label (repeatable)."
    )
    parser.add_argument("--body", default="", help="Candidate body text.")
    parser.add_argument(
        "--state",
        default="open",
        choices=("open", "closed"),
        help="Candidate state (default: open).",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress the OK message.")
    parser.add_argument("--json", action="store_true", help="Emit a JSON report.")
    return parser


def _eval_main(argv: list[str]) -> int:
    args = _eval_parser().parse_args(argv)
    project_root = Path(args.project_root).resolve()
    posture = "enforce" if args.enforce else "advise"
    candidate = _build_candidate_from_args(args)

    if args.json:
        if not project_root.is_dir():
            print(
                json.dumps({"exit": 2, "error": "project-root is not a directory"}),
                file=sys.stderr,
            )
            return 2
        report = build_report(project_root, candidate, posture=posture)
        code = 1 if (posture == "enforce" and report.blocking) else 0
        print(
            json.dumps(
                {
                    "exit": code,
                    "posture": report.posture,
                    "outcomes": [_outcome_to_json(o) for o in report.outcomes],
                    "policy_error": report.policy_error,
                },
                indent=2,
            )
        )
        return code

    code, message = evaluate(project_root, candidate, posture=posture)
    if code == 0:
        if not args.quiet:
            print(message)
    else:
        print(message, file=sys.stderr)
    return code


def _clear_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_judgment_gates.py clear",
        description=(
            "Record a judgment-gate clearance to the durable audit log "
            "(vbrief/.audit/judgment-gate-clearances.jsonl). The clearance binds "
            "to the cleared_scope fingerprint of the supplied evidence -- supply "
            "exactly the dimensions the gate matches on (paths / labels / body / "
            "state) so the fingerprint matches what the engine computes."
        ),
    )
    parser.add_argument("--project-root", default=".", help="Project root (default: cwd).")
    parser.add_argument("--gate-id", required=True, help="Gate id being cleared.")
    parser.add_argument(
        "--path", action="append", default=[], help="A matched path in scope (repeatable)."
    )
    parser.add_argument(
        "--label", action="append", default=[], help="A matched label in scope (repeatable)."
    )
    parser.add_argument(
        "--body", default="", help="The candidate body (for a body-text gate)."
    )
    parser.add_argument(
        "--state",
        default=None,
        choices=("open", "closed"),
        help="The candidate state (for a state gate).",
    )
    parser.add_argument(
        "--updated-at",
        default=None,
        help=(
            "The candidate's updated_at timestamp (for an age-days gate); pass "
            "an empty string to clear an age-days gate on an undated candidate."
        ),
    )
    parser.add_argument(
        "--reviewer", action="append", default=[], help="Human reviewer (repeatable)."
    )
    parser.add_argument("--actor", default="operator", help="Who recorded the clearance.")
    parser.add_argument("--reason", default="", help="Sign-off rationale.")
    return parser


def _clear_evidence(args: argparse.Namespace) -> dict[str, Any]:
    """Build a cleared-scope evidence dict from the supplied clear args.

    Mirrors :func:`match_evidence`: only the dimensions the operator supplies
    contribute a key, so the fingerprint matches what the engine computes for
    a gate that matches on exactly those dimensions.
    """
    evidence: dict[str, Any] = {}
    if args.path:
        evidence["paths"] = sorted(args.path)
    if args.label:
        evidence["labels"] = sorted(args.label)
    if args.body:
        evidence["body-text"] = args.body
    if args.state is not None:
        evidence["state"] = args.state
    if args.updated_at is not None:
        evidence["age-days"] = args.updated_at
    return evidence


def _clear_main(argv: list[str]) -> int:
    args = _clear_parser().parse_args(argv)
    project_root = Path(args.project_root).resolve()
    if not project_root.is_dir():
        print(
            f"verify_judgment_gates: --project-root is not a directory: {project_root}",
            file=sys.stderr,
        )
        return 2
    scope = fingerprint_scope(_clear_evidence(args))
    entry = record_clearance(
        project_root,
        gate_id=args.gate_id,
        cleared_scope=scope,
        reviewers=args.reviewer,
        actor=args.actor,
        reason=args.reason,
    )
    print(
        f"recorded clearance {entry['clearance_id']} for gate {args.gate_id!r} "
        f"(cleared_scope={scope[:12]}...)"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args_list = list(sys.argv[1:] if argv is None else argv)
    if args_list and args_list[0] == "clear":
        return _clear_main(args_list[1:])
    return _eval_main(args_list)


if __name__ == "__main__":
    sys.exit(main())
