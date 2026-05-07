"""tests/integration/test_scm_smoke.py -- integration smoke for #883 Story 1.

Single live test exercising the scm.py wrapper against the real ``gh`` CLI
and the real ``deftai/directive`` repository. Skipped when:

- ``DEFT_NO_NETWORK=1`` is set (CI lanes that disallow network).
- ``gh`` (or ``ghx``) is not on PATH (we have no binary to dispatch to).
- ``gh auth status`` fails (e.g. GitHub Actions runner without ``GH_TOKEN``
  exported into the test job env). The smoke is meant to prove wrapper
  round-trips against a real gh; it is not a credential gate, so we skip
  cleanly when no usable token is present rather than fail the lane.

Asserts a non-empty JSON body comes back with at minimum {number, title}
populated -- enough to prove the wrapper round-trips a real gh response
without re-implementing the full contract suite (that lives in the unit
tests at tests/test_scm_stub.py).
"""

from __future__ import annotations

import importlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

scm = importlib.import_module("scm")

# The smoke target: deftai/directive issue #1 is the seed issue; presence
# is stable enough for a real-network smoke. We pull `--json number,title`
# only to keep the surface tiny -- the contract assertions live in the
# unit tests (test_scm_stub.py) where they don't depend on network.
SMOKE_REPO = "deftai/directive"
SMOKE_ISSUE = "1"


pytestmark = pytest.mark.skipif(
    os.environ.get("DEFT_NO_NETWORK") == "1",
    reason="DEFT_NO_NETWORK=1 disables network-dependent integration tests",
)


def _binary_available() -> bool:
    return shutil.which("ghx") is not None or shutil.which("gh") is not None


def _gh_authenticated() -> bool:
    """Return True when ``gh auth status`` reports a usable token.

    Used as a skip-guard so CI lanes that do not export ``GH_TOKEN`` into
    the pytest job (e.g. our default ``Python (lint + type-check + test)``
    workflow) skip the live smoke instead of failing it. Locally, devs who
    have run ``gh auth login`` will have status==0 and the smoke will run.
    """
    if shutil.which("gh") is None:
        # If only ghx is on PATH we cannot probe auth here; let the test
        # attempt and surface any auth issue. ghx wrappers typically
        # supply their own credentials.
        return shutil.which("ghx") is not None
    try:
        proc = subprocess.run(
            ["gh", "auth", "status"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return False
    return proc.returncode == 0


@pytest.mark.skipif(
    not _binary_available(),
    reason="neither ghx nor gh on PATH; skipping live smoke",
)
@pytest.mark.skipif(
    not _gh_authenticated(),
    reason="gh CLI is not authenticated (no GH_TOKEN); skipping live smoke",
)
def test_scm_issue_view_returns_nonempty_json() -> None:
    """`scm.py issue view 1 --repo deftai/directive --json number,title` -> populated dict."""
    # Invoke scm.py via subprocess so the test actually exercises the
    # PATH-resolved binary, not just the in-process build_command(). The
    # alternative (calling scm.main directly) would inherit pytest's
    # captured stdout and miss the real subprocess plumbing this smoke
    # is meant to verify.
    cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "scm.py"),
        "issue",
        "view",
        SMOKE_ISSUE,
        "--repo",
        SMOKE_REPO,
        "--json",
        "number,title",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert proc.returncode == 0, (
        f"scm.py exit={proc.returncode} stderr={proc.stderr!r}"
    )
    payload = proc.stdout.strip()
    assert payload, "scm.py issue view emitted empty stdout against a real gh"
    parsed = json.loads(payload)
    assert isinstance(parsed, dict), (
        f"expected JSON object from scm:issue:view, got {type(parsed).__name__}"
    )
    assert "number" in parsed and isinstance(parsed["number"], int)
    assert parsed["number"] == int(SMOKE_ISSUE)
    assert "title" in parsed and isinstance(parsed["title"], str) and parsed["title"]
