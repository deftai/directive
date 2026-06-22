"""agents-entry.md path-flip pin (#1046 PR-A AC-1 / #1045).

Asserts ``templates/agents-entry.md`` -- the single source of truth for the
managed-section content rendered into every consumer's ``AGENTS.md`` -- no
longer carries any legacy ``deft/<thing>/`` install-path literal after the
#1046 PR-A canonical-path enforcement (which absorbs the standalone #1045
path-flip issue per the cohort ADR PR #1051).

The actual flip itself landed in PR #1043 (commit ``985a7f2``) as part of
the v0.27.1 installer conformance recheck (#1020); this contract test pins
the post-flip state so a future edit that re-introduces a legacy literal
fails CI immediately rather than silently regressing the rendered managed
section back to the broken-path-loop state issue #1046 documents.

Why this regression matters
---------------------------

When the managed section declares an install path that does not resolve on
disk, the consumer's session-start routing enters a documented no-op Case G
refresh loop (per issue #1046 finding #2): the loop detects "AGENTS.md
references paths that don't exist", refreshes the managed section with
byte-identical bytes, reports success, and the next session re-detects the
same staleness. The canonical-path flip from #1043 closes that loop by
making the on-disk install location agree with what AGENTS.md declares for
the v0.27 install contract. A re-introduction of ``deft/<thing>/`` would
re-open the loop.

Mirrors the existing ``tests/contract/test_no_legacy_deft_run.py`` pattern
but scoped to the rendered managed-section template specifically.

Exclusions
----------

User-config paths under ``~/.config/deft/`` (XDG-ish) and
``%APPDATA%\\deft\\`` (Windows-ish) are NOT subject to this flip -- they
point at the consumer's USER.md location, not the framework install path.
The detector below filters those occurrences out by line context so the
Platform Detection wording in ``First Session`` (which legitimately
references both ``~/.config/deft/USER.md`` and ``%APPDATA%\\deft\\USER.md``)
remains untouched.

PR-C carve-out
--------------

The PR-A cohort scope leaves the Implementation Intent Gate block in
``templates/agents-entry.md`` untouched for PR-C, which will rewrite the
prose around the gate's Taskfile target into a resolver-based contract per
the ADR. The current template already carries the canonical
``.deft/core/scripts/preflight_implementation.py`` literal (flipped by
#1043 alongside the rest of the body), so this test simply checks for the
ABSENCE of the legacy form -- a forward-only assertion that does not block
PR-C's planned rewrite.

Story: #1046 PR-A (acceptance criterion AC-1) -- absorbs #1045.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATE_PATH = _REPO_ROOT / "content/templates/agents-entry.md"

# Legacy install-path literals that MUST NOT appear in the rendered managed
# section. Each token represents a v0.19 / pre-#1043 surface that the v0.27
# canonical-path flip retired. The ``deft/scripts/`` form is included so a
# future regression in PR-C's resolver rewrite does NOT re-introduce the
# hard-coded literal.
_LEGACY_INSTALL_PATH_TOKENS = (
    "deft/skills/",
    "deft/main.md",
    "deft/QUICK-START.md",
    "deft/Taskfile.yml",
    "deft/run",
    "deft/scripts/",
)

# Lines that legitimately contain the substring ``deft/`` but reference the
# user's config-directory location (XDG-ish on Unix, APPDATA-ish on Windows)
# rather than the framework install path. The Platform Detection /
# First Session sections call these out by design; the contract flip does
# NOT apply to them.
_USER_CONFIG_PATH_MARKERS = (
    "~/.config/deft/",
    "%APPDATA%\\deft\\",
)


def _is_user_config_context(line: str) -> bool:
    """True iff a ``deft/`` occurrence on this line is a user-config reference.

    Filters out the lines that document the USER.md location (e.g.
    ``~/.config/deft/USER.md`` or ``%APPDATA%\\deft\\USER.md``) so the test
    does not false-positive on legitimate config-path references that survived
    the install-path flip by design.
    """
    return any(marker in line for marker in _USER_CONFIG_PATH_MARKERS)


def _scan_template_for_legacy_token(token: str) -> list[tuple[int, str]]:
    """Return ``[(line_number, line_text)]`` for every in-scope hit.

    Excludes lines that match the user-config carve-out so the assertion
    surfaces only the framework-install-path occurrences this contract pin
    actually protects against.
    """
    text = _TEMPLATE_PATH.read_text(encoding="utf-8")
    hits: list[tuple[int, str]] = []
    for idx, line in enumerate(text.splitlines(), start=1):
        if token not in line:
            continue
        if _is_user_config_context(line):
            continue
        hits.append((idx, line.rstrip()))
    return hits


# ---------------------------------------------------------------------------
# Contract assertions
# ---------------------------------------------------------------------------


def test_template_on_disk() -> None:
    """``templates/agents-entry.md`` must exist where the framework expects it."""
    assert _TEMPLATE_PATH.is_file(), (
        f"Expected canonical template at {_TEMPLATE_PATH}; the #1046 PR-A "
        "contract regression cannot run without the file on disk."
    )


@pytest.mark.parametrize("token", _LEGACY_INSTALL_PATH_TOKENS)
def test_legacy_install_path_token_absent(token: str) -> None:
    """No legacy ``deft/<thing>/`` install-path literal in the rendered template.

    A hit here means either (a) the canonical-path flip from #1043 was
    partially reverted, or (b) a new edit re-introduced a legacy literal in
    the body of the managed section. Either case must be addressed before
    merge -- the consumer-side no-op Case G refresh loop documented in
    issue #1046 fires whenever the managed section declares an install
    path that does not resolve on disk.

    User-config paths under ``~/.config/deft/`` and ``%APPDATA%\\deft\\``
    are excluded by line context -- those reference the USER.md location,
    not the framework install path, and are NOT subject to this flip.
    """
    hits = _scan_template_for_legacy_token(token)
    assert not hits, (
        f"Legacy install-path literal `{token}` re-introduced into "
        f"templates/agents-entry.md after #1046 PR-A AC-1 (which absorbs "
        f"#1045 per the cohort ADR). Either flip the occurrence to its "
        f"`.deft/core/` canonical form or, if the line is intentionally "
        f"out of scope (e.g. a user-config path), extend the carve-out in "
        f"this test (and document the rationale in the module docstring).\n"
        + "\n".join(f"  line {n}: {text}" for n, text in hits)
    )


def test_canonical_install_path_tokens_present() -> None:
    """Spot-check that the canonical install-path tokens actually landed.

    Pinned against a small set of high-signal occurrences in the rendered
    managed section so a partial flip (e.g. only one of two install-path
    references swapped) fails this test independently of the broader
    legacy-token absence sweep above.
    """
    text = _TEMPLATE_PATH.read_text(encoding="utf-8")
    canonical_tokens = (
        ".deft/core/main.md",
        ".deft/core/skills/",
        ".deft/core/run",
    )
    missing = [token for token in canonical_tokens if token not in text]
    assert not missing, (
        "Expected canonical install-path tokens in "
        "templates/agents-entry.md after #1046 PR-A AC-1; missing:\n  "
        + "\n  ".join(missing)
    )
