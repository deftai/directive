<!-- deft:managed-section v1 marker spec; companion to templates/agents-entry.md -->
# AGENTS.md Template Placeholder Spec (v1)

This document is the canonical spec for placeholder tokens that may appear inside the `<!-- deft:managed-section v1 -->` ... `<!-- /deft:managed-section -->` block of `templates/agents-entry.md`.

The placeholder set is **inherited from the [`deftai/webinstaller`](https://github.com/deftai/webinstaller) pin-marker contract** so the same tokens render identically across the two install rails (the Go installer, which embeds the file via `//go:embed`, and the webinstaller, which substitutes per-fetch metadata at install time).

Legend (RFC2119): !=MUST, ~=SHOULD, ⊗=MUST NOT, ?=MAY.

## Token format

- ! Tokens MUST use the literal form `{{TOKEN_NAME}}` (double-brace, no spaces).
- ! Token names MUST be uppercase ASCII letters, digits, and underscores -- regex `[A-Z][A-Z0-9_]*`.
- ⊗ Tokens MUST NOT carry whitespace inside the braces (e.g. `{{ TOKEN }}` is invalid).
- ⊗ Token names MUST NOT be reused across different semantic concepts -- if the value is different, the token name MUST be different.

## Documented tokens (v1)

The following five tokens are part of the v1 contract. Every renderer (Go installer, webinstaller, `deft/run agents:refresh`) MUST accept them; consumers MAY add custom tokens, but custom tokens MUST NOT shadow any of these names.

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

- ! Type: short string identifying the renderer / installer (e.g. `webinstaller@deftai/webinstaller`, `deft-install/v0.22.0`, `deft/run agents:refresh`).
- ! Source: the surface that performed the AGENTS.md render or refresh.
- ! Rendered as: literal string, no leading whitespace, no trailing newline.
- ? Substituted by webinstaller / Go installer at fetch time. Python reference implementation emits `deft/run agents:refresh@<VERSION>`.

## Substitution semantics

- ! The renderer MUST perform a single pass of literal `{{TOKEN}}` -> value substitution. Nested templates are out of scope for v1.
- ! Tokens that the renderer does not have a value for MUST be left as the literal `{{TOKEN_NAME}}` form so downstream tooling can detect missing substitutions. ⊗ Renderers MUST NOT silently substitute the empty string.
- ! The byte sequence between `<!-- deft:managed-section v1 -->` and `<!-- /deft:managed-section -->` after substitution is what `cmd_agents_refresh --check` compares against the consumer's existing managed section.
- ~ A renderer that has no value for any of the documented tokens (e.g. running outside a Git checkout) MAY skip substitution entirely and emit the template verbatim. The contract test asserts this is byte-stable.

## Version contract

- ! The marker carries a literal version segment (`v1`) so a future format change can be detected without disturbing existing consumers. Bumping the marker version triggers a one-shot migration in `cmd_agents_refresh` (out of scope for v1).
- ⊗ Future format changes MUST NOT silently reuse the `v1` marker.

## Cross-references

- Template: [`./agents-entry.md`](./agents-entry.md)
- Go installer embed: [`./embed.go`](./embed.go)
- Python reference implementation: `cmd_agents_refresh` in the `run` CLI script (root `run`)
- Conformance test: [`../tests/content/test_agents_entry_contract.py`](../tests/content/test_agents_entry_contract.py)
- Universal upgrade gate: `cmd_gate` in the `run` CLI script (root `run`)
- Refs: #768, #636, #746
