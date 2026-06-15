#!/usr/bin/env python3
"""vbrief_reconcile_labels.py -- SCM label reconciliation (#1288).

The reverse-direction companion to ``task vbrief:reconcile:graph`` (#1287):
where the graph walker promotes proposed/ vBRIEFs as their dependencies
clear, this verb (``task vbrief:reconcile:labels``) keeps the *forge*
label surface in sync with canonical vBRIEF state so reviewers never see
drift between an issue's labels and its lifecycle.

Mapping table (canonical vBRIEF state -> managed labels):

* ``plan.status == "blocked"`` OR any unresolved
  ``plan.metadata.swarm.depends_on[]`` entry -> ``status:blocked``
* ``plan.metadata.kind == "epic"``     -> ``epic`` + ``status:tracker``
* ``plan.metadata.kind == "research"`` -> ``rfc``

A dependency is *unresolved* when the brief it names does not (yet) live
in a terminal lifecycle folder (``completed/`` or ``cancelled/``) -- the
exact same resolution rule the #1287 graph walker uses, reused here via
:data:`vbrief_reconcile_graph.RESOLVED_FOLDERS` /
:func:`vbrief_reconcile_graph._dep_resolved`.

Design contract:

* **Mirror, don't accumulate.** The verb manages exactly the four labels
  in :data:`MANAGED_LABELS`. On each run it ADDS the managed labels the
  mapping currently demands and REMOVES managed labels that no longer
  apply. Labels outside the managed set (``bug``, ``priority:high``, ...)
  are never touched.
* **Forge-agnostic.** Every forge call routes through ``scripts/scm.py``
  (#1145) via :func:`scm.call`; ``task verify:scm-boundary`` enforces no
  direct ``gh`` invocation remains. The default :class:`ScmLabelClient`
  is the only thing that talks to the forge, and it is injectable so the
  test suite never makes a live ``gh`` call.
* **Idempotent.** A second run is a no-op: the first run already brought
  the label set to the desired state, so the computed add/remove diff is
  empty and no mutation fires.

Exit codes (three-state, mirrors ``scripts/vbrief_reconcile_graph.py``):

    0 -- ran successfully (zero or more labels reconciled).
    1 -- one or more per-issue forge calls failed.
    2 -- usage / config error (no ``vbrief/`` directory under
         ``--project-root``).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from swarm_readiness import _all_scope_ids, _as_str_list  # noqa: E402
from triage_reconcile import _extract_issue_ref  # noqa: E402
from vbrief_reconcile_graph import _dep_resolved  # noqa: E402

import scm  # noqa: E402

reconfigure_stdio()

#: Lifecycle folders whose vBRIEFs carry an actionable label state. The
#: mapping concepts (blocked / epic / research) are all in-flight, so the
#: terminal folders (completed/cancelled) are not scanned for label
#: application; they DO participate in dependency resolution via
#: :func:`_all_scope_ids` below.
SCAN_FOLDERS = ("proposed", "pending", "active")

#: The complete set of labels this verb owns. Only these are ever added
#: or removed; everything else on an issue is left untouched.
MANAGED_LABELS = ("status:blocked", "epic", "status:tracker", "rfc")

#: scm.call source identity (#1145). v1 supports only github-issue.
SCM_SOURCE = "github-issue"


class ScmLabelError(RuntimeError):
    """Raised when a forge label read / mutation fails."""


# ---------------------------------------------------------------------------
# Mapping
# ---------------------------------------------------------------------------


def compute_desired_labels(plan: dict, *, unresolved_deps: bool) -> set[str]:
    """Return the managed labels the mapping table demands for *plan*.

    The result is always a subset of :data:`MANAGED_LABELS`. ``epic`` and
    ``research`` are mutually exclusive ``kind`` values, so the kind arm
    uses ``elif``; ``status:blocked`` is orthogonal (a blocked epic gets
    all three).
    """
    desired: set[str] = set()
    status = plan.get("status")
    metadata = plan.get("metadata") if isinstance(plan.get("metadata"), dict) else {}
    kind = metadata.get("kind")
    if status == "blocked" or unresolved_deps:
        desired.add("status:blocked")
    if kind == "epic":
        desired.update(("epic", "status:tracker"))
    elif kind == "research":
        desired.add("rfc")
    return desired


# ---------------------------------------------------------------------------
# Forge client (injectable)
# ---------------------------------------------------------------------------


class LabelClient(Protocol):
    """The seam the reconciler talks to. Tests inject an in-memory fake."""

    def fetch_labels(self, repo: str, issue_number: int) -> list[str]:
        ...

    def apply(
        self,
        repo: str,
        issue_number: int,
        add: Sequence[str],
        remove: Sequence[str],
    ) -> None:
        ...


class ScmLabelClient:
    """Forge-backed label client routing every call through ``scripts/scm.py``.

    Both the read (``issue view --json labels``) and the mutation
    (``issue edit --add-label/--remove-label``) go through
    :func:`scm.call` with ``source="github-issue"`` so the #1145 scm
    boundary is honoured -- ``task verify:scm-boundary`` flags any direct
    ``gh`` invocation, and this client deliberately has none.
    """

    def fetch_labels(self, repo: str, issue_number: int) -> list[str]:
        proc = scm.call(
            SCM_SOURCE,
            "issue",
            ["view", str(issue_number), "--repo", repo, "--json", "labels"],
        )
        if proc.returncode != 0:
            raise ScmLabelError(
                f"issue view #{issue_number} ({repo}) failed: "
                f"{(proc.stderr or '').strip()}"
            )
        try:
            data = json.loads(proc.stdout or "{}")
        except json.JSONDecodeError as exc:
            raise ScmLabelError(
                f"issue view #{issue_number} ({repo}) returned non-JSON: {exc}"
            ) from exc
        labels = data.get("labels") if isinstance(data, dict) else None
        if not isinstance(labels, list):
            return []
        names: list[str] = []
        for entry in labels:
            if isinstance(entry, dict) and isinstance(entry.get("name"), str):
                names.append(entry["name"])
            elif isinstance(entry, str):
                names.append(entry)
        return names

    def apply(
        self,
        repo: str,
        issue_number: int,
        add: Sequence[str],
        remove: Sequence[str],
    ) -> None:
        args = ["edit", str(issue_number), "--repo", repo]
        for name in add:
            args += ["--add-label", name]
        for name in remove:
            args += ["--remove-label", name]
        proc = scm.call(SCM_SOURCE, "issue", args)
        if proc.returncode != 0:
            raise ScmLabelError(
                f"issue edit #{issue_number} ({repo}) failed: "
                f"{(proc.stderr or '').strip()}"
            )


# ---------------------------------------------------------------------------
# Outcome types
# ---------------------------------------------------------------------------


@dataclass
class LabelChange:
    """A single issue's computed (and, unless dry-run, applied) label diff."""

    story_id: str
    repo: str
    issue_number: int
    current: list[str]
    desired: list[str]
    add: list[str]
    remove: list[str]

    def to_json(self) -> dict[str, object]:
        return {
            "story_id": self.story_id,
            "repo": self.repo,
            "issue_number": self.issue_number,
            "current": list(self.current),
            "desired": list(self.desired),
            "add": list(self.add),
            "remove": list(self.remove),
        }


@dataclass
class ReconcileLabelsOutcome:
    """Aggregate result of a single label-reconcile run."""

    changed: list[LabelChange] = field(default_factory=list)
    unchanged: list[LabelChange] = field(default_factory=list)
    skipped_no_ref: list[str] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)
    dry_run: bool = False

    def to_json(self) -> dict[str, object]:
        return {
            "changed": [c.to_json() for c in self.changed],
            "unchanged": [c.to_json() for c in self.unchanged],
            "skipped_no_ref": list(self.skipped_no_ref),
            "errors": [{"story_id": sid, "message": msg} for sid, msg in self.errors],
            "dry_run": self.dry_run,
        }


# ---------------------------------------------------------------------------
# Core reconcile logic
# ---------------------------------------------------------------------------


def _unresolved_deps(
    swarm: dict,
    known_ids: dict[str, tuple[Path, str]],
) -> bool:
    """True when any ``depends_on`` entry has NOT resolved to a terminal folder.

    Reuses :func:`vbrief_reconcile_graph._dep_resolved` so "resolved"
    means exactly what the #1287 graph walker means: the named brief
    lives in ``completed/`` or ``cancelled/``. An unknown dependency id
    counts as unresolved (the dependent is still blocked on it).
    """
    return any(
        not _dep_resolved(dep, known_ids)
        for dep in _as_str_list(swarm.get("depends_on"))
    )


def reconcile_labels(
    project_root: Path,
    *,
    repo: str | None = None,
    dry_run: bool = False,
    client: LabelClient | None = None,
) -> tuple[int, ReconcileLabelsOutcome]:
    """Reconcile managed SCM labels against canonical vBRIEF state.

    Walks :data:`SCAN_FOLDERS`, resolves each brief's linked issue from
    its ``x-vbrief/github-issue`` reference (falling back to *repo* when
    the reference URI lacks an owner/name segment), computes the
    add/remove diff against :data:`MANAGED_LABELS`, and applies it via
    *client* (unless *dry_run*). Returns ``(exit_code, outcome)``.
    """
    vbrief_dir = project_root / "vbrief"
    if not vbrief_dir.is_dir():
        return 2, ReconcileLabelsOutcome(dry_run=dry_run)

    if client is None:
        client = ScmLabelClient()

    known_ids = _all_scope_ids(project_root)
    outcome = ReconcileLabelsOutcome(dry_run=dry_run)
    seen_issues: set[tuple[str, int]] = set()

    for folder in SCAN_FOLDERS:
        folder_path = vbrief_dir / folder
        if not folder_path.is_dir():
            continue
        for path in sorted(folder_path.glob("*.vbrief.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError, UnicodeDecodeError):
                continue
            if not isinstance(data, dict):
                continue
            plan = data.get("plan") if isinstance(data.get("plan"), dict) else {}
            story_id = str(plan.get("id") or path.name[: -len(".vbrief.json")])

            ref_repo, number = _extract_issue_ref(data)
            effective_repo = ref_repo or repo
            if number is None or effective_repo is None:
                outcome.skipped_no_ref.append(story_id)
                continue
            key = (effective_repo, number)
            if key in seen_issues:
                continue
            seen_issues.add(key)

            metadata = plan.get("metadata") if isinstance(plan.get("metadata"), dict) else {}
            swarm = metadata.get("swarm") if isinstance(metadata.get("swarm"), dict) else {}
            desired = compute_desired_labels(
                plan, unresolved_deps=_unresolved_deps(swarm, known_ids)
            )

            try:
                current = client.fetch_labels(effective_repo, number)
            except ScmLabelError as exc:
                outcome.errors.append((story_id, str(exc)))
                continue

            current_managed = {name for name in current if name in MANAGED_LABELS}
            add = sorted(desired - current_managed)
            remove = sorted(current_managed - desired)
            change = LabelChange(
                story_id=story_id,
                repo=effective_repo,
                issue_number=number,
                current=sorted(current),
                desired=sorted(desired),
                add=add,
                remove=remove,
            )

            if not add and not remove:
                outcome.unchanged.append(change)
                continue
            if dry_run:
                outcome.changed.append(change)
                continue
            try:
                client.apply(effective_repo, number, add, remove)
            except ScmLabelError as exc:
                outcome.errors.append((story_id, str(exc)))
                continue
            outcome.changed.append(change)

    exit_code = 1 if outcome.errors else 0
    return exit_code, outcome


# ---------------------------------------------------------------------------
# Rendering + CLI
# ---------------------------------------------------------------------------


def _render_report(outcome: ReconcileLabelsOutcome) -> str:
    lines: list[str] = ["vBRIEF reconcile labels", ""]
    suffix = " (dry-run)" if outcome.dry_run else ""

    lines.append(f"Changed{suffix}:")
    if outcome.changed:
        for change in outcome.changed:
            parts: list[str] = []
            if change.add:
                parts.append(f"+{', +'.join(change.add)}")
            if change.remove:
                parts.append(f"-{', -'.join(change.remove)}")
            lines.append(
                f"- #{change.issue_number} ({change.repo}) "
                f"[{change.story_id}]: {'; '.join(parts)}"
            )
    else:
        lines.append("- none")
    lines.append("")

    lines.append("Unchanged:")
    if outcome.unchanged:
        lines.extend(
            f"- #{c.issue_number} ({c.repo}) [{c.story_id}]" for c in outcome.unchanged
        )
    else:
        lines.append("- none")

    if outcome.skipped_no_ref:
        lines.append("")
        lines.append("Skipped (no github-issue reference / repo):")
        lines.extend(f"- {story_id}" for story_id in outcome.skipped_no_ref)

    if outcome.errors:
        lines.append("")
        lines.append("Errors:")
        lines.extend(f"- {story_id}: {message}" for story_id, message in outcome.errors)

    return "\n".join(lines)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Reconcile SCM labels to mirror canonical vBRIEF state: "
            "status:blocked (blocked / unresolved deps), epic + status:tracker "
            "(kind=epic), rfc (kind=research). Routes through scripts/scm.py "
            "(#1145). Idempotent."
        )
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root containing vbrief/ (default: current directory).",
    )
    parser.add_argument(
        "--repo",
        default=None,
        help=(
            "Fallback repo slug 'owner/name' used ONLY when a vBRIEF's "
            "github-issue reference URI lacks an owner/repo segment."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report which labels WOULD change without mutating any issue.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a machine-readable JSON summary instead of the text report.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    project_root = Path(args.project_root).resolve()
    exit_code, outcome = reconcile_labels(
        project_root,
        repo=args.repo,
        dry_run=args.dry_run,
    )
    if exit_code == 2:
        if args.json:
            print(json.dumps({"error": "no vbrief/ directory found"}))
        else:
            print(
                f"Error: no vbrief/ directory found under {project_root}",
                file=sys.stderr,
            )
        return 2
    if args.json:
        print(json.dumps(outcome.to_json(), indent=2))
    else:
        print(_render_report(outcome))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
