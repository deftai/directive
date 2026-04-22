"""_stdio_utf8.py -- Reconfigure sys.stdout / sys.stderr to UTF-8.

Belt-and-suspenders guard for Python scripts under ``scripts/`` that emit
non-ASCII characters (the ``-- / -> / x / !`` style symbols and unicode
equivalents used for success / pending / error / warning markers).

The PRIMARY mechanism for UTF-8 stdout in deft is ``PYTHONUTF8=1`` (set at
the top level of ``Taskfile.yml`` and on every included task per #540). This
module is the SECONDARY safeguard for three scenarios where the env var
does not help:

1. Scripts invoked directly (``python scripts/foo.py``) without going
   through a ``task`` command.
2. Subprocess invocations where the parent process strips or overrides
   the environment.
3. Child Python processes on Windows where the locale-dependent default
   codec (cp1252 on US-English systems) would otherwise crash on the
   unicode glyphs printed by several scripts (#540).

Usage::

    from _stdio_utf8 import reconfigure_stdio
    reconfigure_stdio()

Call once at module top, before any ``print()``. Idempotent: safe to call
more than once and safe on streams that are already UTF-8.
"""

from __future__ import annotations

import sys


def reconfigure_stdio() -> None:
    """Force ``sys.stdout`` / ``sys.stderr`` to UTF-8 without error on failure.

    Python 3.7+ exposes ``reconfigure()`` on ``TextIOWrapper`` streams; for
    redirected / closed / custom streams that lack it, we silently leave
    encoding untouched. The PYTHONUTF8 env set in the task layer is the
    primary fix; this function exists to defend against invocations that
    bypass the task layer entirely.
    """
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        encoding = (getattr(stream, "encoding", "") or "").lower()
        if encoding in ("utf-8", "utf8"):
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except (AttributeError, OSError, ValueError):
            # Reconfigure can fail on streams that aren't TextIOWrapper
            # (e.g. pytest's capsys, subprocess-captured pipes). Silently
            # continue -- the env var path remains the primary defence.
            continue
