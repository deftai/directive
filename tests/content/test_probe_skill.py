"""Deterministic content tests for the deft-directive-probe skill (#1518).

Pins probe skill structure, first-turn contract, no-artifact guard, and
AGENTS.md / template routing so a future edit that drops interrogation
discipline or premature-artifact prohibitions fails CI immediately.

Refs:
  - #1518 (Composer-facing probe skill)
  - strategies/probe.md (source contract)
"""

from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_PROBE_PATH = "skills/deft-directive-probe/SKILL.md"
_AGENTS_MD = "AGENTS.md"
_TEMPLATE = "templates/agents-entry.md"

_MAX_SKILL_LINES = 150

_REQUIRED_TRIGGERS = (
    "run probe",
    "/deft:run:probe",
    "probe",
)


def _read(rel_path: str) -> str:
    return (_REPO_ROOT / rel_path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. File exists, size cap, frontmatter, legend
# ---------------------------------------------------------------------------


def test_probe_skill_exists() -> None:
    """The canonical probe skill body MUST exist at the conventional path (#1518)."""
    assert (_REPO_ROOT / _PROBE_PATH).is_file(), (
        f"Skill file missing: {_PROBE_PATH} (#1518)"
    )


def test_probe_skill_size_cap() -> None:
    """Skill MUST be at-or-under the 150-line write-skill convention (#1518)."""
    line_count = len(_read(_PROBE_PATH).splitlines())
    assert line_count <= _MAX_SKILL_LINES, (
        f"{_PROBE_PATH}: {line_count} lines exceeds the "
        f"{_MAX_SKILL_LINES}-line deft-directive-write-skill convention (#1518)"
    )


def test_probe_skill_frontmatter_name() -> None:
    """Frontmatter MUST carry the canonical skill name."""
    text = _read(_PROBE_PATH)
    assert text.startswith("---"), (
        f"{_PROBE_PATH}: must start with YAML frontmatter"
    )
    assert "name: deft-directive-probe" in text, (
        f"{_PROBE_PATH}: frontmatter must declare name: deft-directive-probe"
    )


def test_probe_skill_rfc2119_legend() -> None:
    """Skill MUST carry the RFC2119 legend line used by every directive skill."""
    text = _read(_PROBE_PATH)
    assert "!=MUST, ~=SHOULD" in text, (
        f"{_PROBE_PATH}: missing RFC2119 legend"
    )


def test_probe_skill_triggers_present() -> None:
    """Canonical probe triggers MUST appear in frontmatter (#1518)."""
    text = _read(_PROBE_PATH)
    parts = text.split("---", 2)
    assert len(parts) >= 3, f"{_PROBE_PATH}: malformed frontmatter"
    frontmatter = parts[1]
    missing = [t for t in _REQUIRED_TRIGGERS if t not in frontmatter]
    assert not missing, (
        f"{_PROBE_PATH}: frontmatter missing required triggers: {missing!r} (#1518)"
    )


# ---------------------------------------------------------------------------
# 2. First-turn contract -- one question, recommended answer, no batching
# ---------------------------------------------------------------------------


def test_probe_skill_first_turn_one_question_rule() -> None:
    """First user-facing probe turn MUST require exactly one focused question (#1518)."""
    text = _read(_PROBE_PATH)
    assert "First-turn contract" in text or "first user-facing probe turn" in text.lower(), (
        f"{_PROBE_PATH}: must document an explicit first-turn contract (#1518)"
    )
    assert "ONE" in text and "focused question" in text, (
        f"{_PROBE_PATH}: must require one focused question per turn (#1518)"
    )


def test_probe_skill_first_turn_recommended_answer() -> None:
    """Each probe question MUST include a recommended answer (#1518)."""
    text = _read(_PROBE_PATH)
    assert "recommended answer" in text.lower(), (
        f"{_PROBE_PATH}: must require a recommended answer with each question (#1518)"
    )


def test_probe_skill_forbids_batched_decisions() -> None:
    """Probe MUST forbid batched decision lists in a single turn (#1518)."""
    text = _read(_PROBE_PATH)
    assert "batched decision" in text.lower() or "multiple questions" in text.lower(), (
        f"{_PROBE_PATH}: must forbid batched decision lists / multiple questions (#1518)"
    )


# ---------------------------------------------------------------------------
# 3. No-artifact guard before completion
# ---------------------------------------------------------------------------


def test_probe_skill_no_artifact_guard_section() -> None:
    """Skill MUST carry an explicit no-artifact guard while probe is incomplete (#1518)."""
    text = _read(_PROBE_PATH)
    assert "No-Artifact Guard" in text or "no-artifact" in text.lower(), (
        f"{_PROBE_PATH}: must document a no-artifact guard (#1518)"
    )


def test_probe_skill_forbids_premature_vbrief_writes() -> None:
    """Incomplete probe sessions MUST NOT write vBRIEF artifacts (#1518)."""
    text = _read(_PROBE_PATH)
    guard_region = text.split("## Output", 1)[0]
    assert "vbrief" in guard_region.lower(), (
        f"{_PROBE_PATH}: no-artifact guard must forbid vBRIEF writes before completion (#1518)"
    )
    assert "\u2297" in guard_region or "MUST NOT" in guard_region, (
        f"{_PROBE_PATH}: guard must use explicit prohibition markers (#1518)"
    )


def test_probe_skill_forbids_premature_plan_updates() -> None:
    """Incomplete probe sessions MUST NOT update plan.vbrief.json (#1518)."""
    text = _read(_PROBE_PATH)
    guard_region = text.split("## Output", 1)[0]
    assert "plan.vbrief.json" in guard_region, (
        f"{_PROBE_PATH}: no-artifact guard must forbid plan updates before completion (#1518)"
    )


def test_probe_skill_forbids_premature_github_comments() -> None:
    """Incomplete probe sessions MUST NOT post GitHub completion comments (#1518)."""
    text = _read(_PROBE_PATH)
    guard_region = text.split("## Output", 1)[0]
    assert "github" in guard_region.lower(), (
        f"{_PROBE_PATH}: no-artifact guard must forbid GitHub completion actions (#1518)"
    )


# ---------------------------------------------------------------------------
# 4. AGENTS.md and template routing
# ---------------------------------------------------------------------------


def test_agents_md_probe_routing_entry() -> None:
    """AGENTS.md Skill Routing MUST map probe triggers to deft-directive-probe (#1518)."""
    text = _read(_AGENTS_MD)
    assert "skills/deft-directive-probe/SKILL.md" in text, (
        "AGENTS.md: missing routing entry for skills/deft-directive-probe/SKILL.md (#1518)"
    )
    assert '"run probe"' in text or '"/deft:run:probe"' in text, (
        "AGENTS.md: probe routing must list 'run probe' or '/deft:run:probe' (#1518)"
    )


def test_agents_entry_template_probe_routing_entry() -> None:
    """Consumer template MUST map probe triggers to deft-directive-probe (#1518)."""
    text = _read(_TEMPLATE)
    assert "deft-directive-probe/SKILL.md" in text, (
        "templates/agents-entry.md: missing probe routing entry (#1518)"
    )
    assert '"run probe"' in text or '"/deft:run:probe"' in text, (
        "templates/agents-entry.md: probe routing must list trigger keywords (#1518)"
    )


def test_probe_skill_exit_block_present() -> None:
    """Skill MUST carry an EXIT section with canonical exit phrasing (#1518)."""
    text = _read(_PROBE_PATH)
    assert "## EXIT" in text, (
        f"{_PROBE_PATH}: missing '## EXIT' heading"
    )
    assert "exiting skill" in text.lower(), (
        f"{_PROBE_PATH}: EXIT block must contain 'exiting skill' confirmation phrasing"
    )
