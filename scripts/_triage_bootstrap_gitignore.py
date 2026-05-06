"""_triage_bootstrap_gitignore.py -- gitignore-ensure helpers (#883 Story 3).

Extracted from :mod:`triage_bootstrap` under #952 to keep the parent
module under the 1000-line MUST limit from ``coding/coding.md``. The
helpers are pure (no module-level state) and operate on the consumer
project's ``.gitignore`` only; nothing here touches the cache, audit
log, or scope vBRIEF state.

Public surface (stable for :mod:`triage_bootstrap` re-exports):

- :data:`GITIGNORE_LINE` -- canonical ``.deft-cache/`` line.
- :data:`GITIGNORE_EVAL_LINE` -- canonical ``vbrief/.eval/`` line.
- :func:`step_ensure_gitignore_entry` -- bootstrap step 3.
- :func:`step_ensure_gitignore_eval_dir` -- bootstrap step 4.

Internal helpers (underscore-prefixed) MUST NOT be imported from
outside :mod:`triage_bootstrap`. The companion ``StepOutcome`` dataclass
is provided by the parent module to avoid a circular import.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from triage_bootstrap import StepOutcome


def _outcome_cls() -> type:
    """Return :class:`triage_bootstrap.StepOutcome` lazily.

    Lazy resolution sidesteps the import cycle between this submodule
    and :mod:`triage_bootstrap`: importing the parent at module load
    time would deadlock when a caller imports this submodule first
    (the parent's ``from _triage_bootstrap_gitignore import ...`` line
    runs before this module's name bindings are populated). Resolving
    on first call is cheap and Python caches the parent in
    ``sys.modules`` after the first hit.
    """
    from triage_bootstrap import StepOutcome as _StepOutcome

    return _StepOutcome


#: Canonical gitignore line. Trailing slash matches the convention in
#: the existing ``.gitignore`` (e.g. ``dist/``, ``.deft/``).
GITIGNORE_LINE: str = ".deft-cache/"

#: Canonical gitignore line for the per-machine triage audit / eval
#: scratch directory (#915).
GITIGNORE_EVAL_LINE: str = "vbrief/.eval/"


_DEFT_CACHE_RATIONALE: str = (
    "\n# Triage v1 local content cache (#845, #883). Mirrors upstream\n"
    "# issues into .deft-cache/github-issue/<owner>/<repo>/<N>/. See\n"
    "# docs/privacy-nfr.md for the gitignore-default + opt-in-commit-cache\n"
    "# contract. Comment this line out to opt in to committing the cache.\n"
)
_EVAL_DIR_RATIONALE: str = (
    "\n# Triage v1 audit/eval scratch (#915). Holds candidates.jsonl + transient\n"
    "# evaluation artefacts written by triage actions. Per-machine operator state;\n"
    "# never versioned (would leak triage timing/identity). Comment this line out\n"
    "# to opt in to committing the audit log.\n"
)


def _gitignore_already_covers(gitignore_text: str, line: str) -> bool:
    """Return True when ``gitignore_text`` already includes ``line``."""

    target = line.strip()
    return any(raw.strip() == target for raw in gitignore_text.splitlines())


def _is_commented_gitignore_line(raw: str, gitignore_line: str) -> bool:
    """Return True when ``raw`` is exactly the commented-out form of ``gitignore_line``."""

    stripped = raw.strip()
    if not stripped.startswith("#"):
        return False
    body = stripped.lstrip("#")
    if body.startswith(" "):
        body = body[1:]
    return body == gitignore_line


def _ensure_gitignore_line(
    gitignore_path: Path,
    line: str,
    *,
    step_name: str,
    create_if_missing: bool,
    rationale_block: str,
    opt_in_message: str,
) -> StepOutcome:
    """Ensure ``line`` is present in ``.gitignore``; idempotent."""

    outcome_cls = _outcome_cls()

    if not gitignore_path.exists():
        if not create_if_missing:
            return outcome_cls(
                name=step_name,
                ok=False,
                message=(
                    f".gitignore not present after the prior gitignore step; "
                    f"{line} not written -- re-run bootstrap to retry"
                ),
                error="prior gitignore step did not create .gitignore",
                details={"created": False, "appended": False, "skipped": "no-gitignore"},
            )
        try:
            gitignore_path.write_text(line + "\n", encoding="utf-8")
        except OSError as exc:
            return outcome_cls(
                name=step_name,
                ok=False,
                message="could not create .gitignore",
                error=str(exc),
            )
        return outcome_cls(
            name=step_name,
            ok=True,
            message=f"created .gitignore with {line} line",
            details={"created": True, "appended": False},
        )

    try:
        existing = gitignore_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return outcome_cls(
            name=step_name,
            ok=False,
            message="could not read .gitignore",
            error=str(exc),
        )

    has_commented_form = any(
        _is_commented_gitignore_line(raw, line) for raw in existing.splitlines()
    )

    if _gitignore_already_covers(existing, line):
        return outcome_cls(
            name=step_name,
            ok=True,
            message=f"{line} already in .gitignore (no-op)",
            details={"created": False, "appended": False, "already_present": True},
        )

    if has_commented_form:
        return outcome_cls(
            name=step_name,
            ok=True,
            message=opt_in_message,
            details={"created": False, "appended": False, "opt_in_commit": True},
        )

    suffix = "" if existing.endswith("\n") or existing == "" else "\n"
    new_content = existing + suffix + rationale_block + line + "\n"
    try:
        gitignore_path.write_text(new_content, encoding="utf-8")
    except OSError as exc:
        return outcome_cls(
            name=step_name,
            ok=False,
            message="could not write .gitignore",
            error=str(exc),
        )
    return outcome_cls(
        name=step_name,
        ok=True,
        message=f"appended {line} to .gitignore",
        details={"created": False, "appended": True},
    )


def step_ensure_gitignore_entry(project_root: Path) -> StepOutcome:
    """Append ``.deft-cache/`` to ``.gitignore`` when absent."""

    return _ensure_gitignore_line(
        project_root / ".gitignore",
        GITIGNORE_LINE,
        step_name="ensure_gitignore_entry",
        create_if_missing=True,
        rationale_block=_DEFT_CACHE_RATIONALE,
        opt_in_message=(
            f"{GITIGNORE_LINE} is commented out (operator has opted in to "
            "commit the cache per docs/privacy-nfr.md NFR-2; not re-adding)"
        ),
    )


def step_ensure_gitignore_eval_dir(project_root: Path) -> StepOutcome:
    """Append ``vbrief/.eval/`` to ``.gitignore`` when absent (#915)."""

    return _ensure_gitignore_line(
        project_root / ".gitignore",
        GITIGNORE_EVAL_LINE,
        step_name="ensure_gitignore_eval_dir",
        create_if_missing=False,
        rationale_block=_EVAL_DIR_RATIONALE,
        opt_in_message=(
            f"{GITIGNORE_EVAL_LINE} is commented out (operator opt-in to "
            "commit triage audit/eval scratch; not re-adding)"
        ),
    )
