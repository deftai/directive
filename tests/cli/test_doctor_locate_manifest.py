"""tests/cli/test_doctor_locate_manifest.py -- canonical-first manifest probe (#1427).

The install provenance manifest is written to divergent paths by two install
rails: the Go installer writes the canonical ``.deft/core/VERSION`` (#1062),
while the webinstaller writes ``.deft/VERSION`` (a 5-field manifest that omits
the ``install_root`` field). Before #1427 the doctor only read
``.deft/core/VERSION`` / legacy ``deft/VERSION``, so a webinstaller-vendored
install was invisible to ``manifest-agreement``, ``install-path-consistency``,
and the #1339 payload-staleness handoff.

These tests pin:
  * ``_manifest_candidate_paths`` / ``_locate_manifest`` canonical-first ordering
    (``<install_root>/VERSION`` > ``.deft/core/VERSION`` > ``.deft/VERSION`` >
    ``deft/VERSION``), de-duplication, and first-existing-wins.
  * ``.deft/VERSION`` detection across all three read paths, AND that an
    existing canonical ``.deft/core/VERSION`` still wins over a stale
    ``.deft/VERSION``.

The ``doctor_module`` fixture (tests/conftest.py) loads ``scripts/doctor.py``.
Refs #1427, #1428, #1062, #1339.
"""

from __future__ import annotations

from pathlib import Path


def _write(path: Path, body: str) -> None:
    """Create parents and write ``body`` (UTF-8) to ``path``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


# ---------------------------------------------------------------------------
# _manifest_candidate_paths -- pure ordering / dedup contract
# ---------------------------------------------------------------------------


class TestManifestCandidatePaths:
    def test_ordering_with_install_root(self, doctor_module, tmp_path):
        cands = doctor_module._manifest_candidate_paths(tmp_path, "custom/root")
        assert cands == [
            tmp_path / "custom" / "root" / "VERSION",
            tmp_path / ".deft" / "core" / "VERSION",
            tmp_path / ".deft" / "VERSION",
            tmp_path / "deft" / "VERSION",
        ]

    def test_ordering_without_install_root(self, doctor_module, tmp_path):
        cands = doctor_module._manifest_candidate_paths(tmp_path, None)
        assert cands == [
            tmp_path / ".deft" / "core" / "VERSION",
            tmp_path / ".deft" / "VERSION",
            tmp_path / "deft" / "VERSION",
        ]

    def test_dedup_when_install_root_is_canonical(self, doctor_module, tmp_path):
        # install_root == ".deft/core" must NOT produce a duplicate
        # .deft/core/VERSION probe entry.
        cands = doctor_module._manifest_candidate_paths(tmp_path, ".deft/core")
        assert cands == [
            tmp_path / ".deft" / "core" / "VERSION",
            tmp_path / ".deft" / "VERSION",
            tmp_path / "deft" / "VERSION",
        ]

    def test_deft_version_precedes_legacy_deft(self, doctor_module, tmp_path):
        # Canonical-first: .deft/VERSION (webinstaller) is probed before the
        # pre-v0.27 legacy deft/VERSION.
        cands = doctor_module._manifest_candidate_paths(tmp_path, None)
        assert cands.index(tmp_path / ".deft" / "VERSION") < cands.index(
            tmp_path / "deft" / "VERSION"
        )


# ---------------------------------------------------------------------------
# _locate_manifest -- first-existing-wins, canonical-first
# ---------------------------------------------------------------------------


class TestLocateManifest:
    def test_returns_none_when_no_manifest(self, doctor_module, tmp_path):
        assert doctor_module._locate_manifest(tmp_path, ".deft/core") is None

    def test_finds_deft_version(self, doctor_module, tmp_path):
        _write(tmp_path / ".deft" / "VERSION", "tag: v0.39.2\n")
        assert doctor_module._locate_manifest(tmp_path, None) == (
            tmp_path / ".deft" / "VERSION"
        )

    def test_canonical_core_wins_over_deft_version(self, doctor_module, tmp_path):
        _write(tmp_path / ".deft" / "core" / "VERSION", "tag: v0.39.2\n")
        _write(tmp_path / ".deft" / "VERSION", "tag: v0.0.1\n")
        assert doctor_module._locate_manifest(tmp_path, None) == (
            tmp_path / ".deft" / "core" / "VERSION"
        )

    def test_install_root_manifest_wins_when_present(self, doctor_module, tmp_path):
        _write(tmp_path / "custom" / "VERSION", "tag: v0.39.2\n")
        _write(tmp_path / ".deft" / "core" / "VERSION", "tag: v0.0.1\n")
        assert doctor_module._locate_manifest(tmp_path, "custom") == (
            tmp_path / "custom" / "VERSION"
        )

    def test_legacy_deft_version_is_last_resort(self, doctor_module, tmp_path):
        _write(tmp_path / "deft" / "VERSION", "tag: v0.39.2\n")
        assert doctor_module._locate_manifest(tmp_path, None) == (
            tmp_path / "deft" / "VERSION"
        )


# ---------------------------------------------------------------------------
# manifest-agreement (check #3) -- .deft/VERSION detection
# ---------------------------------------------------------------------------


class TestManifestAgreementDeftVersion:
    def test_pass_when_deft_version_agrees_with_bare(self, doctor_module, tmp_path):
        # Webinstaller case: manifest lives at .deft/VERSION and AGENTS.md
        # declares no install root (install_root=None). Pre-#1427 this
        # skipped (early install_root-None return); now it is reconciled.
        _write(
            tmp_path / ".deft" / "VERSION",
            "ref: 'v0.39.2'\nsha: 'deadbeef'\ntag: 'v0.39.2'\n",
        )
        _write(tmp_path / ".deft-version", "0.39.2\n")
        check = doctor_module._check_manifest_agreement(tmp_path, None)
        assert check.status == "pass", check.detail
        assert check.data["manifest_path"].replace("\\", "/").endswith(
            ".deft/VERSION"
        )

    def test_fail_drift_with_deft_version(self, doctor_module, tmp_path):
        _write(
            tmp_path / ".deft" / "VERSION",
            "ref: 'v0.39.2'\nsha: 'deadbeef'\ntag: 'v0.39.2'\n",
        )
        _write(tmp_path / ".deft-version", "0.38.0\n")
        check = doctor_module._check_manifest_agreement(tmp_path, None)
        assert check.status == "fail", check.detail
        assert check.data["authoritative"] == "manifest"

    def test_dual_manifest_disagreement_flagged(self, doctor_module, tmp_path):
        # #1325: when BOTH the canonical .deft/core/VERSION (0.39.2) and a
        # stale legacy .deft/VERSION (0.0.1) exist AND disagree, the check
        # FAILS (was: canonical silently won). The stale parent-level file is
        # a source-of-truth hazard that `task upgrade` migrates.
        _write(tmp_path / ".deft" / "core" / "VERSION", "tag: 'v0.39.2'\n")
        _write(tmp_path / ".deft" / "VERSION", "tag: 'v0.0.1'\n")
        _write(tmp_path / ".deft-version", "0.39.2\n")
        check = doctor_module._check_manifest_agreement(tmp_path, None)
        assert check.status == "fail", check.detail
        assert check.data["dual_manifest_drift"] is True
        assert check.data["core_version"] == "0.39.2"
        assert check.data["legacy_version"] == "0.0.1"

    def test_dual_manifest_agreement_passes(self, doctor_module, tmp_path):
        # When both manifests AGREE (same version), there is no stale
        # source-of-truth -- the canonical-vs-bare reconciliation proceeds
        # and PASSES against a matching bare marker.
        _write(tmp_path / ".deft" / "core" / "VERSION", "tag: 'v0.39.2'\n")
        _write(tmp_path / ".deft" / "VERSION", "tag: 'v0.39.2'\n")
        _write(tmp_path / ".deft-version", "0.39.2\n")
        check = doctor_module._check_manifest_agreement(tmp_path, None)
        assert check.status == "pass", check.detail
        assert check.data["manifest_path"].replace("\\", "/").endswith(
            ".deft/core/VERSION"
        )


# ---------------------------------------------------------------------------
# install-path-consistency (check #4) -- .deft/VERSION detection
# ---------------------------------------------------------------------------


class TestInstallPathConsistencyDeftVersion:
    def test_reads_install_root_from_deft_version(self, doctor_module, tmp_path):
        # A webinstaller .deft/VERSION that DOES carry install_root is now
        # consulted (pre-#1427 only .deft/core/VERSION + deft/VERSION were).
        _write(
            tmp_path / ".deft" / "VERSION",
            "ref: 'v0.39.2'\ntag: 'v0.39.2'\ninstall_root: '.deft/core'\n",
        )
        (tmp_path / ".deft" / "core").mkdir(parents=True, exist_ok=True)
        check = doctor_module._check_install_path_consistency(tmp_path, None)
        assert check.status == "pass", check.detail
        assert check.data["effective_install_root"] == ".deft/core"
        assert check.data["effective_install_root_source"] == "manifest"

    def test_canonical_core_version_wins_over_deft_version(
        self, doctor_module, tmp_path
    ):
        # .deft/core/VERSION (install_root .deft/core) must win over a stale
        # .deft/VERSION (install_root .deft/legacy).
        _write(
            tmp_path / ".deft" / "core" / "VERSION",
            "tag: 'v0.39.2'\ninstall_root: '.deft/core'\n",
        )
        _write(
            tmp_path / ".deft" / "VERSION",
            "tag: 'v0.0.1'\ninstall_root: '.deft/legacy'\n",
        )
        check = doctor_module._check_install_path_consistency(tmp_path, None)
        assert check.data["effective_install_root"] == ".deft/core"
        assert check.data["effective_install_root_source"] == "manifest"

    def test_unreadable_manifest_falls_through_to_next_candidate(
        self, doctor_module, tmp_path, monkeypatch
    ):
        # An existing-but-unreadable canonical .deft/core/VERSION (OSError /
        # permission denial -> _read_text_safe returns None) MUST NOT stop
        # the probe; the check falls through to the next readable candidate
        # (.deft/VERSION). Regression for the Greptile P2 on PR #1431 that
        # restored the old two-path loop's continue-on-unreadable behavior.
        _write(
            tmp_path / ".deft" / "core" / "VERSION",
            "tag: 'v0.0.1'\ninstall_root: '.deft/core'\n",
        )
        _write(
            tmp_path / ".deft" / "VERSION",
            "tag: 'v0.39.2'\ninstall_root: '.deft/legacy'\n",
        )
        (tmp_path / ".deft" / "legacy").mkdir(parents=True, exist_ok=True)
        real_read = doctor_module._read_text_safe

        def _fake_read(path):
            # Simulate the canonical manifest existing but being unreadable.
            if str(path).replace("\\", "/").endswith(".deft/core/VERSION"):
                return None
            return real_read(path)

        monkeypatch.setattr(doctor_module, "_read_text_safe", _fake_read)
        check = doctor_module._check_install_path_consistency(tmp_path, None)
        assert check.status == "pass", check.detail
        assert check.data["effective_install_root"] == ".deft/legacy"
        assert check.data["effective_install_root_source"] == "manifest"


# ---------------------------------------------------------------------------
# payload-staleness (#1339) -- .deft/VERSION detection
# ---------------------------------------------------------------------------


class _FakeProc:
    """Minimal stand-in for ``subprocess.run`` output (returncode + stdout)."""

    def __init__(self, stdout: str, returncode: int = 0) -> None:
        self.stdout = stdout
        self.returncode = returncode


def _collect_staleness(doctor_module, project_root: Path):
    findings: list[dict] = []
    warnings: list[str] = []

    def _add_finding(severity: str, message: str, **extras: object) -> None:
        entry: dict[str, object] = {"severity": severity, "message": message}
        entry.update(extras)
        findings.append(entry)

    doctor_module._run_payload_staleness_check(
        project_root,
        emit_warn=warnings.append,
        emit_info=lambda _m: None,
        add_finding=_add_finding,
    )
    return warnings, findings


class TestPayloadStalenessDeftVersion:
    def test_stale_detected_from_deft_version(
        self, doctor_module, tmp_path, monkeypatch
    ):
        # Webinstaller manifest at .deft/VERSION (NOT .deft/core/VERSION).
        _write(
            tmp_path / ".deft" / "VERSION",
            "sha: " + "1" * 40 + "\nref: master\ntag: v0.39.2\n",
        )
        # Force the "manifest next to doctor.py" probe to miss so the
        # project-root fallback (which now includes .deft/VERSION) runs.
        monkeypatch.setattr(
            doctor_module, "get_script_dir", lambda: tmp_path / "no-such-scripts"
        )
        # Remote sha differs -> stale.
        monkeypatch.setattr(
            doctor_module.subprocess,
            "run",
            lambda *a, **k: _FakeProc("2" * 40 + "\trefs/heads/master\n"),
        )
        warnings, findings = _collect_staleness(doctor_module, tmp_path)
        assert [f for f in findings if f.get("status") == "stale"], findings
        assert any("deft-install" in w for w in warnings), warnings

    def test_current_from_deft_version_emits_no_stale(
        self, doctor_module, tmp_path, monkeypatch
    ):
        _write(
            tmp_path / ".deft" / "VERSION",
            "sha: " + "a" * 40 + "\nref: master\ntag: v0.39.2\n",
        )
        monkeypatch.setattr(
            doctor_module, "get_script_dir", lambda: tmp_path / "no-such-scripts"
        )
        # Remote sha matches -> current, not stale.
        monkeypatch.setattr(
            doctor_module.subprocess,
            "run",
            lambda *a, **k: _FakeProc("a" * 40 + "\trefs/heads/master\n"),
        )
        _warnings, findings = _collect_staleness(doctor_module, tmp_path)
        assert not [f for f in findings if f.get("status") == "stale"], findings
