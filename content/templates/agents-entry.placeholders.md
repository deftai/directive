<!-- deft:managed-section v2 marker spec; companion to templates/agents-entry.md -->
# AGENTS.md Template Placeholder Spec (v2)

This document is the canonical spec for placeholder tokens that may appear inside the `<!-- deft:managed-section v2 -->` ... `<!-- /deft:managed-section -->` block of `templates/agents-entry.md`. The marker version was bumped from `v1` to `v2` in the v0.27 release line (#992) when the canonical install layout flipped to `.deft/core/`; the placeholder token set itself is unchanged from the inherited webinstaller pin-marker contract.

The placeholder set is **inherited from the [`deftai/webinstaller`](https://github.com/deftai/webinstaller) pin-marker contract** so the same tokens render identically across the two install rails (the Go installer, which embeds the file via `//go:embed`, and the webinstaller, which substitutes per-fetch metadata at install time).

Legend (RFC2119): !=MUST, ~=SHOULD, ⊗=MUST NOT, ?=MAY.

## Token format

- ! Tokens MUST use the literal form `{{TOKEN_NAME}}` (double-brace, no spaces).
- ! Token names MUST be uppercase ASCII letters, digits, and underscores -- regex `[A-Z][A-Z0-9_]*`.
- ⊗ Tokens MUST NOT carry whitespace inside the braces (e.g. `{{ TOKEN }}` is invalid).
- ⊗ Token names MUST NOT be reused across different semantic concepts -- if the value is different, the token name MUST be different.

## Documented tokens (v2)

The following five tokens are part of the v2 contract (token set unchanged from v1; the marker version bump was triggered by the install-layout flip in #992). Every renderer (Go installer, webinstaller, `.deft/core/run agents:refresh`) MUST accept them; consumers MAY add custom tokens, but custom tokens MUST NOT shadow any of these names.

### `{{UPSTREAM_SHA}}`

- ! Type: full 40-character lowercase Git commit SHA.
- ! Source: the commit SHA of the `deftai/directive` checkout the AGENTS.md was rendered from.
- ! Rendered as: literal SHA, no leading whitespace, no trailing newline.
- ? Substituted by webinstaller / Go installer at install time. The Python `cmd_agents_refresh` reference implementation uses `git rev-parse HEAD` from the framework root when available; falls back to the literal token (left unsubstituted) when not.

### `{{UPSTREAM_REF}}`

- ! Type: a Git ref name (branch or tag) -- e.g. `master`, `main`, `v0.22.0`, `phase-1`.
- ! Source: the ref the upstream `deftai/directive` checkout was on at fetch time.
- ! Rendered as: literal ref, no leading whitespace, no trailing newline.
- ? Substituted by webinstaller / Go installer at install time. Python reference implementation uses `git rev-parse --abbrev-ref HEAD`; falls back to literal token when not available.

### `{{UPSTREAM_TAG}}`

- ! Type: the most recent annotated Git tag visible from the resolved SHA, with leading `v` preserved (e.g. `v0.22.0`).
- ! Source: `git describe --tags --abbrev=0` against the upstream repo.
- ! Rendered as: literal tag, no leading whitespace, no trailing newline.
- ? Substituted by webinstaller / Go installer at install time. Python reference implementation mirrors the same `git describe` priority chain used by `_resolve_version()` in the `run` script (#741); falls back to literal token when no tag is reachable.

### `{{FETCHED_AT}}`

- ! Type: ISO-8601 UTC timestamp with `Z` suffix (e.g. `2026-04-30T22:57:51Z`).
- ! Source: wall-clock time at which the AGENTS.md was rendered or refreshed.
- ! Rendered as: literal ISO-8601 timestamp, no leading whitespace, no trailing newline.
- ? Substituted by webinstaller / Go installer at fetch time. Python reference implementation uses `datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')`.

### `{{FETCHED_BY}}`

- ! Type: short string identifying the renderer / installer (e.g. `webinstaller@deftai/webinstaller`, `deft-install/v0.22.0`, `.deft/core/run agents:refresh`).
- ! Source: the surface that performed the AGENTS.md render or refresh.
- ! Rendered as: literal string, no leading whitespace, no trailing newline.
- ? Substituted by webinstaller / Go installer at fetch time. Python reference implementation emits `.deft/core/run agents:refresh@<VERSION>`.

## Substitution semantics

- ! The renderer MUST perform a single pass of literal `{{TOKEN}}` -> value substitution. Nested templates are out of scope for v2.
- ! Tokens that the renderer does not have a value for MUST be left as the literal `{{TOKEN_NAME}}` form so downstream tooling can detect missing substitutions. ⊗ Renderers MUST NOT silently substitute the empty string.
- ! The byte sequence between `<!-- deft:managed-section v2 -->` and `<!-- /deft:managed-section -->` after substitution is what `cmd_agents_refresh --check` compares against the consumer's existing managed section.
- ~ A renderer that has no value for any of the documented tokens (e.g. running outside a Git checkout) MAY skip substitution entirely and emit the template verbatim. The contract test asserts this is byte-stable.

## Version contract

- ! The marker carries a literal version segment (`v2`) so a future format change can be detected without disturbing existing consumers. Bumping the marker version (e.g. v1 -> v2 in #992) intentionally fires `agents-md=stale` on every consumer install whose AGENTS.md was rendered against the prior version, surfacing the upgrade prompt; in v0.27 the bump is paired with the `.deft/core/` install-layout flip so the prompt routes operators to the relocator.
- ⊗ Future format changes MUST NOT silently reuse a prior marker version (`v1`, `v2`, ...).

## Cross-references

- Template: [`./agents-entry.md`](./agents-entry.md)
- Go installer embed: [`./embed.go`](./embed.go)
- Python reference implementation: `cmd_agents_refresh` in the `run` CLI script (root `run`)
- Conformance test: [`../tests/content/test_agents_entry_contract.py`](../../tests/content/test_agents_entry_contract.py)
- Universal upgrade gate: `cmd_gate` in the `run` CLI script (root `run`)
- Refs: #768, #636, #746
