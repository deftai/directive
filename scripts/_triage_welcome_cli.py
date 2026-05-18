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
from typing import Any

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
            "Run the `task triage:welcome` 6-phase onboarding ritual "
            "(#1143). Idempotent -- re-run after a partial completion "
            "to resume cleanly."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=os.environ.get("DEFT_PROJECT_ROOT", "."),
        help="Consumer project root (default: $DEFT_PROJECT_ROOT or cwd).",
    )
    parser.add_argument(
        "--no-subprocess",
        action="store_true",
        help=(
            "Skip the `task triage:bootstrap` / `scope:demote` / "
            "`triage:summary` subprocess hops. Test-mode flag; never set "
            "in production runs."
        ),
    )
    return parser


def run_cli(argv: list[str] | None, tw_module: Any) -> int:
    """Dispatch ``triage_welcome`` CLI args using ``tw_module`` backend.

    ``tw_module`` is the parent :mod:`triage_welcome` module; passed
    explicitly to avoid a circular import at module-load time.
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
    outcome = tw_module.run_welcome(
        project_root,
        run_subprocess=not args.no_subprocess,
    )
    return outcome.exit_code
