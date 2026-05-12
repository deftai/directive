"""tests/cli/test_install_manifest_root.py -- install_root manifest field (#1062).

Covers the Python-side helpers introduced under #1062 that extend the canonical
install manifest at ``<install>/VERSION`` (#1046 PR-B AC-4) with an
``install_root`` field carrying the relative POSIX-style path from the
consumer project root to the framework deposit. The field is the single
source of truth for the install-layout contract: every framework-side writer
rail (`cmd_install` / `cmd_upgrade`) records it via the same helper, and the
doctor consumer reads it as a manifest-first lookup with the legacy
AGENTS.md parse as a fallback.

Three test sections:

- ``TestBuildAndParseRoundTrip`` -- ``_build_install_manifest_text`` emits
  the field in the canonical YAML shape and ``_parse_install_manifest``
  round-trips it back without loss; the renderer also normalises bare
  ``X.Y.Z`` tags to ``vX.Y.Z`` (preserves the #1046 PR-B contract).
- ``TestDeriveInstallRootString`` -- POSIX-normalisation across canonical
  (``.deft/core``) and legacy (``deft``) install roots; defensive
  out-of-project-root fallback returns an absolute POSIX path.
- ``TestWriteInstallManifest`` -- end-to-end write of the manifest to a
  tmp_path tree exercises the caller-supplied ``project_root`` plumbing
  introduced for the #1062 wiring (so the derived ``install_root`` matches
  the deposit path the wizard chose, not the install-dir parent).

Story: #1062 (single source of truth for install-layout contract).
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_PATH = REPO_ROOT / "run"


def _load_run_module():
    """Re-load the extension-less ``run`` script as a Python module.

    Mirrors the pattern in ``tests/cli/test_run_version.py`` so the suite
    can call ``run`` helpers (``_build_install_manifest_text``,
    ``_parse_install_manifest``, ``_derive_install_root_string``,
    ``_write_install_manifest``) without invoking the full CLI.
    """
    loader = importlib.machinery.SourceFileLoader("deft_run_install_root_test", str(RUN_PATH))
    spec = importlib.util.spec_from_loader(
        "deft_run_install_root_test", loader, origin=str(RUN_PATH)
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(RUN_PATH)
    sys.modules["deft_run_install_root_test"] = module
    loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def run_mod():
    return _load_run_module()


# ---------------------------------------------------------------------------
# Build + parse round-trip
# ---------------------------------------------------------------------------


class TestBuildAndParseRoundTrip:
    """``_build_install_manifest_text`` <-> ``_parse_install_manifest``."""

    def test_install_root_included_in_rendered_text(self, run_mod):
        body = run_mod._build_install_manifest_text(
            tag="v0.28.0",
            sha="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            fetched_at="2026-05-12T02:08:16Z",
            fetched_by="run-install",
            install_root=".deft/core",
        )
        assert "install_root: '.deft/core'" in body
        # Canonical field order: ref / sha / tag / install_root / fetched_at / fetched_by.
        lines = [line.strip() for line in body.splitlines() if line.strip()]
        ordered_keys = [line.split(":", 1)[0] for line in lines]
        assert ordered_keys == [
            "ref",
            "sha",
            "tag",
            "install_root",
            "fetched_at",
            "fetched_by",
        ]

    def test_parse_recovers_install_root_field(self, run_mod):
        body = run_mod._build_install_manifest_text(
            tag="v0.28.0",
            sha="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            fetched_at="2026-05-12T02:08:16Z",
            fetched_by="run-install",
            install_root="deft",
        )
        parsed = run_mod._parse_install_manifest(body)
        assert parsed["install_root"] == "deft"
        assert parsed["tag"] == "v0.28.0"
        assert parsed["fetched_by"] == "run-install"

    def test_bare_tag_normalised_to_v_prefix(self, run_mod):
        """Mirrors the pre-existing #1046 PR-B contract -- a bare ``0.28.0``
        tag renders as ``v0.28.0`` in the file body even when the install_root
        field is present."""
        body = run_mod._build_install_manifest_text(
            tag="0.28.0",
            sha="abc",
            fetched_at="2026-05-12T02:08:16Z",
            fetched_by="run-install",
            install_root=".deft/core",
        )
        assert "tag: 'v0.28.0'" in body
        # ref defaults to the normalised tag when ``ref`` is None.
        assert "ref: 'v0.28.0'" in body

    def test_legacy_manifest_without_install_root_still_parses(self, run_mod):
        """Pre-v0.29 manifests omitted install_root entirely. The parser must
        still resolve the other fields so the doctor's fallback path can fire.
        """
        legacy_body = (
            "ref: 'v0.28.0'\n"
            "sha: 'abc'\n"
            "tag: 'v0.28.0'\n"
            "fetched_at: '2026-05-12T02:08:16Z'\n"
            "fetched_by: 'run-upgrade'\n"
        )
        parsed = run_mod._parse_install_manifest(legacy_body)
        assert parsed.get("install_root") is None
        assert parsed["tag"] == "v0.28.0"
        assert parsed["fetched_by"] == "run-upgrade"


# ---------------------------------------------------------------------------
# Derive install_root string
# ---------------------------------------------------------------------------


class TestDeriveInstallRootString:
    """POSIX-normalisation across canonical / legacy / out-of-tree paths."""

    def test_canonical_layout_renders_posix(self, run_mod, tmp_path):
        install_root = tmp_path / ".deft" / "core"
        install_root.mkdir(parents=True)
        got = run_mod._derive_install_root_string(install_root, tmp_path)
        assert got == ".deft/core"

    def test_legacy_layout_renders_posix(self, run_mod, tmp_path):
        install_root = tmp_path / "deft"
        install_root.mkdir(parents=True)
        got = run_mod._derive_install_root_string(install_root, tmp_path)
        assert got == "deft"

    def test_install_outside_project_root_falls_back_to_absolute_posix(self, run_mod, tmp_path):
        """Defensive case: ``relative_to`` raises ``ValueError`` when the
        install root is not under the project root. The helper still
        populates the manifest field with an absolute POSIX path so the
        record is never empty.
        """
        project_root = tmp_path / "consumer"
        project_root.mkdir()
        install_root = tmp_path / "elsewhere" / "framework"
        install_root.mkdir(parents=True)
        got = run_mod._derive_install_root_string(install_root, project_root)
        # The helper falls back to ``install_root.resolve().as_posix()`` --
        # forward slashes only, regardless of host OS.
        assert "/" in got
        assert "elsewhere" in got


# ---------------------------------------------------------------------------
# Write helper with caller-supplied project_root
# ---------------------------------------------------------------------------


class TestWriteInstallManifest:
    """End-to-end write of the manifest with the #1062 install_root plumbing."""

    def test_write_records_canonical_install_root(self, run_mod, tmp_path):
        project_root = tmp_path / "consumer"
        install_root = project_root / ".deft" / "core"
        install_root.mkdir(parents=True)
        path = run_mod._write_install_manifest(
            install_root,
            fetched_by="run-install",
            project_root=project_root,
            tag="v0.28.0",
            sha="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            fetched_at="2026-05-12T02:08:16Z",
        )
        assert path is not None
        body = Path(path).read_text(encoding="utf-8")
        assert "install_root: '.deft/core'" in body
        assert "fetched_by: 'run-install'" in body

    def test_write_records_legacy_install_root(self, run_mod, tmp_path):
        project_root = tmp_path / "consumer"
        install_root = project_root / "deft"
        install_root.mkdir(parents=True)
        path = run_mod._write_install_manifest(
            install_root,
            fetched_by="run-upgrade",
            project_root=project_root,
            tag="v0.28.0",
            sha="abc",
            fetched_at="2026-05-12T02:08:16Z",
        )
        body = Path(path).read_text(encoding="utf-8")
        assert "install_root: 'deft'" in body

    def test_write_defaults_project_root_to_install_root_parent(self, run_mod, tmp_path):
        """When project_root is omitted, the helper falls back to
        ``install_root.parent``. The derived install_root field then renders
        as just the basename (``core``) -- callers SHOULD pass an explicit
        project_root, but the helper must still produce a non-empty value
        rather than raising.
        """
        install_root = tmp_path / ".deft" / "core"
        install_root.mkdir(parents=True)
        path = run_mod._write_install_manifest(
            install_root,
            fetched_by="run-install",
            tag="v0.28.0",
            sha="abc",
            fetched_at="2026-05-12T02:08:16Z",
        )
        body = Path(path).read_text(encoding="utf-8")
        # ``install_root.parent`` is ``.deft/``; relative_to renders ``core``.
        assert "install_root: 'core'" in body


# ---------------------------------------------------------------------------
# Doctor fallback path on legacy-shape manifests
# ---------------------------------------------------------------------------


def _load_doctor_module():
    """Load ``scripts/framework_doctor.py`` for the doctor-side fallback tests."""
    doctor_path = REPO_ROOT / "scripts" / "framework_doctor.py"
    spec = importlib.util.spec_from_file_location("framework_doctor_install_root", doctor_path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["framework_doctor_install_root"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def doctor_mod():
    return _load_doctor_module()


def _write_agents_md(project_root: Path, install_root: str = ".deft/core") -> None:
    (project_root / "AGENTS.md").write_text(
        (
            "# Project AGENTS.md\n"
            f"Deft is installed in {install_root}/.\n"
            f"Full guidelines: {install_root}/main.md\n"
            "<!-- deft:managed-section v3 -->\n"
            "# Deft\n"
            f"See {install_root}/skills/deft-directive-setup/SKILL.md for setup.\n"
            "<!-- /deft:managed-section -->\n"
        ),
        encoding="utf-8",
    )


def _make_install_tree(project_root: Path, install_root: str) -> Path:
    install = project_root / install_root
    install.mkdir(parents=True, exist_ok=True)
    return install


def _write_manifest(install_dir: Path, *, install_root: str | None) -> None:
    """Write a v0.28-shape manifest at ``<install_dir>/VERSION``."""
    lines = [
        "ref: 'v0.28.0'",
        "sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'",
        "tag: 'v0.28.0'",
    ]
    if install_root is not None:
        lines.append(f"install_root: '{install_root}'")
    lines.append("fetched_at: '2026-05-12T02:08:16Z'")
    lines.append("fetched_by: 'run-install'")
    (install_dir / "VERSION").write_text("\n".join(lines) + "\n", encoding="utf-8")


class TestDoctorInstallRootFallback:
    """``_check_install_path_consistency`` prefers the manifest field (#1062)."""

    def test_manifest_install_root_field_wins_over_agents_md(self, doctor_mod, tmp_path):
        # The manifest declares `.deft/core` -- the doctor must trust the
        # manifest AND label the source so operators reading the diagnostic
        # are pointed at the right artifact (Greptile P1 on PR #1063).
        _write_agents_md(tmp_path, install_root=".deft/core")
        install = _make_install_tree(tmp_path, ".deft/core")
        _write_manifest(install, install_root=".deft/core")
        result = doctor_mod.run_checks(tmp_path)
        check = next(
            c for c in result["checks"] if c["name"] == "install-path-consistency"
        )
        assert check["status"] == "pass"
        assert check["data"]["effective_install_root"] == ".deft/core"
        assert check["data"]["effective_install_root_source"] == "manifest"
        # Pass detail names the source explicitly (verbatim phrasing).
        assert "source: manifest" in check["detail"]
        assert check["data"]["fallback_info_note"] is None

    def test_legacy_manifest_without_install_root_falls_back_with_info_note(
        self, doctor_mod, tmp_path
    ):
        # The legacy v0.28 shape omits install_root entirely. The doctor must
        # fall back to the AGENTS.md parse AND emit an INFO note so operators
        # can see when the fallback fired. The source label MUST be
        # ``AGENTS.md`` so the diagnostic does not falsely credit the
        # manifest (Greptile P1 on PR #1063).
        _write_agents_md(tmp_path, install_root=".deft/core")
        install = _make_install_tree(tmp_path, ".deft/core")
        _write_manifest(install, install_root=None)
        result = doctor_mod.run_checks(tmp_path)
        check = next(
            c for c in result["checks"] if c["name"] == "install-path-consistency"
        )
        assert check["status"] == "pass"
        # AGENTS.md is the source of the resolved install root.
        assert check["data"]["effective_install_root"] == ".deft/core"
        assert check["data"]["effective_install_root_source"] == "AGENTS.md"
        assert "source: AGENTS.md" in check["detail"]
        info = check["data"]["fallback_info_note"]
        assert info is not None
        assert "INFO" in info
        assert "install_root" in info

    def test_no_manifest_keeps_legacy_agents_md_behaviour(self, doctor_mod, tmp_path):
        # No manifest anywhere -- the doctor's previous behaviour (parse
        # AGENTS.md, no INFO note, status driven by directory existence) is
        # preserved. Source label is ``AGENTS.md`` since that is where the
        # install root came from.
        _write_agents_md(tmp_path, install_root=".deft/core")
        _make_install_tree(tmp_path, ".deft/core")
        result = doctor_mod.run_checks(tmp_path)
        check = next(
            c for c in result["checks"] if c["name"] == "install-path-consistency"
        )
        assert check["status"] == "pass"
        assert check["data"]["effective_install_root"] == ".deft/core"
        assert check["data"]["effective_install_root_source"] == "AGENTS.md"
        assert check["data"]["fallback_info_note"] is None

    def test_fail_detail_names_manifest_source_when_dir_missing(
        self, doctor_mod, tmp_path
    ):
        # Greptile P1 regression: when the manifest provides the install_root
        # but the directory does not exist, the FAIL detail must name the
        # manifest as the source -- not say "AGENTS.md claims ...".
        _write_agents_md(tmp_path, install_root=".deft/core")
        # Write the manifest at .deft/core but DO NOT also create a directory
        # at the manifest-declared install_root (we point it at a different
        # path that does not resolve).
        install = _make_install_tree(tmp_path, ".deft/core")
        _write_manifest(install, install_root="does/not/exist")
        result = doctor_mod.run_checks(tmp_path)
        check = next(
            c for c in result["checks"] if c["name"] == "install-path-consistency"
        )
        assert check["status"] == "fail"
        assert check["data"]["effective_install_root"] == "does/not/exist"
        assert check["data"]["effective_install_root_source"] == "manifest"
        assert "source: manifest" in check["detail"]
        # Regression-pin: prose must not falsely blame AGENTS.md.
        assert "AGENTS.md claims" not in check["detail"]
