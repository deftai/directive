#!/usr/bin/env python3
"""triage_reconcile.py -- idempotent triage audit-log self-heal (#1468).

The triage audit log ``vbrief/.eval/candidates.jsonl`` is the single
source of truth for "has issue #N been triaged?", yet it is
operator-private and gitignored (#1464) so branch churn or a
``vbrief/.eval/`` cleanup can silently wipe / reset it. When that
happens, ``proposed/`` / ``pending/`` / ``active/`` vBRIEFs that carry a
valid ``x-vbrief/github-issue`` reference are left with **no matching
``accept`` decision** in the log -- an internally inconsistent state
that ``task triage:summary`` faithfully (but confusingly) counts as
``untriaged``.

The only prior path that re-derived the lost accepts was a full
``task triage:bootstrap`` re-run, which also re-fetches the upstream
cache and is not discoverable as a "repair" action. This module promotes
the bootstrap backfill logic into a standalone, discoverable, idempotent
repair verb -- ``task triage:reconcile`` -- that derives the missing
``accept`` decisions from the on-disk vBRIEF inventory **without a cache
re-fetch**.

Semantics (mirrors ``triage_bootstrap.step_backfill_audit_log``):

- Scans ``vbrief/proposed/`` + ``vbrief/pending/`` + ``vbrief/active/``
  (``BACKFILL_FOLDERS``). ``cancelled/`` and ``completed/`` are NOT
  scanned -- a cancelled item must not be reanimated and completed work
  is out of the triage funnel.
- For each vBRIEF carrying an ``x-vbrief/github-issue`` reference, the
  ``(repo, issue_number)`` is parsed from the reference URI itself, so
  reconcile works even when no ``--repo`` is supplied and ``git remote``
  is unavailable (the filesystem inventory is the recoverable source).
- An ``accept`` decision is appended ONLY when ``(repo, issue_number)``
  has **no existing entry** in the audit log. Any prior decision
  (``accept`` / ``reject`` / ``defer`` / ``reset`` / ...) is left
  untouched -- reconcile never overrides a real operator decision, so a
  re-run is a no-op.

Exit codes (three-state, mirrors ``scripts/triage_bootstrap.py``):

- ``0`` -- reconcile completed (or was a no-op on a re-run).
- ``1`` -- a runtime step failed (e.g. the audit-log append raised).
- ``2`` -- config error: ``--project-root`` does not exist / is not a
  directory.

Refs:

- #1468 (this verb -- audit-log <-> proposed-folder reconciliation).
- #1464 (sibling: the audit log is gitignored, hence silently wipeable).
- #845 Story 2 (the ``candidates.jsonl`` audit log this verb repairs).
- #883 Story 3 (``triage_bootstrap.step_backfill_audit_log``, the
  point-in-time backfill this verb promotes into a repair path).
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Make sibling ``scripts`` modules importable when invoked as
# ``python scripts/triage_reconcile.py`` from the project root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure -- the recap prints ✓ / ✗ glyphs that the
# Windows cp1252 default stdout codepage cannot encode (mirrors the
# pattern in triage_bootstrap.py / triage_summary.py).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")

# Reuse the canonical lifecycle-folder scan + constants from the
# bootstrap module so the reconcile path and the bootstrap backfill stay
# in lockstep (the issue body explicitly asks to "promote the existing
# bootstrap backfill logic"). Importing the private helpers here is the
# intended reuse seam -- a divergent re-implementation is the failure
# mode #1468 warns about.
from triage_bootstrap import (  # noqa: E402
    AUDIT_LOG_RELPATH,
    BACKFILL_FOLDERS,
    _infer_repo_from_git,
)

#: Canonical actor stamped on reconcile-emitted backfill entries. Kept
#: distinct from ``triage_bootstrap.BOOTSTRAP_ACTOR`` (``agent:bootstrap``)
#: so the audit trail records WHICH path re-derived the decision.
RECONCILE_ACTOR: str = "agent:reconcile"


@dataclass(frozen=True)
class ReconcileItem:
    """A single ``(repo, issue_number)`` slated for an ``accept`` backfill."""

    repo: str
    issue_number: int
    folder: str
    path: Path


@dataclass
class ReconcileResult:
    """Aggregate result returned by :func:`reconcile`."""

    project_root: Path
    default_repo: str | None
    restored: int = 0
    skipped_existing: int = 0
    skipped_no_repo: int = 0
    dry_run: bool = False
    items: list[ReconcileItem] = field(default_factory=list)
    error: str | None = None
    exit_code: int = 0

    def summary(self) -> str:
        """Render the human-readable recap the operator sees."""
        verb = "would restore" if self.dry_run else "restored"
        mark = "✓" if self.exit_code == 0 else "✗"
        lines = ["", "Triage audit-log reconcile recap:"]
        lines.append(
            f"  {mark} {verb} {self.restored} accept decision(s) from on-disk "
            f"vBRIEFs; skipped {self.skipped_existing} (already in audit log)"
        )
        if self.skipped_no_repo:
            lines.append(
                f"      skipped {self.skipped_no_repo} vBRIEF(s) with no "
                "resolvable repo (no owner/name in the github-issue reference "
                "and no --repo / git remote fallback)"
            )
        if self.error:
            lines.append(f"      error: {self.error}")
        if self.items:
            lines.append("")
            lines.append("  Issues reconciled:")
            for item in self.items:
                lines.append(
                    f"    #{item.issue_number} ({item.repo}) "
                    f"<- vbrief/{item.folder}/"
                )
        if self.exit_code == 0 and not self.items and not self.dry_run:
            lines.append("")
            lines.append(
                "  Nothing to reconcile -- the audit log already covers every "
                "in-scope vBRIEF."
            )
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# vBRIEF reference parsing
# ---------------------------------------------------------------------------


def _parse_github_issue_uri(uri: str) -> tuple[str | None, int | None]:
    """Parse ``(repo, issue_number)`` from a github-issue reference URI.

    Accepts the canonical
    ``https://github.com/OWNER/REPO/issues/N`` shape (with or without a
    scheme / trailing slash) and returns ``("OWNER/REPO", N)``. When the
    owner/repo segments are not present but the trailing path component
    is numeric, returns ``(None, N)`` so the caller can fall back to a
    ``--repo`` / git-remote resolved default. Anything else is
    ``(None, None)``.
    """
    if not isinstance(uri, str):
        return None, None
    cleaned = uri.strip().rstrip("/")
    if not cleaned:
        return None, None
    # Drop the scheme so http/https/ssh-style forms parse identically.
    no_scheme = cleaned.split("://", 1)[-1]
    parts = [p for p in no_scheme.split("/") if p]
    # Expected tail: [..., owner, repo, "issues", "N"].
    if len(parts) >= 4 and parts[-2] == "issues":
        tail = parts[-1]
        if tail.isdigit():
            owner = parts[-4]
            repo = parts[-3]
            if owner and repo:
                return f"{owner}/{repo}", int(tail)
    # Fallback: bare numeric tail with no resolvable owner/repo.
    tail = parts[-1] if parts else ""
    if tail.isdigit():
        return None, int(tail)
    return None, None


def _extract_issue_ref(vbrief_data: Mapping[str, Any]) -> tuple[str | None, int | None]:
    """Pull ``(repo, issue_number)`` from a scope vBRIEF's references[]."""
    plan = vbrief_data.get("plan")
    if not isinstance(plan, dict):
        return None, None
    refs = plan.get("references")
    if not isinstance(refs, list):
        return None, None
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        if ref.get("type") != "x-vbrief/github-issue":
            continue
        repo, number = _parse_github_issue_uri(ref.get("uri", ""))
        if number is not None:
            return repo, number
    return None, None


def _scan_lifecycle_refs(folder: Path) -> list[tuple[str | None, int, Path]]:
    """Walk a lifecycle folder -> ``(repo_or_none, issue_number, path)`` tuples."""
    results: list[tuple[str | None, int, Path]] = []
    if not folder.exists() or not folder.is_dir():
        return results
    for path in sorted(folder.glob("*.vbrief.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        repo, number = _extract_issue_ref(data)
        if number is None:
            continue
        results.append((repo, number, path))
    return results


# ---------------------------------------------------------------------------
# Audit-log read helpers
# ---------------------------------------------------------------------------


def _existing_audit_refs(audit_path: Path) -> set[tuple[str, int]]:
    """Return ``{(repo, issue_number)}`` already present in the audit log.

    Keying by ``(repo, issue_number)`` (not bare issue number) matches
    ``triage_summary.latest_decisions`` so reconcile heals exactly the
    issues the summary counts as untriaged-because-no-entry. Tolerant of
    a missing log (returns ``set()``) and malformed lines (skipped).
    """
    if not audit_path.exists():
        return set()
    seen: set[tuple[str, int]] = set()
    try:
        text = audit_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return set()
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue
        repo = entry.get("repo")
        number = entry.get("issue_number")
        if (
            isinstance(repo, str)
            and isinstance(number, int)
            and not isinstance(number, bool)
        ):
            seen.add((repo, number))
    return seen


# ---------------------------------------------------------------------------
# Core reconcile logic
# ---------------------------------------------------------------------------


def find_reconcilable(
    project_root: Path,
    *,
    default_repo: str | None = None,
    audit_log_path: Path | None = None,
) -> list[ReconcileItem]:
    """Return the vBRIEFs that need an ``accept`` backfill.

    A vBRIEF is reconcilable when it lives in ``proposed/`` /
    ``pending/`` / ``active/``, carries a valid ``x-vbrief/github-issue``
    reference, and its ``(repo, issue_number)`` has **no** existing entry
    in the audit log. ``repo`` is taken from the reference URI when
    present, else from ``default_repo``. vBRIEFs whose repo cannot be
    resolved are excluded (they surface as ``skipped_no_repo`` in
    :func:`reconcile`). Read-only -- safe for the summary hint.
    """
    audit_path = audit_log_path or (project_root / AUDIT_LOG_RELPATH)
    existing = _existing_audit_refs(audit_path)
    vbrief_root = project_root / "vbrief"

    items: list[ReconcileItem] = []
    seen: set[tuple[str, int]] = set()
    for folder_name in BACKFILL_FOLDERS:
        folder_path = vbrief_root / folder_name
        for ref_repo, number, path in _scan_lifecycle_refs(folder_path):
            effective_repo = ref_repo or default_repo
            if effective_repo is None:
                continue
            key = (effective_repo, number)
            if key in existing or key in seen:
                continue
            seen.add(key)
            items.append(
                ReconcileItem(
                    repo=effective_repo,
                    issue_number=number,
                    folder=folder_name,
                    path=path,
                )
            )
    return items


def _count_no_repo(
    project_root: Path,
    *,
    default_repo: str | None,
    audit_log_path: Path | None,
) -> int:
    """Count reconcilable-looking vBRIEFs whose repo cannot be resolved."""
    audit_path = audit_log_path or (project_root / AUDIT_LOG_RELPATH)
    existing_numbers = {n for _r, n in _existing_audit_refs(audit_path)}
    vbrief_root = project_root / "vbrief"
    count = 0
    for folder_name in BACKFILL_FOLDERS:
        for ref_repo, number, _path in _scan_lifecycle_refs(vbrief_root / folder_name):
            if (ref_repo or default_repo) is None and number not in existing_numbers:
                count += 1
    return count


def _build_reconcile_entry(repo: str, issue_number: int, source_folder: str) -> dict[str, Any]:
    """Compose a single ``accept`` audit entry for a reconciled issue."""
    from candidates_log import new_decision_id
    from triage_bootstrap import _now_iso

    return {
        "decision_id": new_decision_id(),
        "timestamp": _now_iso(),
        "repo": repo,
        "issue_number": issue_number,
        "decision": "accept",
        "actor": RECONCILE_ACTOR,
        "reason": (
            f"reconcile backfill (#1468): vBRIEF present in vbrief/{source_folder}/ "
            "with a github-issue reference but no prior decision in the audit log"
        ),
    }


def reconcile(
    project_root: Path,
    *,
    repo: str | None = None,
    audit_log_path: Path | None = None,
    dry_run: bool = False,
) -> ReconcileResult:
    """Backfill missing ``accept`` decisions from the on-disk vBRIEF inventory.

    Idempotent: only ``(repo, issue_number)`` pairs with no existing
    audit entry are written, so a second invocation is a no-op. Repo
    resolution precedence for vBRIEFs whose reference URI lacks an
    owner/repo segment: explicit ``repo`` arg -> ``git remote get-url
    origin`` inference.
    """
    default_repo = repo
    if default_repo is None:
        default_repo = _infer_repo_from_git(cwd=project_root)

    audit_path = audit_log_path or (project_root / AUDIT_LOG_RELPATH)
    result = ReconcileResult(
        project_root=project_root, default_repo=default_repo, dry_run=dry_run
    )

    items = find_reconcilable(
        project_root, default_repo=default_repo, audit_log_path=audit_path
    )
    result.skipped_existing = _count_skipped_existing(
        project_root, default_repo=default_repo, audit_log_path=audit_path
    )
    result.skipped_no_repo = _count_no_repo(
        project_root, default_repo=default_repo, audit_log_path=audit_path
    )

    if dry_run:
        result.items = items
        result.restored = len(items)
        return result

    from candidates_log import append as candidates_append

    restored = 0
    for item in items:
        entry = _build_reconcile_entry(item.repo, item.issue_number, item.folder)
        try:
            candidates_append(entry, path=audit_path)
        except Exception as exc:  # noqa: BLE001 -- surface honestly, do not swallow
            result.error = f"{type(exc).__name__}: {exc}"
            result.restored = restored
            result.items = items[:restored]
            result.exit_code = 1
            return result
        restored += 1

    result.restored = restored
    result.items = items
    return result


def _count_skipped_existing(
    project_root: Path,
    *,
    default_repo: str | None,
    audit_log_path: Path | None,
) -> int:
    """Count in-scope vBRIEFs whose ``(repo, issue)`` already has an entry."""
    audit_path = audit_log_path or (project_root / AUDIT_LOG_RELPATH)
    existing = _existing_audit_refs(audit_path)
    vbrief_root = project_root / "vbrief"
    count = 0
    counted: set[tuple[str, int]] = set()
    for folder_name in BACKFILL_FOLDERS:
        for ref_repo, number, _path in _scan_lifecycle_refs(vbrief_root / folder_name):
            effective_repo = ref_repo or default_repo
            if effective_repo is None:
                continue
            key = (effective_repo, number)
            if key in existing and key not in counted:
                counted.add(key)
                count += 1
    return count


def count_reconcilable(
    project_root: Path,
    *,
    default_repo: str | None = None,
    audit_log_path: Path | None = None,
    restrict_to: Iterable[tuple[str, int]] | None = None,
) -> int:
    """Return the number of reconcilable ``(repo, issue)`` pairs.

    Read-only convenience used by ``triage_summary`` to surface the
    ``[triage:reconcile] N`` divergence hint. ``default_repo`` is plumbed
    straight through to :func:`find_reconcilable` so the count stays in
    sync with what :func:`reconcile` would actually restore -- without it,
    a bare-URI vBRIEF (whose github-issue reference omits owner/repo)
    would be silently skipped here while the verb (which resolves a
    fallback repo) would restore it. ``restrict_to`` (when provided)
    intersects the reconcilable set with a caller-supplied set of
    ``(repo, issue_number)`` keys -- the summary passes its cached,
    currently-untriaged issues so the hint counts only the issues it is
    actually miscounting.
    """
    items = find_reconcilable(
        project_root, default_repo=default_repo, audit_log_path=audit_log_path
    )
    keys = {(item.repo, item.issue_number) for item in items}
    if restrict_to is not None:
        keys &= set(restrict_to)
    return len(keys)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _emit_json(result: ReconcileResult) -> str:
    payload = {
        "project_root": str(result.project_root),
        "default_repo": result.default_repo,
        "dry_run": result.dry_run,
        "restored": result.restored,
        "skipped_existing": result.skipped_existing,
        "skipped_no_repo": result.skipped_no_repo,
        "exit_code": result.exit_code,
        "error": result.error,
        "items": [
            {
                "repo": item.repo,
                "issue_number": item.issue_number,
                "folder": item.folder,
            }
            for item in result.items
        ],
    }
    return json.dumps(payload, sort_keys=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_reconcile.py",
        description=(
            "Idempotent triage audit-log self-heal (#1468). Derives missing "
            "`accept` decisions for proposed/pending/active vBRIEFs that carry "
            "an x-vbrief/github-issue reference but have no entry in "
            "vbrief/.eval/candidates.jsonl -- no cache re-fetch required."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=os.environ.get("DEFT_PROJECT_ROOT", "."),
        help=(
            "Path to the consumer project root (default: $DEFT_PROJECT_ROOT or "
            "current working directory)."
        ),
    )
    parser.add_argument(
        "--repo",
        default=os.environ.get("DEFT_TRIAGE_REPO"),
        help=(
            "Fallback repo slug 'owner/name' used ONLY when a vBRIEF's "
            "github-issue reference URI lacks an owner/repo segment -- the "
            "per-vBRIEF URI is always the primary source and is NOT overridden "
            "by this flag. Fallback precedence when the URI lacks owner/repo: "
            "(1) this flag; (2) DEFT_TRIAGE_REPO env; "
            "(3) `git remote get-url origin`."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help=(
            "Report what would be reconciled without writing any audit entries."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="emit_json",
        help=(
            "Emit a structured JSON payload to stdout instead of the "
            "human-readable recap. Exit code is unchanged."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_reconcile", argv)
    if rc is not None:
        return rc
    parser = _build_parser()
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    if not project_root.exists() or not project_root.is_dir():
        print(
            f"❌ triage:reconcile: --project-root {project_root} does not exist "
            "or is not a directory.",
            file=sys.stderr,
        )
        return 2

    result = reconcile(
        project_root,
        repo=args.repo,
        dry_run=args.dry_run,
    )

    if args.emit_json:
        print(_emit_json(result))
    else:
        print(result.summary())

    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
