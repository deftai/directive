"""test_consumer_tasks.py -- smoke tests for consumer-safe task/script paths.

These tests fake a minimal consumer project in a ``tmp_path`` directory and
invoke each hardened ``scripts/*.py`` entry point (as a subprocess or via
in-process ``main()`` calls) from that fake consumer root. They assert:

* Lifecycle transitions (#535) resolve against the consumer's ``vbrief/``,
  not deft's own tree, and succeed even when invoked from a CWD that is
  NOT the consumer project.
* ``issue:ingest`` (#538) uses the consumer's ``--repo`` and writes vBRIEFs
  under the consumer's ``vbrief/`` regardless of where the repo's
  ``git remote`` points.
* ``reconcile:issues`` (#538) reports against the consumer repo identity.
* ``prd:render`` (#539) writes to the consumer's ``PRD.md`` when pointed
  there and REFUSES to overwrite a hand-authored PRD (like deft's own
  framework ``PRD.md``) that lacks the auto-generated banner.

The suite is deliberately small and fast -- one smoke test per fixed task.
It exists primarily as a regression gate so the #535 / #538 / #539 class
of bugs cannot reappear undetected.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"


# ---------------------------------------------------------------------------
# Consumer fixture
# ---------------------------------------------------------------------------


@pytest.fixture
def consumer_root(tmp_path: Path) -> Iterator[Path]:
    """Yield a fresh temp directory decoupled from pytest's tmp_path factory.

    The default ``tmp_path`` fixture depends on a session-wide ``pytest-N``
    base directory under the OS temp root. On this project's Windows CI /
    dev machines that base is occasionally wiped by unrelated cleanup mid
    session, producing WinError 3 in unrelated tests; using
    ``tempfile.TemporaryDirectory`` under the same parent gives each
    integration test its own root that is not vulnerable to that race.
    """
    with tempfile.TemporaryDirectory(
        prefix="deft-consumer-", dir=str(tmp_path)
    ) as td:
        yield Path(td)


@pytest.fixture
def consumer_project(consumer_root: Path) -> Path:
    """Create a minimal consumer project tree under ``consumer_root``.

    Layout::

        consumer_root/
            consumer/
                vbrief/
                    proposed/
                    pending/
                    active/
                    completed/
                    cancelled/
                    specification.vbrief.json
    """
    root = consumer_root / "consumer"
    (root / "vbrief").mkdir(parents=True)
    for folder in ("proposed", "pending", "active", "completed", "cancelled"):
        (root / "vbrief" / folder).mkdir()
    spec_path = root / "vbrief" / "specification.vbrief.json"
    spec_path.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {
                    "title": "Consumer Project",
                    "status": "draft",
                    "narratives": {
                        "Overview": "A fixture consumer project used by "
                        "deft's consumer-tasks integration suite.",
                    },
                    "items": [],
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return root


def _write_scope_vbrief(
    project_root: Path,
    folder: str,
    filename: str,
    *,
    status: str = "proposed",
    title: str = "Consumer fixture scope",
) -> Path:
    """Write a minimal scope vBRIEF into ``project_root/vbrief/<folder>/``."""
    target = project_root / "vbrief" / folder / filename
    target.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {
                    "title": title,
                    "status": status,
                    "items": [],
                    "references": [{"type": "github-issue", "id": "#42"}],
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return target


def _load_module(name: str, path: Path):
    """Load a ``scripts/*.py`` module in-process.

    Mirrors the ``importlib.util`` pattern used by the existing ``*_direct``
    test suites so we can monkeypatch ``subprocess.run`` / ``gh`` helpers
    without hitting the live GitHub API.
    """
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# scope:promote (#535)
# ---------------------------------------------------------------------------


def test_scope_promote_resolves_against_consumer_root(
    consumer_project: Path, tmp_path: Path
) -> None:
    """scope_lifecycle.py resolves relative paths against --project-root.

    Pre-fix: the script used ``Path.cwd()`` which was ``deft/`` when Task
    included deft's Taskfile -- a relative path like
    ``vbrief/proposed/X.vbrief.json`` resolved to ``deft/vbrief/...``
    and exit 1 with File-not-found (#535).
    """
    _write_scope_vbrief(
        consumer_project, "proposed", "2026-04-22-fixture.vbrief.json"
    )
    # Invoke from a completely unrelated CWD so the only way the script
    # can find the file is via --project-root.
    unrelated_cwd = tmp_path / "elsewhere"
    unrelated_cwd.mkdir()
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS_DIR / "scope_lifecycle.py"),
            "promote",
            "vbrief/proposed/2026-04-22-fixture.vbrief.json",
            "--project-root",
            str(consumer_project),
        ],
        capture_output=True,
        text=True,
        cwd=str(unrelated_cwd),
        timeout=30,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    dest = consumer_project / "vbrief" / "pending" / "2026-04-22-fixture.vbrief.json"
    assert dest.exists(), "file should have moved into consumer pending/"
    # And deft's own vbrief/ must NOT have been touched.
    deft_collision = REPO_ROOT / "vbrief" / "proposed" / "2026-04-22-fixture.vbrief.json"
    assert not deft_collision.exists(), (
        "Regression of #535: scope_lifecycle fell back to deft's own tree"
    )


def test_scope_promote_fails_loudly_when_no_project_root(tmp_path: Path) -> None:
    """Relative path + no detectable project root -> exit 2, actionable error.

    Guards against the silent-fallback-to-deft regression from #535.
    """
    elsewhere = tmp_path / "no_project_here"
    elsewhere.mkdir()
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS_DIR / "scope_lifecycle.py"),
            "promote",
            "vbrief/proposed/missing.vbrief.json",
        ],
        capture_output=True,
        text=True,
        cwd=str(elsewhere),
        timeout=30,
        env={
            # Clear sentinels so the script cannot walk up to a .git tree.
            "DEFT_PROJECT_ROOT": "",
            "PATH": "",
            "PYTHONPATH": "",
        },
    )
    assert result.returncode == 2
    assert "project root" in result.stderr.lower()


# ---------------------------------------------------------------------------
# issue:ingest (#538)
# ---------------------------------------------------------------------------


def test_issue_ingest_writes_to_consumer_vbrief(
    consumer_project: Path, monkeypatch
) -> None:
    """issue_ingest.main writes into the consumer's vbrief/ tree.

    We monkey-patch the gh / git helpers so no live network call happens.
    The assertion is structural: the file must land under the consumer
    root, never under the deft repo.
    """
    ingest = _load_module("issue_ingest", SCRIPTS_DIR / "issue_ingest.py")

    monkeypatch.setattr(
        ingest, "resolve_project_repo", lambda *_a, **_k: "owner/consumer"
    )
    monkeypatch.setattr(
        ingest,
        "_fetch_single_issue",
        lambda _repo, _n, *, cwd=None: {
            "number": 101,
            "title": "Consumer fixture issue",
            "url": "https://github.com/owner/consumer/issues/101",
            "labels": [],
        },
    )
    rc = ingest.main(
        [
            "101",
            "--vbrief-dir",
            str(consumer_project / "vbrief"),
            "--project-root",
            str(consumer_project),
            "--repo",
            "owner/consumer",
        ]
    )
    assert rc == 0
    written = list((consumer_project / "vbrief" / "proposed").glob("*.vbrief.json"))
    assert written, "ingest should have created a scope vBRIEF in consumer/vbrief/proposed/"
    payload = json.loads(written[0].read_text(encoding="utf-8"))
    refs = payload["plan"]["references"]
    assert refs[0]["url"] == "https://github.com/owner/consumer/issues/101"


def test_issue_ingest_fails_loudly_without_repo(
    consumer_project: Path, monkeypatch, capsys
) -> None:
    """No --repo, no env, no git remote -> exit 2 with actionable error.

    Replicates the #538 regression guard: we MUST NOT silently fall
    through to deft's own origin.
    """
    ingest = _load_module("issue_ingest", SCRIPTS_DIR / "issue_ingest.py")
    monkeypatch.setattr(
        ingest, "resolve_project_repo", lambda *_a, **_k: None
    )
    monkeypatch.setattr(ingest, "detect_repo", lambda: None)
    rc = ingest.main(
        [
            "1",
            "--vbrief-dir",
            str(consumer_project / "vbrief"),
            "--project-root",
            str(consumer_project),
        ]
    )
    assert rc == 2
    err = capsys.readouterr().err
    assert "could not detect repo" in err
    assert "#538" in err


# ---------------------------------------------------------------------------
# reconcile:issues (#538)
# ---------------------------------------------------------------------------


def test_reconcile_issues_uses_consumer_repo(consumer_project: Path, monkeypatch) -> None:
    """reconcile_issues.main fetches for the consumer repo, not deft's own.

    We stub ``fetch_open_issues`` and record the repo slug it receives.
    """
    reconcile = _load_module(
        "reconcile_issues_smoke", SCRIPTS_DIR / "reconcile_issues.py"
    )
    seen: dict[str, object] = {}

    def fake_fetch(repo, cwd=None):
        seen["repo"] = repo
        seen["cwd"] = cwd
        return [{"number": 42, "title": "Consumer issue", "url": ""}]

    monkeypatch.setattr(reconcile, "fetch_open_issues", fake_fetch)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "reconcile_issues.py",
            "--vbrief-dir",
            str(consumer_project / "vbrief"),
            "--project-root",
            str(consumer_project),
            "--repo",
            "owner/consumer",
        ],
    )
    rc = reconcile.main()
    assert rc == 0
    assert seen["repo"] == "owner/consumer", (
        "reconcile_issues must query the CONSUMER repo (#538)"
    )
    # cwd kwarg must be the consumer project root, not None / deft/ root.
    assert str(seen["cwd"]).endswith("consumer")


# ---------------------------------------------------------------------------
# prd:render (#539)
# ---------------------------------------------------------------------------


def test_prd_render_writes_to_consumer_output(consumer_project: Path) -> None:
    """prd_render.py writes the consumer PRD.md, not deft's own."""
    output = consumer_project / "PRD.md"
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS_DIR / "prd_render.py"),
            "--spec",
            str(consumer_project / "vbrief" / "specification.vbrief.json"),
            "--output",
            str(output),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    assert output.is_file()
    content = output.read_text(encoding="utf-8")
    assert "AUTO-GENERATED by task prd:render" in content
    assert "Consumer Project" in content
    # And deft's own PRD.md must not be touched by this invocation.
    # (The subprocess uses explicit absolute paths so this is a sanity
    # check for the sentinel.)


def test_prd_render_refuses_to_clobber_non_generated_file(
    consumer_project: Path, tmp_path: Path
) -> None:
    """If the output PRD was not auto-generated, refuse to overwrite.

    This is the concrete regression guard for #539: deft's own
    hand-authored ``PRD.md`` was being silently replaced when a consumer
    mis-resolved the output path.
    """
    hand_authored = tmp_path / "hand_authored_PRD.md"
    hand_authored.write_text(
        "# Hand-authored PRD\nThis file was not generated by deft.\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS_DIR / "prd_render.py"),
            "--spec",
            str(consumer_project / "vbrief" / "specification.vbrief.json"),
            "--output",
            str(hand_authored),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 2, f"expected exit 2, got {result.returncode}"
    assert "refusing to overwrite" in result.stderr.lower()
    # Content untouched.
    assert "Hand-authored PRD" in hand_authored.read_text(encoding="utf-8")
