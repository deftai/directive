#!/usr/bin/env python3
"""scripts/_agents_md.py -- shared AGENTS.md managed-section helpers (#1389).

Single source of truth for the AGENTS.md managed-section parse / render /
freshness-plan logic. Extracted verbatim from the ``run`` module so BOTH
``run`` (the CLI entry point) and ``scripts/doctor.py`` (the canonical
doctor) can import the same implementation instead of duplicating it.

Why this module exists
----------------------
After the Epic-1 doctor carve (#1335 / #1336) ``scripts/doctor.py`` became
the owner of doctor core logic, but the AGENTS.md managed-section helpers it
needs to compute a freshness verdict still lived in ``run``. The doctor
module could not import them cleanly (``run`` has heavy import-time side
effects -- rich / prompt_toolkit / textual probes), so
``_agents_refresh_plan`` was left as an interim stub that always reported
``{"state": "unreadable"}`` and produced a spurious AGENTS.md-freshness
warning on every consumer ``task doctor`` run (#1389).

This module is intentionally PURE: stdlib-only, no rich / prompt_toolkit /
textual, and NO side effects at import time. Importing it from either rail
is therefore safe and cheap.

The marker contract mirrors ``run``: v1 (#1044 v0.26), v2 (#992 PR1 v0.27)
and v3 (#1046 PR-B, with ``sha`` / ``refreshed`` / ``session`` provenance
attributes on the open tag). ``cmd_agents_refresh`` stamps the v3 attributes
at write time; the staleness classifier normalises the open tag to the bare
v3 form before byte-comparing so the per-refresh attributes never poison
idempotency.

Story: #1389 (follow-up to #1335 / #1336 doctor carve; refs #1308 / #1309).
"""

from __future__ import annotations

import re
import subprocess
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

# --- Managed-section marker contract (verbatim from run) -------------------
#
# v1 was the v0.26 marker (``<!-- deft:managed-section v1 -->``). v2 was the
# v0.27 marker (#992 PR1). v3 is the #1046 PR-B marker that carries refresh
# provenance as attributes on the open tag: ``<!-- deft:managed-section v3
# sha=<framework-sha> refreshed=<iso> session=<id> -->``. The parser accepts
# v1, v2 AND v3 (with or without attributes) so a consumer whose AGENTS.md is
# bracketed by a legacy v1/v2 marker classifies as ``stale`` and the
# bracketed block is byte-replaced in place by the current v3 render (#1044)
# -- never appended as a second managed block.
_AGENTS_MANAGED_OPEN = "<!-- deft:managed-section v3 -->"
_AGENTS_MANAGED_OPEN_V2_LITERAL = "<!-- deft:managed-section v2 -->"
_AGENTS_MANAGED_OPEN_V3_LITERAL = "<!-- deft:managed-section v3 -->"
_AGENTS_MANAGED_CLOSE = "<!-- /deft:managed-section -->"

# Accepts v1, v2 and v3 (with-or-without attributes). Group 1 = version
# (1, 2 or 3). Group 2 = the raw attribute string or '' when no attributes
# are present. v1 acceptance (#1044) is the load-bearing fix that routes a
# legacy marker through the in-place byte-replace path instead of the
# legacy-wrap append path.
_AGENTS_MANAGED_OPEN_RE = re.compile(
    r"<!--\s*deft:managed-section\s+v(1|2|3)(?:\s+([^>]*?))?\s*-->"
)

# Recognised attribute keys on the v3 marker. Extra keys are tolerated
# (parsed into ``extras``) so a future minor extension does not require a
# marker rebump; absence of any recognised key is also tolerated (the bare
# ``v3`` form is the canonical template-shipped marker; attributes are
# stamped at refresh time by ``cmd_agents_refresh``).
_AGENTS_MANAGED_V3_ATTR_KEYS: tuple[str, ...] = ("sha", "refreshed", "session")


# --- Framework-root + template resolution ----------------------------------


def framework_root() -> Path:
    """Return the framework root (the directory that owns ``templates/``).

    This module lives at ``<framework-root>/scripts/_agents_md.py`` in both
    the source checkout and a consumer install (``<deftDir>/scripts/``), so
    the framework root is two parents up. Mirrors ``run::get_script_dir()``
    (which returns the directory containing ``run`` at the framework root).
    """
    return Path(__file__).resolve().parent.parent


def _agents_template_path() -> Path:
    """Return the absolute path to the canonical AGENTS.md template."""
    return framework_root() / "templates" / "agents-entry.md"


def _read_agents_template() -> str | None:
    """Return the AGENTS.md template text, or None when not readable.

    The Go installer embeds the same file via ``//go:embed`` in
    ``templates/embed.go``; the Python rail reads it from disk at runtime so
    ``cmd_agents_refresh`` works against the live framework checkout.
    """
    candidate = _agents_template_path()
    if not candidate.is_file():
        return None
    try:
        return candidate.read_text(encoding="utf-8")
    except OSError:
        return None


# --- Managed-section parse / render helpers ---------------------------------


def _find_managed_open_marker(text: str) -> re.Match | None:
    """Return the regex match for the open marker (v1, v2 OR v3), or None."""
    return _AGENTS_MANAGED_OPEN_RE.search(text)


def _iter_managed_sections(text: str) -> list[tuple]:
    """Yield ``(start, end, block)`` triples for every managed section (#1044).

    Walks ``text`` left-to-right collecting every well-formed
    ``<open>...<close>`` region. ``start`` is the open marker's first byte
    index, ``end`` is the byte index just past the close marker, and
    ``block`` is the corresponding text slice. Used by
    ``_agents_refresh_plan`` to collapse the duplicate-block recovery case
    (a v1 marker coexisting with a v3 marker because a partial upgrade ran
    the append path before this fix) into a single v3 block at the position
    of the first managed section -- preserving surrounding user content
    order.
    """
    results: list[tuple] = []
    pos = 0
    while pos <= len(text):
        open_match = _AGENTS_MANAGED_OPEN_RE.search(text, pos)
        if open_match is None:
            break
        close_idx = text.find(_AGENTS_MANAGED_CLOSE, open_match.end())
        if close_idx < 0:
            break
        end = close_idx + len(_AGENTS_MANAGED_CLOSE)
        results.append((open_match.start(), end, text[open_match.start():end]))
        pos = end
    return results


def _parse_managed_section_attrs(extracted: str) -> dict | None:
    """Parse the open-marker attributes from an extracted managed section.

    Returns a dict with keys ``version`` (int, 1, 2 or 3), ``sha`` (str or
    None), ``refreshed`` (ISO 8601 str or None), ``session`` (str or None),
    and ``extras`` (dict of unrecognised ``key=value`` pairs). Returns None
    when ``extracted`` does not match the open marker regex. v1 markers
    (#1044 back-compat) parse with ``version=1`` and ``None`` for every
    provenance attribute -- v1 never carried attributes.

    Attribute syntax is ``key=value`` separated by whitespace. Quoted values
    (``key='value'``, ``key="value"``) are unwrapped automatically. Unknown
    keys are captured in ``extras`` rather than silently dropped.
    """
    match = _find_managed_open_marker(extracted)
    if match is None:
        return None
    version = int(match.group(1))
    attrs_raw = match.group(2) or ""
    result: dict = {
        "version": version,
        "sha": None,
        "refreshed": None,
        "session": None,
        "extras": {},
    }
    for raw_pair in attrs_raw.split():
        if "=" not in raw_pair:
            continue
        key, _, value = raw_pair.partition("=")
        key = key.strip().lower()
        value = value.strip().strip("'\"")
        if not key:
            continue
        if key in _AGENTS_MANAGED_V3_ATTR_KEYS:
            result[key] = value
        else:
            result["extras"][key] = value
    return result


def _strip_managed_section_attrs(section: str) -> str:
    """Normalise the open marker to the bare v3 form (#1046 PR-B, #1044).

    Replaces any legacy v1 / v2 / attributed-v3 open marker with the bare
    ``<!-- deft:managed-section v3 -->`` literal so byte-equality comparisons
    against the rendered template are not poisoned by per-refresh ``sha`` /
    ``refreshed`` / ``session`` tokens. Only the FIRST open marker is
    normalised. Pure -- no I/O.
    """
    return _AGENTS_MANAGED_OPEN_RE.sub(
        _AGENTS_MANAGED_OPEN_V3_LITERAL, section, count=1
    )


def _render_managed_section(template_text: str) -> str | None:
    """Extract the deft:managed-section block from the template.

    Returns the byte sequence (newlines normalised to ``\\n``) bracketed by
    the open/close markers, INCLUSIVE, with the open marker normalised to the
    bare v3 form (the canonical staleness-comparison baseline). Returns None
    when either marker is missing.

    Placeholder substitution is intentionally a no-op: the documented tokens
    (``{{UPSTREAM_SHA}}``, etc.) are inherited from the webinstaller
    pin-marker contract and rendered there. Leaving them as literal text
    keeps ``--check`` byte-stable when the framework is checked out without
    git metadata.
    """
    normalised = template_text.replace("\r\n", "\n")
    open_match = _find_managed_open_marker(normalised)
    if open_match is None:
        return None
    open_idx = open_match.start()
    close_idx = normalised.find(_AGENTS_MANAGED_CLOSE, open_match.end())
    if close_idx < 0:
        return None
    end = close_idx + len(_AGENTS_MANAGED_CLOSE)
    block = normalised[open_idx:end]
    return _strip_managed_section_attrs(block)


def _extract_managed_section(text: str) -> str | None:
    """Pull the managed-section block out of the consumer's AGENTS.md text.

    Returns the bracketed block (normalised to LF, marker bytes preserved
    verbatim including any v3 ``sha=/refreshed=/session=`` attributes) or
    None if either marker is absent. Accepts BOTH the legacy v2 and the
    canonical v3 open markers (#1046 PR-B back-compat parser).
    """
    normalised = text.replace("\r\n", "\n")
    open_match = _find_managed_open_marker(normalised)
    if open_match is None:
        return None
    open_idx = open_match.start()
    close_idx = normalised.find(_AGENTS_MANAGED_CLOSE, open_match.end())
    if close_idx < 0:
        return None
    end = close_idx + len(_AGENTS_MANAGED_CLOSE)
    return normalised[open_idx:end]


# --- Framework SHA + session id + timestamps -------------------------------


def _now_utc() -> datetime:
    """Return UTC-aware ``datetime.now`` (split out for test monkeypatching)."""
    return datetime.now(UTC)


def _now_utc_iso() -> str:
    """UTC ISO-8601 timestamp at seconds precision."""
    return _now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")


def _resolve_framework_sha() -> str:
    """Return the current framework checkout's HEAD sha (short form).

    Resolution: ``git rev-parse --short=12 HEAD`` rooted at the framework
    root. Falls back to ``unknown`` on subprocess failure (git missing /
    non-git checkout / hook permission error). Best-effort -- the v3 marker
    tolerates the fallback string verbatim so refresh remains idempotent
    across environments lacking git metadata.
    """
    script_dir = str(framework_root())
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
            cwd=script_dir,
        )
    except (subprocess.TimeoutExpired, OSError):
        return "unknown"
    if result.returncode != 0:
        return "unknown"
    sha = (result.stdout or "").strip()
    return sha or "unknown"


def _new_session_id() -> str:
    """Return a freshly-synthesised 12-char session id (#1046 PR-B AC-5)."""
    return uuid.uuid4().hex[:12]


def _attribute_render_managed_section(
    rendered: str,
    *,
    framework_sha: str,
    refreshed: str,
    session_id: str,
) -> str:
    """Inject v3 attributes into a bare-rendered managed section (#1046 PR-B AC-5).

    Takes the byte-stable ``rendered`` block (open marker = bare
    ``<!-- deft:managed-section v3 -->``) emitted by
    ``_render_managed_section`` and produces the attribute-rich form
    consumers write to disk::

        <!-- deft:managed-section v3 sha=<sha> refreshed=<iso> session=<id> -->

    Only the open marker is mutated -- the body bytes between the open/close
    markers are preserved verbatim so subsequent staleness classification
    (after attribute stripping) returns ``current``.
    """
    attr_string = f"v3 sha={framework_sha} refreshed={refreshed} session={session_id}"
    attributed_open = f"<!--{' '}deft:managed-section {attr_string} -->"
    return rendered.replace(_AGENTS_MANAGED_OPEN_V3_LITERAL, attributed_open, 1)


def _wrap_legacy_in_markers(existing: str, rendered: str) -> str:
    """Produce the once-per-project legacy-to-marker migration body.

    The consumer's existing pre-marker AGENTS.md content is preserved
    verbatim ABOVE the new managed section -- so user notes outside the deft
    block survive the migration. The rendered managed-section block is
    appended (with a blank-line separator) so subsequent refreshes can
    operate on the bracketed region in place.
    """
    body = existing.replace("\r\n", "\n").rstrip("\n")
    if body:
        return body + "\n\n" + rendered + "\n"
    return rendered + "\n"


# --- Refresh-plan verdict --------------------------------------------------


def _agents_refresh_plan(
    project_root: Path,
    *,
    read_template: Callable[[], str | None] | None = None,
    resolve_sha: Callable[[], str] | None = None,
    now_iso: Callable[[], str] | None = None,
    new_session: Callable[[], str] | None = None,
) -> dict:
    """Compute the plan ``cmd_agents_refresh`` would apply (no I/O writes).

    The plan dict reports a ``state`` (``current`` / ``stale`` / ``missing``
    / ``absent`` / ``unreadable`` / ``template-missing`` /
    ``template-malformed``) and the byte-content the command would write on a
    non-current state. The stale / absent / missing payloads carry the
    v3-attributed marker stamped with a fresh sha / refreshed / session
    triple so each refresh records its own session lineage (#1046 PR-B
    AC-5). The staleness check itself ignores those attributes -- both the
    extracted block and the rendered template are normalised to the bare
    ``v3`` marker before byte-comparing, so re-running refresh on a current
    file is a no-op.

    The four ``read_template`` / ``resolve_sha`` / ``now_iso`` /
    ``new_session`` seams are injectable so ``run`` can route its own
    (monkeypatchable) helpers through the shared implementation while
    ``scripts/doctor.py`` calls it with the module defaults. They default to
    this module's own pure helpers when omitted (#1389).
    """
    _read = read_template or _read_agents_template
    _sha = resolve_sha or _resolve_framework_sha
    _now = now_iso or _now_utc_iso
    _session = new_session or _new_session_id

    template_text = _read()
    if template_text is None:
        return {
            "state": "template-missing",
            "path": str(project_root / "AGENTS.md"),
            "rendered": None,
            "existing": None,
            "new_content": None,
        }
    rendered = _render_managed_section(template_text)
    if rendered is None:
        return {
            "state": "template-malformed",
            "path": str(project_root / "AGENTS.md"),
            "rendered": None,
            "existing": None,
            "new_content": None,
        }
    framework_sha = _sha()
    refreshed = _now()
    session_id = _session()
    attributed_rendered = _attribute_render_managed_section(
        rendered,
        framework_sha=framework_sha,
        refreshed=refreshed,
        session_id=session_id,
    )
    agents_md = project_root / "AGENTS.md"
    if not agents_md.is_file():
        return {
            "state": "absent",
            "path": str(agents_md),
            "rendered": rendered,
            "attributed_rendered": attributed_rendered,
            "sha": framework_sha,
            "refreshed": refreshed,
            "session": session_id,
            "existing": None,
            "new_content": attributed_rendered + "\n",
        }
    try:
        existing = agents_md.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {
            "state": "unreadable",
            "path": str(agents_md),
            "rendered": rendered,
            "existing": None,
            "new_content": None,
            "error": str(exc),
        }
    normalised = existing.replace("\r\n", "\n")
    blocks = _iter_managed_sections(normalised)
    if not blocks:
        # Legacy file with no markers -- one-time migration: wrap the
        # existing content + render the managed-section beneath it.
        new_content = _wrap_legacy_in_markers(normalised, attributed_rendered)
        return {
            "state": "missing",
            "path": str(agents_md),
            "rendered": rendered,
            "attributed_rendered": attributed_rendered,
            "sha": framework_sha,
            "refreshed": refreshed,
            "session": session_id,
            "existing": existing,
            "new_content": new_content,
        }
    if len(blocks) > 1:
        # Duplicate-block recovery (#1044): collapse to a single
        # v3-attributed block at the position of the FIRST block so
        # surrounding user content order is preserved. Walk in reverse to
        # keep slice indices valid as we remove each block.
        first_start = blocks[0][0]
        new_content = normalised
        for start, end, _ in reversed(blocks):
            new_content = new_content[:start] + new_content[end:]
        new_content = (
            new_content[:first_start]
            + attributed_rendered
            + new_content[first_start:]
        )
        return {
            "state": "stale",
            "path": str(agents_md),
            "rendered": rendered,
            "attributed_rendered": attributed_rendered,
            "sha": framework_sha,
            "refreshed": refreshed,
            "session": session_id,
            "existing": existing,
            "new_content": new_content,
        }
    # Single managed block -- the canonical refresh path.
    extracted = blocks[0][2]
    # Force-upgrade v1 / v2 -> v3 even when body bytes match.
    extracted_attrs = _parse_managed_section_attrs(extracted)
    is_legacy_marker = (
        extracted_attrs is not None and extracted_attrs["version"] in (1, 2)
    )
    if not is_legacy_marker and _strip_managed_section_attrs(extracted) == rendered:
        return {
            "state": "current",
            "path": str(agents_md),
            "rendered": rendered,
            "existing": existing,
            "new_content": existing,
        }
    # Stale: byte-replace the bracketed block in place with the
    # v3-attributed rendered block.
    new_content = normalised.replace(extracted, attributed_rendered, 1)
    return {
        "state": "stale",
        "path": str(agents_md),
        "rendered": rendered,
        "attributed_rendered": attributed_rendered,
        "sha": framework_sha,
        "refreshed": refreshed,
        "session": session_id,
        "existing": existing,
        "new_content": new_content,
    }
