"""test_deprecated_skill_redirects.py -- Tests for #411 v0.19 -> v0.20 bridge
deprecation redirect stubs, UPGRADING.md, README upgrade banner, QUICK-START.md
upgrade detection, and template/setup.go agents-entry fallback rule.

Story: #411 (swarm-402)

These tests ensure that:
- The 8 legacy skills/deft-* paths that v0.19 AGENTS.md may reference each
  contain a small deprecation redirect stub pointing at deft/QUICK-START.md,
  so stale references never dead-end. "Accidental cleanup" (deleting what
  looks like an obsolete skill dir) will break these tests and surface the
  contract explicitly.
- UPGRADING.md exists at the repo root with a v0.20.0 section.
- README.md has a permanent upgrade banner.
- QUICK-START.md has the new upgrade-detection Step 2 and the session-restart
  instruction.
- templates/agents-entry.md (and its Go installer mirror) carry the fallback
  rule that sends agents to QUICK-START.md when a deft/skills/ path is
  unreadable.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]

# Old-name -> new-name mapping mirrored from the issue #411 body.
_REDIRECT_STUBS: list[tuple[str, str]] = [
    ("deft-sync", "deft-directive-sync"),
    ("deft-setup", "deft-directive-setup"),
    ("deft-build", "deft-directive-build"),
    ("deft-review-cycle", "deft-directive-review-cycle"),
    ("deft-roadmap-refresh", "deft-directive-refinement"),
    ("deft-swarm", "deft-directive-swarm"),
    ("deft-pre-pr", "deft-directive-pre-pr"),
    ("deft-interview", "deft-directive-interview"),
]

_STUB_SENTINEL = "<!-- deft:deprecated-skill-redirect -->"
_QUICKSTART_REDIRECT_PHRASE = "deft/QUICK-START.md"


# ---------------------------------------------------------------------------
# 1. Deprecation redirect stub content
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "old_name,new_name",
    _REDIRECT_STUBS,
    ids=[old for old, _ in _REDIRECT_STUBS],
)
class TestDeprecationRedirectStubs:
    """Each legacy skills/deft-*/SKILL.md must exist and redirect to QUICK-START."""

    def test_stub_file_exists(self, old_name: str, new_name: str) -> None:
        path = _REPO_ROOT / "skills" / old_name / "SKILL.md"
        assert path.is_file(), (
            f"skills/{old_name}/SKILL.md missing -- this stub is part of the "
            f"v0.19 -> v0.20 bridge (#411). Accidental cleanup would break "
            f"stale AGENTS.md references."
        )

    def test_stub_has_sentinel(self, old_name: str, new_name: str) -> None:
        path = _REPO_ROOT / "skills" / old_name / "SKILL.md"
        content = path.read_text(encoding="utf-8")
        assert _STUB_SENTINEL in content, (
            f"skills/{old_name}/SKILL.md is missing the {_STUB_SENTINEL!r} "
            f"sentinel that identifies it as a deprecation redirect stub (#411)."
        )
        # QUICK-START Step 2b scans the first 200 characters for the sentinel
        # (matching the window used for the main deprecation-redirect check on
        # SPECIFICATION.md / PROJECT.md in Step 2c).  The sentinel must live
        # within that window on every stub this repo ships; an earlier shape
        # that placed a heading first and pushed the sentinel past 200 chars
        # would silently defeat upgrade detection for fully-migrated v0.19
        # projects.
        assert _STUB_SENTINEL in content[:200], (
            f"skills/{old_name}/SKILL.md sentinel must appear in the first 200 "
            f"characters so QUICK-START Step 2b can detect the stub (#411)."
        )

    def test_stub_points_at_quickstart(self, old_name: str, new_name: str) -> None:
        path = _REPO_ROOT / "skills" / old_name / "SKILL.md"
        content = path.read_text(encoding="utf-8")
        assert _QUICKSTART_REDIRECT_PHRASE in content, (
            f"skills/{old_name}/SKILL.md must point agents at "
            f"{_QUICKSTART_REDIRECT_PHRASE} (the current routing surface)."
        )

    def test_stub_names_replacement_skill(self, old_name: str, new_name: str) -> None:
        path = _REPO_ROOT / "skills" / old_name / "SKILL.md"
        content = path.read_text(encoding="utf-8")
        assert new_name in content, (
            f"skills/{old_name}/SKILL.md should mention its current replacement "
            f"skill name ({new_name}) so agents can manually route if QUICK-START "
            f"is also unreachable."
        )


def test_no_extra_bare_deft_redirect_stubs() -> None:
    """No additional bare deft-* directories beyond the 8 v0.19 bridge stubs."""
    skills_dir = _REPO_ROOT / "skills"
    known = {old for old, _ in _REDIRECT_STUBS}
    found = {
        d.name
        for d in skills_dir.iterdir()
        if d.is_dir()
        and d.name.startswith("deft-")
        and not d.name.startswith("deft-directive-")
    }
    unexpected = found - known
    assert not unexpected, (
        f"skills/ has unexpected bare deft-* directories: {sorted(unexpected)}. "
        f"If these are new redirect stubs, add them to _REDIRECT_STUBS in "
        f"tests/content/test_deprecated_skill_redirects.py."
    )


# ---------------------------------------------------------------------------
# 2. UPGRADING.md at repo root
# ---------------------------------------------------------------------------


class TestUpgradingDoc:
    """UPGRADING.md must exist at the repo root with the v0.20.0 section."""

    PATH = _REPO_ROOT / "UPGRADING.md"

    def test_exists(self) -> None:
        assert self.PATH.is_file(), "UPGRADING.md missing at repo root (#411)"

    def test_has_v020_section(self) -> None:
        content = self.PATH.read_text(encoding="utf-8")
        # The section heading shape is "## From any pre-v0.20 version -> v0.20.0"
        # or similar; we check for both the version tag and a section marker.
        assert "v0.20.0" in content, "UPGRADING.md missing v0.20.0 reference"
        assert "## From" in content, (
            "UPGRADING.md missing version-section heading ('## From <prev> -> <new>')"
        )

    def test_points_at_quickstart(self) -> None:
        content = self.PATH.read_text(encoding="utf-8")
        assert "QUICK-START.md" in content, (
            "UPGRADING.md must direct users to QUICK-START.md as the action."
        )

    def test_points_at_brownfield(self) -> None:
        content = self.PATH.read_text(encoding="utf-8")
        assert "docs/BROWNFIELD.md" in content, (
            "UPGRADING.md must cross-reference docs/BROWNFIELD.md."
        )

    def test_mentions_task_migrate(self) -> None:
        content = self.PATH.read_text(encoding="utf-8")
        assert "task migrate:vbrief" in content, (
            "UPGRADING.md must mention `task migrate:vbrief` for the v0.20 upgrade."
        )

    def test_mentions_run_upgrade(self) -> None:
        content = self.PATH.read_text(encoding="utf-8")
        assert "deft/run upgrade" in content, (
            "UPGRADING.md must mention `deft/run upgrade` (CLI marker writer)."
        )

    def test_instructs_new_session(self) -> None:
        content = self.PATH.read_text(encoding="utf-8").lower()
        assert "new agent session" in content or "new session" in content, (
            "UPGRADING.md must tell users / agents to start a new agent session "
            "after the upgrade to avoid stale context."
        )


# ---------------------------------------------------------------------------
# 3. README upgrade banner
# ---------------------------------------------------------------------------


def test_readme_has_upgrade_banner() -> None:
    """README.md must have a permanent upgrade banner pointing at UPGRADING.md."""
    content = (_REPO_ROOT / "README.md").read_text(encoding="utf-8")
    assert "UPGRADING.md" in content, (
        "README.md must mention UPGRADING.md so existing users see the upgrade "
        "path on a repo browse (#411)."
    )


def test_readme_banner_has_agent_rule() -> None:
    """README banner must include an agent-directed `!` rule."""
    content = (_REPO_ROOT / "README.md").read_text(encoding="utf-8")
    # The banner sits near the top; we look for the two-line ! pattern.
    assert "Read [UPGRADING.md]" in content or "Read UPGRADING.md" in content, (
        "README.md upgrade banner must explicitly direct agents to read "
        "UPGRADING.md on the first session after a framework update."
    )


# ---------------------------------------------------------------------------
# 4. QUICK-START.md upgrade detection + session restart
# ---------------------------------------------------------------------------


class TestQuickStartUpgradeDetection:
    """QUICK-START.md must have upgrade detection and session-restart instructions."""

    PATH = _REPO_ROOT / "QUICK-START.md"

    def _content(self) -> str:
        return self.PATH.read_text(encoding="utf-8")

    def test_detects_stale_agents_md(self) -> None:
        content = self._content()
        assert "stale" in content.lower(), (
            "QUICK-START.md must detect and handle a stale AGENTS.md (#411)."
        )
        assert "deft/skills/" in content, (
            "QUICK-START.md must mention parsing deft/skills/ paths for staleness."
        )

    def test_detects_pre_cutover_artifacts(self) -> None:
        content = self._content()
        assert "pre-cutover" in content.lower() or "pre-v0.20" in content.lower(), (
            "QUICK-START.md must detect pre-cutover / pre-v0.20 artifacts."
        )
        assert "SPECIFICATION.md" in content and "PROJECT.md" in content, (
            "QUICK-START.md must name SPECIFICATION.md and PROJECT.md as the "
            "legacy artifacts it checks for the sentinel."
        )
        assert "deft:deprecated-redirect" in content, (
            "QUICK-START.md must reference the deprecation redirect sentinel "
            "string used by the validator."
        )

    def test_references_task_migrate(self) -> None:
        content = self._content()
        assert "task migrate:vbrief" in content, (
            "QUICK-START.md must reference `task migrate:vbrief` in the "
            "pre-cutover case."
        )

    def test_partial_migration_case(self) -> None:
        content = self._content()
        assert "partial" in content.lower(), (
            "QUICK-START.md must handle partial migration state (vbrief/ exists "
            "but a lifecycle folder is missing)."
        )

    def test_session_restart_instruction(self) -> None:
        content = self._content()
        # Any of these phrases indicates the restart gate.
        phrases = [
            "Start a new agent session",
            "start a new agent session",
            "new agent session",
        ]
        assert any(p in content for p in phrases), (
            "QUICK-START.md must explicitly instruct users to start a new "
            "agent session after rewriting AGENTS.md or running migration "
            "(#411 item 4)."
        )

    def test_brownfield_cross_reference(self) -> None:
        content = self._content()
        assert "docs/BROWNFIELD.md" in content, (
            "QUICK-START.md must cross-reference docs/BROWNFIELD.md."
        )

    def test_upgrading_cross_reference(self) -> None:
        content = self._content()
        assert "UPGRADING.md" in content, (
            "QUICK-START.md must cross-reference UPGRADING.md."
        )


# ---------------------------------------------------------------------------
# 5. Template + Go installer agents-entry fallback rule
# ---------------------------------------------------------------------------


class TestAgentsEntryFallbackRule:
    """templates/agents-entry.md and setup.go agentsMDEntry must carry the
    fallback rule that redirects agents to QUICK-START.md when a deft/skills/
    path is unreadable (#411 item 2)."""

    TEMPLATE = _REPO_ROOT / "templates" / "agents-entry.md"
    SETUP_GO = _REPO_ROOT / "cmd" / "deft-install" / "setup.go"

    def test_template_has_fallback_rule(self) -> None:
        content = self.TEMPLATE.read_text(encoding="utf-8")
        assert "deft/skills/" in content, (
            "templates/agents-entry.md must mention deft/skills/ in the "
            "fallback rule."
        )
        assert "deft/QUICK-START.md" in content, (
            "templates/agents-entry.md must tell agents to read "
            "deft/QUICK-START.md when a skill path is unreadable."
        )
        assert "cannot be read" in content, (
            "templates/agents-entry.md fallback rule must spell out the "
            "trigger condition (path cannot be read)."
        )

    def test_setup_go_has_fallback_rule(self) -> None:
        """The fallback rule lives in templates/agents-entry.md (the single
        canonical source embedded via //go:embed) rather than a hardcoded
        literal in setup.go (#636). Assert that setup.go sources from the
        templates package and that the template carries the fallback rule.
        """
        content = self.SETUP_GO.read_text(encoding="utf-8")
        assert "templates.AgentsEntry" in content, (
            "cmd/deft-install/setup.go must source agentsMDEntry from "
            "templates.AgentsEntry (//go:embed templates/agents-entry.md) (#636)."
        )
        assert "agentsMDEntry = `" not in content, (
            "cmd/deft-install/setup.go reintroduced a hardcoded raw-string "
            "AGENTS.md body -- the fallback rule must live in "
            "templates/agents-entry.md only (#636)."
        )
        # Assert the fallback rule exists in the canonical template, which
        # IS the body the installer writes into consumer AGENTS.md.
        template = self.TEMPLATE.read_text(encoding="utf-8")
        assert "deft/skills/" in template, (
            "templates/agents-entry.md must carry the fallback rule "
            "(mentions deft/skills/)."
        )
        assert "deft/QUICK-START.md" in template, (
            "templates/agents-entry.md fallback rule must point at "
            "deft/QUICK-START.md."
        )
