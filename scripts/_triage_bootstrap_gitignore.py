# ruff: noqa: E501  -- the canonical README literal at the bottom of this
# file contains markdown table rows that intentionally run past the 100-char
# ceiling so the rendered README is byte-identical to the on-disk
# `vbrief/.eval/README.md`. Splitting the table cells across lines breaks
# Markdown rendering. The rest of the module respects the project ceiling.
"""_triage_bootstrap_gitignore.py -- gitignore-ensure + audit-log seed helpers.

Extracted from :mod:`triage_bootstrap` under #952 to keep the parent
module under the 1000-line MUST limit from ``coding/coding.md``. The
helpers are pure (no module-level state) and operate on the consumer
project's ``.gitignore``, ``.gitattributes``, Deft runtime sentinel
paths, and ``vbrief/.eval/`` scratch directory only; nothing here
touches the cache or scope vBRIEF state.

Public surface (stable for :mod:`triage_bootstrap` re-exports):

- :data:`GITIGNORE_LINE` -- canonical ``.deft-cache/`` line.
- :data:`GITIGNORE_DEFT_RUNTIME_SENTINELS` -- canonical selective
  ``.deft`` runtime sentinel lines (``ritual-state.json`` /
  ``last-session.json``). Single source of truth mirrored by the
  installer and imported by the relocator (#1609).
- :data:`GITIGNORE_EVAL_ENTRIES` -- canonical selective per-file lines
  for the #1144 hybrid policy (``candidates.jsonl`` /
  ``summary-history.jsonl`` / ``scope-lifecycle.jsonl`` /
  ``decompositions/`` / ``doctor-state.json``). Single source of truth
  the installer (``cmd/deft-install/setup.go``) mirrors and the relocator
  (``scripts/relocate.py``) imports (#1464).
- :data:`FORBIDDEN_BLANKET_EVAL_LINES` -- canonical forbidden blanket
  lines (``vbrief/.eval/`` / ``vbrief/.eval``) shared with the installer
  and relocator deposit rails so all three agree on what to heal (#1464).
- :func:`strip_gitignore_inline_comment` -- public inline-comment strip
  reused by the installer/relocator heal rails (#1464).
- :data:`GITATTRIBUTES_EVAL_RULE` -- canonical
  ``vbrief/.eval/*.jsonl  merge=union`` line for #1144.
- :func:`step_ensure_gitignore_entry` -- bootstrap step 3.
- :func:`step_ensure_gitignore_eval_entries` -- bootstrap step 4.
  Replaces the pre-#1251 ``step_ensure_gitignore_eval_dir`` which
  appended a blanket ``vbrief/.eval/`` line that violated the
  hybrid-policy decision recorded on #1144.
- :func:`step_seed_candidates_log` -- bootstrap step 5 (#1240).

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
#: the existing ``.gitignore`` (e.g. ``dist/``, ``node_modules/``).
GITIGNORE_LINE: str = ".deft-cache/"

#: Canonical selective gitignore lines for Deft-owned per-clone runtime
#: sentinels under ``.deft/``. The framework payload at ``.deft/core/``
#: remains intentionally trackable for reproducible consumer installs, so
#: these entries MUST stay file-specific and MUST NOT become ``.deft/``.
GITIGNORE_DEFT_RUNTIME_SENTINELS: tuple[str, ...] = (
    ".deft/ritual-state.json",
    ".deft/last-session.json",
    # Operator coding sub-agent model routing per #1739 -- per-machine,
    # per-project, never committed. The framework payload at .deft/core/
    # stays trackable, so this entry MUST stay file-specific.
    ".deft/routing.local.json",
)

#: Canonical selective gitignore lines for the #1144 hybrid policy.
#: Replaces the pre-#1251 blanket ``vbrief/.eval/`` line. The entries
#: below are operator-private / per-machine / local-scratch state;
#: ``slices.jsonl`` is intentionally omitted because it is TRACKED
#: team-shared cohort state per #1132 / D13. ``decompositions/`` holds
#: local story-decomposition draft scratch; ``doctor-state.json`` is
#: per-machine ``task doctor`` throttle state (added under #1464). This
#: tuple is the single source of truth: the relocator imports it and the
#: Go installer mirrors it (a parity test pins the two together), and it
#: stays in lockstep with the ``vbrief/.eval/README.md`` policy table.
GITIGNORE_EVAL_ENTRIES: tuple[str, ...] = (
    "vbrief/.eval/candidates.jsonl",
    "vbrief/.eval/summary-history.jsonl",
    "vbrief/.eval/scope-lifecycle.jsonl",
    "vbrief/.eval/decompositions/",
    "vbrief/.eval/doctor-state.json",
)

#: Canonical ``.gitattributes`` line for the #1144 merge=union rule on
#: append-only JSONL files under ``vbrief/.eval/``. Two spaces between
#: the glob and the attribute mirrors the existing repo convention.
GITATTRIBUTES_EVAL_RULE: str = "vbrief/.eval/*.jsonl  merge=union"

#: Glob the merge=union rule must apply to. Used by the idempotency
#: detector so we don't append a duplicate rule when an operator has
#: hand-edited the attribute spacing or trailing comments.
_GITATTRIBUTES_EVAL_GLOB: str = "vbrief/.eval/*.jsonl"

#: Forbidden blanket gitignore lines. The pre-#1251 step appended
#: ``vbrief/.eval/`` (or ``vbrief/.eval``) which silently hid the
#: tracked ``slices.jsonl`` from git. Detected so we can warn loudly if
#: a re-run encounters a stale entry left behind by a prior bootstrap.
#: Public (#1464) so the installer (mirrored) and relocator (imported)
#: deposit rails share one forbidden-blanket policy and HEAL a
#: pre-existing blanket on upgrade instead of leaving it.
FORBIDDEN_BLANKET_EVAL_LINES: tuple[str, ...] = (
    "vbrief/.eval/",
    "vbrief/.eval",
)
#: Backwards-compatible private alias for internal call sites that
#: predate the public name promoted in #1464.
_FORBIDDEN_BLANKET_EVAL_LINES: tuple[str, ...] = FORBIDDEN_BLANKET_EVAL_LINES


_DEFT_CACHE_RATIONALE: str = (
    "\n# Triage v1 local content cache (#845, #883). Mirrors upstream\n"
    "# issues into .deft-cache/github-issue/<owner>/<repo>/<N>/. See\n"
    "# docs/privacy-nfr.md for the gitignore-default + opt-in-commit-cache\n"
    "# contract. Comment this line out to opt in to committing the cache.\n"
)
#: Comment block written above the selective eval entries on a fresh
#: clone. Captures the #1144 hybrid policy in-line so an operator
#: reading ``.gitignore`` sees why ``slices.jsonl`` is intentionally
#: NOT listed (it is TRACKED team-shared cohort state).
_EVAL_ENTRIES_RATIONALE: str = (
    "\n# vbrief/.eval/ tracking governance (#1144, N4 of #1119).\n"
    "# Hybrid policy from the Current Shape comment on #1144:\n"
    "#   - candidates.jsonl       -> gitignored (operator-private triage\n"
    "#                               decisions; re-derive via\n"
    "#                               `task triage:bootstrap` on a fresh\n"
    "#                               clone). #845 Story 2 + #915.\n"
    "#   - summary-history.jsonl  -> gitignored (operator-private\n"
    "#                               observability; not load-bearing for\n"
    "#                               any decision).\n"
    "#   - scope-lifecycle.jsonl  -> gitignored (operator-private\n"
    "#                               scope-lifecycle audit decisions;\n"
    "#                               D1 / #1121). Per-operator demote\n"
    "#                               stream; sharing would conflate\n"
    "#                               operators' demote timing across the\n"
    "#                               team.\n"
    "#   - decompositions/        -> gitignored (local story-decomposition\n"
    "#                               draft scratch; generated child story\n"
    "#                               vBRIEFs live in lifecycle folders via\n"
    "#                               `task scope:decompose`).\n"
    "#   - doctor-state.json      -> gitignored (per-machine `task doctor`\n"
    "#                               throttle state gating the 24h/4h\n"
    "#                               re-probe window; #1308 / #1464). Local\n"
    "#                               to each clone; never committed.\n"
    "#   - slices.jsonl           -> TRACKED (team-shared cohort records\n"
    "#                               produced by slicing skills; see\n"
    "#                               #1132 / D13).\n"
    "# See vbrief/.eval/README.md for the full policy + merge=union\n"
    "# rebase note.\n"
)
_GITATTRIBUTES_EVAL_RATIONALE: str = (
    "\n# Append-only JSON-lines logs under vbrief/.eval/ use the union merge driver\n"
    "# (#1144, N4 of #1119). Both branches' appended lines are concatenated on\n"
    "# auto-merge so single-operator rebases of two append branches resolve\n"
    "# without manual conflict surgery. Note: merge=union does NOT dedupe; see\n"
    "# vbrief/.eval/README.md for the operator-facing semantics.\n"
)

#: First line of ``_EVAL_ENTRIES_RATIONALE`` used as the dedup sentinel
#: when deciding whether to prepend the comment block on partial re-runs
#: (Greptile P2 finding on PR #1256 -- a partial-state .gitignore that
#: already carries the rationale block but is missing one or more
#: selective entries should not get a duplicated comment block).
_EVAL_ENTRIES_RATIONALE_SENTINEL: str = (
    "# vbrief/.eval/ tracking governance (#1144, N4 of #1119)."
)


def _strip_gitignore_inline_comment(line: str) -> str:
    """Strip an inline ``# ...`` comment from a gitignore line.

    Returns the line content with any trailing comment removed and
    surrounding whitespace stripped. A line whose entire content is a
    comment (after leading whitespace) returns an empty string. Used
    to detect forbidden blanket lines like ``vbrief/.eval/  # legacy``
    that would otherwise slip past the set-membership check (SLizard
    P1 finding on PR #1256).
    """
    stripped = line.strip()
    if not stripped:
        return ""
    if stripped.startswith("#"):
        return ""
    comment_idx = stripped.find("#")
    if comment_idx == -1:
        return stripped
    return stripped[:comment_idx].rstrip()


#: Public alias for the inline-comment strip (#1464). The installer's
#: Go heal mirrors this behaviour and the relocator's Python heal imports
#: this exact helper so all three rails detect a forbidden blanket -- even
#: one carrying a trailing ``# legacy`` comment -- identically.
strip_gitignore_inline_comment = _strip_gitignore_inline_comment


def _gitignore_already_covers(gitignore_text: str, line: str) -> bool:
    """Return True when ``gitignore_text`` already includes ``line``."""

    target = line.strip()
    return any(
        _strip_gitignore_inline_comment(raw) == target
        for raw in gitignore_text.splitlines()
    )


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


def step_ensure_gitignore_eval_entries(project_root: Path) -> StepOutcome:
    """Ensure the #1144 hybrid policy is encoded in the repo (idempotent).

    Three sub-operations run unconditionally; each is independently
    idempotent and the aggregate StepOutcome reports the union of work
    done:

    1. ``.gitignore`` -- append the three selective entries
       (``candidates.jsonl`` / ``summary-history.jsonl`` /
       ``scope-lifecycle.jsonl``) when any are missing. NEVER appends
       the blanket ``vbrief/.eval/`` line that violated #1144 -- the
       pre-#1251 behaviour. Refuses to create ``.gitignore`` from
       scratch; step 3 owns that responsibility.
    2. ``.gitattributes`` -- append the ``vbrief/.eval/*.jsonl
       merge=union`` rule when absent. Creates the file on a fresh
       clone.
    3. ``vbrief/.eval/README.md`` -- write the canonical hybrid-policy
       README when absent so operators reading the directory in
       isolation discover the tracking contract.

    All three operations are no-ops when the surface is already
    correctly configured (the framework's own repo case). The step is
    safe to re-run on every ``task triage:bootstrap`` invocation.
    """
    outcome_cls = _outcome_cls()
    gitignore_path = project_root / ".gitignore"
    gitattributes_path = project_root / ".gitattributes"
    readme_path = project_root / "vbrief" / ".eval" / "README.md"
    step_name = "ensure_gitignore_eval_entries"

    details: dict[str, object] = {}

    # Sub-op 1 -- .gitignore selective entries.
    gi_result = _ensure_gitignore_selective_entries(
        gitignore_path, step_name=step_name,
    )
    if not gi_result.ok:
        details.update(gi_result.details)
        return outcome_cls(
            name=step_name,
            ok=False,
            message=gi_result.message,
            error=gi_result.error,
            details=details,
        )
    details.update(gi_result.details)

    # Sub-op 2 -- .gitattributes merge=union rule.
    ga_result = _ensure_gitattributes_merge_union(
        gitattributes_path, step_name=step_name,
    )
    if not ga_result.ok:
        details.update(ga_result.details)
        return outcome_cls(
            name=step_name,
            ok=False,
            message=ga_result.message,
            error=ga_result.error,
            details=details,
        )
    details.update(ga_result.details)

    # Sub-op 3 -- README documents the policy.
    rd_result = _ensure_eval_readme(readme_path, step_name=step_name)
    if not rd_result.ok:
        details.update(rd_result.details)
        return outcome_cls(
            name=step_name,
            ok=False,
            message=rd_result.message,
            error=rd_result.error,
            details=details,
        )
    details.update(rd_result.details)

    appended_lines = int(details.get("gitignore_appended_lines", 0))
    appended_attr = bool(details.get("gitattributes_appended", False))
    created_readme = bool(details.get("readme_created", False))
    if not appended_lines and not appended_attr and not created_readme:
        message = (
            ".gitignore selective entries, .gitattributes merge=union, "
            "and vbrief/.eval/README.md already present (#1144 hybrid "
            "policy satisfied; no-op)"
        )
    else:
        parts: list[str] = []
        if appended_lines:
            parts.append(
                f"{appended_lines} selective .gitignore "
                f"entr{'y' if appended_lines == 1 else 'ies'}"
            )
        if appended_attr:
            parts.append(".gitattributes merge=union rule")
        if created_readme:
            parts.append("vbrief/.eval/README.md")
        message = "wrote " + " + ".join(parts) + " per #1144 hybrid policy"
    # Greptile P1 on PR #1256: propagate the stale-blanket warning
    # through to the outer step's message so it reaches
    # ``run_bootstrap``'s progress emit + the recap (the sub-step's
    # message was discarded by the aggregator before this fix).
    message = message + _format_blanket_warning(
        bool(details.get("blanket_present", False))
    )
    return outcome_cls(
        name=step_name,
        ok=True,
        message=message,
        details=details,
    )


def _ensure_gitignore_selective_entries(
    gitignore_path: Path,
    *,
    step_name: str,
) -> StepOutcome:
    """Append any missing #1144 selective entries to ``.gitignore``.

    Idempotent: when every selective entry is already present, the
    file is left untouched. When the ``.gitignore`` itself is absent
    we refuse (step 3 owns creation) so an out-of-order call surfaces
    loudly. The forbidden blanket line ``vbrief/.eval/`` is never
    appended and a warning is logged in ``details`` when an operator
    has left one behind manually (the bootstrap does NOT rewrite it --
    the workaround documented on #1251 is for the operator to remove
    it; auto-rewriting risks racing with concurrent edits).
    """
    outcome_cls = _outcome_cls()

    if not gitignore_path.exists():
        return outcome_cls(
            name=step_name,
            ok=False,
            message=(
                ".gitignore not present after the prior gitignore step; "
                "selective eval entries not written -- re-run bootstrap"
            ),
            error="prior gitignore step did not create .gitignore",
            details={
                "gitignore_appended_lines": 0,
                "skipped": "no-gitignore",
            },
        )

    try:
        existing = gitignore_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return outcome_cls(
            name=step_name,
            ok=False,
            message="could not read .gitignore",
            error=str(exc),
            details={"gitignore_appended_lines": 0},
        )

    # SLizard P1 finding on PR #1256: the previous detector used the
    # whole stripped line (including inline comments) for set
    # membership, so a blanket entry like ``vbrief/.eval/  # legacy``
    # slipped past the forbidden check. Now strip the inline comment
    # before building the membership set + scanning for forbidden
    # blanket lines.
    existing_lines = {
        stripped
        for raw in existing.splitlines()
        if (stripped := _strip_gitignore_inline_comment(raw))
    }
    blanket_present = any(
        forbidden in existing_lines
        for forbidden in _FORBIDDEN_BLANKET_EVAL_LINES
    )
    # Greptile P2 finding on PR #1256: dedup the rationale comment
    # block across partial re-runs (operator deleted one of the three
    # entries manually; re-run should append the missing entry without
    # re-prepending the rationale).
    rationale_already_present = _EVAL_ENTRIES_RATIONALE_SENTINEL in existing

    missing = [
        entry for entry in GITIGNORE_EVAL_ENTRIES
        if entry not in existing_lines
    ]
    blanket_warning = _format_blanket_warning(blanket_present)
    if not missing:
        return outcome_cls(
            name=step_name,
            ok=True,
            message=(
                "all #1144 selective entries already in .gitignore (no-op)"
                + blanket_warning
            ),
            details={
                "gitignore_appended_lines": 0,
                "gitignore_already_selective": True,
                "blanket_present": blanket_present,
            },
        )

    suffix = "" if existing.endswith("\n") or existing == "" else "\n"
    if rationale_already_present:
        appended_block = "\n".join(missing) + "\n"
    else:
        appended_block = _EVAL_ENTRIES_RATIONALE + "\n".join(missing) + "\n"
    new_content = existing + suffix + appended_block
    try:
        gitignore_path.write_text(new_content, encoding="utf-8")
    except OSError as exc:
        return outcome_cls(
            name=step_name,
            ok=False,
            message="could not write .gitignore",
            error=str(exc),
            details={"gitignore_appended_lines": 0},
        )
    return outcome_cls(
        name=step_name,
        ok=True,
        message=(
            f"appended {len(missing)} selective .gitignore "
            f"entr{'y' if len(missing) == 1 else 'ies'}"
            + blanket_warning
        ),
        details={
            "gitignore_appended_lines": len(missing),
            "gitignore_appended_entries": list(missing),
            "blanket_present": blanket_present,
            "rationale_already_present": rationale_already_present,
        },
    )


def _format_blanket_warning(blanket_present: bool) -> str:
    """Return the operator-visible warning suffix when a blanket line is detected.

    Greptile P1 finding on PR #1256: when an operator who ran the
    pre-#1251 bootstrap upgrades, their ``.gitignore`` still carries
    the stale ``vbrief/.eval/`` blanket line that hides ``slices.jsonl``
    from git. Detecting it but reporting only ``hybrid policy
    satisfied; no-op`` left the operator unaware their repo was still
    broken. The warning surfaces in ``StepOutcome.message`` so it
    flows through ``run_bootstrap`` 's progress emit AND the recap.
    The forbidden line is NEVER auto-rewritten (concurrency safety);
    the operator removes it manually per the #1251 workaround.
    """
    if not blanket_present:
        return ""
    return (
        " WARNING: stale blanket vbrief/.eval/ line detected in .gitignore -- "
        "remove it manually (it hides tracked slices.jsonl from git per #1251)"
    )


def _ensure_gitattributes_merge_union(
    gitattributes_path: Path,
    *,
    step_name: str,
) -> StepOutcome:
    """Ensure the ``vbrief/.eval/*.jsonl  merge=union`` rule is present.

    Idempotent. Detects an existing rule that targets the canonical
    glob ``vbrief/.eval/*.jsonl`` with ``merge=union`` (regardless of
    whitespace between the glob and the attribute) so a hand-edited
    file with single-space spacing or trailing comments is recognised
    as already-satisfied. Creates the file on a fresh clone.
    """
    outcome_cls = _outcome_cls()

    if gitattributes_path.exists():
        try:
            existing = gitattributes_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            return outcome_cls(
                name=step_name,
                ok=False,
                message="could not read .gitattributes",
                error=str(exc),
                details={"gitattributes_appended": False},
            )
        if _gitattributes_has_eval_merge_union(existing):
            return outcome_cls(
                name=step_name,
                ok=True,
                message=(
                    "vbrief/.eval/*.jsonl merge=union already in "
                    ".gitattributes (no-op)"
                ),
                details={
                    "gitattributes_appended": False,
                    "gitattributes_already_present": True,
                },
            )
        suffix = "" if existing.endswith("\n") or existing == "" else "\n"
        new_content = (
            existing
            + suffix
            + _GITATTRIBUTES_EVAL_RATIONALE
            + GITATTRIBUTES_EVAL_RULE
            + "\n"
        )
        try:
            gitattributes_path.write_text(new_content, encoding="utf-8")
        except OSError as exc:
            return outcome_cls(
                name=step_name,
                ok=False,
                message="could not write .gitattributes",
                error=str(exc),
                details={"gitattributes_appended": False},
            )
        return outcome_cls(
            name=step_name,
            ok=True,
            message=(
                "appended vbrief/.eval/*.jsonl merge=union to .gitattributes"
            ),
            details={
                "gitattributes_appended": True,
                "gitattributes_created": False,
            },
        )

    new_content = (
        _GITATTRIBUTES_EVAL_RATIONALE + GITATTRIBUTES_EVAL_RULE + "\n"
    )
    try:
        gitattributes_path.write_text(new_content, encoding="utf-8")
    except OSError as exc:
        return outcome_cls(
            name=step_name,
            ok=False,
            message="could not create .gitattributes",
            error=str(exc),
            details={"gitattributes_appended": False},
        )
    return outcome_cls(
        name=step_name,
        ok=True,
        message=(
            "created .gitattributes with vbrief/.eval/*.jsonl merge=union"
        ),
        details={
            "gitattributes_appended": True,
            "gitattributes_created": True,
        },
    )


def _gitattributes_has_eval_merge_union(body: str) -> bool:
    """Return True when ``body`` already carries the merge=union rule.

    Tolerant of arbitrary whitespace between the glob and the attribute
    plus trailing comments / extra attributes on the same line. A
    line beginning with ``#`` does not satisfy the rule.
    """
    for raw in body.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        # Tokenise on whitespace; first token is the pattern.
        parts = stripped.split()
        if not parts:
            continue
        if parts[0] != _GITATTRIBUTES_EVAL_GLOB:
            continue
        if "merge=union" in parts[1:]:
            return True
    return False


def _ensure_eval_readme(
    readme_path: Path,
    *,
    step_name: str,
) -> StepOutcome:
    """Write ``vbrief/.eval/README.md`` when absent.

    Idempotent: a pre-existing README (operator-edited or framework-
    shipped) is left untouched. The bootstrap is intentionally
    non-destructive here -- if the framework's canonical README drifts
    relative to a consumer's edited copy, that's an upgrade-time
    concern, not a bootstrap-time concern.
    """
    outcome_cls = _outcome_cls()
    if readme_path.exists():
        return outcome_cls(
            name=step_name,
            ok=True,
            message="vbrief/.eval/README.md already present (no-op)",
            details={
                "readme_created": False,
                "readme_already_present": True,
            },
        )
    try:
        readme_path.parent.mkdir(parents=True, exist_ok=True)
        readme_path.write_text(_EVAL_README_BODY, encoding="utf-8")
    except OSError as exc:
        return outcome_cls(
            name=step_name,
            ok=False,
            message=f"could not create {readme_path}",
            error=str(exc),
            details={"readme_created": False},
        )
    return outcome_cls(
        name=step_name,
        ok=True,
        message="created vbrief/.eval/README.md (#1144 hybrid policy)",
        details={"readme_created": True},
    )


#: Canonical README body written on a fresh clone. Mirrors the on-disk
#: copy at ``vbrief/.eval/README.md`` so the framework's own repo and
#: a consumer's fresh clone produce byte-identical files. The content
#: satisfies the deterministic gates in
#: ``tests/test_eval_governance.py::test_eval_readme_documents_policy``
#: (the tracked/gitignored filenames including ``doctor-state.json``,
#: the ``task triage:bootstrap`` regen command, the ``merge=union``
#: policy, and the no-dedupe qualifier). The markdown table rows below
#: intentionally run past the 100-char ceiling so the rendered README
#: mirrors the canonical on-disk file; see the module-level lint
#: exemption at the top of this file for the rationale.
_EVAL_README_BODY: str = """# `vbrief/.eval/` -- triage + slicing evaluation artefacts

This directory holds the append-only JSON-lines logs that the triage and
slicing skills emit. The framework governs which files in here are tracked
by git versus gitignored using a **hybrid policy** (#1144, child of #1119).

## Tracking policy

| File | Tracked? | Why |
| --- | --- | --- |
| `slices.jsonl` | Yes -- **committed** | Team-shared cohort records produced by slicing skills (D13 / #1132). New operators joining the team need to see prior cohort outputs to detect orphans and avoid re-slicing the same scope. |
| `candidates.jsonl` | No -- **gitignored** | Operator-private triage decisions (#845 Story 2). Each operator's local accept / defer / reject stream is per-machine state; sharing it would conflate operators' timing + identity across the team. Re-derive on a fresh clone via `task triage:bootstrap`. |
| `summary-history.jsonl` | No -- **gitignored** | Operator-private observability for `task triage:summary` output time-series. Not load-bearing for any decision. |
| `scope-lifecycle.jsonl` | No -- **gitignored** | Operator-private scope-lifecycle audit decisions (D1 / #1121). Each demote (`task scope:demote`) appends one entry including a `demote_meta` block (`was_promoted`, `original_promotion_decision_id`, `days_in_pending`, `demote_reason`, `demoted_from`). Per-operator stream; sharing would conflate operators' demote timing across the team. Lightweight metrics over this log are tracked separately at #1180. |
| `decompositions/` | No -- **gitignored** | Temporary story-decomposition proposal drafts. These JSON drafts are local scratch artifacts, not vBRIEFs; generated child story vBRIEFs are created by `task scope:decompose` in lifecycle folders, defaulting to `vbrief/pending/`. |
| `doctor-state.json` | No -- **gitignored** | Per-machine `task doctor` throttle state (last exit code + timestamps) persisted to gate the 24h/4h re-probe window (#1308 / #1464). Local to each clone; never committed. |

The gitignore lines live in the repo-root `.gitignore` (`vbrief/.eval/candidates.jsonl`,
`vbrief/.eval/summary-history.jsonl`, `vbrief/.eval/scope-lifecycle.jsonl`,
`vbrief/.eval/decompositions/`, and `vbrief/.eval/doctor-state.json`). All paths
not listed above remain committed by default.

## Fresh-clone regeneration

On a fresh clone (or any machine that has never run triage), `candidates.jsonl`
is absent. Regenerate it with:

```
task triage:bootstrap
```

The bootstrap path detects the missing file, runs the auto-classifier, and
writes a fresh `vbrief/.eval/candidates.jsonl`. It does NOT touch the tracked
`slices.jsonl`; cohort records remain a team-shared resource.

## `merge=union` policy for `*.jsonl`

The repo-root `.gitattributes` declares:

```
vbrief/.eval/*.jsonl  merge=union
```

The `union` merge driver concatenates both sides' appended lines on
auto-merge, so two branches that each appended a different record to the
same JSON-lines file rebase cleanly without operator surgery. Two things
operators should know:

- **Concatenation, not set-union.** When two branches append DIFFERENT
  records to the file, the merge driver concatenates both sides' lines
  -- there is no smart deduplication of "semantically similar" records.
  (Identical line-for-line appends collapse because git's three-way
  merge sees them as the same change, but distinct records always
  survive verbatim, even if a downstream reader would consider them
  redundant.) The append-only writers in `scripts/candidates_log.py`
  mint a fresh `decision_id` per call, so genuinely duplicate records
  are not the expected case, but downstream readers MUST tolerate
  multiple records describing the same logical decision.
- **Single-operator scope only.** This is the foundational rebase
  ergonomic for the single-operator case (operator A rebases their
  feature branch onto a master that grew while they were AFK).
  Multi-operator merge-conflict resolution is explicitly out of scope per
  #1119 R4 (tracked separately as M1-M4 in #1183).

## See also

- Current Shape comment on #1144 for the canonical decisions (the source
  of truth this README documents).
- `.gitignore` -- selective gitignore entries for the operator-private
  files.
- `.gitattributes` -- the `merge=union` rule.
- `scripts/candidates_log.py` -- the writer for `candidates.jsonl`.
"""


#: Canonical relative location of the audit log; mirrors
#: :data:`triage_bootstrap.AUDIT_LOG_RELPATH` (re-stated here to avoid an
#: import cycle with the parent module).
_CANDIDATES_RELPATH: Path = Path("vbrief") / ".eval" / "candidates.jsonl"


def step_seed_candidates_log(project_root: Path) -> StepOutcome:
    """Ensure ``vbrief/.eval/candidates.jsonl`` exists (#1240 option A).

    Bootstrap previously left the audit log absent on the happy path
    (no items to backfill). ``task verify:cache-fresh`` then exited
    with the ``treating as bootstrap state`` message because it could
    not distinguish a never-bootstrapped consumer from a freshly-
    bootstrapped one. Per issue #1240 option A we seed an empty
    zero-length ``candidates.jsonl`` so the two surfaces agree on a
    single state machine: post-bootstrap the gate sees both the cache
    AND the audit log, and reports ``fresh bootstrap, no triage
    actions yet`` (or the canonical fresh / actively-triaging message
    once decisions are recorded).

    Idempotent: a pre-existing audit log (zero-length or filled) is
    left untouched. The step succeeds with a no-op message in that
    case so a re-run of ``task triage:bootstrap`` does not perturb
    existing audit state.
    """
    outcome_cls = _outcome_cls()
    audit_path = project_root / _CANDIDATES_RELPATH
    audit_dir = audit_path.parent
    try:
        audit_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return outcome_cls(
            name="seed_candidates_log",
            ok=False,
            message=f"could not create {audit_dir}",
            error=str(exc),
        )
    if audit_path.exists():
        return outcome_cls(
            name="seed_candidates_log",
            ok=True,
            message=f"{audit_path.relative_to(project_root)} already present (no-op)",
            details={"created": False, "already_present": True},
        )
    try:
        # Zero-byte touch: open in append mode + close. open("a") is
        # the canonical "create if missing, otherwise noop" primitive
        # and avoids race conditions on concurrent bootstrap runs.
        audit_path.touch()
    except OSError as exc:
        return outcome_cls(
            name="seed_candidates_log",
            ok=False,
            message=f"could not seed {audit_path}",
            error=str(exc),
        )
    return outcome_cls(
        name="seed_candidates_log",
        ok=True,
        message=f"created empty {audit_path.relative_to(project_root)}",
        details={"created": True, "already_present": False},
    )
