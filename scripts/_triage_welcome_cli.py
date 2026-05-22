"""CLI + prompt helpers for ``scripts/triage_welcome.py`` (#1143).

Extracted from ``scripts/triage_welcome.py`` so the parent module stays
under the 500-line SHOULD ceiling from ``coding/coding.md``. The public
ritual surface lives in :mod:`triage_welcome`; this module is the
argparse shim, the deterministic-questions-compliant numbered-menu
helpers, and the yes/no + integer prompt helpers only.

Mirrors the split convention established by ``scripts/_triage_scope_cli.py``
(#1131 / D12) and ``scripts/_triage_queue_cli.py`` (#1128 / D11).
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover -- import-time-only typing alias
    from triage_welcome import PriorState, WelcomeOutcome

# ---------------------------------------------------------------------------
# Default-mode (non-onboard) nudge strings (#1309)
# ---------------------------------------------------------------------------

#: Default-mode nudge string emitted by :func:`run_default_mode` when the
#: operator has never run ``task triage:welcome --onboard``. Kept as a
#: module-level constant so tests can pin the exact byte-shape and so
#: future copy edits land in one place.
FIRST_TIME_NUDGE: str = (
    "[welcome] First-time? Run `task triage:welcome --onboard` "
    "to set up triage."
)

#: Template for the partial-onboarding nudge. ``{missing}`` is filled with
#: a stable `" + "`-joined list of absent state pieces (see
#: :func:`_classify_onboarding`).
INCOMPLETE_NUDGE_TEMPLATE: str = (
    "[welcome] Onboarding incomplete: {missing}. Run "
    "`task triage:welcome --onboard` to resume."
)


# ---------------------------------------------------------------------------
# Default IO -- tests inject overrides
# ---------------------------------------------------------------------------


def default_input(prompt: str) -> str:
    return input(prompt)


def default_output(line: str = "") -> None:
    print(line)


# ---------------------------------------------------------------------------
# Numbered-menu prompts (contracts/deterministic-questions.md compliant)
# ---------------------------------------------------------------------------


@dataclass
class PromptOutcome:
    """Structured prompt result -- ``discuss`` / ``back`` / ``value``."""

    discuss: bool = False
    back: bool = False
    value: Any = None


def prompt_menu(
    *,
    title: str,
    options: list[tuple[str, str]],
    default_index: int,
    input_fn: Callable[[str], str],
    output_fn: Callable[[str], None],
) -> PromptOutcome:
    """Render a numbered menu and return the operator's choice.

    Options are ``(label, value-key)`` tuples; the renderer appends
    ``Discuss`` and ``Back`` as the canonical final two options per
    :doc:`contracts/deterministic-questions.md`. Empty input accepts
    *default_index* (0-based). Invalid input re-renders the menu.
    """
    discuss_idx = len(options) + 1
    back_idx = len(options) + 2
    while True:
        output_fn(title)
        for i, (label, _key) in enumerate(options, start=1):
            marker = " (default)" if i - 1 == default_index else ""
            output_fn(f"  {i}) {label}{marker}")
        output_fn(f"  {discuss_idx}) Discuss")
        output_fn(f"  {back_idx}) Back")
        try:
            raw = input_fn(f"  > [{default_index + 1}] ")
        except EOFError:
            raw = ""
        choice = raw.strip()
        if not choice:
            _label, key = options[default_index]
            return PromptOutcome(value=key)
        if not choice.isdecimal():
            output_fn(f"  ! Invalid selection: {choice!r}. Pick a number.")
            continue
        n = int(choice)
        if 1 <= n <= len(options):
            _label, key = options[n - 1]
            return PromptOutcome(value=key)
        if n == discuss_idx:
            output_fn(
                "  [discuss] Pausing the ritual. Re-run "
                "`task triage:welcome` after the discussion to resume."
            )
            return PromptOutcome(discuss=True)
        if n == back_idx:
            return PromptOutcome(back=True)
        output_fn(f"  ! Out-of-range selection: {n}. Pick 1..{back_idx}.")


def prompt_yes_no(
    *,
    title: str,
    default_yes: bool,
    input_fn: Callable[[str], str],
    output_fn: Callable[[str], None],
) -> bool:
    """Yes/no confirm; empty input accepts *default_yes*."""
    suffix = "[Y/n]" if default_yes else "[y/N]"
    try:
        raw = input_fn(f"  {title} {suffix} ")
    except EOFError:
        raw = ""
    text = raw.strip().lower()
    if not text:
        return default_yes
    if text in {"y", "yes"}:
        return True
    if text in {"n", "no"}:
        return False
    output_fn(f"  ! Unrecognized: {raw!r}; treating as 'n'.")
    return False


def prompt_int(
    *,
    title: str,
    default: int,
    input_fn: Callable[[str], str],
    output_fn: Callable[[str], None],
    minimum: int = 1,
) -> int | None:
    """Free-text positive int with default; returns None on Discuss/Back."""
    while True:
        try:
            raw = input_fn(f"  {title} (default {default}): ")
        except EOFError:
            raw = ""
        text = raw.strip()
        if not text:
            return default
        if text.lower() in {"discuss", "back"}:
            return None
        if not text.isdecimal():
            output_fn(f"  ! Not a positive integer: {raw!r}. Try again.")
            continue
        value = int(text)
        if value < minimum:
            output_fn(f"  ! Value {value} below minimum {minimum}. Try again.")
            continue
        return value


# ---------------------------------------------------------------------------
# argparse shim
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_welcome.py",
        description=(
            "Emit the `task triage:welcome` session-start status surface "
            "(#1309 default mode -- summary one-liner plus a state-conditional "
            "first-time / incomplete-onboarding nudge), or run the full "
            "6-phase interactive onboarding ritual (#1143) under --onboard. "
            "Idempotent -- re-run after a partial completion to resume cleanly."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=os.environ.get("DEFT_PROJECT_ROOT", "."),
        help="Consumer project root (default: $DEFT_PROJECT_ROOT or cwd).",
    )
    parser.add_argument(
        "--onboard",
        action="store_true",
        help=(
            "Run the interactive 6-phase onboarding ritual (#1143). "
            "Without this flag (the default), `task triage:welcome` emits "
            "the non-interactive summary one-liner plus a state-conditional "
            "nudge pointing at `--onboard` when state is missing or partial "
            "(#1309)."
        ),
    )
    parser.add_argument(
        "--no-subprocess",
        action="store_true",
        help=(
            "Skip the `task triage:bootstrap` / `scope:demote` / "
            "`triage:summary` subprocess hops. Test-mode flag for the "
            "--onboard ritual; never set in production runs."
        ),
    )
    parser.add_argument(
        "--skip-bootstrap",
        action="store_true",
        help=(
            "Explicitly decline the --onboard Phase 3 `task triage:bootstrap` "
            "invocation (#1244). The ritual still completes but emits a "
            "visible audit message AND records the decline in "
            "`meta/policy-changes.log`; downstream verbs that depend on "
            "`vbrief/.eval/candidates.jsonl` will refuse to run until "
            "bootstrap is invoked separately."
        ),
    )
    parser.add_argument(
        "--no-history",
        action="store_true",
        help=(
            "Suppress the `vbrief/.eval/summary-history.jsonl` append "
            "when emitting the default-mode summary (#1309). Test-mode "
            "flag; production callers SHOULD let the history sidecar "
            "track every invocation."
        ),
    )
    return parser


def run_cli(argv: list[str] | None, tw_module: Any) -> int:
    """Dispatch ``triage_welcome`` CLI args using ``tw_module`` backend.

    ``tw_module`` is the parent :mod:`triage_welcome` module; passed
    explicitly to avoid a circular import at module-load time.

    Default invocation (no ``--onboard``) routes to the non-interactive
    :func:`triage_welcome.run_default_mode` surface (#1309); ``--onboard``
    routes to the original 6-phase interactive ritual
    :func:`triage_welcome.run_welcome` (#1143).
    """
    parser = build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    if not project_root.is_dir():
        print(
            f"triage:welcome: --project-root {project_root} is not a directory.",
            file=sys.stderr,
        )
        return 2
    if args.onboard:
        outcome = tw_module.run_welcome(
            project_root,
            run_subprocess=not args.no_subprocess,
            skip_bootstrap=args.skip_bootstrap,
        )
    else:
        outcome = tw_module.run_default_mode(
            project_root,
            write_history=not args.no_history,
        )
    return outcome.exit_code


# ---------------------------------------------------------------------------
# Default-mode (non-onboard) helpers (#1309)
#
# Hosted here -- not in :mod:`triage_welcome` -- so the parent module stays
# under the 1000-line MUST cap from ``coding/coding.md``. Re-exported by
# :mod:`triage_welcome` for backward compatibility with callers / tests that
# reference ``triage_welcome.<name>``.
# ---------------------------------------------------------------------------


def _classify_onboarding(state: PriorState) -> tuple[str, list[str]]:
    """Return ``(state_label, missing_pieces)`` for the default-mode nudge.

    Three discrete states keyed off the canonical "has the operator run
    onboarding?" signals (#1309 vBRIEF / paired with #1308):

    - ``"first-time"`` -- NONE of the three signals present: no
      ``vbrief/.eval/candidates.jsonl``, no ``plan.policy.triageScope``,
      no ``plan.policy.wipCap``. The operator has never run
      ``task triage:welcome --onboard``.
    - ``"incomplete"`` -- a strict subset (1 or 2) of the three signals
      present; ``missing_pieces`` names the absent piece(s) so the
      operator-facing nudge can be specific.
    - ``"fully-set-up"`` -- all three signals present.

    Pure helper -- no I/O, no audit log.
    """
    signals = {
        "candidates.jsonl": state.audit_log_present,
        "triageScope": state.triage_scope_set,
        "wipCap": state.wip_cap_set,
    }
    present = [name for name, ok in signals.items() if ok]
    missing = [name for name, ok in signals.items() if not ok]
    if not present:
        return "first-time", missing
    if not missing:
        return "fully-set-up", []
    return "incomplete", missing


def emit_oneliner(
    project_root: Path,
    *,
    output_fn: Callable[[str], None] | None = None,
    write_history: bool = True,
) -> str:
    """Emit the ``task triage:summary`` one-liner via internal Python call.

    Mirrors the byte-shape produced by
    ``scripts/triage_summary.py::main`` (the headline plus, when
    applicable, the second ``[triage:scope]`` line per #1270) without
    spawning a subprocess. ``write_history`` controls whether the
    rolling ``vbrief/.eval/summary-history.jsonl`` sidecar is appended
    to; default-mode welcome runs DO append so observability stays
    aligned with direct ``task triage:summary`` invocations.

    Returns the rendered line(s) so callers can compose with downstream
    state without re-rendering.
    """
    # Lazy-import to keep startup cost off the interactive ritual path
    # and to mirror the existing :func:`run_welcome` Phase 6 idiom of
    # treating ``triage_summary`` as a sibling module.
    import triage_summary  # noqa: I001

    out_fn = output_fn or default_output
    result = triage_summary.compute_summary(project_root)
    line = triage_summary.format_summary(result)
    out_fn(line)
    if write_history:
        history_path = project_root / triage_summary.SUMMARY_HISTORY_REL_PATH
        triage_summary.append_history(history_path, result, line)
    return line


def run_default_mode(
    project_root: Path,
    *,
    output_fn: Callable[[str], None] | None = None,
    write_history: bool = True,
) -> WelcomeOutcome:
    """Non-interactive default mode for ``task triage:welcome`` (#1309).

    Subsumes the prior session-start step of running
    ``task triage:summary`` plus a state-conditional first-time /
    incomplete-onboarding nudge so a fresh consumer sees one
    actionable line. The interactive 6-phase ritual now lives behind
    ``task triage:welcome --onboard`` (see :func:`run_cli`).

    No interactive prompts; the function never reads from stdin and is
    safe to invoke from any non-tty surface (CI, cloud agents, etc.).
    Always returns ``exit_code=0`` -- the default-mode surface is a
    status report, not a gate.
    """
    # Lazy-import the parent module so we can reach ``detect_prior_state``
    # / ``WelcomeOutcome`` without a module-load cycle (parent module
    # imports names from this file at top level; reverse direction MUST
    # be deferred).
    import triage_welcome  # noqa: I001

    out_fn = output_fn or default_output
    outcome = triage_welcome.WelcomeOutcome()
    outcome.phases_run.append(0)  # "phase 0" = default-mode summary
    emit_oneliner(project_root, output_fn=out_fn, write_history=write_history)
    state = triage_welcome.detect_prior_state(project_root)
    label, missing = _classify_onboarding(state)
    if label == "first-time":
        out_fn(FIRST_TIME_NUDGE)
    elif label == "incomplete":
        # Stable, deterministic ordering for the missing-piece list so
        # tests can pin the byte-shape across runs.
        joined = " + ".join(missing)
        out_fn(INCOMPLETE_NUDGE_TEMPLATE.format(missing=joined))
    # ``fully-set-up`` is silent -- the summary line alone is enough.
    outcome.exit_code = 0
    return outcome
