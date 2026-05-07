"""slug_normalize.py -- canonical slug normalization for scope vBRIEF filenames (#532).

Single source of truth for the rules laid out in issue #532. Used by
``scripts/migrate_vbrief.py`` when generating scope vBRIEF filenames so the
migrator and any future skill / helper that creates scope vBRIEFs all agree
on how ``YYYY-MM-DD-<slug>.vbrief.json`` slugs are derived.

Rules (per #532 Suggested normalization rules):

1. Normalize Unicode to NFKD; strip combining marks; drop non-ASCII.
2. Lowercase the entire result.
3. Strip common Markdown checkbox markers (``[x]``, ``[ ]``) before the
   punctuation pass so they do not leak into the slug as a literal ``x``.
4. Replace any run of ``[^a-z0-9]+`` with a single hyphen.
5. Strip leading and trailing hyphens.
6. Truncate at word boundaries at or before ``max_len`` (default 60). If the
   next character after the cut is inside a word, backtrack to the most
   recent hyphen provided that hyphen is past ``max_len // 2``.
7. Empty-slug fallback: return ``"untitled"`` when normalization produces
   an empty string.
8. Reserved names: if the slug equals a Windows reserved name (``con``,
   ``prn``, ``aux``, ``nul``, ``com1``-``com9``, ``lpt1``-``lpt9``), append
   ``-scope``.

Collision handling: :func:`disambiguate_slug` appends ``-2``, ``-3``, ... to
the normalized slug until the candidate is not in the supplied ``existing``
set. Callers typically pass a set pre-populated with stems from existing
lifecycle-folder files.

This module intentionally has no dependency on the rest of the migrator so
future skills (refinement, setup) can import it without dragging the full
migration surface.
"""

from __future__ import annotations

import re
import unicodedata

__all__ = [
    "WINDOWS_RESERVED",
    "DEFAULT_MAX_LEN",
    "normalize_slug",
    "disambiguate_slug",
]

# Windows-reserved filename stems (case-insensitive). Matching is performed on
# the fully normalized slug so ``CON`` -> ``con`` is rejected just like ``con``.
WINDOWS_RESERVED: frozenset[str] = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{i}" for i in range(1, 10)}
    | {f"lpt{i}" for i in range(1, 10)}
)

# Default body length per #532. Shorter than the historic ~80 char ceiling so
# the final ``YYYY-MM-DD-<slug>.vbrief.json`` filename stays well within
# Windows path limits for deeply nested worktrees.
DEFAULT_MAX_LEN: int = 60

# Match a leading checkbox marker at a word boundary: ``[x]``, ``[X]``, ``[ ]``.
# We deliberately only strip leading markers (or those preceded by whitespace)
# rather than anywhere in the string, so a legitimate ``[x]`` inside a sentence
# like ``add [x]-axis scaling`` is not mangled.
_CHECKBOX_RE = re.compile(r"(?:(?<=^)|(?<=\s))\[[ xX]\]")


def normalize_slug(text: str, max_len: int = DEFAULT_MAX_LEN) -> str:
    """Return a filesystem-safe, deterministic slug for ``text``.

    See module docstring for the full rule list.

    Parameters
    ----------
    text:
        Free-form input -- typically a GitHub issue title, ROADMAP line, or
        spec task body.  ``None`` and empty strings return ``"untitled"``.
    max_len:
        Hard ceiling on the returned body length. Default 60. Values less
        than 1 fall back to ``DEFAULT_MAX_LEN`` so callers cannot accidentally
        truncate the slug away entirely.

    Returns
    -------
    str
        A slug matching ``^[a-z0-9]+(-[a-z0-9]+)*$`` with length <= ``max_len``.
    """
    if not text:
        return "untitled"
    if max_len < 1:
        max_len = DEFAULT_MAX_LEN

    # 1. Unicode NFKD, drop combining marks, drop non-ASCII.
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_only = "".join(
        ch for ch in decomposed if not unicodedata.combining(ch)
    )
    ascii_only = ascii_only.encode("ascii", "ignore").decode("ascii")

    # 2. Lowercase.
    lowered = ascii_only.lower()

    # 3. Strip checkbox markers before the punctuation pass so ``[x]`` does
    # not leak into the slug as a literal ``x``.
    stripped = _CHECKBOX_RE.sub(" ", lowered)

    # 4. Collapse non-alphanumeric runs to a single hyphen.
    hyphenated = re.sub(r"[^a-z0-9]+", "-", stripped)

    # 5. Strip leading/trailing hyphens.
    trimmed = hyphenated.strip("-")

    # 6. Truncate at word boundaries at or before max_len.
    if len(trimmed) > max_len:
        truncated = trimmed[:max_len]
        # If we cut mid-word, backtrack to the most recent hyphen provided
        # that hyphen is past max_len // 2 -- otherwise the slug collapses
        # too aggressively for short limits.
        if trimmed[max_len] not in "-":
            last_hyphen = truncated.rfind("-")
            if last_hyphen > max_len // 2:
                truncated = truncated[:last_hyphen]
        trimmed = truncated.rstrip("-")

    # 7. Empty-after-normalization fallback.
    if not trimmed:
        return "untitled"

    # 8. Windows reserved names.
    if trimmed in WINDOWS_RESERVED:
        return f"{trimmed}-scope"

    return trimmed


def disambiguate_slug(
    slug: str,
    existing: set[str] | frozenset[str],
    *,
    max_len: int = DEFAULT_MAX_LEN,
) -> str:
    """Return a collision-free variant of ``slug`` relative to ``existing``.

    Appends ``-2``, ``-3``, ... to ``slug`` until the candidate is not in
    ``existing``. The suffix always respects ``max_len`` by truncating the
    body portion when necessary so the final slug remains within the ceiling.

    The function does NOT mutate ``existing``; callers record the returned
    value themselves once it is adopted.
    """
    if slug not in existing:
        return slug

    base = slug
    n = 2
    while True:
        suffix = f"-{n}"
        candidate = base + suffix
        if len(candidate) > max_len:
            # Trim the base to make room for the suffix; rstrip hyphens so we
            # do not produce e.g. ``foo--2``.
            body_budget = max_len - len(suffix)
            if body_budget < 1:
                # Pathological short max_len -- just return the base + suffix;
                # caller's filesystem handling will still reject if absurd.
                body_budget = 1
            trimmed = base[:body_budget].rstrip("-") or base[:body_budget]
            candidate = trimmed + suffix
        if candidate not in existing:
            return candidate
        n += 1
        # Guard against runaway loops on pathological inputs (e.g. ``existing``
        # that contains every integer suffix). 10_000 is well above any
        # reasonable real-world collision depth.
        if n > 10_000:
            raise RuntimeError(
                f"disambiguate_slug: unable to resolve collision for {slug!r} "
                f"after {n} attempts"
            )
