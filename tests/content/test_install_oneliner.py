"""test_install_oneliner.py -- Content tests for #1661.

Guards the canonical agent/headless fetch-and-run install one-liner so the
guidance cannot silently regress. An agent told to "download and install Deft
from GitHub into this directory" must find a copy-pasteable per-platform
one-liner that fetches the release binary from `releases/latest/download` and
runs it headless (`--yes --repo-root . --json`) instead of fabricating a
source-checkout `go build` path.

Story: #1661
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]

# Release assets published by .github/workflows/release.yml.
_RELEASE_ASSETS = (
    "install-macos-universal",
    "install-linux-amd64",
    "install-windows-amd64.exe",
)

_DOC_FILES = ("README.md", "QUICK-START.md")


def _doc(name: str) -> str:
    return (_REPO_ROOT / name).read_text(encoding="utf-8")


@pytest.mark.parametrize("name", _DOC_FILES)
class TestFetchAndRunOneLiner:
    """README + QUICK-START must carry the canonical fetch-and-run one-liner."""

    def test_references_releases_latest_download(self, name: str):
        content = _doc(name)
        assert "releases/latest/download" in content, (
            f"{name} must document the fetch-and-run one-liner that downloads "
            "from releases/latest/download (#1661)."
        )

    def test_runs_headless_flags(self, name: str):
        content = _doc(name)
        assert "--yes --repo-root . --json" in content, (
            f"{name} one-liner must run the binary headless with "
            "`--yes --repo-root . --json` (#1661)."
        )

    def test_covers_each_platform_asset(self, name: str):
        content = _doc(name)
        for asset in _RELEASE_ASSETS:
            assert f"releases/latest/download/{asset}" in content, (
                f"{name} must reference the {asset} release binary via "
                f"releases/latest/download/{asset} (#1661)."
            )

    def test_no_source_build_in_oneliner(self, name: str):
        """The fetch-and-run command lines must not invoke go build.

        Inspect only lines that reference a concrete release asset
        (`releases/latest/download/install-...`) -- those are the actual
        copy-pasteable commands. Prose guidance that *warns against* `go build`
        is intentionally excluded.
        """
        content = _doc(name)
        command_lines = [
            line
            for line in content.splitlines()
            if "releases/latest/download/install-" in line
        ]
        assert command_lines, (
            f"{name} must contain at least one concrete fetch command "
            "referencing a release asset (#1661)."
        )
        for line in command_lines:
            assert "go build" not in line, (
                f"{name}: the fetch-and-run command must not invoke "
                "`go build` -- it fetches the release binary (#1661)."
            )
