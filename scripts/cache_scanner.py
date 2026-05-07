#!/usr/bin/env python3
r"""cache_scanner.py -- quarantine scanner v2 for the unified cache (#883 Story 2).

Public surface
--------------

``scan(content_md: str) -> ScanResult``
    Run the three baseline categories over ``content_md`` and return a
    structured :class:`ScanResult` carrying ``passed`` (False iff any
    hard-fail severity flag fires), the per-category ``flags`` list, and
    the ``transformed_content`` that the cache layer should persist as
    ``content.md`` when ``passed`` is True.

``SCANNER_VERSION``
    Module-level SemVer string. Bumped per the documented rule:

    - patch (``2.0.x``) -- pattern additions to an existing category
    - minor (``2.x.0``) -- new category landed (e.g. shell-cmd-injection)
      OR a material detection-policy change that alters which bodies flag
      (e.g. v2.1.0 #949 strict-signal injection-heading tuning)
    - major (``x.0.0``) -- semantic rewrite (e.g. cache:put hard-fails on
      every fence-and-pass match instead of writing content.md)

Scanner v2 baseline categories
------------------------------

1. ``injection-heading`` -- severity ``fence-and-pass``. Tuned in v2.1.0 for
   precision against organic GitHub issue templates (#949). The detector
   no longer fires on bare imperative-shaped headings (``## STEP 1``,
   ``## Action items``, ``## Important notes``, ``## Task list``,
   ``## Background``, ...). It now requires a *structural* injection
   signal before flagging: either (a) an instruction-override / role-hijack
   phrase in the heading text -- ``IGNORE/DISREGARD/FORGET PREVIOUS``,
   ``SYSTEM:`` / ``ASSISTANT:`` / ``USER:`` / ``AGENT:`` / ``OVERRIDE:`` /
   ``DIRECTIVE:`` / ``ROLE:`` / ``INSTRUCTION(S):`` / ``PROMPT:`` /
   ``TOOL:`` / ``FUNCTION:`` at the heading's start -- or (b) a shell
   vector inside the heading's body (``curl ... | sh``, ``wget ... | sh``,
   ``base64 -d``, ``eval``, ``sh -c``, ```eval `cmd``` ``). Plain-prose
   lines with the same instruction-override phrasing also flag. The
   structural-signal check is the sole gate -- there is no allowlist
   short-circuit, so a benign-template heading whose tail smuggles an
   injection phrase (e.g. ``## STEP 1 - Ignore previous instructions``)
   still flags. ``quarantine_ext`` keeps its broader policy untouched --
   this category owns its own detection + wrapping. The flag carries
   ``match_count`` = number of detected sections.

2. ``credentials`` -- severity ``hard-fail``. A curated regex set covering
   the canonical exfiltratable secret shapes (``gh[pousr]_``, ``sk-`` /
   ``sk-ant-``, ``xox[bp]-``, ``AKIA``, PEM private-key headers, ``Bearer``
   tokens, JWTs). When any pattern matches, ``passed`` is set to ``False``
   and ``cache:put`` declines to write ``content.md``. The flag's
   ``detail`` field carries the pattern label (e.g. ``"github-pat"``)
   NOT the matched bytes -- a redacted descriptor only, so the audit log
   never persists the secret it caught.

3. ``invisible-unicode`` -- severity ``strip-and-pass``. A codepoint
   membership test against the canonical bidi / zero-width / tag character
   set (U+200B-200F, U+202A-202E, U+2060, U+2066-2069, U+FEFF,
   U+E0000-U+E007F). Matched codepoints are stripped from
   ``transformed_content`` and the flag's ``match_count`` field records
   how many were removed (the precise codepoint set is summarised in
   ``detail`` as a comma-separated list of ``U+XXXX`` labels).

Order of operations
-------------------

Within a single :func:`scan` call:

1. Invisible-unicode strip runs FIRST so subsequent categories scan the
   visible-only text. A credential token that smuggles itself across a
   word boundary using a U+200B (e.g. ``gh\u200bp_<...>``) would otherwise
   slip past the credentials regex; stripping first closes that hole.

2. Credentials regex runs on the stripped text. The flag is recorded
   immediately; we do NOT short-circuit the scan even when ``passed``
   becomes False, because the meta.json audit trail is more useful with
   the full flag list.

3. Injection-heading wrap runs LAST on the stripped text. The transform
   is applied unconditionally; ``transformed_content`` is the
   strip-then-fence output regardless of ``passed``. (Callers that ignore
   the transform on hard-fail are fine -- ``cache:put`` writes
   raw.json + meta.json only when ``passed`` is False, never the
   transformed_content.)

CLI
---

The module is callable as a script for ad-hoc inspection:

    python scripts/cache_scanner.py [<input-file>]

Reads input file (or stdin), runs :func:`scan`, and writes the JSON
representation of the :class:`ScanResult` to stdout. Exit code is
0 when scan_result.passed is True, 2 when False -- mirrors the cache:put
exit-code contract so a caller piping content through the scanner gets
an actionable signal without having to parse the JSON.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

# Make ``scripts`` importable when this file is invoked via
# ``python scripts/cache_scanner.py`` from a Taskfile dispatch.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Module-level scanner SemVer. The version is persisted into every
#: meta.json scan_result.scanner_version field on cache:put so a future
#: cache:doctor --rescan (deferred to v2) can detect entries written by
#: an older scanner and re-run them. Bump rules in module docstring.
#:
#: 2.0.0 -- baseline (3 categories on, injection-heading reused
#: quarantine_ext.SUSPICIOUS_TOKENS).
#: 2.1.0 -- injection-heading detector tuned for precision (#949): tighter
#: structural-signal policy (instruction-override / role-hijack / body
#: shell-vector) reduces the false-positive rate from ~85% to <20% on
#: organic deftai/directive issue bodies. No schema break; existing
#: meta.json + audit-log records remain valid.
SCANNER_VERSION: str = "2.1.0"

#: Categories baselined in scanner v2. Frozen tuple so the ordering
#: matches the meta.json ScanFlag.category enum in
#: vbrief/schemas/cache-meta.schema.json.
CATEGORIES: tuple[str, ...] = (
    "injection-heading",
    "credentials",
    "invisible-unicode",
)

#: Severity per category. Per-category severity is a documented epic
#: departure from the design doc's uniform hard-fail; rationale lives in
#: vbrief/active/.../883-deft-cache-quarantine-v1.vbrief.json under
#: metadata.x-tracking.design_doc_departures.
SEVERITY_BY_CATEGORY: dict[str, str] = {
    "injection-heading": "fence-and-pass",
    "credentials": "hard-fail",
    "invisible-unicode": "strip-and-pass",
}

# ---------------------------------------------------------------------------
# Credentials patterns
# ---------------------------------------------------------------------------

#: Curated regex set for the credentials category. Each entry pairs a
#: short label (carried into ScanFlag.detail) with a compiled regex. The
#: label is what the audit log persists -- the matched secret itself is
#: NEVER persisted (per cache-meta.schema.json's ScanFlag.detail
#: redaction rule). Patterns are anchored loose-but-specific: tight
#: enough to avoid false positives in benign prose, loose enough to
#: catch real-world variations.
#:
#: Layout: list of (label, compiled-regex) tuples. Order is the order
#: emitted into flags; not security-critical, but kept consistent so
#: tests can pin offsets without flake.
_CREDENTIAL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # GitHub personal-access tokens. The four prefixes (``ghp_``, ``gho_``,
    # ``ghu_``, ``ghs_``, ``ghr_``) cover personal / oauth / user-to-server
    # / server-to-server / refresh tokens respectively. The 30+ trailing
    # alphanumeric run is the documented gh format.
    ("github-pat", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    # Anthropic API key (sk-ant-...). Listed BEFORE the generic ``sk-``
    # OpenAI pattern so the more-specific match wins (re.search is
    # iteration-order independent but the per-flag label depends on
    # which pattern fired first; sk-ant should win for clarity).
    ("anthropic-api-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    # OpenAI API key (sk-...). The 20+ trailing run keeps the pattern
    # specific enough to skip false positives like ``sk-discovery`` or
    # ``sk-rules`` that show up in non-token prose.
    ("openai-api-key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    # Slack tokens. ``xoxb-`` (bot) and ``xoxp-`` (user) are the two
    # commonly-leaked variants; ``xoxa-`` / ``xoxs-`` are session-scoped
    # and out of v1 scope.
    ("slack-token", re.compile(r"\bxox[bp]-[A-Za-z0-9-]{20,}\b")),
    # AWS access-key-id. The ``AKIA`` prefix + exactly-16 A-Z0-9 run is
    # the canonical AWS IAM access-key shape; ``ASIA`` (session keys)
    # is intentionally NOT covered in v1 because session keys are
    # short-lived and the false-positive rate against codenames is high.
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    # PEM private key BEGIN header. Matches RSA / DSA / EC / generic
    # ``PRIVATE KEY`` variants (``OPENSSH PRIVATE KEY`` is the modern
    # ssh-keygen default).
    (
        "pem-private-key",
        re.compile(
            r"-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"
        ),
    ),
    # Bearer authorization header. The 20+ run guards against the
    # word "Bearer" used in benign prose (e.g. "the Bearer of bad news").
    (
        "bearer-token",
        re.compile(r"\bBearer\s+[A-Za-z0-9_.~+/=-]{20,}\b"),
    ),
    # JWT shape: three base64url segments separated by dots. The
    # ``eyJ`` prefix is the base64url encoding of the JSON ``{"`` header
    # opener -- effectively unique to JWTs.
    (
        "jwt",
        re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
    ),
]

# ---------------------------------------------------------------------------
# Invisible-unicode codepoints
# ---------------------------------------------------------------------------

#: Codepoint set for the invisible-unicode category. Each codepoint that
#: appears here is stripped from the content and counted against the
#: invisible-unicode flag. The set covers:
#:
#: - U+200B..U+200F -- zero-width space, zero-width non-joiner, joiner,
#:   left-to-right mark, right-to-left mark.
#: - U+202A..U+202E -- LRE, RLE, PDF, LRO, RLO (bidi overrides; the
#:   well-known "trojan source" attack vector).
#: - U+2060          -- word joiner (zero-width non-breaking).
#: - U+2066..U+2069 -- LRI, RLI, FSI, PDI (isolates; #2024-bidi-attack
#:   vector).
#: - U+FEFF          -- byte-order mark / zero-width no-break space.
#: - U+E0000..U+E007F -- tag characters / language-tag block (Unicode
#:   "tag" plane; abused for invisible exfiltration).
_INVISIBLE_RANGES: tuple[tuple[int, int], ...] = (
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2060),
    (0x2066, 0x2069),
    (0xFEFF, 0xFEFF),
    (0xE0000, 0xE007F),
)


def _is_invisible(ch: str) -> bool:
    """Return True iff ``ch`` is in the invisible-unicode strip set."""
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _INVISIBLE_RANGES)


# ---------------------------------------------------------------------------
# Injection-heading detection (#949 tuning)
# ---------------------------------------------------------------------------

#: Structural injection signal detected within a heading TEXT. A heading
#: that triggers any of these patterns is treated as a real injection
#: vector. The patterns are deliberately narrow so generic prose ("the
#: user clicks ...", "system requires ...") does NOT fire.
#:
#: 1. Override / disregard phrases -- the canonical prompt-injection
#:    opener ("ignore previous instructions", "disregard the above",
#:    "forget prior"). Word-boundary on the verb; the operand requires
#:    one of {previous, prior, above, all, earlier, your}.
#: 2. Role-hijack prefix at the START of the heading text -- ``SYSTEM:``,
#:    ``ASSISTANT:``, ``USER:``, ``AGENT:``, ``TOOL:``, ``FUNCTION:``,
#:    ``OVERRIDE:``, ``DIRECTIVE:``, ``ROLE:``, ``PROMPT:``,
#:    ``INSTRUCTION:``, ``INSTRUCTIONS:``. The colon-anchored shape is
#:    the distinctive injection vector; ``System Requirements`` / ``User
#:    Story`` / etc. do NOT match because they lack the colon.
_INJECTION_OVERRIDE_RE: re.Pattern[str] = re.compile(
    r"\b(?:ignore|disregard|forget|override|bypass)\s+(?:the\s+|all\s+|any\s+)?"
    r"(?:previous|prior|above|earlier|all|your|preceding|original|system)\b",
    re.IGNORECASE,
)

_HEADING_ROLE_PREFIXES: tuple[str, ...] = (
    "SYSTEM",
    "ASSISTANT",
    "USER",
    "AGENT",
    "TOOL",
    "FUNCTION",
    "OVERRIDE",
    "DIRECTIVE",
    "ROLE",
    "PROMPT",
    "INSTRUCTION",
    "INSTRUCTIONS",
)

_HEADING_ROLE_PREFIX_RE: re.Pattern[str] = re.compile(
    r"^(?:" + "|".join(re.escape(p) for p in _HEADING_ROLE_PREFIXES) + r")\s*:",
    re.IGNORECASE,
)

#: Body-context shell-vector regex. When a heading's body (the lines
#: between the heading and the next heading) contains any of these
#: patterns, the heading is treated as a pre-roll for a shell-injection
#: vector and flagged. This is the ONLY body-context signal the v2.1.0
#: injection-heading detector consumes; the dedicated shell-cmd-injection
#: scanner category that would do this body-wide is intentionally
#: deferred (#949 follow-up).
_BODY_VECTOR_RE: re.Pattern[str] = re.compile(
    # Shell set kept consistent across all three sub-patterns (pipe-to-
    # shell, ``sh -c``, ``/bin/sh -c``) so a vector like ``ksh -c '...'``
    # or ``/bin/ksh -c '...'`` is not silently passed through; ksh was
    # previously only listed in the pipe-to-shell alternative which left
    # a blind spot the other two branches did not cover. Refs PR #957
    # Greptile review on commit 5acfa8a.
    r"(?:curl|wget|fetch)\s+[^|\n]*\|\s*(?:sh|bash|zsh|ksh)\b"
    r"|\bbase64\s+(?:-d|--decode|-D)\b"
    r"|\beval\s*[\(\$\"'`]"
    r"|\b(?:sh|bash|zsh|ksh)\s+-c\s+[\"']"
    r"|\b/bin/(?:sh|bash|zsh|ksh)\s+-c\s+[\"']",
    re.IGNORECASE,
)

#: Heading regex (mirrors quarantine_ext._HEADING_RE). 1-6 hashes plus
#: at least one space; setext-style ``===`` / ``---`` is intentionally
#: out of scope (vanishingly rare in GitHub issue bodies, multi-line
#: lookahead would complicate the iteration).
_HEADING_RE: re.Pattern[str] = re.compile(r"^(#{1,6})\s+(.*\S.*)$")

#: Code-fence delimiter regex.
_FENCE_RE: re.Pattern[str] = re.compile(r"^(```|~~~)")

#: Quarantine fence labels (mirror quarantine_ext for downstream-grep
#: compatibility -- the literal ``quarantined`` label is the contract).
_QUARANTINE_FENCE_OPEN: str = "```quarantined"
_QUARANTINE_FENCE_CLOSE: str = "```"


def _heading_text(line: str) -> str | None:
    """Return the heading text portion (after the ``#``-prefix) or None."""
    match = _HEADING_RE.match(line)
    if match is None:
        return None
    return match.group(2).strip()


def _heading_signal(text: str) -> bool:
    """Return True iff the heading text carries a structural injection signal."""
    if _INJECTION_OVERRIDE_RE.search(text):
        return True
    return bool(_HEADING_ROLE_PREFIX_RE.match(text))


def _body_has_shell_vector(body_lines: list[str]) -> bool:
    """Return True iff any non-fenced line in ``body_lines`` matches the shell vector.

    Lines inside nested code-fence blocks are skipped so a legitimate
    technical doc that illustrates a shell command inside a fenced
    example (e.g. a ``## Steps to reproduce`` body containing
    ```` ```sh\ncurl ... | sh\n``` ````) does not FP-flag. The fence
    state machine mirrors the outer loop in
    :func:`_detect_injection_heading`: a closing fence MUST be only the
    delim chars after right-trim (per CommonMark a closer carries no
    info string), so ``` ```python ``` is an OPENER for a nested block
    rather than a closer for the outer one. Refs PR #957 Greptile P1.
    """
    in_fence: str | None = None
    for ln in body_lines:
        fence_match = _FENCE_RE.match(ln)
        if fence_match:
            delim = fence_match.group(1)
            if in_fence is None:
                in_fence = delim
            elif ln.rstrip() == in_fence:
                in_fence = None
            continue
        if in_fence is not None:
            continue
        if _BODY_VECTOR_RE.search(ln):
            return True
    return False


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------


@dataclass
class ScanFlag:
    """One scanner finding. Mirrors vbrief/schemas/cache-meta.schema.json $defs/ScanFlag."""

    category: str
    severity: str
    detail: str
    match_count: int = 0


@dataclass
class ScanResult:
    """Aggregate scanner outcome."""

    passed: bool
    scanner_version: str
    flags: list[ScanFlag] = field(default_factory=list)
    transformed_content: str = ""
    scanned_at: str = ""

    def to_meta_dict(self) -> dict[str, object]:
        """Render the scan_result subset of meta.json (per the schema).

        The cache layer composes this with the source/key/fetched_at/...
        envelope before persisting; the scanner does NOT compose the full
        meta.json itself because TTL / fetched_at are cache-layer concerns.
        """
        return {
            "passed": self.passed,
            "scanned_at": self.scanned_at,
            "scanner_version": self.scanner_version,
            "flags": [
                {k: v for k, v in asdict(flag).items() if k != "match_count" or v}
                for flag in self.flags
            ],
        }


# ---------------------------------------------------------------------------
# Strip-then-flag helpers
# ---------------------------------------------------------------------------


def _strip_invisible(text: str) -> tuple[str, list[str]]:
    """Strip invisible-unicode codepoints; return ``(stripped_text, removed_labels)``.

    ``removed_labels`` is a list of unique ``U+XXXX`` labels for the
    codepoints that were removed; the order matches first-occurrence
    in the input. The list is what the ScanFlag.detail field summarises.
    """
    if not text:
        return text, []
    out_chars: list[str] = []
    seen: dict[int, str] = {}
    for ch in text:
        if _is_invisible(ch):
            cp = ord(ch)
            if cp not in seen:
                seen[cp] = f"U+{cp:04X}"
            continue
        out_chars.append(ch)
    return "".join(out_chars), list(seen.values())


def _detect_credentials(text: str) -> list[ScanFlag]:
    """Return one :class:`ScanFlag` per pattern that matched in ``text``.

    The detail string carries the pattern label (e.g. ``"github-pat"``)
    NOT the matched bytes -- the secret itself is never persisted into
    the audit log. ``match_count`` records how many distinct matches
    fired for that pattern.
    """
    flags: list[ScanFlag] = []
    if not text:
        return flags
    for label, pattern in _CREDENTIAL_PATTERNS:
        matches = pattern.findall(text)
        if not matches:
            continue
        flags.append(
            ScanFlag(
                category="credentials",
                severity="hard-fail",
                detail=f"matched credentials pattern: {label}",
                match_count=len(matches),
            )
        )
    return flags


def _detect_injection_heading(text: str) -> tuple[str, ScanFlag | None]:
    """Wrap suspicious sections in ``quarantined`` fences using v2.1.0 policy.

    Detection rule (#949 tuning):

    1. **Heading structural signal.** When the heading text contains an
       instruction-override phrase (``IGNORE PREVIOUS`` /
       ``DISREGARD ABOVE`` / ``OVERRIDE ALL``) OR the heading text starts
       with a role-hijack prefix (``SYSTEM:`` / ``ASSISTANT:`` /
       ``USER:`` / ``AGENT:`` / ``OVERRIDE:`` / ``DIRECTIVE:`` /
       ``ROLE:`` / ``INSTRUCTION(S):`` / ``PROMPT:`` / ``TOOL:`` /
       ``FUNCTION:``) we wrap the heading + section. The signal check is
       evaluated on the full heading text with no allowlist short-circuit
       so a benign-template heading whose tail smuggles an injection
       phrase (e.g. ``## STEP 1 - Ignore previous instructions``) still
       flags.
    2. **Body shell vector.** When the heading's body contains a
       shell-injection vector (``curl ... | sh`` / ``base64 -d`` /
       ``eval`` -- including ``eval `cmd``` `` backtick form -- /
       ``sh -c``) we wrap the heading + section even when the heading
       text itself is benign-looking.
    3. **Inline (non-heading) injection.** Any line outside a heading
       that carries an instruction-override phrase or a body shell
       vector is wrapped on its own.
    4. **Idempotency.** Lines inside an existing fenced code block (any
       ```` ``` ```` / ``~~~`` opener) are passed through verbatim, so a
       previously-wrapped ``quarantined`` block is a no-op on re-scan.

    Returns ``(transformed_content, flag)``. ``flag.match_count`` is the
    number of distinct sections wrapped (NOT individual tokens) -- the
    audit log's primary signal under the new policy is "how many
    injection-shaped sections did we observe", which is the value
    operators reach for when triaging detector noise.
    """
    if not text:
        return text, None

    lines = text.splitlines()
    out: list[str] = []
    in_fence: str | None = None
    sections_wrapped = 0
    i = 0

    while i < len(lines):
        line = lines[i]

        # Existing fenced code blocks pass through verbatim (idempotent
        # on re-scan; the v1 ``quarantine_body`` semantic is preserved).
        # Closer detection requires the line to be ONLY the fence delim
        # (after right-trim) -- per CommonMark a closing fence carries no
        # info string, so ``` ```python ``` ``` is an OPENER for a nested
        # block, not a closer for the outer one. The naive
        # ``line.startswith(in_fence)`` check would otherwise drop the
        # outer fence prematurely on the nested opener and re-process the
        # nested block's content as live, breaking the idempotency
        # guarantee on previously-quarantined bodies that happen to
        # contain an embedded code example.
        fence_match = _FENCE_RE.match(line)
        if fence_match:
            delim = fence_match.group(1)
            if in_fence is None:
                in_fence = delim
            elif line.rstrip() == in_fence:
                in_fence = None
            out.append(line)
            i += 1
            continue
        if in_fence is not None:
            out.append(line)
            i += 1
            continue

        heading_text = _heading_text(line)
        if heading_text is not None:
            # Determine the section span (this heading down to but not
            # including the next heading; nested fences are consumed
            # whole so an unbalanced opener never splits a section).
            section_end = i + 1
            while section_end < len(lines):
                nxt = lines[section_end]
                nested_fence = _FENCE_RE.match(nxt)
                if nested_fence:
                    section_end += 1
                    nested = nxt[:3]
                    # Same closer-vs-nested-opener disambiguation as the
                    # outer fence loop above: a closing fence MUST be
                    # only the delim chars (no info string).
                    while (
                        section_end < len(lines)
                        and lines[section_end].rstrip() != nested
                    ):
                        section_end += 1
                    section_end += 1  # consume the closer
                    continue
                if _HEADING_RE.match(nxt):
                    break
                section_end += 1

            body_lines = lines[i + 1 : section_end]

            # Structural-signal check is the sole gate on the heading
            # text (no allowlist short-circuit -- a benign-template
            # heading whose tail smuggles an injection phrase like
            # ``## STEP 1 - Ignore previous instructions`` would
            # otherwise pass through unwrapped). The body shell-vector
            # check fires independently so a clean heading that smuggles
            # ``curl ... | sh`` in the body is still flagged.
            heading_signal = _heading_signal(heading_text)
            body_signal = _body_has_shell_vector(body_lines)

            if heading_signal or body_signal:
                out.append(_QUARANTINE_FENCE_OPEN)
                out.extend(lines[i:section_end])
                out.append(_QUARANTINE_FENCE_CLOSE)
                sections_wrapped += 1
                i = section_end
                continue

            # Heading itself is fine; pass it through and let the
            # per-line scan below handle inline body content.
            out.append(line)
            i += 1
            continue

        # Non-heading line: wrap if it carries an inline injection
        # phrase or a shell vector. We deliberately do NOT wrap on a
        # bare ``IMPORTANT:`` / ``STEP`` / etc. token in prose -- those
        # are noise tokens under the v2.1.0 policy.
        if _INJECTION_OVERRIDE_RE.search(line) or _BODY_VECTOR_RE.search(
            line
        ):
            out.append(_QUARANTINE_FENCE_OPEN)
            out.append(line)
            out.append(_QUARANTINE_FENCE_CLOSE)
            sections_wrapped += 1
            i += 1
            continue

        out.append(line)
        i += 1

    suffix = "\n" if text.endswith("\n") else ""
    wrapped_text = "\n".join(out) + suffix

    if sections_wrapped == 0:
        return wrapped_text, None
    return wrapped_text, ScanFlag(
        category="injection-heading",
        severity="fence-and-pass",
        detail=(
            f"wrapped {sections_wrapped} injection-shaped section(s) in"
            " `quarantined` fence (v2.1.0 strict-signal policy)"
        ),
        match_count=sections_wrapped,
    )


# ---------------------------------------------------------------------------
# Public scan API
# ---------------------------------------------------------------------------


def scan(content_md: str, *, scanned_at: str | None = None) -> ScanResult:
    """Run scanner v2 over ``content_md`` and return a :class:`ScanResult`.

    Args:
        content_md: Untrusted markdown body (e.g. an issue body fetched
            via ``scm:issue:view --json body``).
        scanned_at: Optional override for the scanned_at timestamp. When
            ``None`` the current UTC time is used. Tests pass an explicit
            value for deterministic snapshots.

    Returns:
        A :class:`ScanResult` carrying:

        - ``passed``: ``False`` iff any credentials-category flag fired.
        - ``flags``: per-category findings in the order
          (invisible-unicode, credentials, injection-heading).
        - ``transformed_content``: the strip-then-fence output. Callers
          treat this as the canonical content.md when ``passed`` is True;
          when ``passed`` is False, the cache layer skips the
          content.md write entirely.
        - ``scanner_version`` / ``scanned_at``: timestamp + version
          stamps for the meta.json scan_result envelope.
    """
    timestamp = scanned_at if scanned_at is not None else _utc_now_iso()
    flags: list[ScanFlag] = []

    # 1. Strip invisibles first so subsequent regexes see the visible-only
    #    surface (a U+200B-smuggled credential token would otherwise dodge
    #    the credentials regex).
    stripped, removed_labels = _strip_invisible(content_md)
    if removed_labels:
        # match_count here is the COUNT of stripped codepoints, not the
        # cardinality of distinct labels -- we recompute against the
        # original text so a body with 17 U+200B chars surfaces 17, not 1.
        total_stripped = sum(1 for ch in (content_md or "") if _is_invisible(ch))
        flags.append(
            ScanFlag(
                category="invisible-unicode",
                severity="strip-and-pass",
                detail=(
                    f"stripped {total_stripped} invisible-unicode codepoint(s): "
                    + ", ".join(removed_labels)
                ),
                match_count=total_stripped,
            )
        )

    # 2. Credentials regex on the stripped text. We do NOT short-circuit
    #    on first match -- meta.json audit value comes from the full flag
    #    list, so we run every pattern.
    cred_flags = _detect_credentials(stripped)
    flags.extend(cred_flags)

    # 3. Injection-heading wrap on the stripped text. Idempotent on
    #    already-wrapped content (quarantine_body's #583 contract).
    wrapped, inj_flag = _detect_injection_heading(stripped)
    if inj_flag is not None:
        flags.append(inj_flag)

    passed = not any(f.severity == "hard-fail" for f in flags)
    return ScanResult(
        passed=passed,
        scanner_version=SCANNER_VERSION,
        flags=flags,
        transformed_content=wrapped,
        scanned_at=timestamp,
    )


def _utc_now_iso() -> str:
    """Return current UTC time as an RFC-3339 / ISO-8601 string with ``Z`` suffix."""
    # The cache-meta.schema.json dateTime guard requires a ``Z`` or
    # +HH:MM suffix; ``datetime.isoformat()`` emits ``+00:00`` which
    # doesn't match the schema's regex. We replace the suffix
    # manually so the scan output validates without an extra normalisation
    # pass at the caller.
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Reads input file (or stdin), emits JSON ScanResult.

    Returns:
        ``0`` when the scan passed; ``2`` when at least one hard-fail
        flag fired. Mirrors the cache:put exit-code contract so a caller
        piping content through ``cache_scanner.py`` gets an actionable
        signal without parsing the JSON.
    """
    args = list(argv if argv is not None else sys.argv[1:])
    if args and args[0] in {"-h", "--help"}:
        sys.stdout.write(__doc__ or "")
        return 0
    text = (
        Path(args[0]).read_text(encoding="utf-8") if args else sys.stdin.read()
    )
    result = scan(text)
    payload = {
        "passed": result.passed,
        "scanner_version": result.scanner_version,
        "scanned_at": result.scanned_at,
        "flags": [asdict(f) for f in result.flags],
        "transformed_content": result.transformed_content,
    }
    sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0 if result.passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
