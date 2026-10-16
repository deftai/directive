# Framework-gap filing (consumer → deftai/directive)

Durable house style for consumer framework-gap issues filed against
`deftai/directive`. Mirrors the shipped builders `buildFrameworkGapTitle` and
`buildFrameworkGapBody` in the value-feedback engine. This document is
**gate-free**: agents may read it while `plan.policy.valueFeedback.upstreamPrompt`
is OFF.

Primary command: `deft feedback:file` (optional Taskfile wrapper when
go-task is installed). Skill: `deft-directive-feedback`.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Title

- ! Prefix with `[framework-gap]` (the builder adds it when missing).
- ! Consumer hard-stop classification uses the sole title token `BLOCKER`
  (`--blocker`). Example: `[framework-gap] BLOCKER Missing decompose hint`.
- ⊗ Invent other title classifications. Label-only classes stay labels.
- ⊗ Treat absence of `BLOCKER` as "not a blocker" — absence means not classified.

## Body sections

The builder emits this shape (placeholders when a field is omitted):

1. `## Summary` — one-line sanitized summary
2. `## Context`
3. `## Expected behavior`
4. `## Actual behavior / gap`
5. `## Session notes`
6. When `--blocker`: `## Adoption impact` with affected flow/version,
   documented alternatives, observed recovery cost, and a triage owner/date
   placeholder for a privileged actor
7. Footer separator + `_Filed via \`deft feedback:file\` … (Refs #1709 …)_`

Free-text fields fence line-leading `#` and `---` (indent) so operator paste
cannot break the markdown skeleton.

## Labels at create

- ! Pass an **empty** label list at issue create. Consumers generally lack
  push access to set labels.
- ! Maintainer triage applies labels afterward from the maintainer catalog
  (`.github/ISSUE_LABELS.md`) and `content/scm/github.md`.
- ~ `docs/consumer-issue-label-kit.md` is contrast only for consumer-kit
  repos — not the privileged upstream `adoption-blocker` SoT.
- ⊗ Cite the consumer label kit as authority for upstream
  `adoption-blocker`.

## Privileged `adoption-blocker`

- ! `adoption-blocker` is a **privileged write** after the body-evidence test
  in `content/scm/github.md` § Consumer hard-blocker.
- ! The `BLOCKER` title token is an inbound flare only; it never writes the
  ranking label.
- ⊗ Auto-apply or request `adoption-blocker` from a consumer-authored title alone.

## Dedup

- ! Normalize titles by stripping `[framework-gap]` and optional `BLOCKER`
  before comparison so marked/unmarked drafts collide.
- ! When an open upstream issue matches, STOP and link it — do not file again.

## Tracking footer

- ! Use `Refs #1709` (value-feedback gap escalation) only.
- ⊗ Use `Closes` / `Fixes` / `Resolves` in the upstream body.

## Draft → confirm

1. Draft / readout: `deft feedback:file --summary "…" …` (optional
   `--dry-run` / `--json`). Gate-OFF still returns title+body for template
   readout; filing stays blocked until consent.
2. Enable upstream path when needed:
   `deft policy:enable-value-feedback --confirm --upstream-prompt`
   (audited setter; bare `--confirm` does not silently enable
   `upstreamPrompt`). ⊗ Hand-edit PROJECT-DEFINITION as the primary setter.
3. Confirm: re-run the **same report fields and target repo** with `--confirm`
   added and without `--dry-run` or `--json`.

## Related

- Skill: `skills/deft-directive-feedback/SKILL.md`
- SCM hard-stop rules: `scm/github.md` § Consumer hard-blocker
- Maintainer label catalog: `.github/ISSUE_LABELS.md` (repo-only; not deposited)
