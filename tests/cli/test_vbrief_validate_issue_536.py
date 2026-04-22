"""test_vbrief_validate_issue_536.py -- Tests for #536 validator fixes.

Covers:
- D11 origin provenance: schema-trusting default (any ``^x-vbrief/`` counts),
  ``--strict-origin-types`` flag for allow-list enforcement, and legacy bare
  type fallback (``github-issue`` etc.).
- Exit code semantics: exit 0 when only warnings are present; exit 1 with
  ``--warnings-as-errors``.
- "OK" banner is suppressed when exit code is non-zero.
- Dual-version acceptance (v0.5 + v0.6) during the transition window (#533).

Part of #536 (validator D11 schema-trusting, exit code semantics) and #533
(v0.5 -> v0.6 transition window).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


def _load_vbrief_validate():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "vbrief_validate_issue536",
        scripts_dir / "vbrief_validate.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vv = _load_vbrief_validate()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_lifecycle_dirs(vbrief_dir: Path) -> None:
    for folder in vv.LIFECYCLE_FOLDERS:
        (vbrief_dir / folder).mkdir(parents=True, exist_ok=True)


def _write_scope(
    vbrief_dir: Path,
    folder: str,
    filename: str,
    references: list[dict] | None = None,
    version: str = "0.6",
    status: str = "pending",
) -> Path:
    plan = {
        "title": "Scope T",
        "status": status,
        "items": [],
    }
    if references is not None:
        plan["references"] = references
    doc = {"vBRIEFInfo": {"version": version}, "plan": plan}
    path = vbrief_dir / folder / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


# ===========================================================================
# D11 origin provenance (#536 Defect 1)
# ===========================================================================


class TestOriginProvenanceSchemaTrusting:
    """Default behavior: any reference with ``type`` matching ``^x-vbrief/``
    counts as an origin. The canonical v0.6 shape
    (``x-vbrief/github-issue``) MUST NOT trigger a D11 warning."""

    def test_x_vbrief_github_issue_counts(self, tmp_path):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        fp = _write_scope(
            vd,
            "pending",
            "2026-04-22-has-gh-issue.vbrief.json",
            references=[
                {
                    "uri": "https://github.com/o/r/issues/1",
                    "type": "x-vbrief/github-issue",
                    "title": "Issue #1",
                }
            ],
        )
        data = json.loads(fp.read_text())
        warns = vv.validate_origin_provenance(fp, data, vd)
        assert warns == []

    def test_x_vbrief_arbitrary_suffix_counts(self, tmp_path):
        """Any `^x-vbrief/` value counts by default (schema-trusting)."""
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        fp = _write_scope(
            vd,
            "active",
            "2026-04-22-custom-type.vbrief.json",
            status="running",
            references=[
                {
                    "uri": "https://example.com/whatever",
                    "type": "x-vbrief/custom-team-type",
                }
            ],
        )
        data = json.loads(fp.read_text())
        warns = vv.validate_origin_provenance(fp, data, vd)
        assert warns == []

    def test_no_references_warns(self, tmp_path):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        fp = _write_scope(
            vd,
            "pending",
            "2026-04-22-no-refs.vbrief.json",
            references=[],
        )
        data = json.loads(fp.read_text())
        warns = vv.validate_origin_provenance(fp, data, vd)
        assert any("(D11)" in w for w in warns)

    def test_non_x_vbrief_type_warns(self, tmp_path):
        """Non-legacy, non-x-vbrief types do not count as origins."""
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        fp = _write_scope(
            vd,
            "pending",
            "2026-04-22-wrong-type.vbrief.json",
            references=[
                {
                    "uri": "https://example.com/x",
                    "type": "web",
                }
            ],
        )
        data = json.loads(fp.read_text())
        warns = vv.validate_origin_provenance(fp, data, vd)
        assert any("(D11)" in w for w in warns)

    def test_legacy_bare_github_issue_still_counts(self, tmp_path):
        """Pre-migration vBRIEFs with bare `github-issue` types keep working."""
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        fp = _write_scope(
            vd,
            "pending",
            "2026-04-22-legacy.vbrief.json",
            references=[{"type": "github-issue", "url": "https://x", "id": "#1"}],
        )
        data = json.loads(fp.read_text())
        warns = vv.validate_origin_provenance(fp, data, vd)
        assert warns == []

    def test_proposed_folder_skipped(self, tmp_path):
        """D11 only applies to pending/ and active/."""
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        fp = _write_scope(
            vd,
            "proposed",
            "2026-04-22-proposed.vbrief.json",
            references=[],
            status="draft",
        )
        data = json.loads(fp.read_text())
        assert vv.validate_origin_provenance(fp, data, vd) == []


class TestOriginProvenanceStrict:
    """With --strict-origin-types, only the registered allow-list counts."""

    def test_x_vbrief_github_issue_still_counts(self, tmp_path):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        fp = _write_scope(
            vd,
            "pending",
            "2026-04-22-strict-allowed.vbrief.json",
            references=[
                {
                    "uri": "https://github.com/o/r/issues/1",
                    "type": "x-vbrief/github-issue",
                }
            ],
        )
        data = json.loads(fp.read_text())
        warns = vv.validate_origin_provenance(fp, data, vd, strict_origin_types=True)
        assert warns == []

    def test_custom_x_vbrief_type_warns_in_strict(self, tmp_path):
        """In strict mode an unregistered x-vbrief/* type triggers D11."""
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        fp = _write_scope(
            vd,
            "pending",
            "2026-04-22-strict-custom.vbrief.json",
            references=[
                {
                    "uri": "https://example.com/x",
                    "type": "x-vbrief/custom-team-type",
                }
            ],
        )
        data = json.loads(fp.read_text())
        warns = vv.validate_origin_provenance(fp, data, vd, strict_origin_types=True)
        assert any("(D11" in w and "allow-listed" in w for w in warns)

    def test_legacy_bare_type_still_counts_in_strict(self, tmp_path):
        """Pre-migration vBRIEFs do not regress when strict mode is enabled."""
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        fp = _write_scope(
            vd,
            "pending",
            "2026-04-22-strict-legacy.vbrief.json",
            references=[{"type": "github-issue", "url": "https://x"}],
        )
        data = json.loads(fp.read_text())
        warns = vv.validate_origin_provenance(fp, data, vd, strict_origin_types=True)
        assert warns == []


# ===========================================================================
# Exit code semantics (#536 Defect 2)
# ===========================================================================


class TestExitCodes:
    """main() must exit 0 on warnings-only and 1 only when errors exist.

    With --warnings-as-errors, warnings escalate to exit 1. The "OK" banner
    is suppressed whenever the process will exit non-zero.
    """

    def _seed_with_origin_warning(self, tmp_path: Path) -> Path:
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        # Valid schema, but no origin references -> D11 warning.
        _write_scope(
            vd,
            "pending",
            "2026-04-22-needs-origin.vbrief.json",
            references=[],
        )
        return vd

    def test_warnings_only_exits_zero(self, tmp_path, capsys):
        vd = self._seed_with_origin_warning(tmp_path)
        rc = vv.main(["--vbrief-dir", str(vd)])
        captured = capsys.readouterr()
        assert rc == 0
        assert "WARN:" in captured.out
        assert "OK: vBRIEF validation passed" in captured.out

    def test_warnings_as_errors_exits_one(self, tmp_path, capsys):
        vd = self._seed_with_origin_warning(tmp_path)
        rc = vv.main(
            [
                "--vbrief-dir",
                str(vd),
                "--warnings-as-errors",
            ]
        )
        captured = capsys.readouterr()
        assert rc == 1
        # OK banner MUST NOT appear on a non-zero exit (#536 Defect 2).
        assert "OK: vBRIEF validation passed" not in captured.out
        assert "treated as errors" in captured.out

    def test_real_error_exits_one(self, tmp_path, capsys):
        vd = tmp_path / "vbrief"
        _make_lifecycle_dirs(vd)
        # Invalid schema: missing required plan fields.
        bad = {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {"status": "pending"},
        }
        path = vd / "pending" / "2026-04-22-broken.vbrief.json"
        path.write_text(json.dumps(bad), encoding="utf-8")
        rc = vv.main(["--vbrief-dir", str(vd)])
        captured = capsys.readouterr()
        assert rc == 1
        assert "OK: vBRIEF validation passed" not in captured.out
        assert "FAIL:" in captured.out

    def test_strict_origin_flag_parses(self, tmp_path, capsys):
        vd = self._seed_with_origin_warning(tmp_path)
        rc = vv.main(
            [
                "--vbrief-dir",
                str(vd),
                "--strict-origin-types",
            ]
        )
        captured = capsys.readouterr()
        assert rc == 0  # warning still present, but exit 0
        assert "allow-listed" in captured.out

    def test_unknown_flag_exits_two(self, tmp_path, capsys):
        rc = vv.main(["--does-not-exist"])
        assert rc == 2

    def test_missing_vbrief_dir_exits_zero(self, tmp_path, capsys):
        rc = vv.main(["--vbrief-dir", str(tmp_path / "nope")])
        assert rc == 0


# ===========================================================================
# Strict v0.6-only acceptance (#533)
# ===========================================================================


class TestStrictV06Acceptance:
    def test_v0_6_accepted(self):
        doc = {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {"title": "T", "status": "draft", "items": []},
        }
        assert vv.validate_vbrief_schema(doc, "f.json") == []

    def test_v0_5_rejected(self):
        """v0.5 is no longer accepted -- migrator sweep handles upgrades (#533)."""
        doc = {
            "vBRIEFInfo": {"version": "0.5"},
            "plan": {"title": "T", "status": "draft", "items": []},
        }
        errs = vv.validate_vbrief_schema(doc, "f.json")
        assert any("0.6" in e for e in errs)

    def test_unknown_version_rejected(self):
        doc = {
            "vBRIEFInfo": {"version": "0.7"},
            "plan": {"title": "T", "status": "draft", "items": []},
        }
        errs = vv.validate_vbrief_schema(doc, "f.json")
        assert any("0.6" in e for e in errs)

    def test_failed_status_accepted(self):
        """v0.6 adds `failed` as a Status enum value."""
        doc = {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {"title": "T", "status": "failed", "items": []},
        }
        assert vv.validate_vbrief_schema(doc, "f.json") == []
