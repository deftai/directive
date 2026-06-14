# Vendored reference: forensic-research skill bundle

**Status:** Reference material — read-only. This is **not** an active directive skill.

## What this is

A self-contained agent skill bundle that turns "why did X break / slow down?" into a
disciplined, multi-agent **investigation mode**: a vBRIEF-shaped claim ledger, mandatory
falsification before any conclusion, a chat "answer embargo" until evidence closes,
pluggable per-project domain packs, and a deterministic validator gate.

## Why it lives here

It is the concrete reference design for the consolidated debugging capability tracked in
**deftai/directive#1621** (which supersedes #659 and #1173). The directive adaptation
(`coding/debugging.md` + `skills/deft-directive-debug/` + `task verify:investigation`) is
authored fresh against this source — **do not repurpose this vendored copy as the live
skill.** Keeping it verbatim preserves its provenance value.

## Provenance

- **Origin:** SLizard `forensic-research` skill, bundled 2026-06-13.
- **Generic core** with SLizard-specific material quarantined under `examples/slizard/`
  (reference only — not required for directive).
- Vendored verbatim. The bundle's own install/runtime guidance (harness paths,
  `.tmp/investigations/` gitignore) applies to *consumers of the eventual skill*, not to
  this reference copy.

## Map

- `SKILL.md` — entry point + iron laws
- `README.md` — install/usage overview (upstream)
- `references/` — mode contract, orchestrator protocol, question framing, sub-agent
  prompts, investigation vBRIEF profile, outcome template, failures
- `references/domains/` — `TEMPLATE.md` + `code-debug.md` example domain packs
- `templates/investigation.vbrief.json` — ledger scaffold (vBRIEF 0.6 profile)
- `examples/slizard/` — full SLizard production pack (quarantined; reference only)
