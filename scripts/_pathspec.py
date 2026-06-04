"""_pathspec.py -- minimal gitignore-style glob matcher (#1419 Delivery Slice 3).

The judgment-gate engine (``scripts/verify_judgment_gates.py``) needs a path
predicate so a gate can match a diff that touches, say, ``secrets/**`` or
``**/*.pem``. Python's stdlib ``fnmatch`` treats ``*`` as matching across path
separators and has no ``**`` concept, so it is the wrong tool for path globs.
This helper translates a small, well-defined glob dialect to a compiled regex:

* ``*``  -- matches any run of characters WITHIN a single path segment
           (it does NOT cross ``/``).
* ``?``  -- matches exactly one non-``/`` character.
* ``**`` -- matches any number of path segments (including zero). ``a/**/b``
           matches ``a/b``, ``a/x/b``, ``a/x/y/b``; ``**/foo`` matches ``foo``
           and ``x/y/foo``; ``secrets/**`` matches anything under ``secrets/``.
* every other character is matched literally.

Paths and patterns are normalised to forward slashes so a Windows-style
``a\\b`` diff path matches an ``a/b`` glob. Matching is case-sensitive
(POSIX path semantics); callers that need case-insensitivity should lower-case
both sides before calling.

Pure stdlib so the helper stays importable from git hooks without ``uv``.
"""

from __future__ import annotations

import re
from functools import lru_cache


def _normalize(path: str) -> str:
    """Return *path* with backslashes folded to forward slashes."""
    return path.replace("\\", "/")


@lru_cache(maxsize=512)
def _compile(pattern: str) -> re.Pattern[str]:
    """Translate a glob *pattern* to an anchored, compiled regex.

    Cached because the universal gates re-evaluate the same handful of
    patterns against every candidate path on every gate run.
    """
    glob = _normalize(pattern)
    i, n = 0, len(glob)
    out: list[str] = ["^"]
    while i < n:
        char = glob[i]
        if char == "*":
            if glob[i : i + 2] == "**":
                # Consume the full run of '*' so '***' degrades to '**'.
                j = i
                while j < n and glob[j] == "*":
                    j += 1
                # A '**/' segment matches zero or more leading directories;
                # a trailing '**' (no slash) matches the rest of the path.
                if j < n and glob[j] == "/":
                    out.append("(?:.*/)?")
                    i = j + 1
                else:
                    out.append(".*")
                    i = j
            else:
                out.append("[^/]*")
                i += 1
        elif char == "?":
            out.append("[^/]")
            i += 1
        elif char == "/":
            out.append("/")
            i += 1
        else:
            out.append(re.escape(char))
            i += 1
    out.append("$")
    return re.compile("".join(out))


def match_path(pattern: str, path: str) -> bool:
    """True when *path* matches the glob *pattern*."""
    if not isinstance(pattern, str) or not pattern:
        return False
    if not isinstance(path, str) or not path:
        return False
    return _compile(pattern).match(_normalize(path)) is not None


def match_any(patterns: object, path: str) -> bool:
    """True when *path* matches any glob in *patterns* (an iterable of str)."""
    if not isinstance(patterns, (list, tuple)):
        return False
    return any(match_path(p, path) for p in patterns if isinstance(p, str) and p)
