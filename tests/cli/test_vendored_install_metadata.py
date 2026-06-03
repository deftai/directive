"""tests/cli/test_vendored_install_metadata.py -- vendored-install metadata fixes.

Regression coverage for the four tightly-coupled vendored-install metadata
bugs that all share one root cause: on a vendored ``.deft/core/`` install
with no nested ``.git``, no canonical version metadata was resolvable, so the
framework fell back to the CONSUMER repo's git context (wrong version, wrong
upstream, wrong sha) or left stale manifests behind.

Issues:
- #1323 -- version resolver returned ``0.0.0-dev`` on vendored installs;
  the chain now reads ``<install>/VERSION`` (tag/ref) and
  ``<install>/.deft-version`` before falling back to ``git describe``.
- #1320 -- ``framework:check-updates`` probed the consumer origin; it now
  resolves the upstream from the manifest ``url`` field or the baked-in
  ``DEFT_UPSTREAM_URL`` constant and NEVER the consumer's origin, and reads
  ``current`` from the manifest before the in-process ``VERSION``.
- #1332 -- ``_resolve_framework_sha`` now reads the manifest ``sha`` first;
  the doctor redirect-stub detection keys on file SHAPE not substring.
- #1325 -- ``cmd_upgrade`` migrates a stale legacy ``.deft/VERSION`` and the
  doctor manifest-agreement check flags two manifests that disagree.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_PATH = REPO_ROOT / "run"
DOCTOR_PATH = REPO_ROOT / "scripts" / "doctor.py"
RESOLVE_VERSION_PATH = REPO_ROOT / "scripts" / "resolve_version.py"


def _load_run_module() -> ModuleType:
    loader = importlib.machinery.SourceFileLoader(
        "deft_run_vendored_test", str(RUN_PATH)
    )
    spec = importlib.util.spec_from_loader(
        "deft_run_vendored_test", loader, origin=str(RUN_PATH)
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(RUN_PATH)
    sys.modules["deft_run_vendored_test"] = module
    loader.exec_module(module)
    return module


def _load_doctor_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "doctor_vendored_test", DOCTOR_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["doctor_vendored_test"] = module
    spec.loader.exec_module(module)
    return module


def _load_resolve_version_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "resolve_version_vendored_test", RESOLVE_VERSION_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["resolve_version_vendored_test"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def run_mod() -> ModuleType:
    return _load_run_module()


@pytest.fixture(scope="module")
def doctor_mod() -> ModuleType:
    return _load_doctor_module()


@pytest.fixture(scope="module")
def rv_mod() -> ModuleType:
    return _load_resolve_version_module()


def _write_manifest(
    install_dir: Path,
    *,
    tag: str = "v0.27.1",
    sha: str = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    url: str | None = None,
    install_root: str | None = None,
) -> Path:
    install_dir.mkdir(parents=True, exist_ok=True)
    lines = [f"ref: '{tag}'", f"sha: '{sha}'", f"tag: '{tag}'"]
    if install_root is not None:
        lines.append(f"install_root: '{install_root}'")
    if url is not None:
        lines.append(f"url: '{url}'")
    lines.append("fetched_at: '2026-05-11T15:30:52Z'")
    lines.append("fetched_by: 'run-install'")
    path = install_dir / "VERSION"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# #1323 -- version resolver chain extension
# ---------------------------------------------------------------------------


class TestResolverManifestBranch:
    """run::_version_from_install_manifest + .deft-version precedence (#1323)."""

    def test_manifest_tag_parsed(self, run_mod, tmp_path):
        _write_manifest(tmp_path, tag="v1.2.3")
        assert run_mod._version_from_install_manifest(tmp_path) == "1.2.3"

    def test_manifest_ref_parsed_when_only_ref(self, run_mod, tmp_path):
        (tmp_path / "VERSION").write_text("ref: 'v2.3.4'\n", encoding="utf-8")
        assert run_mod._version_from_install_manifest(tmp_path) == "2.3.4"

    def test_manifest_absent_returns_none(self, run_mod, tmp_path):
        assert run_mod._version_from_install_manifest(tmp_path) is None

    def test_deft_version_file_strips_leading_v(self, run_mod, tmp_path):
        (tmp_path / ".deft-version").write_text("v3.4.5\n", encoding="utf-8")
        assert run_mod._version_from_deft_version_file(tmp_path) == "3.4.5"

    def test_deft_version_absent_returns_none(self, run_mod, tmp_path):
        assert run_mod._version_from_deft_version_file(tmp_path) is None

    def test_env_wins_over_manifest(self, run_mod, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "9.9.9")

        def _forbidden(*a, **k):
            raise AssertionError("manifest must not be read when env is set")

        monkeypatch.setattr(run_mod, "_version_from_install_manifest", _forbidden)
        assert run_mod._resolve_version() == "9.9.9"

    def test_manifest_wins_over_deft_version_and_git(self, run_mod, monkeypatch):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)
        monkeypatch.setattr(
            run_mod, "_version_from_install_manifest", lambda d: "1.1.1"
        )

        def _forbidden_git(*a, **k):
            raise AssertionError("git must not run when manifest resolves")

        monkeypatch.setattr(run_mod.subprocess, "run", _forbidden_git)
        assert run_mod._resolve_version() == "1.1.1"

    def test_deft_version_wins_over_git(self, run_mod, monkeypatch):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)
        monkeypatch.setattr(
            run_mod, "_version_from_install_manifest", lambda d: None
        )
        monkeypatch.setattr(
            run_mod, "_version_from_deft_version_file", lambda d: "2.2.2"
        )

        def _forbidden_git(*a, **k):
            raise AssertionError("git must not run when .deft-version resolves")

        monkeypatch.setattr(run_mod.subprocess, "run", _forbidden_git)
        assert run_mod._resolve_version() == "2.2.2"


class TestResolveVersionScriptBranch:
    """scripts/resolve_version.py mirrors the same chain (#1323)."""

    def test_from_manifest(self, rv_mod, tmp_path):
        _write_manifest(tmp_path, tag="v4.5.6")
        assert rv_mod._from_manifest(tmp_path) == "4.5.6"

    def test_from_deft_version(self, rv_mod, tmp_path):
        (tmp_path / ".deft-version").write_text("v5.6.7\n", encoding="utf-8")
        assert rv_mod._from_deft_version(tmp_path) == "5.6.7"

    def test_resolve_prefers_manifest_over_git(self, rv_mod, monkeypatch):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)
        monkeypatch.setattr(rv_mod, "_from_manifest", lambda *a: "6.7.8")

        def _forbidden_git():
            raise AssertionError("git must not run when manifest resolves")

        monkeypatch.setattr(rv_mod, "_from_git", _forbidden_git)
        assert rv_mod.resolve_version() == "6.7.8"


# ---------------------------------------------------------------------------
# #1320 -- check-updates upstream resolution + current from manifest
# ---------------------------------------------------------------------------


class TestUpstreamResolution:
    def test_baked_in_constant_present(self, run_mod):
        assert run_mod.DEFT_UPSTREAM_URL == "https://github.com/deftai/directive.git"

    def test_manifest_url_field_wins(self, run_mod, tmp_path):
        _write_manifest(
            tmp_path / ".deft" / "core",
            url="https://github.com/forky/directive.git",
        )
        assert (
            run_mod._resolve_upstream_url(tmp_path)
            == "https://github.com/forky/directive.git"
        )

    def test_falls_back_to_constant_without_querying_origin(
        self, run_mod, tmp_path, monkeypatch
    ):
        # No manifest -> baked-in constant, and git origin is NEVER consulted.
        def _forbidden(*a, **k):
            raise AssertionError("subprocess (git origin) must not be called")

        monkeypatch.setattr(run_mod.subprocess, "run", _forbidden)
        assert run_mod._resolve_upstream_url(tmp_path) == run_mod.DEFT_UPSTREAM_URL


class TestCheckUpdatesVendored:
    def test_behind_uses_manifest_current_and_never_origin(
        self, run_command, deft_run_module, monkeypatch, tmp_path
    ):
        monkeypatch.delenv("DEFT_NO_NETWORK", raising=False)
        # Vendored install whose manifest pins a low version.
        _write_manifest(tmp_path / ".deft" / "core", tag="v0.1.0")
        monkeypatch.chdir(tmp_path)

        def _fake_run(cmd, *a, **k):
            joined = " ".join(cmd)
            if "remote" in cmd and "get-url" in cmd:
                raise AssertionError(
                    "check-updates must NOT probe the consumer origin"
                )
            if "ls-remote" in joined:
                class _R:
                    returncode = 0
                    stdout = "sha1\trefs/tags/v0.2.0\n"
                    stderr = ""

                return _R()

            class _Other:
                returncode = 128
                stdout = ""
                stderr = "unhandled"

            return _Other()

        monkeypatch.setattr(deft_run_module.subprocess, "run", _fake_run)

        result = run_command("cmd_check_updates", ["--json"])

        assert result.return_code == 1
        payload = json.loads(result.stdout.strip())
        assert payload["status"] == "behind"
        assert payload["remote"] == "v0.2.0"
        assert payload["current"] == "0.1.0"
        assert payload["upstream_url"] == deft_run_module.DEFT_UPSTREAM_URL


# ---------------------------------------------------------------------------
# #1332(a) -- _resolve_framework_sha manifest-first
# ---------------------------------------------------------------------------


class TestResolveFrameworkSha:
    def test_manifest_sha_wins(self, run_mod, tmp_path):
        install = tmp_path / ".deft" / "core"
        _write_manifest(install, sha="cafebabecafebabecafebabecafebabecafebabe")
        assert (
            run_mod._resolve_framework_sha(install)
            == "cafebabecafebabecafebabecafebabecafebabe"
        )

    def test_falls_back_to_git_when_no_manifest(self, run_mod, tmp_path, monkeypatch):
        install = tmp_path / ".deft" / "core"
        install.mkdir(parents=True)
        monkeypatch.setattr(
            run_mod, "_resolve_framework_sha_git", lambda: "gitfallbacksha"
        )
        assert run_mod._resolve_framework_sha(install) == "gitfallbacksha"


# ---------------------------------------------------------------------------
# #1325 -- legacy .deft/VERSION migration + doctor dual-manifest
# ---------------------------------------------------------------------------


class TestLegacyManifestMigration:
    def test_cmd_upgrade_migrates_stale_legacy_manifest(
        self, run_command, deft_run_module, monkeypatch, tmp_path
    ):
        monkeypatch.chdir(tmp_path)
        # Canonical install dir exists; legacy parent-level manifest disagrees.
        (tmp_path / ".deft" / "core").mkdir(parents=True)
        legacy = tmp_path / ".deft" / "VERSION"
        _write_manifest(tmp_path / ".deft", tag="v0.1.0")  # writes .deft/VERSION
        assert legacy.is_file()

        result = run_command("cmd_upgrade", [])

        assert result.return_code == 0
        assert not legacy.is_file(), "stale legacy .deft/VERSION must be moved"
        assert (tmp_path / ".deft" / "VERSION.premigrate").is_file()
        assert (tmp_path / ".deft" / "core" / "VERSION").is_file()

    def test_migration_skipped_when_legacy_absent(
        self, run_mod, tmp_path
    ):
        canonical = _write_manifest(tmp_path / ".deft" / "core", tag="v0.39.5")
        # No .deft/VERSION present -> no-op, no raise.
        run_mod._migrate_legacy_install_manifest(tmp_path, canonical)
        assert not (tmp_path / ".deft" / "VERSION.premigrate").exists()


class TestDoctorDualManifest:
    def _write_agents_md(self, project_root: Path) -> None:
        (project_root / "AGENTS.md").write_text(
            "# Project AGENTS.md\n"
            "Deft is installed in .deft/core/.\n"
            "Full guidelines: .deft/core/main.md\n"
            "<!-- deft:managed-section v3 -->\n"
            "# Deft\n"
            "<!-- /deft:managed-section -->\n",
            encoding="utf-8",
        )

    def test_dual_manifest_disagreement_flagged(self, doctor_mod, tmp_path):
        self._write_agents_md(tmp_path)
        _write_manifest(tmp_path / ".deft" / "core", tag="v0.39.5")
        _write_manifest(tmp_path / ".deft", tag="v0.1.0")  # legacy, disagrees
        result = doctor_mod.run_checks(tmp_path)
        check = next(
            c for c in result["checks"] if c["name"] == "manifest-agreement"
        )
        assert check["status"] == "fail"
        assert check["data"].get("dual_manifest_drift") is True

    def test_dual_manifest_agreement_does_not_flag(self, doctor_mod, tmp_path):
        self._write_agents_md(tmp_path)
        _write_manifest(tmp_path / ".deft" / "core", tag="v0.39.5")
        _write_manifest(tmp_path / ".deft", tag="v0.39.5")  # agree
        result = doctor_mod.run_checks(tmp_path)
        check = next(
            c for c in result["checks"] if c["name"] == "manifest-agreement"
        )
        assert check["data"].get("dual_manifest_drift") is not True


# ---------------------------------------------------------------------------
# #1332(b) -- doctor redirect-stub: match by SHAPE, not substring
# ---------------------------------------------------------------------------


class TestRedirectStubShape:
    def test_standalone_sentinel_in_header_is_stub(self, doctor_mod):
        text = "<!-- deft:deprecated-skill-redirect -->\n# Deprecated\n"
        assert doctor_mod._is_deprecation_redirect_stub(text) is True

    def test_inline_prose_mention_is_not_stub(self, doctor_mod):
        text = (
            "---\nname: real-skill\n---\n\n"
            "# Real Skill\n\n"
            "A file is a stub when it carries the "
            "`<!-- deft:deprecated-skill-redirect -->` sentinel on its own line.\n"
        )
        assert doctor_mod._is_deprecation_redirect_stub(text) is False

    def test_sentinel_beyond_header_window_is_not_stub(self, doctor_mod):
        preamble = "\n".join(f"# line {i}" for i in range(12))
        text = f"{preamble}\n<!-- deft:deprecated-skill-redirect -->\n"
        assert doctor_mod._is_deprecation_redirect_stub(text) is False
