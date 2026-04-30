"""test_reconcile_issues_apply.py -- tests for --apply-lifecycle-fixes (#734).

Coverage:
- ``apply_lifecycle_fixes`` happy path: a Section (c) entry in
  ``proposed/`` is moved to ``completed/`` with ``plan.status=completed``
  and a stamped ``vBRIEFInfo.updated``.
- Idempotent re-run: a second invocation with a fresh report (where the
  vBRIEF already lives in ``completed/``) is a no-op (``moved=0``).
- Mixed reference shapes: legacy bare ``github-issue`` AND canonical
  ``x-vbrief/github-issue`` entries are both detected + moved.
- Reverse mismatch: a vBRIEF in ``completed/`` whose issue is OPEN is
  reported via ``reconcile()`` but NOT auto-reverse-moved by the
  apply-mode helper.
- No-issue-ref vBRIEFs (older 2026-04-14-* shape) are silently skipped.
- Default-off (``--apply-lifecycle-fixes`` absent) -> report-only;
  files do NOT move.

Story: #734 (vBRIEF-lifecycle reconciliation gate at task release Phase 1).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load scripts/reconcile_issues.py in-process so we can call the
    apply-mode helpers directly without firing the gh CLI."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "reconcile_issues",
        scripts_dir / "reconcile_issues.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["reconcile_issues"] = module
    spec.loader.exec_module(module)
    return module


reconcile_issues = _load_module()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _write_vbrief(
    vbrief_dir: Path,
    folder: str,
    filename: str,
    *,
    issue_number: int | None,
    status: str = "running",
    ref_type: str = "x-vbrief/github-issue",
    include_ref: bool = True,
) -> Path:
    """Write a synthetic vBRIEF into the given lifecycle folder."""
    folder_path = vbrief_dir / folder
    folder_path.mkdir(parents=True, exist_ok=True)
    references: list[dict] = []
    if include_ref and issue_number is not None:
        if ref_type == "github-issue":
            # Legacy bare shape (id-only).
            references.append({"type": "github-issue", "id": f"#{issue_number}"})
        else:
            references.append(
                {
                    "uri": (
                        f"https://github.com/deftai/directive/issues/"
                        f"{issue_number}"
                    ),
                    "type": ref_type,
                    "title": f"Issue #{issue_number}: synthetic",
                }
            )

    data = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": f"synthetic scope #{issue_number}" if issue_number else "synthetic",
            "status": status,
            "narratives": {},
            "items": [],
            "references": references,
        },
    }
    file_path = folder_path / filename
    file_path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return file_path


@pytest.fixture
def vbrief_dir(tmp_path: Path) -> Path:
    """Empty synthetic vbrief/ tree."""
    root = tmp_path / "vbrief"
    for folder in reconcile_issues.LIFECYCLE_FOLDERS:
        (root / folder).mkdir(parents=True, exist_ok=True)
    return root


# ---------------------------------------------------------------------------
# apply_lifecycle_fixes -- happy path
# ---------------------------------------------------------------------------


class TestApplyLifecycleFixesHappy:
    def test_moves_section_c_entry_and_stamps_status(self, vbrief_dir):
        # Stage a vBRIEF in proposed/ whose issue is closed (Section (c)).
        src = _write_vbrief(
            vbrief_dir,
            "proposed",
            "2026-04-29-100-closed.vbrief.json",
            issue_number=100,
        )
        # gh reports zero open issues -> reconcile flags #100 as no_open_issue.
        issue_to_vbriefs = reconcile_issues.scan_vbrief_dir(vbrief_dir)
        report = reconcile_issues.reconcile_with_unlinked(issue_to_vbriefs, [])
        assert report["summary"]["vbriefs_no_open_issue_count"] == 1

        moved, skipped, failures = reconcile_issues.apply_lifecycle_fixes(
            vbrief_dir, report
        )
        assert moved == 1
        assert skipped == 0
        assert failures == []

        # File no longer in proposed/, lives in completed/.
        assert not src.is_file()
        dst = vbrief_dir / "completed" / "2026-04-29-100-closed.vbrief.json"
        assert dst.is_file()

        # plan.status = "completed" + vBRIEFInfo.updated stamped.
        moved_data = json.loads(dst.read_text(encoding="utf-8"))
        assert moved_data["plan"]["status"] == "completed"
        assert moved_data["vBRIEFInfo"].get("updated"), (
            "apply-mode MUST stamp vBRIEFInfo.updated"
        )
        # The stamp is an ISO-8601 string with a Z suffix.
        assert moved_data["vBRIEFInfo"]["updated"].endswith("Z")

    def test_idempotent_rerun_is_noop(self, vbrief_dir):
        """Second call after the first lands on no-op (moved=0)."""
        _write_vbrief(
            vbrief_dir,
            "active",
            "2026-04-29-200-already.vbrief.json",
            issue_number=200,
        )
        issue_to_vbriefs = reconcile_issues.scan_vbrief_dir(vbrief_dir)
        report = reconcile_issues.reconcile_with_unlinked(issue_to_vbriefs, [])
        moved1, _skipped1, failures1 = reconcile_issues.apply_lifecycle_fixes(
            vbrief_dir, report
        )
        assert moved1 == 1
        assert failures1 == []

        # Re-scan: file is now in completed/. The fresh report no longer has
        # a non-completed candidate; apply-mode is a no-op.
        issue_to_vbriefs2 = reconcile_issues.scan_vbrief_dir(vbrief_dir)
        report2 = reconcile_issues.reconcile_with_unlinked(issue_to_vbriefs2, [])
        moved2, skipped2, failures2 = reconcile_issues.apply_lifecycle_fixes(
            vbrief_dir, report2
        )
        assert moved2 == 0
        # Section (c) still surfaces #200 (it lives in completed/), so the
        # entry is reported but skipped by the apply helper.
        assert skipped2 >= 1
        assert failures2 == []


# ---------------------------------------------------------------------------
# Mixed reference shapes
# ---------------------------------------------------------------------------


class TestMixedReferenceShapes:
    def test_legacy_and_canonical_both_detected_and_moved(self, vbrief_dir):
        # One legacy bare shape, one canonical -- both with closed issues.
        legacy = _write_vbrief(
            vbrief_dir,
            "proposed",
            "2026-04-29-300-legacy.vbrief.json",
            issue_number=300,
            ref_type="github-issue",
        )
        canonical = _write_vbrief(
            vbrief_dir,
            "pending",
            "2026-04-29-301-canonical.vbrief.json",
            issue_number=301,
            ref_type="x-vbrief/github-issue",
        )
        issue_to_vbriefs = reconcile_issues.scan_vbrief_dir(vbrief_dir)
        # Both must be discovered by scan_vbrief_dir.
        assert 300 in issue_to_vbriefs
        assert 301 in issue_to_vbriefs

        report = reconcile_issues.reconcile_with_unlinked(issue_to_vbriefs, [])
        moved, _skipped, failures = reconcile_issues.apply_lifecycle_fixes(
            vbrief_dir, report
        )
        assert moved == 2, (
            "both legacy and canonical reference shapes MUST be detected "
            "and moved by apply-mode"
        )
        assert failures == []
        # Both files moved to completed/.
        assert not legacy.is_file()
        assert not canonical.is_file()
        assert (vbrief_dir / "completed" / legacy.name).is_file()
        assert (vbrief_dir / "completed" / canonical.name).is_file()


# ---------------------------------------------------------------------------
# Reverse mismatch / no-issue-ref skip / report-only by default
# ---------------------------------------------------------------------------


class TestReverseMismatch:
    def test_completed_vbrief_with_open_issue_not_auto_reversed(self, vbrief_dir):
        """Section (c) reverse-mismatch reported but NOT auto-moved.

        vBRIEF in completed/ + corresponding issue is OPEN (reopened) ->
        the report's ``linked`` section flags the open issue with a
        completed-folder vBRIEF, but apply-mode MUST NOT move the file
        out of completed/. The operator decides.
        """
        completed = _write_vbrief(
            vbrief_dir,
            "completed",
            "2026-04-29-400-reopened.vbrief.json",
            issue_number=400,
            status="completed",
        )
        issue_to_vbriefs = reconcile_issues.scan_vbrief_dir(vbrief_dir)
        # Mock open-issues fetch: #400 is open (reopened).
        open_issues = [
            {"number": 400, "title": "Reopened", "url": "https://example/400", "labels": []}
        ]
        report = reconcile_issues.reconcile_with_unlinked(issue_to_vbriefs, open_issues)
        # Report classifies as linked (matched via vBRIEF) -- but folder
        # is completed/, which is the reverse-mismatch shape.
        assert report["summary"]["linked_count"] == 1
        assert report["summary"]["vbriefs_no_open_issue_count"] == 0

        moved, skipped, failures = reconcile_issues.apply_lifecycle_fixes(
            vbrief_dir, report
        )
        assert moved == 0, "reverse-mismatch MUST NOT trigger any move"
        assert failures == []
        # File still lives in completed/.
        assert completed.is_file()


class TestNoIssueRefVbriefs:
    def test_no_reference_vbriefs_silently_skipped(self, vbrief_dir):
        """Scope vBRIEFs without GitHub issue refs are not in any section."""
        no_ref = _write_vbrief(
            vbrief_dir,
            "proposed",
            "2026-04-14-no-ref.vbrief.json",
            issue_number=None,
            include_ref=False,
        )
        issue_to_vbriefs = reconcile_issues.scan_vbrief_dir(vbrief_dir)
        # No issue numbers extracted -> no entries in the map.
        assert issue_to_vbriefs == {}
        report = reconcile_issues.reconcile_with_unlinked(issue_to_vbriefs, [])
        moved, _skipped, failures = reconcile_issues.apply_lifecycle_fixes(
            vbrief_dir, report
        )
        assert moved == 0
        assert failures == []
        # File untouched in proposed/.
        assert no_ref.is_file()


class TestReportOnlyDefault:
    def test_default_off_does_not_move_files(self, vbrief_dir, monkeypatch, capsys):
        """Without --apply-lifecycle-fixes, main() emits the report only."""
        src = _write_vbrief(
            vbrief_dir,
            "active",
            "2026-04-29-500-closed.vbrief.json",
            issue_number=500,
        )
        # Stub fetch_issue_states + repo resolution so we don't fire gh.
        # #754: default path is inverted lookup; an empty state map means
        # every referenced issue is treated as NOT_FOUND (closed).
        monkeypatch.setattr(
            reconcile_issues,
            "fetch_issue_states",
            lambda _r, _ids, cwd=None: {},
        )
        monkeypatch.setattr(
            reconcile_issues, "detect_repo", lambda: "deftai/directive"
        )
        # Run argv WITHOUT --apply-lifecycle-fixes.
        argv = [
            "reconcile_issues",
            "--vbrief-dir",
            str(vbrief_dir),
            "--repo",
            "deftai/directive",
            "--format",
            "json",
        ]
        monkeypatch.setattr(sys, "argv", argv)
        rc = reconcile_issues.main()
        assert rc == 0
        # File must NOT have moved.
        assert src.is_file(), (
            "apply-mode is opt-in; without --apply-lifecycle-fixes the "
            "Section (c) vBRIEF MUST remain in its original folder"
        )
        # Report (markdown or JSON) was emitted.
        out = capsys.readouterr().out
        assert out.strip(), "main() MUST emit the report on stdout"

    def test_apply_flag_invokes_helper_and_moves_file(
        self, vbrief_dir, monkeypatch, capsys
    ):
        """With --apply-lifecycle-fixes, the file is moved."""
        src = _write_vbrief(
            vbrief_dir,
            "active",
            "2026-04-29-600-closed.vbrief.json",
            issue_number=600,
        )
        # #754: default path uses fetch_issue_states (inverted lookup).
        monkeypatch.setattr(
            reconcile_issues,
            "fetch_issue_states",
            lambda _r, _ids, cwd=None: {},
        )
        monkeypatch.setattr(
            reconcile_issues, "detect_repo", lambda: "deftai/directive"
        )
        argv = [
            "reconcile_issues",
            "--vbrief-dir",
            str(vbrief_dir),
            "--repo",
            "deftai/directive",
            "--format",
            "json",
            "--apply-lifecycle-fixes",
        ]
        monkeypatch.setattr(sys, "argv", argv)
        rc = reconcile_issues.main()
        assert rc == 0
        # File moved to completed/.
        assert not src.is_file()
        assert (vbrief_dir / "completed" / src.name).is_file()
        err = capsys.readouterr().err
        assert "vBRIEFs reconciled" in err, (
            "apply-mode must emit a `[N/M] vBRIEFs reconciled` summary line"
        )


# ---------------------------------------------------------------------------
# Conflict handling
# ---------------------------------------------------------------------------


class TestConflictHandling:
    def test_target_already_exists_is_failure(self, vbrief_dir):
        """A pre-existing file in completed/ with the same name fails."""
        # Source in proposed/ for a closed issue.
        _write_vbrief(
            vbrief_dir,
            "proposed",
            "2026-04-29-700-conflict.vbrief.json",
            issue_number=700,
        )
        # Plant a same-named placeholder in completed/ (different content).
        existing = vbrief_dir / "completed" / "2026-04-29-700-conflict.vbrief.json"
        existing.parent.mkdir(parents=True, exist_ok=True)
        existing.write_text(
            '{"vBRIEFInfo": {"version": "0.6"}, "plan": {"title": "preexisting", '
            '"status": "completed", "items": [], "references": []}}\n',
            encoding="utf-8",
        )

        issue_to_vbriefs = reconcile_issues.scan_vbrief_dir(vbrief_dir)
        report = reconcile_issues.reconcile_with_unlinked(issue_to_vbriefs, [])
        moved, _skipped, failures = reconcile_issues.apply_lifecycle_fixes(
            vbrief_dir, report
        )
        assert moved == 0
        assert any("target already exists" in f for f in failures), (
            f"expected conflict failure; got: {failures!r}"
        )
