#!/usr/bin/env python3
"""triage_bootstrap.py -- idempotent 5-step triage v1 installer (#845 Story 6).

Single-command opt-in for triage v1 (#845). Wires the consumer's project for
the pre-ingest triage workflow without touching any existing vBRIEF, scope, or
skill state. Designed to be re-runnable: every step is idempotent and a second
invocation is a no-op.

Steps (in order):

1. ``populate_cache`` -- populate ``.deft-cache/issues/<owner>-<repo>/`` for
   every open upstream issue. Delegates to Story 1's
   ``scripts.triage_cache.populate``. Gracefully degrades to a deferred-action
   warning when Story 1 has not yet merged on the consumer's branch.

2. ``backfill_audit_log`` -- write an ``accepted`` audit entry to
   ``vbrief/.eval/candidates.jsonl`` for every scope vBRIEF currently in
   ``vbrief/proposed/``, ``vbrief/pending/``, or ``vbrief/active/``. Skips
   ``vbrief/cancelled/`` so rejected items are NOT reanimated. Skips
   ``vbrief/completed/`` because completed work is not in the triage funnel.
   Delegates to Story 2's ``scripts.candidates_log.append`` when present;
   falls back to a self-contained JSONL append when Story 2 has not merged.

3. ``ensure_gitignore_entry`` -- append ``.deft-cache/`` to ``.gitignore``
   when absent. Idempotent: the line is already present in this repo's
   ``.gitignore`` (Story 1 may also add it), so this step is typically a
   no-op.

4. ``ensure_gitcrawl`` -- install ``gitcrawl`` via the project's documented
   path (``pipx install gitcrawl`` if available, else a print-only diagnostic).
   Skipped entirely when ``gitcrawl`` is already on PATH.

5. ``recap`` -- print a summary of the actions taken and the canonical next
   commands (``task triage:show <N>``, ``task triage:cache``, etc.). The
   recap is rendered by :meth:`BootstrapResult.summary` and printed in
   :func:`main` rather than dispatched as a separate ``StepOutcome``;
   :func:`run_bootstrap` therefore appends four step outcomes (1-4) and
   the recap closes the run via the printed summary.

Exit codes (three-state, mirrors ``scripts/preflight_branch.py``):

- ``0`` -- bootstrap completed (or all steps were no-ops on a re-run).
- ``1`` -- bootstrap failed at a runtime step (e.g. ``gh issue list`` returned
  non-zero, ``vbrief/`` missing, etc.). The error message names the failing
  step.
- ``2`` -- config error: ``--project-root`` doesn't exist or isn't a directory.

Refs:

- #845 (parent epic).
- #583 (consumed by Story 1's quarantine; this bootstrap doesn't touch
  quarantine directly).
- ``docs/privacy-nfr.md`` -- privacy contract for ``.deft-cache/``.
- ``docs/quarantine-spec.md`` -- companion algorithm spec.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Make sibling ``scripts`` modules importable when the consumer invokes this
# script via ``python scripts/triage_bootstrap.py`` from the project root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure (mirrors #814 fix). The Windows cp1252 default would
# crash on the ✓ / ⚠ glyphs we print in the recap.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


#: Canonical cache-directory name. The Story 1 cache writes to
#: ``.deft-cache/issues/<owner>-<repo>/<N>.{json,md}``; the gitignore step
#: protects the same root.
CACHE_DIR_NAME = ".deft-cache"

#: Canonical gitignore line. Trailing slash matches the convention in the
#: existing ``.gitignore`` (e.g. ``dist/``, ``backup/``, ``.deft/``).
GITIGNORE_LINE = ".deft-cache/"

#: Canonical audit-log path relative to the project root. Story 2 writes
#: append-only JSONL here; Story 6's bootstrap backfills ``accepted`` entries
#: for items that have already been triaged into a lifecycle folder.
AUDIT_LOG_RELPATH = Path("vbrief") / ".eval" / "candidates.jsonl"

#: Lifecycle folders whose contents are backfilled with ``accepted`` entries.
#: ``cancelled/`` is intentionally excluded so the bootstrap does not
#: reanimate rejected items. ``completed/`` is excluded because completed
#: work is no longer in the triage funnel; recording an ``accepted`` decision
#: would imply the item is awaiting evaluation.
BACKFILL_FOLDERS = ("proposed", "pending", "active")

#: Canonical actor for the bootstrap-emitted backfill entries. The audit
#: schema defined by Story 2 expects a string of the form ``agent:<name>`` or
#: a user identity. ``agent:bootstrap`` is unambiguous.
BOOTSTRAP_ACTOR = "agent:bootstrap"


@dataclass
class StepOutcome:
    """Per-step result captured by the dispatcher.

    Attributes:
        name: The canonical step name (matches the function name without the
            ``step_`` prefix).
        ok: True when the step completed without raising or detecting a hard
            error. A no-op step (e.g. gitignore line already present) is OK.
        message: Human-readable status line printed by the recap.
        error: Optional captured exception message when ``ok`` is False.
        details: Free-form structured info for tests (e.g. counts, paths).
    """

    name: str
    ok: bool
    message: str
    error: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class BootstrapResult:
    """Aggregate result returned by :func:`run_bootstrap`."""

    project_root: Path
    repo: str | None
    steps: list[StepOutcome] = field(default_factory=list)
    exit_code: int = 0

    def summary(self) -> str:
        """Render a recap table the operator sees at the end of bootstrap."""
        lines = ["", "Triage v1 bootstrap recap:"]
        for step in self.steps:
            mark = "✓" if step.ok else "✗"
            lines.append(f"  {mark} {step.name}: {step.message}")
            if step.error:
                lines.append(f"      error: {step.error}")
        if self.exit_code == 0:
            lines.append("")
            lines.append("Next steps:")
            # IMPORTANT: every command printed here MUST exist on master at the
            # time the bootstrap recap fires (Greptile P1 PR #877 review). Story
            # 6 wires only the top-level `task triage:bootstrap` alias; every
            # other surface ships under the include namespace key for its
            # owning fragment (`triage-cache:`, `triage-actions:`,
            # `triage-bulk:`). The shorthand `task triage:cache` /
            # `task triage:accept <N>` forms are intentionally NOT wired in
            # Story 6 (go-task v3 cannot share an `includes:` namespace key
            # across multiple files); a follow-up cleanup PR will consolidate
            # `task triage:*` aliases once the four-fragment cascade has fully
            # landed and inner task names are stable. Until then, the recap
            # uses the namespaced forms so a user who copy-pastes a line gets
            # a working invocation.
            lines.append("  task triage-cache:cache             # refresh the cache (Story 1)")
            lines.append("  task triage-cache:show <N>          # inspect issue N (Story 1)")
            lines.append("  task triage-actions:accept <N>      # accept issue N (Story 3)")
            lines.append("  task triage-actions:reject <N> -- --reason 'why' (Story 3)")
            lines.append("  task triage-bulk:bulk-accept -- --label adoption-blocker (Story 4)")
            lines.append(
                "  task triage-bulk:refresh-active     # pre-swarm freshness (Story 4)"
            )
            lines.append("")
            lines.append(
                "Note: shorthand `task triage:<verb>` aliases are deferred to a follow-up"
            )
            lines.append(
                "cleanup PR after the cascade fully lands. See UPGRADING.md "
                "`Migration to triage v1` for details."
            )
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Step 1 -- populate cache
# ---------------------------------------------------------------------------


def step_populate_cache(project_root: Path, repo: str | None) -> StepOutcome:
    """Populate the local issue cache for all open upstream issues.

    Delegates to Story 1's ``scripts.triage_cache.populate(repo, force=False)``
    when the module is importable. When Story 1 has not yet merged onto the
    consumer's branch, the step degrades to a deferred-action warning -- the
    bootstrap as a whole still succeeds because (a) the script is designed to
    be re-runnable, and (b) the gitignore + backfill steps are independent of
    cache content.
    """
    if repo is None:
        return StepOutcome(
            name="populate_cache",
            ok=True,
            message=(
                "skipped (no --repo provided; pass --repo OWNER/NAME to populate)"
            ),
            details={"skipped": "no-repo"},
        )

    try:
        import triage_cache  # type: ignore[import-not-found]
    except ImportError:
        return StepOutcome(
            name="populate_cache",
            ok=True,
            message=(
                "deferred (Story 1 surface scripts/triage_cache.py not present "
                "on this branch; re-run after rebase to populate)"
            ),
            details={"deferred": "story-1-missing"},
        )

    populate = getattr(triage_cache, "populate", None)
    if populate is None or not callable(populate):
        return StepOutcome(
            name="populate_cache",
            ok=False,
            message="triage_cache.populate is not callable",
            error="Story 1 surface drift: populate() not exposed",
        )

    try:
        count = populate(repo=repo, force=False)
    except Exception as exc:  # noqa: BLE001 -- forward exception text verbatim
        # Graceful degradation: cache populate is best-effort. If Story 1's
        # populate fails (e.g. ``gh`` CLI not on PATH, network down, repo
        # access denied) the bootstrap should still succeed -- the gitignore
        # + audit-log + gitcrawl steps are independent of cache content,
        # and the operator can re-run ``task triage-cache:cache`` after
        # fixing the underlying environment. Returning ok=True with a
        # deferred-action message preserves bootstrap exit code 0 (per
        # the module docstring's ``re-runnable`` contract) while still
        # surfacing the failure cause in the recap.
        return StepOutcome(
            name="populate_cache",
            ok=True,
            message=(
                f"deferred -- populate raised {type(exc).__name__} "
                "(re-run after the underlying issue is resolved; "
                "see error for detail)"
            ),
            error=str(exc),
            details={"deferred": "populate-error"},
        )

    return StepOutcome(
        name="populate_cache",
        ok=True,
        message=f"cached {count} issues into {CACHE_DIR_NAME}/issues/",
        details={"count": count, "repo": repo},
    )


# ---------------------------------------------------------------------------
# Step 2 -- backfill audit log with `accepted` entries
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    """Return current time as ISO-8601 UTC with the literal ``Z`` suffix.

    The Story 2 audit-log schema (``vbrief/schemas/candidates.schema.json``)
    pins the ``timestamp`` field to the ``Z``-suffix UTC form -- the
    pattern is ``^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$``.
    Python's ``datetime.isoformat()`` emits ``+00:00`` for ``tz=UTC``,
    which matches the schema's ``format: date-time`` annotation but FAILS
    the Z-anchored ``pattern``. Story 2's ``candidates_log.append()``
    enforces the pattern (Greptile #876 P1 fix-batch) so a non-Z form is
    rejected with ``CandidatesLogError``.

    Uses ``datetime.timezone.utc`` rather than the ``datetime.UTC`` alias
    (Python 3.11+) for maximum portability and ecosystem compatibility:
    even though the project's ``requires-python`` is ``>=3.11`` (see
    ``pyproject.toml``), the ``timezone.utc`` form is unambiguous, works
    on every Python 3.x release, and removes a foot-gun for downstream
    consumers that vendor or copy this module. The trailing
    ``# noqa: UP017`` keeps ruff's ``Use datetime.UTC alias`` rule from
    re-flipping the form on auto-fix.
    """
    return (
        _dt.datetime.now(tz=_dt.timezone.utc)  # noqa: UP017
        .replace(microsecond=0)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def _extract_issue_number(vbrief_data: dict[str, Any]) -> int | None:
    """Pull the issue number from a scope vBRIEF's references[] block.

    vBRIEFs ingested via ``task issue:ingest`` carry an
    ``x-vbrief/github-issue`` reference whose URI ends with the issue number.
    Returns None for vBRIEFs without such a reference (e.g. user-authored
    plans that don't trace to an upstream issue).
    """
    plan = vbrief_data.get("plan")
    if not isinstance(plan, dict):
        return None
    refs = plan.get("references")
    if not isinstance(refs, list):
        return None
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        if ref.get("type") != "x-vbrief/github-issue":
            continue
        uri = ref.get("uri", "")
        if not isinstance(uri, str):
            continue
        # URIs look like "https://github.com/owner/repo/issues/845"
        tail = uri.rstrip("/").rsplit("/", 1)[-1]
        if tail.isdigit():
            return int(tail)
    return None


def _scan_lifecycle_folder(folder: Path) -> list[tuple[int, Path]]:
    """Walk a lifecycle folder, returning (issue_number, vbrief_path) tuples.

    vBRIEFs without a parseable issue-number reference are skipped silently
    -- the bootstrap only backfills items that have an upstream origin to
    record against.
    """
    results: list[tuple[int, Path]] = []
    if not folder.exists() or not folder.is_dir():
        return results
    for path in sorted(folder.glob("*.vbrief.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            # Defensive: a malformed vBRIEF should not block bootstrap. The
            # standard `task vbrief:validate` gate will surface it elsewhere.
            continue
        if not isinstance(data, dict):
            continue
        issue_number = _extract_issue_number(data)
        if issue_number is None:
            continue
        results.append((issue_number, path))
    return results


def _existing_audit_issue_numbers(audit_path: Path) -> set[int]:
    """Read the audit log and return the set of issue numbers already logged.

    Used to make the backfill idempotent: a re-run does NOT append a duplicate
    entry for an issue that already has any decision recorded.
    """
    if not audit_path.exists():
        return set()
    seen: set[int] = set()
    try:
        for line in audit_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                # Malformed lines are skipped (Story 2's reader does the same).
                continue
            if not isinstance(entry, dict):
                continue
            n = entry.get("issue_number")
            if isinstance(n, int):
                seen.add(n)
    except (OSError, UnicodeDecodeError):
        # If we can't read the file, assume nothing logged. The append step
        # will surface any write-side IO error.
        return set()
    return seen


def _build_audit_entry(repo: str, issue_number: int, source_folder: str) -> dict[str, Any]:
    """Compose a single ``accepted`` audit entry per Story 2's schema."""
    return {
        "decision_id": str(uuid.uuid4()),
        "timestamp": _now_iso(),
        "repo": repo,
        "issue_number": issue_number,
        "decision": "accept",
        "actor": BOOTSTRAP_ACTOR,
        "reason": (
            f"bootstrap backfill: vBRIEF already in vbrief/{source_folder}/ at "
            f"opt-in time"
        ),
    }


def _append_audit_entry(audit_path: Path, entry: dict[str, Any]) -> None:
    """Self-contained JSONL append used when Story 2 hasn't merged yet.

    Mirrors the schema Story 2 prescribes (UUID + ISO-8601 + repo +
    issue_number + decision + actor + reason). Story 2's ``append`` provides
    advisory locking; the bootstrap path does not because this step is run
    once at opt-in and does not race with other writers.
    """
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(entry, ensure_ascii=False, sort_keys=True)
    with audit_path.open("a", encoding="utf-8") as fh:
        fh.write(serialized)
        fh.write("\n")


def step_backfill_audit_log(project_root: Path, repo: str | None) -> StepOutcome:
    """Backfill ``accepted`` audit entries for items already in lifecycle folders.

    Idempotent: items whose issue number already appears in the audit log are
    skipped, regardless of which decision was recorded. The first-write-wins
    semantic preserves any pre-existing audit history (e.g. an issue that was
    accepted, then rejected, then re-accepted before bootstrap was first run).

    Skips ``vbrief/cancelled/`` so rejected items are not reanimated.
    """
    if repo is None:
        return StepOutcome(
            name="backfill_audit_log",
            ok=True,
            message=(
                "skipped (no --repo provided; pass --repo OWNER/NAME to backfill)"
            ),
            details={"skipped": "no-repo"},
        )

    vbrief_root = project_root / "vbrief"
    if not vbrief_root.exists() or not vbrief_root.is_dir():
        return StepOutcome(
            name="backfill_audit_log",
            ok=True,
            message=f"skipped (no vbrief/ directory under {project_root})",
            details={"skipped": "no-vbrief"},
        )

    audit_path = project_root / AUDIT_LOG_RELPATH
    already_logged = _existing_audit_issue_numbers(audit_path)

    # Detect Story 2's append() if available -- prefer it so the advisory
    # lock is honored on contended writes (defence-in-depth even though the
    # bootstrap is single-writer).
    try:
        import candidates_log  # type: ignore[import-not-found]

        story2_append = getattr(candidates_log, "append", None)
        if not callable(story2_append):
            story2_append = None
    except ImportError:
        story2_append = None

    appended = 0
    skipped_existing = 0
    skipped_cancelled = 0

    # Count cancelled items only for diagnostic transparency. We do NOT log
    # them; the count tells the operator how many would be reanimated if the
    # bootstrap incorrectly included cancelled/.
    cancelled_dir = vbrief_root / "cancelled"
    if cancelled_dir.exists():
        skipped_cancelled = len(_scan_lifecycle_folder(cancelled_dir))

    for folder_name in BACKFILL_FOLDERS:
        folder_path = vbrief_root / folder_name
        for issue_number, _vbrief_path in _scan_lifecycle_folder(folder_path):
            if issue_number in already_logged:
                skipped_existing += 1
                continue
            entry = _build_audit_entry(repo, issue_number, folder_name)
            try:
                if story2_append is not None:
                    # Pass path=audit_path explicitly so Story 2 writes to
                    # the consumer's project-root audit log rather than
                    # ``DEFAULT_LOG_PATH`` (which is anchored to the repo
                    # housing ``scripts/candidates_log.py``). Without this,
                    # bootstrap invocations from a different ``--project-root``
                    # (and pytest tmp_path fixtures) silently leak entries
                    # into the deft-directive repo's own audit log.
                    story2_append(entry, path=audit_path)
                else:
                    _append_audit_entry(audit_path, entry)
            except Exception as exc:  # noqa: BLE001
                return StepOutcome(
                    name="backfill_audit_log",
                    ok=False,
                    message=(
                        f"append failed at issue #{issue_number} after "
                        f"{appended} successful writes"
                    ),
                    error=f"{type(exc).__name__}: {exc}",
                    details={
                        "appended": appended,
                        "skipped_existing": skipped_existing,
                        "skipped_cancelled": skipped_cancelled,
                    },
                )
            appended += 1
            already_logged.add(issue_number)

    return StepOutcome(
        name="backfill_audit_log",
        ok=True,
        message=(
            f"appended {appended} accepted entries; skipped "
            f"{skipped_existing} (already logged); skipped "
            f"{skipped_cancelled} (cancelled/, no reanimation)"
        ),
        details={
            "appended": appended,
            "skipped_existing": skipped_existing,
            "skipped_cancelled": skipped_cancelled,
            "audit_path": str(audit_path),
        },
    )


# ---------------------------------------------------------------------------
# Step 3 -- ensure .deft-cache/ is gitignored
# ---------------------------------------------------------------------------


def _gitignore_already_covers(gitignore_text: str, line: str) -> bool:
    """Return True when ``gitignore_text`` already includes ``line``.

    Match is line-exact (after stripping trailing whitespace) so commented-out
    forms like ``# .deft-cache/`` do NOT count as coverage. This is consistent
    with NFR-2 in ``docs/privacy-nfr.md``: the consumer's commented-out form
    is the explicit opt-in to commit the cache, and the bootstrap MUST NOT
    re-add the active rule without operator intent.
    """
    target = line.strip()
    return any(raw.strip() == target for raw in gitignore_text.splitlines())


def _is_commented_gitignore_line(raw: str, gitignore_line: str) -> bool:
    """Return True when ``raw`` is exactly the commented-out form of ``gitignore_line``.

    Recognized shapes (NFR-2 opt-in markers):

    - ``# .deft-cache/``
    - ``#.deft-cache/``           (no space)
    - ``  # .deft-cache/  ``      (surrounding whitespace)
    - ``## .deft-cache/``         (double-hash for visual emphasis)

    Rejected:

    - ``.deft-cache/`` (active rule -- handled by ``_gitignore_already_covers``)
    - ``# Do not track files under .deft-cache/ here`` (mere mention)
    - ``# anything-else.deft-cache/`` (substring would match; literal-form
      anchoring rejects it)

    The check strips leading/trailing whitespace, requires the line to
    start with ``#``, then peels successive ``#`` characters and at most one
    space before comparing the remainder to ``gitignore_line`` exactly. This
    is tighter than a substring scan (Greptile P2 on PR #877) while still
    accepting reasonable hand-written variants of the documented opt-in
    pattern.
    """
    stripped = raw.strip()
    if not stripped.startswith("#"):
        return False
    # Peel off all leading '#' characters (allows ``##`` etc.) plus at most
    # one optional space, then compare the remainder to the active-rule form.
    body = stripped.lstrip("#")
    if body.startswith(" "):
        body = body[1:]
    return body == gitignore_line


def step_ensure_gitignore_entry(project_root: Path) -> StepOutcome:
    """Append ``.deft-cache/`` to ``.gitignore`` when absent.

    Idempotent: a re-run is a no-op when the line is present (or when the
    consumer has commented it out as the explicit opt-in to commit the
    cache, per NFR-2 in ``docs/privacy-nfr.md``).
    """
    gitignore_path = project_root / ".gitignore"
    if not gitignore_path.exists():
        # Greenfield project. Create a minimal .gitignore with just the
        # cache line so the bootstrap is still self-contained.
        try:
            gitignore_path.write_text(GITIGNORE_LINE + "\n", encoding="utf-8")
        except OSError as exc:
            return StepOutcome(
                name="ensure_gitignore_entry",
                ok=False,
                message="could not create .gitignore",
                error=str(exc),
            )
        return StepOutcome(
            name="ensure_gitignore_entry",
            ok=True,
            message=f"created .gitignore with {GITIGNORE_LINE} line",
            details={"created": True, "appended": False},
        )

    try:
        existing = gitignore_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return StepOutcome(
            name="ensure_gitignore_entry",
            ok=False,
            message="could not read .gitignore",
            error=str(exc),
        )

    # Check for either the active line OR a commented-out form (NFR-2 opt-in).
    # If commented out, we treat that as "consumer has opted in to commit the
    # cache" and respect that decision.
    #
    # The match is tightened to the exact `# .deft-cache/` form (with optional
    # leading/trailing whitespace and an optional second `#` for double-hash
    # comments) so a comment that merely *mentions* the cache directory --
    # e.g. `# Do not track files under .deft-cache/ here` -- does NOT trigger
    # the opt-in detection. Only a literal commented-out form counts as the
    # NFR-2 opt-in (Greptile P2 review on PR #877).
    has_commented_form = any(
        _is_commented_gitignore_line(raw, GITIGNORE_LINE) for raw in existing.splitlines()
    )

    if _gitignore_already_covers(existing, GITIGNORE_LINE):
        return StepOutcome(
            name="ensure_gitignore_entry",
            ok=True,
            message=f"{GITIGNORE_LINE} already in .gitignore (no-op)",
            details={"created": False, "appended": False, "already_present": True},
        )

    if has_commented_form:
        return StepOutcome(
            name="ensure_gitignore_entry",
            ok=True,
            message=(
                f"{GITIGNORE_LINE} is commented out (operator has opted in to "
                "commit the cache per docs/privacy-nfr.md NFR-2; not re-adding)"
            ),
            details={
                "created": False,
                "appended": False,
                "opt_in_commit_cache": True,
            },
        )

    # Append the line. Ensure we land on a fresh line even if the existing
    # file lacks a trailing newline.
    suffix = "" if existing.endswith("\n") or existing == "" else "\n"
    new_content = (
        existing
        + suffix
        + "\n# Triage v1 local issue cache (#845).\n"
        + "# See docs/privacy-nfr.md for the gitignore-default + opt-in-commit-cache\n"
        + "# contract. Comment this line out to opt in to committing the cache.\n"
        + GITIGNORE_LINE
        + "\n"
    )
    try:
        gitignore_path.write_text(new_content, encoding="utf-8")
    except OSError as exc:
        return StepOutcome(
            name="ensure_gitignore_entry",
            ok=False,
            message="could not write .gitignore",
            error=str(exc),
        )
    return StepOutcome(
        name="ensure_gitignore_entry",
        ok=True,
        message=f"appended {GITIGNORE_LINE} to .gitignore",
        details={"created": False, "appended": True},
    )


# ---------------------------------------------------------------------------
# Step 4 -- ensure gitcrawl is installed (best-effort)
# ---------------------------------------------------------------------------


def step_ensure_gitcrawl(skip: bool = False) -> StepOutcome:
    """Install ``gitcrawl`` when missing.

    ``gitcrawl`` is the GitHub-aware crawler Story 1 prefers when populating
    the cache (with a fallback to ``gh issue list`` when absent). The bootstrap
    tries ``pipx install gitcrawl`` and falls back to a print-only diagnostic
    when neither pipx nor gitcrawl can be detected. Installation is best-effort:
    the bootstrap does NOT fail if gitcrawl can't be installed because Story 1
    has a documented fallback.

    The ``skip`` flag is a test-only escape hatch; CLI consumers should not
    pass it.
    """
    if skip:
        return StepOutcome(
            name="ensure_gitcrawl",
            ok=True,
            message="skipped (--skip-gitcrawl flag set)",
            details={"skipped": "flag"},
        )

    if shutil.which("gitcrawl") is not None:
        return StepOutcome(
            name="ensure_gitcrawl",
            ok=True,
            message="already on PATH (no-op)",
            details={"installed": True, "action": "noop"},
        )

    pipx = shutil.which("pipx")
    if pipx is None:
        return StepOutcome(
            name="ensure_gitcrawl",
            ok=True,
            message=(
                "deferred -- pipx not on PATH; install gitcrawl manually if "
                "you want gh-API-free cache populates "
                "(Story 1 falls back to 'gh issue list')"
            ),
            details={"installed": False, "action": "deferred-no-pipx"},
        )

    try:
        proc = subprocess.run(  # noqa: S603 -- explicit args, no shell
            [pipx, "install", "gitcrawl"],
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        return StepOutcome(
            name="ensure_gitcrawl",
            ok=True,
            message=(
                f"deferred -- pipx install raised {type(exc).__name__} "
                "(Story 1 has a 'gh issue list' fallback)"
            ),
            error=str(exc),
            details={"installed": False, "action": "deferred-error"},
        )

    if proc.returncode == 0:
        return StepOutcome(
            name="ensure_gitcrawl",
            ok=True,
            message="installed via pipx",
            details={"installed": True, "action": "pipx-install"},
        )

    return StepOutcome(
        name="ensure_gitcrawl",
        ok=True,
        message=(
            f"deferred -- pipx install exited {proc.returncode} "
            "(Story 1 has a 'gh issue list' fallback)"
        ),
        error=(proc.stderr or proc.stdout or "").strip()[:512],
        details={"installed": False, "action": "deferred-pipx-fail"},
    )


# ---------------------------------------------------------------------------
# Dispatcher + CLI
# ---------------------------------------------------------------------------


def run_bootstrap(
    project_root: Path,
    repo: str | None,
    *,
    skip_gitcrawl: bool = False,
) -> BootstrapResult:
    """Run the bootstrap pipeline, returning the aggregate result.

    Dispatches the four mutating steps documented in the module docstring
    (populate_cache, backfill_audit_log, ensure_gitignore_entry,
    ensure_gitcrawl) and appends one ``StepOutcome`` per step. The fifth
    documented step (``recap``) is rendered by
    :meth:`BootstrapResult.summary` and printed in :func:`main` rather
    than dispatched as a separate ``StepOutcome``; the recap therefore
    produces no entry in ``result.steps``. ``len(result.steps) == 4`` is
    the expected post-condition.

    Separated from :func:`main` so tests drive the function directly
    without argparse plumbing.
    """
    result = BootstrapResult(project_root=project_root, repo=repo)

    result.steps.append(step_populate_cache(project_root, repo))
    result.steps.append(step_backfill_audit_log(project_root, repo))
    result.steps.append(step_ensure_gitignore_entry(project_root))
    result.steps.append(step_ensure_gitcrawl(skip=skip_gitcrawl))

    # Aggregate exit code: any step with ok=False sets exit 1.
    if any(not step.ok for step in result.steps):
        result.exit_code = 1
    return result


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_bootstrap.py",
        description=(
            "Idempotent 5-step triage v1 installer (#845 Story 6). Re-runnable "
            "by design; reversible via `rm -rf .deft-cache/ vbrief/.eval/` and "
            "removing the .deft-cache/ line from .gitignore."
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
            "Upstream repo slug 'owner/name'. Required for cache populate + "
            "audit-log backfill steps. Bootstrap is partial when omitted "
            "(gitignore + gitcrawl steps still run)."
        ),
    )
    parser.add_argument(
        "--skip-gitcrawl",
        action="store_true",
        help=(
            "Skip step 4 (gitcrawl install). Mainly for test fixtures that "
            "shouldn't shell out to pipx."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="emit_json",
        help=(
            "Emit a structured JSON payload to stdout (one object per step) "
            "instead of the human-readable recap. Exit code is unchanged."
        ),
    )
    return parser


def _emit_json(result: BootstrapResult) -> str:
    """Render the structured ``--json`` payload (pinned by tests)."""
    payload = {
        "project_root": str(result.project_root),
        "repo": result.repo,
        "exit_code": result.exit_code,
        "steps": [
            {
                "name": s.name,
                "ok": s.ok,
                "message": s.message,
                "error": s.error,
                "details": s.details,
            }
            for s in result.steps
        ],
    }
    return json.dumps(payload, sort_keys=True)


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    if not project_root.exists() or not project_root.is_dir():
        msg = (
            f"❌ triage:bootstrap: --project-root {project_root} does not exist "
            "or is not a directory."
        )
        print(msg, file=sys.stderr)
        return 2

    result = run_bootstrap(
        project_root=project_root,
        repo=args.repo,
        skip_gitcrawl=args.skip_gitcrawl,
    )

    if args.emit_json:
        print(_emit_json(result))
    else:
        print(result.summary())

    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
