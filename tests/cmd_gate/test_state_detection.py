"""tests/cmd_gate/test_state_detection.py -- install-layout state detector + auto-prompt (#992 PR3).

Covers:
- ``_classify_install_layout`` correctly classifies states A/B/C/D and returns
  ``None`` for non-deft directories.
- ``_format_install_layout_prompt`` renders the canonical one-line prompt.
- ``_maybe_emit_install_layout_prompt`` emits the prompt on non-A states,
  stays silent on state A and undetectable directories, and NEVER mutates
  filesystem state.
- ``_agents_md_has_managed_markers`` correctly reads marker presence.
- Operator-consent contract: the detector NEVER auto-invokes ``task relocate``
  or otherwise wipes any directory.

The detector is the gate-side surface for the v0.27 relocator (PR2). State A
is the legacy ``deft/`` install (working today); B / C / D are the broken
post-installer states the relocator targets. The auto-prompt mirrors the
#884 ghx-install consent gate -- the prompt asks ``(Y/n)`` purely as a
visual consent affordance; the operator runs ``task relocate`` on consent.

Story: #992 PR3 (acceptance criterion ``992-ac-3-pr3-gate-prompt-upgrading-md``)
"""

from __future__ import annotations

from pathlib import Path

import pytest

# --- Helpers ----------------------------------------------------------------

# The marker open/close text is intentionally pinned in this test rather than
# imported from `run` so the test fails closed if a future PR re-bumps the
# marker without updating the layout-detector contract.
_MANAGED_OPEN_V2 = "<!-- deft:managed-section v2 -->"
_MANAGED_CLOSE = "<!-- /deft:managed-section -->"


def _make_state_a(project_root: Path) -> None:
    """State A: pure ``deft/`` (legacy install)."""
    (project_root / "deft").mkdir(parents=True, exist_ok=True)


def _make_state_b(project_root: Path) -> None:
    """State B: pure ``.deft/core/`` (canonical install)."""
    (project_root / ".deft" / "core").mkdir(parents=True, exist_ok=True)


def _make_state_c(project_root: Path) -> None:
    """State C: hybrid (both ``deft/`` and ``.deft/core/`` present)."""
    _make_state_a(project_root)
    _make_state_b(project_root)


def _make_state_d(project_root: Path) -> None:
    """State D: AGENTS.md only (no framework dir)."""
    agents_md = project_root / "AGENTS.md"
    agents_md.write_text(
        f"# AGENTS\n\n{_MANAGED_OPEN_V2}\n\nmanaged content\n\n{_MANAGED_CLOSE}\n",
        encoding="utf-8",
    )


def _snapshot_filesystem(root: Path) -> set[str]:
    """Return a stable snapshot of all filesystem entries under ``root``.

    Used to assert the detector never mutates filesystem state.
    """
    entries: set[str] = set()
    for child in root.rglob("*"):
        rel = child.relative_to(root).as_posix()
        kind = "d" if child.is_dir() else "f"
        if child.is_file():
            try:
                size = child.stat().st_size
            except OSError:
                size = -1
            entries.add(f"{kind}:{rel}:{size}")
        else:
            entries.add(f"{kind}:{rel}")
    return entries


# --- _classify_install_layout ------------------------------------------------


class TestClassifyInstallLayout:
    """Unit tests for ``_classify_install_layout`` (A / B / C / D / None)."""

    def test_state_a_pure_deft(self, tmp_path, deft_run_module):
        _make_state_a(tmp_path)
        assert deft_run_module._classify_install_layout(tmp_path) == "A"

    def test_state_b_pure_dotdeft_core(self, tmp_path, deft_run_module):
        _make_state_b(tmp_path)
        assert deft_run_module._classify_install_layout(tmp_path) == "B"

    def test_state_c_hybrid(self, tmp_path, deft_run_module):
        _make_state_c(tmp_path)
        assert deft_run_module._classify_install_layout(tmp_path) == "C"

    def test_state_d_agents_md_only(self, tmp_path, deft_run_module):
        _make_state_d(tmp_path)
        assert deft_run_module._classify_install_layout(tmp_path) == "D"

    def test_none_when_not_a_deft_project(self, tmp_path, deft_run_module):
        # Empty tmp_path: no deft/, no .deft/core/, no AGENTS.md.
        assert deft_run_module._classify_install_layout(tmp_path) is None

    def test_agents_md_without_markers_does_not_classify_d(
        self, tmp_path, deft_run_module
    ):
        # An AGENTS.md without managed-section markers is a legacy file --
        # the layout detector treats it as "not a deft project" so the
        # prompt does not fire on hand-rolled non-deft AGENTS.md content.
        (tmp_path / "AGENTS.md").write_text(
            "# AGENTS\n\nhand-rolled non-deft content\n", encoding="utf-8"
        )
        assert deft_run_module._classify_install_layout(tmp_path) is None

    def test_dotdeft_without_core_subdir_does_not_classify_b(
        self, tmp_path, deft_run_module
    ):
        # The detector specifically checks for ``.deft/core/`` -- a bare
        # ``.deft/`` (e.g. an unrelated tool's hidden dir) MUST NOT be
        # mistaken for a deft framework install.
        (tmp_path / ".deft").mkdir()
        assert deft_run_module._classify_install_layout(tmp_path) is None


# --- _agents_md_has_managed_markers ------------------------------------------


class TestAgentsMdHasManagedMarkers:
    """Marker-presence helper used by the layout detector for state D."""

    def test_returns_false_when_agents_md_absent(self, tmp_path, deft_run_module):
        assert deft_run_module._agents_md_has_managed_markers(tmp_path) is False

    def test_returns_false_when_markers_absent(self, tmp_path, deft_run_module):
        (tmp_path / "AGENTS.md").write_text("# AGENTS\nno markers\n", encoding="utf-8")
        assert deft_run_module._agents_md_has_managed_markers(tmp_path) is False

    def test_returns_true_when_markers_present(self, tmp_path, deft_run_module):
        _make_state_d(tmp_path)
        assert deft_run_module._agents_md_has_managed_markers(tmp_path) is True


# --- _format_install_layout_prompt -------------------------------------------


class TestFormatInstallLayoutPrompt:
    """Pin the canonical one-line prompt format."""

    @pytest.mark.parametrize(
        "state,description_substring",
        [
            ("B", "pure .deft/core/ canonical install"),
            ("C", "hybrid (deft/ + .deft/core/)"),
            ("D", "AGENTS.md only (partial install)"),
        ],
    )
    def test_format_carries_state_description_target_and_consent_marker(
        self, deft_run_module, state, description_substring
    ):
        line = deft_run_module._format_install_layout_prompt(state)
        # Single line, no embedded newlines.
        assert "\n" not in line
        # Carries the canonical structured prefix.
        assert line.startswith(f"[deft] install layout state: {state} (")
        # Carries the per-state description.
        assert description_substring in line
        # Surfaces the canonical relocate target string verbatim.
        assert ".deft/core/run relocate" in line
        # Visual consent affordance is intact.
        assert line.endswith("(Y/n)")


# --- _maybe_emit_install_layout_prompt ---------------------------------------


class TestMaybeEmitInstallLayoutPrompt:
    """Behaviour contract for the gate-side prompt emission helper."""

    @pytest.mark.parametrize(
        "factory,expected_state",
        [
            (_make_state_b, "B"),
            (_make_state_c, "C"),
            (_make_state_d, "D"),
        ],
    )
    def test_emits_prompt_on_non_a_states(
        self, tmp_path, deft_run_module, capsys, factory, expected_state
    ):
        factory(tmp_path)
        result = deft_run_module._maybe_emit_install_layout_prompt(tmp_path)
        captured = capsys.readouterr()
        assert result is not None, (
            "Expected a prompt string for non-A state but got None"
        )
        # Returned string is what landed on stdout (modulo trailing newline).
        assert result in captured.out
        assert f"[deft] install layout state: {expected_state}" in captured.out
        # The canonical relocate target is surfaced verbatim.
        assert ".deft/core/run relocate" in captured.out
        # Visual consent affordance.
        assert "(Y/n)" in captured.out

    def test_stays_silent_on_state_a(self, tmp_path, deft_run_module, capsys):
        _make_state_a(tmp_path)
        result = deft_run_module._maybe_emit_install_layout_prompt(tmp_path)
        captured = capsys.readouterr()
        assert result is None
        assert captured.out == ""

    def test_stays_silent_when_not_a_deft_project(
        self, tmp_path, deft_run_module, capsys
    ):
        # No framework dir, no managed AGENTS.md.
        result = deft_run_module._maybe_emit_install_layout_prompt(tmp_path)
        captured = capsys.readouterr()
        assert result is None
        assert captured.out == ""


# --- Read-only contract ------------------------------------------------------


class TestDetectorIsReadOnly:
    """The detector MUST NOT mutate filesystem state on any code path."""

    @pytest.mark.parametrize(
        "factory",
        [_make_state_a, _make_state_b, _make_state_c, _make_state_d],
    )
    def test_classify_does_not_mutate(self, tmp_path, deft_run_module, factory):
        factory(tmp_path)
        before = _snapshot_filesystem(tmp_path)
        deft_run_module._classify_install_layout(tmp_path)
        after = _snapshot_filesystem(tmp_path)
        assert before == after, (
            "_classify_install_layout mutated filesystem state -- "
            "the detector is contractually read-only."
        )

    @pytest.mark.parametrize(
        "factory",
        [_make_state_a, _make_state_b, _make_state_c, _make_state_d],
    )
    def test_emit_prompt_does_not_mutate(self, tmp_path, deft_run_module, factory):
        factory(tmp_path)
        before = _snapshot_filesystem(tmp_path)
        deft_run_module._maybe_emit_install_layout_prompt(tmp_path)
        after = _snapshot_filesystem(tmp_path)
        assert before == after, (
            "_maybe_emit_install_layout_prompt mutated filesystem state -- "
            "auto-prompt MUST NEVER auto-wipe; operator consent required."
        )


# --- Operator-consent contract -----------------------------------------------


class TestOperatorConsentContract:
    """The gate NEVER invokes ``task relocate`` automatically.

    Mirrors the #884 ghx-install consent gate convention: the prompt asks
    ``(Y/n)`` but the gate itself NEVER acts on the answer. The operator
    runs ``task relocate`` (or ``.deft/core/run relocate``) explicitly.
    """

    def test_prompt_does_not_invoke_subprocess(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        """A poisoned subprocess.run / Popen MUST NOT be called by the
        detector or the prompt-emission helper."""
        import subprocess as _subprocess

        called: list[tuple] = []

        def _poisoned_run(*args, **kwargs):
            called.append(("run", args, kwargs))
            raise AssertionError(
                "subprocess.run invoked from install-layout detector -- "
                "auto-prompt MUST NEVER auto-execute task relocate"
            )

        def _poisoned_popen(*args, **kwargs):
            called.append(("Popen", args, kwargs))
            raise AssertionError(
                "subprocess.Popen invoked from install-layout detector -- "
                "auto-prompt MUST NEVER auto-execute task relocate"
            )

        monkeypatch.setattr(_subprocess, "run", _poisoned_run)
        monkeypatch.setattr(_subprocess, "Popen", _poisoned_popen)

        # Exercise every non-A state -- none of them may shell out.
        for factory in (_make_state_b, _make_state_c, _make_state_d):
            sub_root = tmp_path / f"state-{factory.__name__}"
            sub_root.mkdir()
            factory(sub_root)
            deft_run_module._maybe_emit_install_layout_prompt(sub_root)

        assert called == [], (
            "Detector or prompt emission shelled out to subprocess; "
            "operator-consent contract violated"
        )

    def test_prompt_does_not_invoke_read_yn(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        """The auto-prompt is informational -- it MUST NOT call the
        interactive ``read_yn`` / ``ask_confirm`` helpers and turn itself
        into a blocking gate."""
        called: list[tuple] = []

        def _poisoned_read_yn(*args, **kwargs):
            called.append(("read_yn", args, kwargs))
            raise AssertionError(
                "read_yn invoked from install-layout detector -- "
                "auto-prompt MUST stay informational, never blocking"
            )

        # Both legacy + canonical names are patched so a future rename of
        # the module-level alias does not silently weaken this test.
        for name in ("read_yn", "ask_confirm"):
            if hasattr(deft_run_module, name):
                monkeypatch.setattr(deft_run_module, name, _poisoned_read_yn)

        _make_state_b(tmp_path)
        deft_run_module._maybe_emit_install_layout_prompt(tmp_path)

        assert called == [], (
            "Auto-prompt invoked an interactive confirm helper -- "
            "the prompt is informational only"
        )
