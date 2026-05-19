"""Tests for scripts/triage_help.py (#1150 / N10 of #1119).

Covers the acceptance criteria in the issue body:

* Bare ``task triage`` output format (category renderer + ordering).
* Bare ``task scope`` output format.
* ``--help`` on representative verbs prints structured help (description,
  flags, examples, cross-refs).
* Unknown-verb ``--help`` error path -- the CLI dispatcher rejects
  unmapped verb names with a clear actionable message.
* Registry shape invariants (every category-listed verb is registered;
  every script-to-subcommand mapping maps to a real registry entry).

The tests are hermetic: ``triage_help`` is imported directly via
``importlib`` so failures surface as Python exceptions in the test
report and we never shell out to ``uv run`` (mirrors the
``test_triage_summary.py`` pattern).
"""

from __future__ import annotations

import importlib
import io
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_help = importlib.import_module("triage_help")


# ---------------------------------------------------------------------------
# Registry invariants
# ---------------------------------------------------------------------------


def test_registry_is_non_empty_and_dictlike() -> None:
    assert isinstance(triage_help.REGISTRY, dict)
    assert len(triage_help.REGISTRY) >= 30, (
        "registry should cover the full triage:* + scope:* verb space"
    )


def test_every_category_entry_resolves_to_a_registered_verb() -> None:
    for label, verbs in triage_help.CATEGORIES_TRIAGE:
        for verb in verbs:
            assert verb in triage_help.REGISTRY, (
                f"triage category {label!r} lists unregistered verb {verb!r}"
            )
    for label, verbs in triage_help.CATEGORIES_SCOPE:
        for verb in verbs:
            assert verb in triage_help.REGISTRY, (
                f"scope category {label!r} lists unregistered verb {verb!r}"
            )


def test_script_subcommand_map_targets_are_registered() -> None:
    for script, sub_map in triage_help.SCRIPT_SUBCOMMAND_MAP.items():
        for subcommand, verb in sub_map.items():
            assert verb in triage_help.REGISTRY, (
                f"SCRIPT_SUBCOMMAND_MAP[{script!r}][{subcommand!r}] "
                f"-> {verb!r} is not in REGISTRY"
            )


def test_verb_help_dataclass_shape() -> None:
    sample = triage_help.REGISTRY["task triage:queue"]
    assert sample.name == "task triage:queue"
    assert sample.summary
    assert sample.refs
    assert sample.description
    assert sample.usage
    assert len(sample.flags) >= 1
    assert all(len(triple) == 3 for triple in sample.flags)
    assert len(sample.examples) >= 1
    assert len(sample.see_also) >= 1
    assert sample.placeholder is False


def test_placeholder_entries_carry_the_flag() -> None:
    placeholder = triage_help.REGISTRY["task triage:metrics"]
    assert placeholder.placeholder is True
    assert "coming" in placeholder.refs.lower()


# ---------------------------------------------------------------------------
# Bare-invocation category renderers
# ---------------------------------------------------------------------------


def test_render_category_list_triage_contains_required_sections() -> None:
    output = triage_help.render_category_list("triage")
    # Category labels documented in the issue body.
    for label in (
        "Session-start:",
        "State verbs (mutate audit log):",
        "Read verbs:",
        "Lifecycle:",
        "Subscription mutation:",
        "Archive / rotation:",
    ):
        assert label in output, f"missing section {label!r} in bare triage output"
    # A handful of canonical verbs MUST appear.
    assert "task triage:summary" in output
    assert "task triage:queue" in output
    assert "task triage:subscribe" in output
    # Placeholder verbs surface in the catalog.
    assert "task triage:metrics" in output


def test_render_category_list_scope_contains_required_sections() -> None:
    output = triage_help.render_category_list("scope")
    for label in ("Promote / demote:", "Activate / complete:", "Reversibility:"):
        assert label in output, f"missing section {label!r} in bare scope output"
    assert "task scope:promote" in output
    assert "task scope:demote" in output
    assert "task scope:undo" in output


def test_render_category_list_rejects_unknown_category() -> None:
    with pytest.raises(ValueError):
        triage_help.render_category_list("typo")


def test_session_start_section_orders_summary_before_cache_fresh() -> None:
    output = triage_help.render_category_list("triage")
    summary_idx = output.index("task triage:summary")
    cache_fresh_idx = output.index("task verify:cache-fresh")
    assert summary_idx < cache_fresh_idx


# ---------------------------------------------------------------------------
# Per-verb structured help
# ---------------------------------------------------------------------------


def _assert_structured_help(output: str, verb: str) -> None:
    """Helper -- assert the standard four sections appear in ``output``."""
    assert output.startswith(verb)
    assert "Usage:" in output
    assert "Flags:" in output
    assert "Examples:" in output
    assert "See also:" in output


def test_render_verb_help_triage_queue() -> None:
    output = triage_help.render_verb_help("task triage:queue")
    _assert_structured_help(output, "task triage:queue")
    assert "--limit" in output
    assert "task triage:queue --help" not in output  # not part of body
    # Cross-refs include the umbrella ID and sibling verbs.
    assert "#1119 / D11" in output


def test_render_verb_help_triage_defer_includes_resume_on() -> None:
    output = triage_help.render_verb_help("task triage:defer")
    _assert_structured_help(output, "task triage:defer")
    assert "--resume-on" in output
    assert "D3" in output


def test_render_verb_help_scope_promote() -> None:
    output = triage_help.render_verb_help("task scope:promote")
    _assert_structured_help(output, "task scope:promote")
    assert "--from-issue" in output
    assert "task scope:demote" in output


def test_render_verb_help_scope_demote() -> None:
    output = triage_help.render_verb_help("task scope:demote")
    _assert_structured_help(output, "task scope:demote")
    assert "--batch" in output
    assert "--older-than-days" in output
    assert "D1" in output


def test_render_verb_help_placeholder_includes_not_yet_marker() -> None:
    output = triage_help.render_verb_help("task triage:audit:prune")
    assert "not yet implemented" in output
    assert "D19" in output


def test_render_verb_help_rejects_unknown_verb() -> None:
    with pytest.raises(KeyError):
        triage_help.render_verb_help("task triage:does-not-exist")


# ---------------------------------------------------------------------------
# intercept_help() shim used by verb scripts' main()
# ---------------------------------------------------------------------------


def test_intercept_help_returns_none_when_no_flag_present() -> None:
    assert triage_help.intercept_help("triage_queue", ["queue", "--limit", "5"]) is None


def test_intercept_help_returns_zero_and_prints_for_multi_subcommand_script() -> None:
    sink = io.StringIO()
    rc = triage_help.intercept_help(
        "triage_actions", ["defer", "--issue", "42", "--help"], out=sink
    )
    assert rc == 0
    rendered = sink.getvalue()
    assert rendered.startswith("task triage:defer")
    assert "Usage:" in rendered


def test_intercept_help_returns_zero_for_single_verb_script() -> None:
    sink = io.StringIO()
    rc = triage_help.intercept_help("triage_summary", ["--help"], out=sink)
    assert rc == 0
    assert "task triage:summary" in sink.getvalue()


def test_intercept_help_handles_short_help_flag() -> None:
    sink = io.StringIO()
    rc = triage_help.intercept_help("triage_queue", ["queue", "-h"], out=sink)
    assert rc == 0
    assert "task triage:queue" in sink.getvalue()


def test_intercept_help_unmapped_script_returns_none() -> None:
    # Scripts outside our registry (e.g. unrelated verb) should NOT have
    # their --help swallowed -- they keep their argparse default.
    sink = io.StringIO()
    rc = triage_help.intercept_help("some_other_script", ["--help"], out=sink)
    assert rc is None
    assert sink.getvalue() == ""


def test_intercept_help_multi_subcommand_no_match_falls_to_default_or_none() -> None:
    # ``triage_actions`` has no __default__, so no positional match means
    # the shim hands control back to argparse.
    sink = io.StringIO()
    rc = triage_help.intercept_help(
        "triage_actions", ["--help"], out=sink
    )
    assert rc is None
    assert sink.getvalue() == ""


# ---------------------------------------------------------------------------
# CLI dispatcher (python -m scripts.triage_help ...)
# ---------------------------------------------------------------------------


def _run_main(argv: list[str], capsys: pytest.CaptureFixture[str]) -> tuple[int, str, str]:
    rc = triage_help.main(argv)
    captured = capsys.readouterr()
    return rc, captured.out, captured.err


def test_cli_triage_prints_category_list(capsys: pytest.CaptureFixture[str]) -> None:
    rc, out, _err = _run_main(["triage"], capsys)
    assert rc == 0
    assert "Session-start:" in out
    assert "Subscription mutation:" in out


def test_cli_scope_prints_category_list(capsys: pytest.CaptureFixture[str]) -> None:
    rc, out, _err = _run_main(["scope"], capsys)
    assert rc == 0
    assert "Promote / demote:" in out


def test_cli_help_for_verb_prints_structured_help(
    capsys: pytest.CaptureFixture[str],
) -> None:
    rc, out, _err = _run_main(["help", "triage:queue"], capsys)
    assert rc == 0
    assert "task triage:queue" in out
    assert "Usage:" in out


def test_cli_help_for_verb_accepts_task_prefix(
    capsys: pytest.CaptureFixture[str],
) -> None:
    rc, out, _err = _run_main(["help", "task triage:queue"], capsys)
    assert rc == 0
    assert "task triage:queue" in out


def test_cli_unknown_verb_rejected_with_clear_error(
    capsys: pytest.CaptureFixture[str],
) -> None:
    rc, _out, err = _run_main(["help", "triage:does-not-exist"], capsys)
    assert rc == 2
    assert "unknown verb" in err
    assert "list" in err  # the error suggests running `list`


def test_cli_missing_verb_argument_emits_usage(
    capsys: pytest.CaptureFixture[str],
) -> None:
    rc, _out, err = _run_main(["help"], capsys)
    assert rc == 2
    assert "missing <verb>" in err


def test_cli_unknown_command_emits_usage(
    capsys: pytest.CaptureFixture[str],
) -> None:
    rc, _out, err = _run_main(["typo"], capsys)
    assert rc == 2
    assert "unknown command" in err


def test_cli_list_dumps_every_registered_verb(
    capsys: pytest.CaptureFixture[str],
) -> None:
    rc, out, _err = _run_main(["list"], capsys)
    assert rc == 0
    listed = {line.split(" [")[0] for line in out.strip().splitlines() if line.strip()}
    assert listed == set(triage_help.REGISTRY.keys())
    # Placeholder entries carry the `[coming]` tag.
    assert "[coming]" in out


def test_cli_no_args_emits_usage_to_stderr(
    capsys: pytest.CaptureFixture[str],
) -> None:
    rc, _out, err = _run_main([], capsys)
    assert rc == 2
    assert "usage:" in err
