#!/usr/bin/env python3
"""vbrief_reconcile_umbrellas.py -- umbrella current-shape auto-update (#1289).

The final reconcile-suite verb (``task vbrief:reconcile:umbrellas``), the
companion to ``task vbrief:reconcile:graph`` (#1287) and
``task vbrief:reconcile:labels`` (#1288). Where the graph walker promotes
proposed/ vBRIEFs as their dependencies clear and the label reconciler
keeps the forge label surface in sync, this verb keeps every
``kind == "epic"`` umbrella's canonical *current-shape* comment in sync
with canonical vBRIEF state per the AGENTS.md "Umbrella current-shape
convention (#1152)".

For each epic vBRIEF the verb:

* resolves the epic's children from its ``plan.references[]`` entries of
  type ``x-vbrief/plan`` (the linkage ``scripts/scope_decompose.py``
  writes), looking each child up by filename across the lifecycle folders
  so a child that has since moved folder is still resolved to its current
  lifecycle state;
* computes the wave structure from the children's
  ``plan.metadata.swarm.depends_on[]`` edges (restricted to the child
  set; a dependency cycle degrades gracefully to a single trailing wave);
* builds the canonical AGENTS.md section-1152 body (Last updated /
  Last pass type / Child count / Child-count history / Open children /
  Closed children / Wave order / Open questions / Reading order); and
* edits the linked SCM umbrella's current-shape comment **in place** via
  the ``scripts/scm.py`` shim so the comment permalink is preserved and
  the amendment trail is never touched. When no current-shape comment
  exists yet, one is created at pass-1.

Design contract:

* **Edit in place, preserve the permalink.** The verb finds the single
  comment whose body carries the ``## Current shape (as of pass-N)``
  header and PATCHes that comment; it never deletes amendment comments
  and never posts a replacement.
* **Forge-agnostic.** Every forge call routes through ``scripts/scm.py``
  (#1145) via :func:`scm.call`; ``task verify:scm-boundary`` enforces no
  direct ``gh`` invocation remains. The default :class:`ScmUmbrellaClient`
  is the only thing that talks to the forge, and it is injectable so the
  test suite never makes a live ``gh`` call.
* **Idempotent.** A second run with unchanged epic state is a no-op: the
  pass number is only bumped (and ``Last updated`` only re-stamped) when
  the rendered substantive body differs from the comment already posted.

Exit codes (three-state, mirrors ``scripts/vbrief_reconcile_labels.py``):

    0 -- ran successfully (zero or more umbrellas reconciled).
    1 -- one or more per-umbrella forge calls failed.
    2 -- usage / config error (no ``vbrief/`` directory under
         ``--project-root``).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from triage_reconcile import _extract_issue_ref  # noqa: E402

import scm  # noqa: E402

reconfigure_stdio()

#: Lifecycle folders, partitioned into open (in-flight) vs closed
#: (terminal). A child's *closure reason* is just its terminal folder.
OPEN_FOLDERS = ("proposed", "pending", "active")
CLOSED_FOLDERS = ("completed", "cancelled")
LIFECYCLE_FOLDERS = OPEN_FOLDERS + CLOSED_FOLDERS

#: The reference type ``scripts/scope_decompose.py`` writes onto a parent
#: epic for each decomposed child story (uri is a vbrief-relative path).
CHILD_REF_TYPE = "x-vbrief/plan"

#: scm.call source identity (#1145). v1 supports only github-issue.
SCM_SOURCE = "github-issue"

#: The canonical current-shape comment header. The pass number is the
#: single source of truth for "which design pass produced this shape".
_HEADER_RE = re.compile(r"^## Current shape \(as of pass-(\d+)\)", re.MULTILINE)
_HISTORY_RE = re.compile(r"^Child-count history:\s*(.*)$", re.MULTILINE)
_LAST_UPDATED_RE = re.compile(r"^Last updated:\s*(.*)$", re.MULTILINE)
_LAST_PASS_TYPE_RE = re.compile(r"^Last pass type:\s*(.*)$", re.MULTILINE)

_VALID_PASS_TYPES = ("additive", "subtractive", "refactor", "verify")

_READING_ORDER = (
    "1. Read the umbrella issue body.\n"
    "2. Read this current-shape comment.\n"
    "3. Read the amendment comments in chronological order for the full audit trail."
)


class UmbrellaScmError(RuntimeError):
    """Raised when a forge comment read / mutation fails."""


# ---------------------------------------------------------------------------
# Child model + lifecycle index
# ---------------------------------------------------------------------------


@dataclass
class Child:
    """A single resolved child of an epic, with its current lifecycle state."""

    story_id: str
    title: str
    kind: str
    folder: str
    depends_on: list[str] = field(default_factory=list)

    @property
    def is_open(self) -> bool:
        return self.folder in OPEN_FOLDERS


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _child_from_data(data: dict, folder: str, fallback_id: str) -> Child:
    plan = data.get("plan") if isinstance(data.get("plan"), dict) else {}
    metadata = plan.get("metadata") if isinstance(plan.get("metadata"), dict) else {}
    swarm = metadata.get("swarm") if isinstance(metadata.get("swarm"), dict) else {}
    raw_deps = swarm.get("depends_on")
    depends_on = [str(d) for d in raw_deps] if isinstance(raw_deps, list) else []
    return Child(
        story_id=str(plan.get("id") or fallback_id),
        title=str(plan.get("title") or plan.get("id") or fallback_id),
        kind=str(metadata.get("kind") or "story"),
        folder=folder,
        depends_on=depends_on,
    )


def build_child_index(vbrief_dir: Path) -> dict[str, Child]:
    """Index every lifecycle vBRIEF by filename -> :class:`Child`.

    Keying by filename (not story id) lets :func:`compute_children`
    resolve an epic's ``x-vbrief/plan`` references -- whose URIs carry the
    file *path* the decomposition wrote -- even after a child has moved
    lifecycle folder (the URI's folder segment goes stale, but the
    basename does not).
    """
    index: dict[str, Child] = {}
    for folder in LIFECYCLE_FOLDERS:
        folder_path = vbrief_dir / folder
        if not folder_path.is_dir():
            continue
        for path in sorted(folder_path.glob("*.vbrief.json")):
            data = _read_json(path)
            if data is None:
                continue
            fallback_id = path.name[: -len(".vbrief.json")]
            index[path.name] = _child_from_data(data, folder, fallback_id)
    return index


def compute_children(epic_data: dict, index: dict[str, Child]) -> list[Child]:
    """Resolve an epic's children from its ``x-vbrief/plan`` references."""
    plan = epic_data.get("plan") if isinstance(epic_data.get("plan"), dict) else {}
    refs = plan.get("references")
    children: list[Child] = []
    seen: set[str] = set()
    if not isinstance(refs, list):
        return children
    for ref in refs:
        if not isinstance(ref, dict) or ref.get("type") != CHILD_REF_TYPE:
            continue
        name = Path(str(ref.get("uri") or "")).name
        child = index.get(name)
        if child is None or child.story_id in seen:
            continue
        seen.add(child.story_id)
        children.append(child)
    return children


def compute_waves(children: Sequence[Child]) -> list[list[str]]:
    """Layer the children into dependency waves (deterministic ordering).

    A child enters a wave once every one of its in-set ``depends_on``
    edges has been placed in an earlier wave. Dependencies pointing
    outside the child set are ignored (they cannot gate a wave). A
    dependency cycle is non-fatal: the unresolvable remainder is emitted
    as a single trailing wave so the verb never hangs or raises.
    """
    ids = {c.story_id for c in children}
    deps = {c.story_id: [d for d in c.depends_on if d in ids] for c in children}
    resolved: set[str] = set()
    remaining = set(ids)
    waves: list[list[str]] = []
    while remaining:
        layer = sorted(r for r in remaining if all(d in resolved for d in deps[r]))
        if not layer:
            waves.append(sorted(remaining))
            break
        waves.append(layer)
        resolved.update(layer)
        remaining.difference_update(layer)
    return waves


# ---------------------------------------------------------------------------
# Body render + parse
# ---------------------------------------------------------------------------


def _bullet_block(lines: Sequence[str]) -> str:
    return "\n".join(lines) if lines else "- none"


def render_body(
    *,
    pass_n: int,
    last_pass_type: str,
    last_updated: str,
    open_children: Sequence[Child],
    closed_children: Sequence[Child],
    waves: Sequence[Sequence[str]],
    history: Sequence[tuple[int, int]],
) -> str:
    """Render the canonical AGENTS.md section-1152 current-shape body."""
    total = len(open_children) + len(closed_children)
    history_str = ", ".join(f"pass-{n}: {count}" for n, count in history)
    open_lines = [f"- {c.story_id}: {c.title} ({c.kind})" for c in open_children]
    closed_lines = [f"- {c.story_id}: {c.title} ({c.folder})" for c in closed_children]
    wave_lines = [f"- Wave {i}: {', '.join(layer)}" for i, layer in enumerate(waves, 1)]
    return (
        f"## Current shape (as of pass-{pass_n})\n"
        "\n"
        f"Last updated: {last_updated}\n"
        f"Last pass type: {last_pass_type}\n"
        f"Child count: {total} ({len(open_children)}/{len(closed_children)})\n"
        f"Child-count history: {history_str}\n"
        "\n"
        "### Open children\n"
        "\n"
        f"{_bullet_block(open_lines)}\n"
        "\n"
        "### Closed children\n"
        "\n"
        f"{_bullet_block(closed_lines)}\n"
        "\n"
        "### Wave order\n"
        "\n"
        f"{_bullet_block(wave_lines)}\n"
        "\n"
        "### Open questions\n"
        "\n"
        "- none\n"
        "\n"
        "### Reading order for fresh contributors\n"
        "\n"
        f"{_READING_ORDER}"
    )


@dataclass
class ParsedShape:
    """The fields parsed back out of an existing current-shape comment."""

    pass_n: int | None = None
    history: list[tuple[int, int]] = field(default_factory=list)
    last_updated: str | None = None
    last_pass_type: str | None = None


def _parse_history(raw: str) -> list[tuple[int, int]]:
    history: list[tuple[int, int]] = []
    for token in raw.split(","):
        match = re.match(r"\s*pass-(\d+):\s*(\d+)\s*$", token)
        if match:
            history.append((int(match.group(1)), int(match.group(2))))
    return history


def parse_current_shape(body: str) -> ParsedShape:
    """Parse pass number, history, timestamp, and pass type from *body*.

    Tolerant of a hand-authored / pre-convention comment: any field that
    does not match returns its empty default, so a first reconcile of a
    legacy comment is treated as a substantive change (pass bump) rather
    than crashing.
    """
    header = _HEADER_RE.search(body)
    if header is None:
        return ParsedShape()
    history_match = _HISTORY_RE.search(body)
    updated_match = _LAST_UPDATED_RE.search(body)
    pass_type_match = _LAST_PASS_TYPE_RE.search(body)
    return ParsedShape(
        pass_n=int(header.group(1)),
        history=_parse_history(history_match.group(1)) if history_match else [],
        last_updated=updated_match.group(1).strip() if updated_match else None,
        last_pass_type=pass_type_match.group(1).strip() if pass_type_match else None,
    )


def _classify_pass_type(prev_total: int | None, total: int) -> str:
    if prev_total is None:
        return "refactor"
    if total > prev_total:
        return "additive"
    if total < prev_total:
        return "subtractive"
    return "refactor"


def _has_current_shape(body: str) -> bool:
    return _HEADER_RE.search(body) is not None


# ---------------------------------------------------------------------------
# Forge client (injectable)
# ---------------------------------------------------------------------------


class UmbrellaClient(Protocol):
    """The seam the reconciler talks to. Tests inject an in-memory fake."""

    def fetch_comments(self, repo: str, issue_number: int) -> list[dict]:
        ...

    def edit_comment(self, repo: str, comment_id: int, body: str) -> None:
        ...

    def create_comment(self, repo: str, issue_number: int, body: str) -> int | None:
        ...


class ScmUmbrellaClient:
    """Forge-backed comment client routing every call through ``scripts/scm.py``.

    The comment list (``api repos/.../issues/<N>/comments``) and the
    in-place edit / create (``api -X PATCH|POST ... --input -``) all go
    through :func:`scm.call` with ``source="github-issue"`` so the #1145
    scm boundary is honoured. Markdown bodies are sent as a JSON payload
    over stdin (``--input -``) so backticks in the rendered body are never
    interpreted by a shell (preamble section 5.5).
    """

    def fetch_comments(self, repo: str, issue_number: int) -> list[dict]:
        proc = scm.call(
            SCM_SOURCE,
            "api",
            [f"repos/{repo}/issues/{issue_number}/comments?per_page=100"],
        )
        if proc.returncode != 0:
            raise UmbrellaScmError(
                f"list comments #{issue_number} ({repo}) failed: "
                f"{(proc.stderr or '').strip()}"
            )
        try:
            data = json.loads(proc.stdout or "[]")
        except json.JSONDecodeError as exc:
            raise UmbrellaScmError(
                f"list comments #{issue_number} ({repo}) returned non-JSON: {exc}"
            ) from exc
        if not isinstance(data, list):
            return []
        comments: list[dict] = []
        for entry in data:
            if (
                isinstance(entry, dict)
                and isinstance(entry.get("id"), int)
                and isinstance(entry.get("body"), str)
            ):
                comments.append({"id": entry["id"], "body": entry["body"]})
        return comments

    def edit_comment(self, repo: str, comment_id: int, body: str) -> None:
        proc = scm.call(
            SCM_SOURCE,
            "api",
            ["-X", "PATCH", f"repos/{repo}/issues/comments/{comment_id}", "--input", "-"],
            input=json.dumps({"body": body}),
        )
        if proc.returncode != 0:
            raise UmbrellaScmError(
                f"edit comment {comment_id} ({repo}) failed: "
                f"{(proc.stderr or '').strip()}"
            )

    def create_comment(self, repo: str, issue_number: int, body: str) -> int | None:
        proc = scm.call(
            SCM_SOURCE,
            "api",
            ["-X", "POST", f"repos/{repo}/issues/{issue_number}/comments", "--input", "-"],
            input=json.dumps({"body": body}),
        )
        if proc.returncode != 0:
            raise UmbrellaScmError(
                f"create comment #{issue_number} ({repo}) failed: "
                f"{(proc.stderr or '').strip()}"
            )
        try:
            data = json.loads(proc.stdout or "{}")
        except json.JSONDecodeError:
            return None
        if isinstance(data, dict) and isinstance(data.get("id"), int):
            return data["id"]
        return None


# ---------------------------------------------------------------------------
# Outcome types
# ---------------------------------------------------------------------------


@dataclass
class UmbrellaChange:
    """A single epic's computed (and, unless dry-run, applied) shape update."""

    story_id: str
    repo: str
    issue_number: int
    action: str  # "created" | "edited" | "unchanged"
    pass_n: int
    body: str

    def to_json(self) -> dict[str, object]:
        return {
            "story_id": self.story_id,
            "repo": self.repo,
            "issue_number": self.issue_number,
            "action": self.action,
            "pass_n": self.pass_n,
        }


@dataclass
class ReconcileUmbrellasOutcome:
    """Aggregate result of a single umbrella-reconcile run."""

    changed: list[UmbrellaChange] = field(default_factory=list)
    unchanged: list[UmbrellaChange] = field(default_factory=list)
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


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _plan_of(data: dict) -> dict:
    plan = data.get("plan")
    return plan if isinstance(plan, dict) else {}


def _is_epic(plan: dict) -> bool:
    metadata = plan.get("metadata") if isinstance(plan.get("metadata"), dict) else {}
    return metadata.get("kind") == "epic"


def _plan_shape(
    epic_data: dict, index: dict[str, Child]
) -> tuple[list[Child], list[Child], list[list[str]]]:
    children = compute_children(epic_data, index)
    open_children = sorted(
        (c for c in children if c.is_open), key=lambda c: c.story_id
    )
    closed_children = sorted(
        (c for c in children if not c.is_open), key=lambda c: c.story_id
    )
    waves = compute_waves(children)
    return open_children, closed_children, waves


def _reconcile_one_epic(
    epic_data: dict,
    index: dict[str, Child],
    *,
    story_id: str,
    repo: str,
    number: int,
    client: UmbrellaClient,
    dry_run: bool,
    now: str,
) -> UmbrellaChange:
    """Compute (and, unless dry-run, apply) one epic's current-shape update."""
    open_children, closed_children, waves = _plan_shape(epic_data, index)
    total = len(open_children) + len(closed_children)

    comments = client.fetch_comments(repo, number)
    existing = next(
        (c for c in comments if _has_current_shape(str(c.get("body", "")))), None
    )

    if existing is None:
        body = render_body(
            pass_n=1,
            last_pass_type="additive",
            last_updated=now,
            open_children=open_children,
            closed_children=closed_children,
            waves=waves,
            history=[(1, total)],
        )
        if not dry_run:
            client.create_comment(repo, number, body)
        return UmbrellaChange(story_id, repo, number, "created", 1, body)

    parsed = parse_current_shape(str(existing.get("body", "")))
    prev_pass = parsed.pass_n or 1
    prev_total = parsed.history[-1][1] if parsed.history else None

    # Re-render the body with the PREVIOUS pass/history/timestamp/type. If
    # it reproduces the posted comment byte-for-byte, nothing substantive
    # changed -> idempotent no-op (no edit, no Last-updated re-stamp).
    candidate = render_body(
        pass_n=prev_pass,
        last_pass_type=parsed.last_pass_type or "refactor",
        last_updated=parsed.last_updated or now,
        open_children=open_children,
        closed_children=closed_children,
        waves=waves,
        history=parsed.history or [(prev_pass, total)],
    )
    if candidate == str(existing.get("body", "")):
        return UmbrellaChange(story_id, repo, number, "unchanged", prev_pass, candidate)

    pass_n = prev_pass + 1
    body = render_body(
        pass_n=pass_n,
        last_pass_type=_classify_pass_type(prev_total, total),
        last_updated=now,
        open_children=open_children,
        closed_children=closed_children,
        waves=waves,
        history=[*parsed.history, (pass_n, total)],
    )
    if not dry_run:
        client.edit_comment(repo, int(existing["id"]), body)
    return UmbrellaChange(story_id, repo, number, "edited", pass_n, body)


def reconcile_umbrellas(
    project_root: Path,
    *,
    repo: str | None = None,
    dry_run: bool = False,
    client: UmbrellaClient | None = None,
    now: str | None = None,
) -> tuple[int, ReconcileUmbrellasOutcome]:
    """Reconcile every epic umbrella's current-shape comment to vBRIEF state.

    Scans all lifecycle folders for ``kind == "epic"`` vBRIEFs, resolves
    each one's linked SCM issue, and creates / edits-in-place its
    current-shape comment. Returns ``(exit_code, outcome)``.
    """
    vbrief_dir = project_root / "vbrief"
    if not vbrief_dir.is_dir():
        return 2, ReconcileUmbrellasOutcome(dry_run=dry_run)

    if client is None:
        client = ScmUmbrellaClient()
    if now is None:
        now = _now_iso()

    index = build_child_index(vbrief_dir)
    outcome = ReconcileUmbrellasOutcome(dry_run=dry_run)
    seen_issues: set[tuple[str, int]] = set()

    for folder in LIFECYCLE_FOLDERS:
        folder_path = vbrief_dir / folder
        if not folder_path.is_dir():
            continue
        for path in sorted(folder_path.glob("*.vbrief.json")):
            data = _read_json(path)
            if data is None:
                continue
            plan = _plan_of(data)
            if not _is_epic(plan):
                continue
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

            try:
                change = _reconcile_one_epic(
                    data,
                    index,
                    story_id=story_id,
                    repo=effective_repo,
                    number=number,
                    client=client,
                    dry_run=dry_run,
                    now=now,
                )
            except UmbrellaScmError as exc:
                outcome.errors.append((story_id, str(exc)))
                continue
            if change.action == "unchanged":
                outcome.unchanged.append(change)
            else:
                outcome.changed.append(change)

    exit_code = 1 if outcome.errors else 0
    return exit_code, outcome


# ---------------------------------------------------------------------------
# Rendering + CLI
# ---------------------------------------------------------------------------


def _render_report(outcome: ReconcileUmbrellasOutcome) -> str:
    lines: list[str] = ["vBRIEF reconcile umbrellas", ""]
    suffix = " (dry-run)" if outcome.dry_run else ""

    lines.append(f"Changed{suffix}:")
    if outcome.changed:
        lines.extend(
            f"- #{c.issue_number} ({c.repo}) [{c.story_id}]: {c.action} -> pass-{c.pass_n}"
            for c in outcome.changed
        )
    else:
        lines.append("- none")
    lines.append("")

    lines.append("Unchanged:")
    if outcome.unchanged:
        lines.extend(
            f"- #{c.issue_number} ({c.repo}) [{c.story_id}]: pass-{c.pass_n}"
            for c in outcome.unchanged
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
            "Reconcile each kind=epic umbrella's current-shape comment to "
            "canonical vBRIEF state per AGENTS.md #1152: edit the comment in "
            "place (preserve permalink), never delete amendment comments. "
            "Routes through scripts/scm.py (#1145). Idempotent."
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
            "Fallback repo slug 'owner/name' used ONLY when an epic's "
            "github-issue reference URI lacks an owner/repo segment."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report which umbrellas WOULD change without mutating any comment.",
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
    exit_code, outcome = reconcile_umbrellas(
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
