"""test_release_workflow.py -- Guard-rail tests for #733.

The deft release workflow MUST NOT auto-publish releases. Per #716 (Phase 5
user-only authority gate) and #733 (this regression), publish authority
belongs exclusively to ``task release:publish`` (which runs
``gh release edit --draft=false`` under operator review). The workflow's
``release`` job is BUILD AND UPLOAD only.

This module parses ``.github/workflows/release.yml`` and asserts:

1. Every ``softprops/action-gh-release@v*`` usage carries ``draft: true``
   (the action's default is ``false``, so an unset ``draft`` key is the
   same defect as ``draft: false`` -- both flip the release to public).
2. No step runs ``gh release edit --draft=false``.
3. No step otherwise flips ``isDraft: false``.

The tests are deliberately string/regex based rather than YAML-parsed --
PyYAML is not in the project's dev dependencies (per ``pyproject.toml``)
and the workflow's structure is stable enough that a regex scan with a
narrow context window is sufficient. If a future contributor adds a third
mechanism to flip drafts (e.g. another action), the catch-all assertions
will surface it.

Refs:
  - deftai/directive#733 -- root regression issue
  - deftai/directive#716 -- Phase 5 safety hardening / user-only authority
  - skills/deft-directive-release/SKILL.md -- canonical release workflow
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
RELEASE_YML = REPO_ROOT / ".github" / "workflows" / "release.yml"


@pytest.fixture(scope="module")
def workflow_text() -> str:
    assert RELEASE_YML.is_file(), (
        f".github/workflows/release.yml missing at {RELEASE_YML}"
    )
    return RELEASE_YML.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_ACTION_RE = re.compile(
    r"uses:\s*softprops/action-gh-release@v\S+",
    re.IGNORECASE,
)


def _softprops_blocks(text: str) -> list[str]:
    """Return the YAML ``with:`` block following each softprops usage.

    Each returned block is the raw text from the ``with:`` line up to (but
    not including) the next sibling step (a line that starts with the same
    or shallower indentation and a ``-`` marker, or a new top-level key).
    Sufficient for substring / regex assertions on the ``draft:`` key.
    """
    blocks: list[str] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        if _ACTION_RE.search(lines[i]):
            # Walk forward, collecting subsequent lines until we hit the
            # next list item at the same indentation OR a new top-level
            # block. Both yaml-flavoured release.yml dialects (the v1
            # `softprops/action-gh-release@v1` form + the v2 form used
            # post-#733) format the parameters under a `with:` mapping
            # immediately after the `uses:` line.
            block: list[str] = [lines[i]]
            uses_indent = len(lines[i]) - len(lines[i].lstrip(" "))
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if not nxt.strip():
                    block.append(nxt)
                    j += 1
                    continue
                nxt_indent = len(nxt) - len(nxt.lstrip(" "))
                # Stop on a sibling list item or shallower top-level key.
                if nxt_indent <= uses_indent and nxt.lstrip().startswith("- "):
                    break
                if nxt_indent < uses_indent:
                    break
                block.append(nxt)
                j += 1
            blocks.append("\n".join(block))
            i = j
            continue
        i += 1
    return blocks


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_release_yml_exists(workflow_text: str) -> None:
    """Sanity: the workflow file is present and non-empty."""
    assert workflow_text.strip(), "release.yml is empty"


def test_softprops_action_present_at_least_once(workflow_text: str) -> None:
    """The release job uses softprops/action-gh-release@vN at least once.

    If the action is removed entirely the auto-publish defect cannot
    recur, but the upload-binaries-to-draft-release flow per #716/#733
    relies on it. This test pins the contract so future contributors do
    not silently drop the upload step.
    """
    matches = _ACTION_RE.findall(workflow_text)
    assert matches, (
        "release.yml MUST contain at least one softprops/action-gh-release@vN "
        "usage to upload binaries to the draft release; if the action is "
        "removed entirely, update this test or substitute an equivalent "
        "upload mechanism."
    )


def test_no_softprops_usage_with_draft_false(workflow_text: str) -> None:
    """No softprops action carries ``draft: false`` (#733)."""
    blocks = _softprops_blocks(workflow_text)
    offenders: list[str] = []
    for block in blocks:
        if re.search(r"^\s*draft:\s*false\b", block, re.MULTILINE):
            offenders.append(block)
    assert not offenders, (
        "softprops/action-gh-release usage with `draft: false` is forbidden "
        "per #733 (auto-publish bypasses #716 user-only authority gate). "
        f"Offending block(s):\n{chr(10).join(offenders)}"
    )


def test_every_softprops_usage_sets_draft_true(workflow_text: str) -> None:
    """Every softprops usage explicitly sets ``draft: true`` (#733).

    softprops/action-gh-release@v2 defaults ``draft`` to ``false`` when the
    key is absent, so omitting the key is functionally identical to
    ``draft: false`` and equally forbidden by the #716 / #733 contract.
    """
    blocks = _softprops_blocks(workflow_text)
    assert blocks, "softprops blocks not found -- companion test should fail first"
    missing: list[str] = []
    for block in blocks:
        if not re.search(r"^\s*draft:\s*true\b", block, re.MULTILINE):
            missing.append(block)
    assert not missing, (
        "Every softprops/action-gh-release@vN usage MUST set `draft: true` "
        "(the action defaults to draft=false, so an absent key flips the "
        "release to public per #733). Missing in:\n"
        f"{chr(10).join(missing)}"
    )


def test_no_gh_release_edit_draft_false(workflow_text: str) -> None:
    """No workflow step runs ``gh release edit --draft=false`` (#733).

    ``task release:publish`` is the only authorised path that flips a
    release from draft to public. A workflow step running the same edit
    silently bypasses the user-only authority gate.

    Comment lines are stripped before scanning -- the rule documents
    `task release:publish` itself as the canonical command that runs
    this edit, so a literal mention in a YAML comment is not a defect.
    """
    # Strip YAML comments so that prose mentioning the canonical
    # publish-authority command (e.g. in the `release:` job header)
    # does not false-positive. We split each line at the first `#`
    # NOT inside a quoted string. The release.yml workflow does not
    # use `#` inside YAML strings today; if that ever changes the
    # regex below should be replaced with a real YAML parser.
    code_lines: list[str] = []
    for line in workflow_text.splitlines():
        # YAML comments start at `#` only when preceded by whitespace
        # or beginning-of-line (so a literal `#NNN` issue reference
        # inside a string value is preserved). The release.yml file
        # carries `# comment` style only -- this single-pass split is
        # sufficient for that shape.
        idx = 0
        in_quote = False
        while idx < len(line):
            ch = line[idx]
            if ch in ("'", '"'):
                in_quote = not in_quote
            elif ch == "#" and not in_quote and (idx == 0 or line[idx - 1] in " \t"):
                line = line[:idx]
                break
            idx += 1
        code_lines.append(line)
    code_only = "\n".join(code_lines)
    # Match either `--draft=false` or `--draft false` (gh accepts both).
    pattern = re.compile(r"gh\s+release\s+edit[^\n]*--draft[\s=]+false\b")
    offenders = pattern.findall(code_only)
    assert not offenders, (
        "release.yml MUST NOT run `gh release edit --draft=false` -- that "
        "is the publish-authority operation reserved for "
        "`task release:publish` per #716 / #733. Offenders: "
        f"{offenders}"
    )


def test_no_isdraft_false_flip_anywhere(workflow_text: str) -> None:
    """Defence-in-depth: no step otherwise flips isDraft to false.

    Catches creative future variants that don't fit the two pattern-based
    assertions above (e.g. an inline ``run:`` block calling the GitHub
    REST API with ``{\"draft\": false}`` body, or a third-party action
    that sets the draft state via a different param name like
    ``is_draft``). The check is permissive about whitespace / quoting.
    """
    suspicious_patterns = [
        # JSON body to the REST API ({"draft": false})
        re.compile(r'"\s*draft\s*"\s*:\s*false\b'),
        # is_draft: false (alternate naming a third-party action might use)
        re.compile(r"^\s*is_draft:\s*false\b", re.MULTILINE),
    ]
    offenders: list[tuple[str, list[str]]] = []
    for pat in suspicious_patterns:
        hits = pat.findall(workflow_text)
        if hits:
            offenders.append((pat.pattern, hits))
    assert not offenders, (
        "release.yml contains suspicious draft-flipping pattern(s): "
        f"{offenders}. Per #733 / #716 publish authority MUST remain with "
        "`task release:publish`."
    )
