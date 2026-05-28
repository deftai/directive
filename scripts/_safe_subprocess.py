"""_safe_subprocess.py -- UTF-8-safe subprocess capture helper (#1366).

Wraps :func:`subprocess.run` with the defaults required for reliable text
capture under Windows hosts where the system codepage (cp1252 / cp437)
otherwise corrupts non-ASCII bytes emitted by ``gh`` / Greptile rolling
summaries and crashes one of Python's internal reader threads with
``UnicodeDecodeError`` (the canonical ``Thread-3 (_readerthread)`` stack
seen across the #1166 swarm session).

Background
----------
The default ``subprocess.run(..., capture_output=True, text=True)`` binding
uses ``locale.getpreferredencoding()`` to decode the child process's
stdout / stderr streams. On Windows + Grok Build that resolves to the
active codepage rather than UTF-8, so any byte the codepage cannot decode
raises ``UnicodeDecodeError`` from inside the helper thread that drains
the pipe. Once that thread crashes, the calling script returns no valid
output on stdout (or crashes outright), and any dependent monitor that
parses the JSON sees ``head: None`` / empty data.

The fix is to force ``encoding="utf-8"`` and ``errors="replace"`` on every
text-capturing subprocess call. ``replace`` substitutes the U+FFFD
replacement character for any undecodable byte rather than raising; the
parser downstream then sees a well-formed string with at most a handful
of replacement glyphs in the otherwise-clean Greptile body.

Usage
-----

    from _safe_subprocess import run_text

    result = run_text(["gh", "api", "repos/<owner>/<repo>/pulls/<N>"])
    if result.returncode == 0:
        body = result.stdout

Scope
-----
This helper covers the read-side text capture path that the #1366 root
cause analysis identified. It is NOT a general-purpose ``subprocess.run``
replacement -- callers that need binary streams (``capture_output=True``
with ``text=False``) or process redirection should keep using
``subprocess.run`` directly. The helper deliberately rejects ``shell=True``
to keep injection-prone usage out of the framework's surface (per
``coding/security.md`` Input Validation rules).
"""

from __future__ import annotations

import subprocess
from collections.abc import Mapping, Sequence
from typing import Any

# Default timeout (seconds) when callers do not specify one. Mirrors the
# 60s ceiling used by ``scripts/pr_merge_readiness.py::_run_gh`` so the
# helper does not silently relax existing call-site timeouts.
_DEFAULT_TIMEOUT_SECONDS = 60


def run_text(  # noqa: A002 -- `input` parameter name mirrors subprocess.run
    cmd: Sequence[str],
    *,
    timeout: float | None = _DEFAULT_TIMEOUT_SECONDS,
    input: str | None = None,  # noqa: A002
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
    check: bool = False,
    **extra: Any,
) -> subprocess.CompletedProcess[str]:
    """Run ``cmd`` capturing stdout / stderr as UTF-8 text safely.

    Equivalent to::

        subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            ...,
        )

    with the following guarantees:

    - ``encoding="utf-8"`` and ``errors="replace"`` are FORCED -- callers
      cannot override them via ``**extra``. Any attempt is ignored so a
      typo cannot reintroduce the cp1252 decode bug.
    - ``capture_output=True`` is FORCED -- callers cannot accidentally
      pass ``stdout=None`` / ``stderr=None`` and lose the captured streams.
    - ``shell=False`` is FORCED -- callers cannot opt into shell expansion
      via ``**extra`` (mirrors ``coding/security.md`` "no shell=True on
      untrusted input").
    - ``timeout`` defaults to 60s. Pass ``timeout=None`` explicitly to
      disable; pass an explicit value to override. ``subprocess.run``
      raises :class:`subprocess.TimeoutExpired` on overrun -- callers
      handle that the same way they would with the bare API.

    The returned :class:`subprocess.CompletedProcess` exposes ``returncode``,
    ``stdout``, and ``stderr`` exactly as ``subprocess.run`` would. The
    ``check=False`` default mirrors the bare API; pass ``check=True`` to
    raise :class:`subprocess.CalledProcessError` on non-zero exit.

    Args:
        cmd: Argument vector for the child process. MUST be a sequence
            (list / tuple) -- the helper rejects ``str`` to discourage
            shell-quoting bugs (mirrors ``subprocess.run``'s
            ``shell=False`` requirement).
        timeout: Seconds to wait for the child to exit. Defaults to 60.
            Pass ``None`` to wait indefinitely.
        input: Optional UTF-8 text to feed into the child's stdin.
        cwd: Optional working directory for the child.
        env: Optional environment mapping. ``None`` inherits the parent's
            env (the default :func:`subprocess.run` behavior).
        check: If ``True``, raise :class:`subprocess.CalledProcessError`
            on non-zero exit (mirrors :func:`subprocess.run`).
        **extra: Forwarded to :func:`subprocess.run`. Keys that would
            conflict with the forced safety defaults (``capture_output``,
            ``text``, ``encoding``, ``errors``, ``shell``, ``stdout``,
            ``stderr``) are silently dropped.

    Returns:
        :class:`subprocess.CompletedProcess` with ``stdout`` and ``stderr``
        as UTF-8 strings (any undecodable bytes replaced with U+FFFD).

    Raises:
        subprocess.TimeoutExpired: If the child does not exit within
            ``timeout`` seconds.
        subprocess.CalledProcessError: If ``check=True`` and the child
            exits non-zero.
        FileNotFoundError: If the executable cannot be found.
        TypeError: If ``cmd`` is a bare string (callers should pass a
            sequence so argv quoting is unambiguous).
    """
    if isinstance(cmd, (str, bytes)):
        raise TypeError(
            "run_text requires a sequence of arguments (e.g. ['gh', 'api', ...]); "
            "passing a single string would require shell=True which is forbidden."
        )

    # Drop any caller-provided keys that conflict with the forced safety
    # defaults. Silently ignoring beats raising because most callers are
    # mechanically refactoring existing subprocess.run sites that may
    # have redundant text=True / encoding=... kwargs.
    forbidden_keys = {
        "capture_output",
        "text",
        "encoding",
        "errors",
        "shell",
        "stdout",
        "stderr",
    }
    sanitized = {k: v for k, v in extra.items() if k not in forbidden_keys}

    return subprocess.run(
        list(cmd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        timeout=timeout,
        input=input,
        cwd=cwd,
        env=dict(env) if env is not None else None,
        check=check,
        **sanitized,
    )
