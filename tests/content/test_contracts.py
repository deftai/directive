"""
test_contracts.py — Cross-file contract checks for the Deft Directive framework.

Spec: SPECIFICATION.md Subphase 2.4 (Task 2.4.1)

Checks:
  1. Every internal link in REFERENCES.md resolves to an existing file
  2. Every link in strategies/README.md resolves (rapid.md xfail — future)
  3. Every "See also" link across all .md files resolves
  4. strategies/discuss.md IS listed in the strategies/README.md table
     (currently failing — documents the gap for Phase 2 fix)

Author: Scott Adams (msadams) — 2026-03-10
"""

import json
import re
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")

_SKIP_DIRS = {".git", ".venv", "__pycache__", ".pytest_cache", "backup", "dist", "tests"}


# ---------------------------------------------------------------------------
# Known-failures helpers
# ---------------------------------------------------------------------------

def _load_entries() -> list[dict]:
    kf_path = _REPO_ROOT / "tests/content/snapshots/known_failures.json"
    return json.loads(kf_path.read_text(encoding="utf-8"))["known_failures"]


def _xfail_files(check: str) -> set[str]:
    """Files marked xfail for a given check (matched on 'file' field)."""
    return {e["file"] for e in _load_entries() if e.get("xfail") and e.get("check") == check}


def _xfail_composite(check: str) -> set[str]:
    """Composite keys 'source::target' marked xfail for a given check."""
    return {
        e["composite_key"]
        for e in _load_entries()
        if e.get("xfail") and e.get("check") == check and "composite_key" in e
    }


# ---------------------------------------------------------------------------
# Link parsing helpers
# ---------------------------------------------------------------------------

def _internal_links(filepath: Path) -> list[tuple[str, Path]]:
    """Return (raw_target, resolved_path) for every internal link in filepath."""
    text = filepath.read_text(encoding="utf-8", errors="replace")
    results = []
    for _, target in _LINK_RE.findall(text):
        if target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        path_part = target.split("#")[0].strip()
        if not path_part:
            continue
        resolved = (filepath.parent / path_part).resolve()
        results.append((target, resolved))
    return results


def _see_also_links() -> list[tuple[str, str, Path]]:
    """Return (source_rel, raw_target, resolved_path) for every See also link."""
    results = []
    for md_file in sorted(_REPO_ROOT.rglob("*.md")):
        if any(part in _SKIP_DIRS for part in md_file.parts):
            continue
        text = md_file.read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            if "see also" not in line.lower():
                continue
            for _, target in _LINK_RE.findall(line):
                if target.startswith(("http://", "https://", "mailto:", "#")):
                    continue
                path_part = target.split("#")[0].strip()
                if not path_part:
                    continue
                source_rel = md_file.relative_to(_REPO_ROOT).as_posix()
                resolved = (md_file.parent / path_part).resolve()
                results.append((source_rel, target, resolved))
    return results


# ---------------------------------------------------------------------------
# 1. REFERENCES.md internal links
# ---------------------------------------------------------------------------

def _references_params() -> list:
    refs_file = _REPO_ROOT / "REFERENCES.md"
    return [
        pytest.param(target, str(resolved), id=target)
        for target, resolved in _internal_links(refs_file)
    ]


@pytest.mark.parametrize("raw_target,resolved_str", _references_params())
def test_references_md_links_resolve(raw_target: str, resolved_str: str) -> None:
    """Every internal link in REFERENCES.md must point to an existing file."""
    assert Path(resolved_str).exists(), (
        f"REFERENCES.md: broken link '{raw_target}' — target does not exist"
    )


# ---------------------------------------------------------------------------
# 2. strategies/README.md links
# ---------------------------------------------------------------------------

_STRATEGY_INDEX_CHECK = "test_contracts.strategy_index_links_resolve"


def _strategy_index_params() -> list:
    xfail = _xfail_files(_STRATEGY_INDEX_CHECK)
    strategy_readme = _REPO_ROOT / "strategies/README.md"
    params = []
    for target, resolved in _internal_links(strategy_readme):
        # Use the filename as the key for xfail lookup
        target_name = resolved.name
        rel = f"strategies/{target_name}"
        if rel in xfail:
            params.append(
                pytest.param(
                    target,
                    str(resolved),
                    id=target,
                    marks=pytest.mark.xfail(
                        reason=f"{rel} referenced but not yet created — see todo.md Phase 2",
                        strict=True,
                    ),
                )
            )
        else:
            params.append(pytest.param(target, str(resolved), id=target))
    return params


@pytest.mark.parametrize("raw_target,resolved_str", _strategy_index_params())
def test_strategy_index_links_resolve(raw_target: str, resolved_str: str) -> None:
    """Every link in strategies/README.md must point to an existing file."""
    assert Path(resolved_str).exists(), (
        f"strategies/README.md: broken link '{raw_target}' — target does not exist"
    )


# ---------------------------------------------------------------------------
# 3. "See also" links across all .md files
# ---------------------------------------------------------------------------

_SEE_ALSO_CHECK = "test_contracts.see_also_links_resolve"


def _see_also_params() -> list:
    xfail_keys = _xfail_composite(_SEE_ALSO_CHECK)
    params = []
    for source_rel, target, resolved in _see_also_links():
        composite = f"{source_rel}::{target}"
        test_id = f"{source_rel}::{target}"
        if composite in xfail_keys:
            params.append(
                pytest.param(
                    source_rel,
                    target,
                    str(resolved),
                    id=test_id,
                    marks=pytest.mark.xfail(
                        reason=f"broken See also link in {source_rel} — see todo.md Phase 2",
                        strict=True,
                    ),
                )
            )
        else:
            params.append(pytest.param(source_rel, target, str(resolved), id=test_id))
    return params


@pytest.mark.parametrize("source_rel,raw_target,resolved_str", _see_also_params())
def test_see_also_links_resolve(source_rel: str, raw_target: str, resolved_str: str) -> None:
    """Every 'See also' link in every .md file must resolve to an existing file."""
    assert Path(resolved_str).exists(), (
        f"{source_rel}: broken See also link '{raw_target}' — target does not exist"
    )


# ---------------------------------------------------------------------------
# 4. strategies/discuss.md must appear in the strategy index
# ---------------------------------------------------------------------------

def test_discuss_in_strategy_index() -> None:
    """strategies/discuss.md must be listed in the strategies/README.md table."""
    readme = (_REPO_ROOT / "strategies/README.md").read_text(encoding="utf-8")
    assert "discuss.md" in readme, (
        "strategies/discuss.md is not referenced in strategies/README.md"
    )
