"""Tests for scripts/verify_encoding.py -- the #798 deterministic-tier PS 5.1
non-ASCII round-trip corruption gate.

Pin the contract that:

- Every entry in MOJIBAKE_PATTERNS is detected when present in a tracked file.
- U+FFFD replacement chars are detected.
- Unexpected UTF-8 BOM on .md/.json/.yml/.yaml/.txt is flagged; .ps1 is exempt.
- Markdown inline-code spans (single backticks) and fenced code blocks are
  stripped before scanning -- the recurrence-record case where mojibake bytes
  appear legitimately quoted inside backticks must NOT flag.
- ``--allow-list <path>`` accepts newline-separated globs and skips matches.
- The built-in allow-list skips the #798 brief itself + history/archive/**.
- ``--staged`` mode reads from ``git diff --cached --name-only``; ``--all``
  reads from ``git ls-files``.
- Three-state exit: 0 clean / 1 corruption / 2 config error.
- The ``main()`` entry-point reconfigures stdout/stderr to UTF-8 with
  ``errors='replace'`` (mirrors #814 contract test).

Strategy mirrors ``tests/cli/test_preflight_branch.py`` and
``tests/cli/test_preflight_implementation.py``: drive ``evaluate()`` directly
for state matrix, exercise ``main([...])`` for CLI plumbing + exit codes,
build synthetic git repos via ``git init`` + ``git add`` in ``tmp_path`` for
the ``--staged`` / ``--all`` modes.
"""

from __future__ import annotations

import importlib.util
import io
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "verify_encoding.py"


def _load_module():
    """Load scripts/verify_encoding.py as a module (sibling-import style)."""
    spec = importlib.util.spec_from_file_location("verify_encoding", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["verify_encoding"] = mod
    spec.loader.exec_module(mod)
    return mod


verify_encoding = _load_module()


def _init_git_repo(root: Path) -> None:
    """Create a minimal git repo at ``root`` for --staged / --all modes.

    Uses --initial-branch=main to avoid the "default branch master" warning
    on newer git versions (and to keep the test independent of user config).
    """
    subprocess.run(
        ["git", "init", "--quiet", "--initial-branch=main", str(root)],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.name", "Test"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "commit.gpgsign", "false"],
        check=True,
    )


def _git_add(root: Path, *rel_paths: str) -> None:
    subprocess.run(
        ["git", "-C", str(root), "add", "--", *rel_paths],
        check=True,
    )


def _git_commit(root: Path, msg: str = "init") -> None:
    subprocess.run(
        ["git", "-C", str(root), "commit", "--quiet", "-m", msg],
        check=True,
    )


# ---------------------------------------------------------------------------
# MOJIBAKE_PATTERNS -- one parametrized test per pattern.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "pattern,label",
    list(verify_encoding.MOJIBAKE_PATTERNS.items()),
    ids=list(verify_encoding.MOJIBAKE_PATTERNS.keys()),
)
def test_each_mojibake_pattern_is_detected(
    pattern: str,
    label: str,
    tmp_path: Path,
) -> None:
    """Every MOJIBAKE_PATTERNS entry MUST be detected in a tracked .json file.

    We use .json (not .md) so the markdown inline-code stripping does NOT
    interfere with detection -- this test exercises the pattern matcher
    directly, not the markdown false-positive guard (covered separately).
    """
    _init_git_repo(tmp_path)
    bad = tmp_path / "bad.json"
    bad.write_text(
        f'{{"corrupted_marker": "{pattern}", "note": "synthetic"}}\n',
        encoding="utf-8",
    )
    _git_add(tmp_path, "bad.json")
    _git_commit(tmp_path)

    code, findings, msg = verify_encoding.evaluate(tmp_path, mode="all")
    assert code == 1, f"expected exit 1 (corruption) for {pattern!r}, got {code} -- {msg}"
    assert any(f.label == label for f in findings), (
        f"expected a Finding with label {label!r} for pattern {pattern!r}; "
        f"got labels {[f.label for f in findings]}"
    )


def test_replacement_char_u_fffd_is_detected(tmp_path: Path) -> None:
    """U+FFFD detection is encoding-agnostic; flagged regardless of pattern set."""
    _init_git_repo(tmp_path)
    (tmp_path / "weird.txt").write_text(
        "this line has a replacement \ufffd marker.\n",
        encoding="utf-8",
    )
    _git_add(tmp_path, "weird.txt")
    _git_commit(tmp_path)

    code, findings, msg = verify_encoding.evaluate(tmp_path, mode="all")
    assert code == 1
    assert any(f.label == "U+FFFD replacement char" for f in findings)


# ---------------------------------------------------------------------------
# Unexpected UTF-8 BOM detection.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("ext", [".md", ".json", ".yml", ".yaml", ".txt"])
def test_bom_flagged_on_no_bom_extensions(ext: str, tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    p = tmp_path / f"bom{ext}"
    # Write BOM + minimal valid body for the extension.
    body = "{}\n" if ext == ".json" else "hello\n"
    p.write_bytes(b"\xef\xbb\xbf" + body.encode("utf-8"))
    _git_add(tmp_path, p.name)
    _git_commit(tmp_path)

    code, findings, msg = verify_encoding.evaluate(tmp_path, mode="all")
    assert code == 1, msg
    assert any(f.label == "unexpected UTF-8 BOM" for f in findings), (
        f"expected BOM finding for {ext}; got labels {[f.label for f in findings]}"
    )


def test_bom_not_flagged_on_ps1_extension(tmp_path: Path) -> None:
    """PS1 / CSV / BAT files tolerate a BOM; the gate MUST NOT flag those."""
    _init_git_repo(tmp_path)
    (tmp_path / "script.ps1").write_bytes(
        b"\xef\xbb\xbfWrite-Host 'hello'\n"
    )
    _git_add(tmp_path, "script.ps1")
    _git_commit(tmp_path)

    code, findings, msg = verify_encoding.evaluate(tmp_path, mode="all")
    assert code == 0, f"expected exit 0 for .ps1 with BOM, got {code} -- {msg}"
    assert all(f.label != "unexpected UTF-8 BOM" for f in findings)


# ---------------------------------------------------------------------------
# Markdown inline-code false-positive guard.
# ---------------------------------------------------------------------------


def test_markdown_inline_code_strips_mojibake_quote(tmp_path: Path) -> None:
    """Recurrence-record prose can quote mojibake bytes inside backticks.

    The CHANGELOG.md PR #844 fix entry contains the literal mojibake `Γèù`
    inside backticks while documenting the corruption that was fixed; the
    gate MUST NOT flag this case.
    """
    _init_git_repo(tmp_path)
    (tmp_path / "doc.md").write_text(
        "Documenting the fix: replaced `\u0393\u00e8\u00f9` with the canonical `\u2297`.\n",
        encoding="utf-8",
    )
    _git_add(tmp_path, "doc.md")
    _git_commit(tmp_path)

    code, findings, msg = verify_encoding.evaluate(tmp_path, mode="all")
    assert code == 0, (
        f"markdown inline-code stripping should hide quoted mojibake; "
        f"got code={code} findings={[(f.label, f.context) for f in findings]} msg={msg}"
    )


def test_markdown_fenced_code_block_strips_mojibake_quote(tmp_path: Path) -> None:
    """Fenced code blocks (```...```) MUST also be stripped before scanning."""
    _init_git_repo(tmp_path)
    (tmp_path / "doc.md").write_text(
        "Example:\n\n```\n\u0393\u00e8\u00f9 MUST NOT appear in your prose.\n```\n",
        encoding="utf-8",
    )
    _git_add(tmp_path, "doc.md")
    _git_commit(tmp_path)

    code, findings, msg = verify_encoding.evaluate(tmp_path, mode="all")
    assert code == 0, msg


def test_markdown_bare_mojibake_outside_backticks_still_flagged(tmp_path: Path) -> None:
    """The stripping only suppresses quoted bytes; bare mojibake still flags."""
    _init_git_repo(tmp_path)
    (tmp_path / "broken.md").write_text(
        "This line contains a real corruption: \u0393\u00e8\u00f9 outside backticks.\n",
        encoding="utf-8",
    )
    _git_add(tmp_path, "broken.md")
    _git_commit(tmp_path)

    code, findings, msg = verify_encoding.evaluate(tmp_path, mode="all")
    assert code == 1, msg
    assert any(f.label.startswith("U+2297") for f in findings)


def test_markdown_mojibake_after_fenced_block_reports_correct_line(
    tmp_path: Path,
) -> None:
    """Greptile P1 regression (PR #862): mojibake AFTER a fenced code block
    must report the true line number with the true context.

    The prior implementation used ``_MD_FENCED_BLOCK.sub("")`` which removed
    the newlines INSIDE the matched fence, shifting every post-fence line
    upward in ``stripped_lines`` relative to ``original_lines``. This test
    pins the alignment-preserving fix (see
    :func:`verify_encoding._blank_block`).

    The fixture has a fence on lines 3-5 and a real mojibake hit on line 7.
    Without the fix, the bug would either (a) report the hit at line 3 with
    context from a fence-interior line, or (b) miss the hit entirely if
    padding-with-empty-strings landed at the right index. Either way, the
    post-fix expectation is: line 7, context contains the bare mojibake.
    """
    _init_git_repo(tmp_path)
    (tmp_path / "after_fence.md").write_text(
        "# Title\n"            # line 1
        "\n"                   # line 2
        "```\n"                # line 3 (fence open)
        "safe content here\n"  # line 4 (inside fence; not scanned)
        "```\n"                # line 5 (fence close)
        "\n"                   # line 6
        "Real corruption \u0393\u00e8\u00f9 here.\n"  # line 7
        "\n"                   # line 8
        "Tail.\n",             # line 9
        encoding="utf-8",
    )
    _git_add(tmp_path, "after_fence.md")
    _git_commit(tmp_path)

    code, findings, msg = verify_encoding.evaluate(tmp_path, mode="all")
    assert code == 1, msg
    u2297_findings = [f for f in findings if f.label.startswith("U+2297")]
    assert u2297_findings, f"expected U+2297 finding; got {[f.label for f in findings]}"
    hit = u2297_findings[0]
    assert hit.line == 7, (
        f"fenced-block alignment bug: expected line 7, got {hit.line}. "
        f"context={hit.context!r}"
    )
    assert "\u0393\u00e8\u00f9" in hit.context, (
        f"context should be the original bare-mojibake line, not a "
        f"fence-interior line. got: {hit.context!r}"
    )


# ---------------------------------------------------------------------------
# Allow-list (custom + built-in).
# ---------------------------------------------------------------------------


def test_custom_allow_list_skips_matched_paths(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    bad = tmp_path / "fixture.json"
    bad.write_text('{"x": "\u00c2\u00a7"}\n', encoding="utf-8")
    _git_add(tmp_path, "fixture.json")
    allow = tmp_path / ".encoding-allow-list"
    allow.write_text(
        "# documented exception\nfixture.json\n",
        encoding="utf-8",
    )
    _git_add(tmp_path, ".encoding-allow-list")
    _git_commit(tmp_path)

    code, findings, msg = verify_encoding.evaluate(
        tmp_path,
        mode="all",
        allow_list_path=allow,
    )
    assert code == 0, f"allow-list should skip fixture.json; got {msg}"


def test_missing_allow_list_path_returns_exit_2(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    (tmp_path / "ok.txt").write_text("hello\n", encoding="utf-8")
    _git_add(tmp_path, "ok.txt")
    _git_commit(tmp_path)

    code, _findings, msg = verify_encoding.evaluate(
        tmp_path,
        mode="all",
        allow_list_path=tmp_path / "does-not-exist.txt",
    )
    assert code == 2, f"missing allow-list path should be config error; got {code}"
    assert "allow-list" in msg.lower()


def test_builtin_allow_list_globs_match_798_brief_pattern() -> None:
    """The script ships allow-list globs covering the #798 brief in every
    lifecycle folder. Without them the #798 brief itself would fail the gate.
    """
    expected_brief_globs = {
        "vbrief/active/*-798-*.vbrief.json",
        "vbrief/completed/*-798-*.vbrief.json",
        "vbrief/cancelled/*-798-*.vbrief.json",
        "vbrief/pending/*-798-*.vbrief.json",
        "vbrief/proposed/*-798-*.vbrief.json",
    }
    builtin = set(verify_encoding.BUILTIN_ALLOW_LIST)
    missing = expected_brief_globs - builtin
    assert not missing, (
        f"BUILTIN_ALLOW_LIST is missing #798 brief globs: {missing}"
    )
    assert any(
        glob.startswith("history/archive/") for glob in builtin
    ), "BUILTIN_ALLOW_LIST must skip history/archive/** for preserved historical state"


# ---------------------------------------------------------------------------
# --staged mode.
# ---------------------------------------------------------------------------


def test_staged_mode_only_scans_staged_files(tmp_path: Path) -> None:
    """--staged reads ``git diff --cached --name-only``; unstaged corruption
    in tracked files is NOT scanned (that's --all's job).
    """
    _init_git_repo(tmp_path)
    # Tracked + clean.
    (tmp_path / "clean.txt").write_text("hello\n", encoding="utf-8")
    _git_add(tmp_path, "clean.txt")
    _git_commit(tmp_path)
    # Now stage a corrupt file -- the only thing --staged should see.
    (tmp_path / "staged.json").write_text(
        '{"x": "\u00c2\u00a7"}\n',
        encoding="utf-8",
    )
    _git_add(tmp_path, "staged.json")

    code, findings, msg = verify_encoding.evaluate(tmp_path, mode="staged")
    assert code == 1, msg
    assert {f.path for f in findings} == {"staged.json"}, (
        f"--staged should scan ONLY the staged file; got {[f.path for f in findings]}"
    )


def test_staged_mode_clean_when_nothing_staged(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    (tmp_path / "ok.txt").write_text("hello\n", encoding="utf-8")
    _git_add(tmp_path, "ok.txt")
    _git_commit(tmp_path)

    code, findings, msg = verify_encoding.evaluate(tmp_path, mode="staged")
    assert code == 0, msg
    assert findings == []


# ---------------------------------------------------------------------------
# Three-state exit codes via main([...]).
# ---------------------------------------------------------------------------


def test_main_exit_0_on_clean_repo(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _init_git_repo(tmp_path)
    (tmp_path / "ok.txt").write_text("hello\n", encoding="utf-8")
    _git_add(tmp_path, "ok.txt")
    _git_commit(tmp_path)

    rc = verify_encoding.main(["--all", "--project-root", str(tmp_path)])
    assert rc == 0
    captured = capsys.readouterr()
    assert (
        "clean" in captured.out.lower()
        or captured.out == ""
        or "verify_encoding" in captured.out
    )


def test_main_exit_1_on_corruption(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _init_git_repo(tmp_path)
    (tmp_path / "bad.json").write_text(
        '{"x": "\u00c2\u00a7"}\n',
        encoding="utf-8",
    )
    _git_add(tmp_path, "bad.json")
    _git_commit(tmp_path)

    rc = verify_encoding.main(["--all", "--project-root", str(tmp_path)])
    assert rc == 1
    captured = capsys.readouterr()
    # Diagnostic prints to stderr.
    assert "verify_encoding" in captured.err
    assert "bad.json" in captured.err


def test_main_exit_2_on_unreadable_allow_list(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _init_git_repo(tmp_path)
    (tmp_path / "ok.txt").write_text("hello\n", encoding="utf-8")
    _git_add(tmp_path, "ok.txt")
    _git_commit(tmp_path)

    rc = verify_encoding.main([
        "--all",
        "--project-root", str(tmp_path),
        "--allow-list", str(tmp_path / "no-such.txt"),
    ])
    assert rc == 2
    captured = capsys.readouterr()
    assert "allow-list" in captured.err.lower()


def test_main_quiet_suppresses_ok_message(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _init_git_repo(tmp_path)
    (tmp_path / "ok.txt").write_text("hello\n", encoding="utf-8")
    _git_add(tmp_path, "ok.txt")
    _git_commit(tmp_path)

    rc = verify_encoding.main(["--all", "--project-root", str(tmp_path), "--quiet"])
    assert rc == 0
    captured = capsys.readouterr()
    assert captured.out == ""


# ---------------------------------------------------------------------------
# UTF-8 self-reconfigure at main() entry (#814 contract carryover).
# ---------------------------------------------------------------------------


def test_main_self_reconfigures_stdout_to_utf8_under_cp1252(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mirrors tests/cli/test_hooks_encoding.py::test_hook_script_self_reconfigures_stdout_to_utf8.

    The verify_encoding hook is invoked from .githooks/pre-commit alongside
    preflight_branch; its main() MUST self-reconfigure stdout/stderr to UTF-8
    with errors='replace' before any print, otherwise a Windows-cp1252 default
    crashes the gate after it has already approved the commit.
    """
    _init_git_repo(tmp_path)
    (tmp_path / "ok.txt").write_text("hello\n", encoding="utf-8")
    _git_add(tmp_path, "ok.txt")
    _git_commit(tmp_path)

    fake_out_buf = io.BytesIO()
    fake_err_buf = io.BytesIO()
    fake_stdout = io.TextIOWrapper(
        fake_out_buf, encoding="cp1252", errors="strict", write_through=True,
    )
    fake_stderr = io.TextIOWrapper(
        fake_err_buf, encoding="cp1252", errors="strict", write_through=True,
    )
    monkeypatch.setattr(sys, "stdout", fake_stdout)
    monkeypatch.setattr(sys, "stderr", fake_stderr)

    # main() must NOT raise UnicodeEncodeError when its OK-message uses U+2713.
    rc = verify_encoding.main(["--all", "--project-root", str(tmp_path)])
    assert rc == 0
    assert sys.stdout.encoding.lower() == "utf-8", (
        f"sys.stdout.encoding is {sys.stdout.encoding!r} after main(); "
        "expected 'utf-8' (the #814 self-reconfigure must run BEFORE any print)."
    )
    # The U+2713 success glyph must have reached the underlying buffer as
    # canonical UTF-8 bytes (same assertion shape as #814's contract test).
    assert b"\xe2\x9c\x93" in fake_out_buf.getvalue(), (
        f"U+2713 (b'\\xe2\\x9c\\x93') not present in stdout buffer; "
        f"got: {fake_out_buf.getvalue()!r}"
    )
