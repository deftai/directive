"""test_issue_emit.py -- Tests for scripts/issue_emit.py (#1274 Change 2).

In-process tests: the module's functions are imported and called directly
with an injected fake ``scm.call`` client and ``tmp_path`` vBRIEFs so the
write path is exercised without any live ``gh`` call. Subprocess-only tests
do not attribute coverage and would regress the master coverage gate, so
this suite deliberately drives the importable API.

Covers:
- single / umbrella / per-vbrief modes
- --dry-run and DEFT_NO_NETWORK=1 (plan only; no forge write, no disk mutation)
- references[] write-back with external TrustLevel
- idempotent re-run (existing github-issue reference is detected, not duplicated)
- issue-body rendering from title + Description + Acceptance + Traces

Story: #1274 Change 2 (task issue:emit); epic #1284.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


def _load_issue_emit():
    """Load scripts/issue_emit.py in-process via importlib.util."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "issue_emit",
        scripts_dir / "issue_emit.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


issue_emit = _load_issue_emit()


# --- Fakes / fixtures -------------------------------------------------------


class _FakeCompleted:
    """Mimic subprocess.CompletedProcess for the scm.call return contract."""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _FakeScm:
    """Records calls and returns canned issue URLs in sequence."""

    def __init__(self, urls=None, returncode=0, stderr=""):
        self._urls = list(urls or ["https://github.com/o/r/issues/1"])
        self._returncode = returncode
        self._stderr = stderr
        self.calls: list[tuple] = []

    def __call__(self, source, verb, args, **kwargs):
        self.calls.append((source, verb, list(args), kwargs))
        if self._returncode != 0:
            return _FakeCompleted(returncode=self._returncode, stderr=self._stderr)
        url = self._urls.pop(0) if self._urls else "https://github.com/o/r/issues/99"
        return _FakeCompleted(returncode=0, stdout=f"{url}\n")


def _make_vbrief(
    tmp_path: Path,
    name: str,
    *,
    title: str = "Add widget support",
    references: list[dict] | None = None,
    narratives: dict | None = None,
    items: list[dict] | None = None,
) -> Path:
    data: dict = {
        "vBRIEFInfo": {"version": "0.6", "description": f"Scope vBRIEF for {title}"},
        "plan": {
            "title": title,
            "status": "running",
            "narratives": narratives
            if narratives is not None
            else {
                "Description": "Build the widget subsystem.",
                "Traces": "planRef #1274",
            },
            "items": items if items is not None else [],
        },
    }
    if references is not None:
        data["plan"]["references"] = references
    path = tmp_path / name
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return path


# --- Body rendering ---------------------------------------------------------


class TestRenderIssueBody:
    def test_includes_description_acceptance_traces(self):
        data = {
            "plan": {
                "title": "T",
                "narratives": {
                    "Description": "Do the thing.",
                    "Traces": "planRef #1274",
                },
                "items": [
                    {
                        "title": "step one",
                        "narrative": {"Acceptance": "It works when run."},
                    }
                ],
            }
        }
        body = issue_emit.render_issue_body(data)
        assert "## Description" in body
        assert "Do the thing." in body
        assert "## Acceptance" in body
        assert "step one" in body
        assert "It works when run." in body
        assert "## Traces" in body
        assert "planRef #1274" in body

    def test_empty_narratives_still_nonempty_body(self):
        data = {"plan": {"title": "Lonely scope", "narratives": {}, "items": []}}
        body = issue_emit.render_issue_body(data)
        assert body.strip()
        assert "Lonely scope" in body

    def test_plan_level_acceptance_narrative(self):
        data = {
            "plan": {
                "title": "T",
                "narratives": {"Acceptance": "Plan-level AC holds."},
                "items": [],
            }
        }
        body = issue_emit.render_issue_body(data)
        assert "## Acceptance" in body
        assert "Plan-level AC holds." in body


class TestVbriefTitle:
    def test_prefers_plan_title(self):
        assert issue_emit.vbrief_title({"plan": {"title": "Hello"}}) == "Hello"

    def test_falls_back_to_description(self):
        data = {"plan": {}, "vBRIEFInfo": {"description": "Fallback desc"}}
        assert issue_emit.vbrief_title(data) == "Fallback desc"

    def test_placeholder_when_empty(self):
        assert issue_emit.vbrief_title({"plan": {}}) == "Untitled vBRIEF"


# --- Reference helpers ------------------------------------------------------


class TestReferenceHelpers:
    def test_existing_ref_detected(self):
        data = {
            "plan": {
                "references": [
                    {
                        "uri": "https://github.com/o/r/issues/5",
                        "type": "x-vbrief/github-issue",
                    }
                ]
            }
        }
        assert issue_emit.existing_github_issue_ref(data) == "https://github.com/o/r/issues/5"

    def test_no_ref_returns_none(self):
        data = {"plan": {"references": [{"type": "x-vbrief/plan", "uri": "x"}]}}
        assert issue_emit.existing_github_issue_ref(data) is None

    def test_add_reference_shape(self):
        data = {"plan": {}}
        issue_emit.add_github_issue_reference(data, "https://github.com/o/r/issues/9")
        ref = data["plan"]["references"][0]
        assert ref["uri"] == "https://github.com/o/r/issues/9"
        assert ref["type"] == "x-vbrief/github-issue"
        assert ref["TrustLevel"] == "external"


# --- file_issue -------------------------------------------------------------


class TestFileIssue:
    def test_routes_through_scm_and_parses_url(self):
        fake = _FakeScm(urls=["https://github.com/o/r/issues/42"])
        url = issue_emit.file_issue("o/r", "Title", "body text", scm_call=fake)
        assert url == "https://github.com/o/r/issues/42"
        source, verb, args, kwargs = fake.calls[0]
        assert source == "github-issue"
        assert verb == "issue"
        assert args[0] == "create"
        assert "--repo" in args and "o/r" in args
        assert "--title" in args and "Title" in args
        # Body is passed via --body-file (not inline --body).
        assert "--body-file" in args
        assert "--body" not in args
        # #1366 safe-capture contract.
        assert kwargs.get("encoding") == "utf-8"
        assert kwargs.get("errors") == "replace"

    def test_body_file_contains_body_utf8(self, tmp_path):
        captured = {}

        def _scm(source, verb, args, **kwargs):
            body_file = args[args.index("--body-file") + 1]
            captured["body"] = Path(body_file).read_text(encoding="utf-8")
            return _FakeCompleted(stdout="https://github.com/o/r/issues/7\n")

        issue_emit.file_issue("o/r", "T", "unicode body \u2014 em dash", scm_call=_scm)
        assert "unicode body \u2014 em dash" in captured["body"]

    def test_nonzero_exit_raises(self):
        fake = _FakeScm(returncode=1, stderr="boom")
        with pytest.raises(issue_emit.IssueEmitError):
            issue_emit.file_issue("o/r", "T", "b", scm_call=fake)


# --- emit_single ------------------------------------------------------------


class TestEmitSingle:
    def test_files_issue_and_writes_back_reference(self, tmp_path):
        path = _make_vbrief(tmp_path, "a.vbrief.json")
        fake = _FakeScm(urls=["https://github.com/o/r/issues/100"])
        action = issue_emit.emit_single(path, repo="o/r", scm_call=fake)
        assert action["result"] == "created"
        assert action["url"] == "https://github.com/o/r/issues/100"
        data = json.loads(path.read_text(encoding="utf-8"))
        refs = data["plan"]["references"]
        assert refs[-1]["uri"] == "https://github.com/o/r/issues/100"
        assert refs[-1]["type"] == "x-vbrief/github-issue"
        assert refs[-1]["TrustLevel"] == "external"

    def test_dry_run_makes_no_call_and_no_mutation(self, tmp_path):
        path = _make_vbrief(tmp_path, "a.vbrief.json")
        before = path.read_text(encoding="utf-8")
        fake = _FakeScm()
        action = issue_emit.emit_single(path, repo="o/r", scm_call=fake, no_network=True)
        assert action["result"] == "dryrun"
        assert fake.calls == []
        assert path.read_text(encoding="utf-8") == before

    def test_idempotent_rerun_skips(self, tmp_path):
        path = _make_vbrief(tmp_path, "a.vbrief.json")
        fake = _FakeScm(urls=["https://github.com/o/r/issues/100"])
        issue_emit.emit_single(path, repo="o/r", scm_call=fake)
        # Second run: existing reference detected, no second forge call.
        fake2 = _FakeScm(urls=["https://github.com/o/r/issues/200"])
        action = issue_emit.emit_single(path, repo="o/r", scm_call=fake2)
        assert action["result"] == "skipped"
        assert fake2.calls == []
        data = json.loads(path.read_text(encoding="utf-8"))
        github_refs = [
            r for r in data["plan"]["references"] if r.get("type") == "x-vbrief/github-issue"
        ]
        assert len(github_refs) == 1


# --- emit_per_vbrief --------------------------------------------------------


class TestEmitPerVbrief:
    def test_one_issue_per_vbrief(self, tmp_path):
        p1 = _make_vbrief(tmp_path, "a.vbrief.json", title="Alpha")
        p2 = _make_vbrief(tmp_path, "b.vbrief.json", title="Beta")
        fake = _FakeScm(
            urls=[
                "https://github.com/o/r/issues/1",
                "https://github.com/o/r/issues/2",
            ]
        )
        actions = issue_emit.emit_per_vbrief([p1, p2], repo="o/r", scm_call=fake)
        assert [a["result"] for a in actions] == ["created", "created"]
        assert len(fake.calls) == 2
        for p, expected in (
            (p1, "https://github.com/o/r/issues/1"),
            (p2, "https://github.com/o/r/issues/2"),
        ):
            data = json.loads(p.read_text(encoding="utf-8"))
            assert data["plan"]["references"][-1]["uri"] == expected

    def test_dry_run_no_calls(self, tmp_path):
        p1 = _make_vbrief(tmp_path, "a.vbrief.json")
        fake = _FakeScm()
        actions = issue_emit.emit_per_vbrief([p1], repo="o/r", scm_call=fake, no_network=True)
        assert actions[0]["result"] == "dryrun"
        assert fake.calls == []


# --- emit_umbrella ----------------------------------------------------------


class TestEmitUmbrella:
    def test_one_umbrella_issue_updates_all(self, tmp_path):
        p1 = _make_vbrief(tmp_path, "a.vbrief.json", title="Alpha")
        p2 = _make_vbrief(tmp_path, "b.vbrief.json", title="Beta")
        fake = _FakeScm(urls=["https://github.com/o/r/issues/500"])
        action = issue_emit.emit_umbrella([p1, p2], repo="o/r", scm_call=fake)
        assert action["result"] == "created"
        assert action["url"] == "https://github.com/o/r/issues/500"
        # Exactly ONE forge call for the umbrella.
        assert len(fake.calls) == 1
        # Both vBRIEFs reference the umbrella.
        for p in (p1, p2):
            data = json.loads(p.read_text(encoding="utf-8"))
            assert data["plan"]["references"][-1]["uri"] == "https://github.com/o/r/issues/500"

    def test_umbrella_body_is_checklist(self, tmp_path):
        p1 = _make_vbrief(tmp_path, "a.vbrief.json", title="Alpha")
        p2 = _make_vbrief(tmp_path, "b.vbrief.json", title="Beta")
        captured = {}

        def _scm(source, verb, args, **kwargs):
            body_file = args[args.index("--body-file") + 1]
            captured["body"] = Path(body_file).read_text(encoding="utf-8")
            return _FakeCompleted(stdout="https://github.com/o/r/issues/3\n")

        issue_emit.emit_umbrella([p1, p2], repo="o/r", scm_call=_scm)
        assert "- [ ] Alpha" in captured["body"]
        assert "- [ ] Beta" in captured["body"]

    def test_custom_title(self, tmp_path):
        p1 = _make_vbrief(tmp_path, "a.vbrief.json")
        fake = _FakeScm(urls=["https://github.com/o/r/issues/3"])
        action = issue_emit.emit_umbrella([p1], repo="o/r", scm_call=fake, title="My Roadmap")
        assert action["title"] == "My Roadmap"
        _source, _verb, args, _kwargs = fake.calls[0]
        assert "My Roadmap" in args

    def test_dry_run_no_calls_no_mutation(self, tmp_path):
        p1 = _make_vbrief(tmp_path, "a.vbrief.json")
        before = p1.read_text(encoding="utf-8")
        fake = _FakeScm()
        action = issue_emit.emit_umbrella([p1], repo="o/r", scm_call=fake, no_network=True)
        assert action["result"] == "dryrun"
        assert fake.calls == []
        assert p1.read_text(encoding="utf-8") == before

    def test_all_already_tracked_skips(self, tmp_path):
        ref = [{"uri": "https://github.com/o/r/issues/1", "type": "x-vbrief/github-issue"}]
        p1 = _make_vbrief(tmp_path, "a.vbrief.json", references=ref)
        fake = _FakeScm(urls=["https://github.com/o/r/issues/2"])
        action = issue_emit.emit_umbrella([p1], repo="o/r", scm_call=fake)
        assert action["result"] == "skipped"
        assert fake.calls == []

    def test_partial_tracking_only_files_untracked(self, tmp_path):
        ref = [{"uri": "https://github.com/o/r/issues/1", "type": "x-vbrief/github-issue"}]
        tracked = _make_vbrief(tmp_path, "a.vbrief.json", references=ref)
        untracked = _make_vbrief(tmp_path, "b.vbrief.json", title="Beta")
        fake = _FakeScm(urls=["https://github.com/o/r/issues/600"])
        action = issue_emit.emit_umbrella([tracked, untracked], repo="o/r", scm_call=fake)
        assert action["result"] == "created"
        # Untracked vBRIEF gets the umbrella ref; tracked one keeps only its own.
        untracked_data = json.loads(untracked.read_text(encoding="utf-8"))
        assert (
            untracked_data["plan"]["references"][-1]["uri"] == "https://github.com/o/r/issues/600"
        )
        tracked_data = json.loads(tracked.read_text(encoding="utf-8"))
        github_refs = [
            r
            for r in tracked_data["plan"]["references"]
            if r.get("type") == "x-vbrief/github-issue"
        ]
        assert len(github_refs) == 1


# --- expand_patterns --------------------------------------------------------


class TestExpandPatterns:
    def test_glob_expansion(self, tmp_path):
        _make_vbrief(tmp_path, "a.vbrief.json")
        _make_vbrief(tmp_path, "b.vbrief.json")
        matched = issue_emit.expand_patterns(["*.vbrief.json"], root=tmp_path)
        names = sorted(p.name for p in matched)
        assert names == ["a.vbrief.json", "b.vbrief.json"]

    def test_literal_existing_file(self, tmp_path):
        p = _make_vbrief(tmp_path, "a.vbrief.json")
        matched = issue_emit.expand_patterns([str(p)])
        assert [str(m) for m in matched] == [str(p)]

    def test_dedup_preserves_order(self, tmp_path):
        p = _make_vbrief(tmp_path, "a.vbrief.json")
        matched = issue_emit.expand_patterns([str(p), str(p)])
        assert len(matched) == 1


# --- main (CLI integration with monkeypatched scm) -------------------------


class TestMainCli:
    def test_single_mode_dry_run(self, tmp_path, capsys, monkeypatch):
        path = _make_vbrief(tmp_path, "a.vbrief.json")
        monkeypatch.setattr(issue_emit, "resolve_project_root", lambda *_a, **_k: tmp_path)
        rc = issue_emit.main([str(path), "--dry-run"])
        assert rc == 0
        out = capsys.readouterr().out
        assert "no network" in out.lower()

    def test_no_network_env(self, tmp_path, monkeypatch):
        path = _make_vbrief(tmp_path, "a.vbrief.json")
        before = path.read_text(encoding="utf-8")
        monkeypatch.setenv("DEFT_NO_NETWORK", "1")
        monkeypatch.setattr(issue_emit, "resolve_project_root", lambda *_a, **_k: tmp_path)
        called = {"n": 0}

        def _boom(*_a, **_k):
            called["n"] += 1
            raise AssertionError("forge must not be called under DEFT_NO_NETWORK")

        monkeypatch.setattr(issue_emit.scm, "call", _boom)
        rc = issue_emit.main([str(path)])
        assert rc == 0
        assert called["n"] == 0
        assert path.read_text(encoding="utf-8") == before

    def test_umbrella_mode_end_to_end(self, tmp_path, monkeypatch):
        p1 = _make_vbrief(tmp_path, "a.vbrief.json", title="Alpha")
        p2 = _make_vbrief(tmp_path, "b.vbrief.json", title="Beta")
        fake = _FakeScm(urls=["https://github.com/o/r/issues/700"])
        monkeypatch.setattr(issue_emit, "resolve_project_root", lambda *_a, **_k: tmp_path)
        monkeypatch.setattr(issue_emit, "resolve_project_repo", lambda *_a, **_k: "o/r")
        monkeypatch.setattr(issue_emit.scm, "call", fake)
        rc = issue_emit.main(["--umbrella", "*.vbrief.json"])
        assert rc == 0
        assert len(fake.calls) == 1
        for p in (p1, p2):
            data = json.loads(p.read_text(encoding="utf-8"))
            assert data["plan"]["references"][-1]["uri"] == "https://github.com/o/r/issues/700"

    def test_per_vbrief_mode_end_to_end(self, tmp_path, monkeypatch):
        _make_vbrief(tmp_path, "a.vbrief.json", title="Alpha")
        _make_vbrief(tmp_path, "b.vbrief.json", title="Beta")
        fake = _FakeScm(
            urls=[
                "https://github.com/o/r/issues/1",
                "https://github.com/o/r/issues/2",
            ]
        )
        monkeypatch.setattr(issue_emit, "resolve_project_root", lambda *_a, **_k: tmp_path)
        monkeypatch.setattr(issue_emit, "resolve_project_repo", lambda *_a, **_k: "o/r")
        monkeypatch.setattr(issue_emit.scm, "call", fake)
        rc = issue_emit.main(["--per-vbrief", "*.vbrief.json", "--json"])
        assert rc == 0
        assert len(fake.calls) == 2

    def test_no_match_errors(self, tmp_path, monkeypatch):
        monkeypatch.setattr(issue_emit, "resolve_project_root", lambda *_a, **_k: tmp_path)
        rc = issue_emit.main(["nonexistent-*.vbrief.json", "--dry-run"])
        assert rc == 2

    def test_missing_repo_for_real_emit_errors(self, tmp_path, monkeypatch):
        path = _make_vbrief(tmp_path, "a.vbrief.json")
        monkeypatch.setattr(issue_emit, "resolve_project_root", lambda *_a, **_k: tmp_path)
        monkeypatch.setattr(issue_emit, "resolve_project_repo", lambda *_a, **_k: None)
        rc = issue_emit.main([str(path)])
        assert rc == 2

    def test_title_without_umbrella_errors(self, tmp_path, monkeypatch, capsys):
        path = _make_vbrief(tmp_path, "a.vbrief.json")
        monkeypatch.setattr(issue_emit, "resolve_project_root", lambda *_a, **_k: tmp_path)
        with pytest.raises(SystemExit):
            issue_emit.main([str(path), "--title", "X"])
