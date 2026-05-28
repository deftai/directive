"""test_safe_subprocess.py -- Tests for scripts/_safe_subprocess.py (#1366).

Covers the UTF-8-safe subprocess capture helper that closes the
``Thread-3 (_readerthread) UnicodeDecodeError`` hole on Windows + Grok
Build. The tests below exercise the helper end-to-end against real
subprocess child processes (Python one-liners) so the encoding guarantees
are verified at the process boundary, not just at the call-site shim.

Test surface
------------
- ``run_text`` round-trips plain ASCII output.
- ``run_text`` decodes UTF-8 multi-byte sequences (em dash / arrow / smart
  quote / U+FFFD) without raising.
- ``run_text`` does NOT raise ``UnicodeDecodeError`` when the child emits
  bytes that are not valid in the host codepage (the Greptile rolling-
  summary repro).
- ``run_text`` preserves non-zero ``returncode`` from the child.
- ``run_text`` captures stderr.
- ``run_text`` enforces ``timeout``, raising :class:`subprocess.TimeoutExpired`
  for overruns.
- ``run_text`` honors ``input=``.
- ``run_text`` honors ``cwd=`` so child resolution happens in the supplied
  directory.
- ``run_text`` honors ``env=`` so the child sees the supplied environment.
- ``run_text`` drops the forbidden ``encoding`` / ``errors`` / ``shell``
  overrides without crashing (defense-in-depth).
- ``run_text`` rejects a bare-string ``cmd`` with :class:`TypeError`.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"


def _load_module():
    """Load scripts/_safe_subprocess.py as the module under test."""
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(
        "_safe_subprocess", SCRIPTS_DIR / "_safe_subprocess.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["_safe_subprocess"] = module
    spec.loader.exec_module(module)
    return module


safe_subprocess = _load_module()


# ---------------------------------------------------------------------------
# ASCII / UTF-8 round-trip
# ---------------------------------------------------------------------------


class TestRoundTrip:
    def test_ascii_stdout_round_trip(self):
        result = safe_subprocess.run_text(
            [sys.executable, "-c", "print('hello world')"],
        )
        assert result.returncode == 0
        assert result.stdout.strip() == "hello world"
        assert result.stderr == ""

    def test_utf8_multibyte_round_trip(self):
        # Em dash (U+2014), arrow (U+2192), smart quote (U+201D), and a
        # raw replacement char (U+FFFD) all decode without raising under
        # encoding="utf-8". This is the canonical glyph set Greptile
        # rolling-summary bodies carry that crashes the default text=True
        # decode path on Windows + Grok Build.
        snippet = (
            "import sys; "
            "sys.stdout.buffer.write('em\\u2014dash arrow\\u2192 q\\u201Dx fffd\\ufffd'"
            ".encode('utf-8'))"
        )
        result = safe_subprocess.run_text([sys.executable, "-c", snippet])
        assert result.returncode == 0
        assert "em\u2014dash" in result.stdout
        assert "arrow\u2192" in result.stdout
        assert "q\u201Dx" in result.stdout
        assert "\ufffd" in result.stdout

    def test_undecodable_bytes_replaced_not_raised(self):
        # Emit a byte sequence that is NOT valid UTF-8 (a lone 0xFF, plus
        # cp1252-decodable 0x80 / 0x9F that are invalid UTF-8 start bytes).
        # Under text=True + encoding="utf-8" + errors="strict" this raises
        # UnicodeDecodeError from inside the reader thread. The helper
        # forces errors="replace" so the call returns cleanly with U+FFFD
        # in place of every undecodable byte.
        snippet = (
            "import sys; "
            "sys.stdout.buffer.write("
            "b'before ' + bytes([0xFF, 0x80, 0x9F]) + b' after'"
            ")"
        )
        result = safe_subprocess.run_text([sys.executable, "-c", snippet])
        assert result.returncode == 0
        # 'before ' and ' after' must round-trip; the undecodable bytes
        # MUST be substituted (any number of U+FFFD chars in between).
        assert result.stdout.startswith("before ")
        assert result.stdout.endswith(" after")
        assert "\ufffd" in result.stdout


# ---------------------------------------------------------------------------
# returncode / stderr / nonzero exits
# ---------------------------------------------------------------------------


class TestReturnCodeAndStderr:
    def test_nonzero_returncode_preserved(self):
        result = safe_subprocess.run_text(
            [sys.executable, "-c", "import sys; sys.exit(7)"],
        )
        assert result.returncode == 7

    def test_stderr_captured(self):
        result = safe_subprocess.run_text(
            [
                sys.executable,
                "-c",
                "import sys; print('to-err', file=sys.stderr); sys.exit(1)",
            ],
        )
        assert result.returncode == 1
        assert "to-err" in result.stderr
        assert result.stdout == ""

    def test_check_true_raises_on_nonzero(self):
        with pytest.raises(subprocess.CalledProcessError) as excinfo:
            safe_subprocess.run_text(
                [sys.executable, "-c", "import sys; sys.exit(2)"],
                check=True,
            )
        assert excinfo.value.returncode == 2


# ---------------------------------------------------------------------------
# Timeout enforcement
# ---------------------------------------------------------------------------


class TestTimeout:
    def test_timeout_raises_subprocess_timeoutexpired(self):
        with pytest.raises(subprocess.TimeoutExpired):
            safe_subprocess.run_text(
                [sys.executable, "-c", "import time; time.sleep(5)"],
                timeout=0.5,
            )

    def test_default_timeout_is_set(self):
        # Sanity: the default timeout is a finite number, not None.
        # We cannot easily exercise the 60s default in CI without a
        # 60s sleep child; verify the signature default instead.
        import inspect

        sig = inspect.signature(safe_subprocess.run_text)
        default = sig.parameters["timeout"].default
        assert default is not None
        assert isinstance(default, (int, float))
        assert default > 0


# ---------------------------------------------------------------------------
# Stdin / cwd / env propagation
# ---------------------------------------------------------------------------


class TestPassthroughKwargs:
    def test_input_propagates_to_child_stdin(self):
        result = safe_subprocess.run_text(
            [sys.executable, "-c", "import sys; print(sys.stdin.read().upper())"],
            input="hello",
        )
        assert result.returncode == 0
        assert "HELLO" in result.stdout

    def test_cwd_propagates(self, tmp_path):
        result = safe_subprocess.run_text(
            [sys.executable, "-c", "import os; print(os.getcwd())"],
            cwd=str(tmp_path),
        )
        assert result.returncode == 0
        # Compare via Path so trailing-slash / case-folding differences on
        # Windows do not false-fail the assertion.
        assert Path(result.stdout.strip()).resolve() == tmp_path.resolve()

    def test_env_propagates(self):
        result = safe_subprocess.run_text(
            [
                sys.executable,
                "-c",
                "import os; print(os.environ.get('DEFT_TEST_VAR', 'missing'))",
            ],
            env={"DEFT_TEST_VAR": "present", "PATH": ""},
        )
        assert result.returncode == 0
        assert "present" in result.stdout


# ---------------------------------------------------------------------------
# Safety defaults / forbidden kwargs
# ---------------------------------------------------------------------------


class TestSafetyDefaults:
    def test_string_cmd_rejected(self):
        with pytest.raises(TypeError) as excinfo:
            safe_subprocess.run_text(
                f"{sys.executable} -c 'print(1)'",  # type: ignore[arg-type]
            )
        assert "sequence" in str(excinfo.value).lower()

    def test_bytes_cmd_rejected(self):
        with pytest.raises(TypeError):
            safe_subprocess.run_text(b"foo")  # type: ignore[arg-type]

    def test_forbidden_kwargs_silently_dropped(self):
        # Caller tries to opt back into the broken defaults; helper MUST
        # silently drop the overrides so the safety guarantee survives.
        result = safe_subprocess.run_text(
            [sys.executable, "-c", "print('still-utf8')"],
            encoding="cp1252",      # forbidden -- must be ignored
            errors="strict",        # forbidden -- must be ignored
            shell=True,              # forbidden -- must be ignored
            capture_output=False,    # forbidden -- must be ignored
            text=False,              # forbidden -- must be ignored
        )
        assert result.returncode == 0
        assert "still-utf8" in result.stdout

    def test_executable_not_found_raises_filenotfounderror(self):
        with pytest.raises(FileNotFoundError):
            safe_subprocess.run_text(
                ["this-binary-does-not-exist-deft-1366", "--help"],
            )


# ---------------------------------------------------------------------------
# Regression: Greptile-shaped multi-byte payload does not crash reader thread
# ---------------------------------------------------------------------------


class TestGreptileShapeRegression:
    def test_greptile_rolling_summary_shape_round_trips(self):
        # Synthesise a payload that mirrors the Greptile rolling-summary
        # body shape that originally triggered the cp1252 reader-thread
        # crash: a markdown body with em dashes, arrows, smart quotes,
        # and a few raw replacement glyphs.
        payload = (
            "## Greptile Summary\n\n"
            "No P0 or P1 issues found \u2014 confidence high.\n\n"
            "**Confidence Score: 5/5**\n\n"
            "Last reviewed commit: [fix \u2192 stuff]"
            "(https://github.com/deftai/directive/commit/abc1234)\n"
            "\u201CSmart quote\u201D bytes \u00b7 mixed.\n"
        )
        snippet = (
            "import sys; "
            f"sys.stdout.buffer.write({payload.encode('utf-8')!r})"
        )
        result = safe_subprocess.run_text([sys.executable, "-c", snippet])
        assert result.returncode == 0
        # Spot-check the load-bearing tokens survive the round trip.
        assert "## Greptile Summary" in result.stdout
        assert "\u2014" in result.stdout       # em dash
        assert "\u2192" in result.stdout       # arrow
        assert "\u201C" in result.stdout       # left smart quote
        assert "\u201D" in result.stdout       # right smart quote
        assert "Confidence Score: 5/5" in result.stdout
