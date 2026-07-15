# Skill pin policy (#2508)

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `≉`=SHOULD NOT, `⊗`=MUST NOT, `?`=MAY.

## Why pins exist

AGENTS.md always loads; on-demand skills load only when trigger matching succeeds. Empirical and practitioner guidance (antfu/skills FAQ; directive #2484 progressive disclosure) show **false negatives** — the agent never opens a process-critical skill because no trigger matched. Pins mitigate that by naming must-apply skills directly in the always-loaded AGENTS.md surface.

Pins are for **false-negative-sensitive process gates**, not for copying entire framework corpora into context.

## Pin tiers

| Tier | Meaning | How the agent discovers it |
|---|---|---|
| **always-pin** | Named in AGENTS.md (managed or consumer unmanaged header) as a required `SKILL.md` load when a matching work type starts | Always-loaded AGENTS.md |
| **on-demand** | Routed via Skills Index triggers in `REFERENCES.md` — scan Level-0, read Level-1 on match | Skills Index → `SKILL.md` |
| **reference-only** | External, rare, or maintainer-only corpora; no standing trigger routing | Explicit doc pointer only |

### Criteria for always-pin

A skill belongs in the always-pin tier when **all** of the following hold:

1. **Process gate** — skipping it breaks lifecycle, quality, or safety (implementation intent, pre-PR, review-cycle, swarm dispatch).
2. **False-negative risk** — trigger keywords alone are insufficient because work starts without an obvious keyword (`drive-to: merge-ready`, silent PR open, cohort dispatch).
3. **Bounded body** — the skill is a workflow gate, not a language/deployment manual (those stay on-demand behind task/trigger gates per #644).

### Criteria for on-demand

Default for indexed directive skills: triggers in the Skills Index table are sufficient when the user or task surface names the workflow (`build`, `pre-pr`, `swarm`, `triage`, etc.).

### Criteria for reference-only

External packs, archived lessons, maintainer-only release tooling, or docs reached only through explicit `packs:slice` / task-based loading pointers.

## Default always-pin set (directive)

These four process skills are the **default always-pin list** for directive development and for consumer projects using the framework lifecycle:

| Skill | Load when |
|---|---|
| `deft-directive-build` | Code mutation / implementation against an active scope xBRIEF (#810) |
| `deft-directive-pre-pr` | Before opening or pushing a PR |
| `deft-directive-review-cycle` | Greptile/bot review response until merge-ready (#2308) |
| `deft-directive-swarm` | Parallel agent dispatch / cohort orchestration |

Consumer installs mirror the same four paths under `.deft/core/.agents/skills/`. Maintainer checkouts use `content/skills/<name>/SKILL.md`.

`deft-directive-setup` stays **on-demand** (explicit `setup` / `bootstrap` triggers). `deft-directive-sync` stays **on-demand** (session-start `sync` trigger and managed AGENTS pointers).

## How to pin (AGENTS.md)

Always-pin skills are referenced by **id + path pointer**, not by pasting skill bodies into AGENTS.md:

```markdown
! Before code mutation: read `deft-directive-build` (`content/skills/deft-directive-build/SKILL.md`).
! Before PR: read `deft-directive-pre-pr`; review: `deft-directive-review-cycle`; swarm: `deft-directive-swarm`.
```

The managed AGENTS.md section `## Skill pin policy (#2508)` carries the framework default list; consumer projects MAY copy the same four ids into their **unmanaged** AGENTS header when they want the mitigation without editing the managed block.

## Anti-patterns

- ⊗ **Pin entire language or deployment packs** (`languages/`, `deployments/`, full `coding/` tree) into AGENTS.md — those corpora are thousands of lines and defeat the #645 budget / #644 reference-chain gating.
- ⊗ **Paste full SKILL.md bodies** into AGENTS.md instead of id + path pointers.
- ⊗ **Always-pin convenience skills** (glossary, article-review, gh-slice) that are not lifecycle gates — triggers are enough.
- ⊗ **Rely on triggers alone** for review-cycle or pre-PR when dispatch envelopes use action verbs without review keywords (the #1862 / #2508 recurrence class) -- includes Cursor product actions such as **babysit-pull-request-in-cloud** that share the babysit name with the global host skill (#2261).

## Catalog convention (optional)

Skills-pack entries (`content/packs/skills/skills-pack-0.1.json`) MAY record `"alwaysPin": true` on metadata-only rows so slice tooling and future gates can list pins without parsing AGENTS.md. The authoritative runtime list for agents remains the AGENTS.md pin section; the catalog field is advisory for tooling (#1535).

## Related

- Skills Index: `REFERENCES.md` § Skills Index
- Progressive disclosure: #2484
- Trigger coverage evals: #1586
- Review-surface precedence: #2308 / `deft-directive-review-cycle`
