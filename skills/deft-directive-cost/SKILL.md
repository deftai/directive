---
name: deft-directive-cost
description: >
  Pre-build cost & budget transparency phase. Use after the project
  SPECIFICATION is approved and before the build skill kicks off, to
  produce a plain-English COST-ESTIMATE.md the user can read, react to,
  and explicitly accept, rescope, no-build, or skip with a recorded
  reason. Audience is non-technical users; voice is dollars and
  whole-number bands, not spreadsheets.
---

# Deft Directive Cost

Plain-English cost & budget transparency phase between SPECIFICATION
approval and build kickoff. Closes the adoption-blocker surfaced by
issue #739 (and issue #151 umbrella) where users finished the spec
flow and stopped at build because deft offered no cost signal.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- After `skills/deft-directive-setup/SKILL.md` Phase 3 has produced an
  approved `vbrief/specification.vbrief.json` (status `approved`)
- Before `skills/deft-directive-build/SKILL.md` kicks off
- When the user says "cost", "budget", "pre-build cost", "how much will
  this cost", or asks to estimate cost before building

## Audience & Voice

- ! Non-technical users. Voice is plain English, dollars, and whole
  numbers. No spreadsheets, no scientific notation, no industry jargon.
- ! Loose ranges, not single point estimates. Express bands as **low /
  typical / high**.
- ⊗ Use jargon like "TCO", "burn rate", "p50", "OPEX vs CAPEX",
  "amortised", "blended rate", "unit economics", "FTE", or any other
  term a non-technical user is unlikely to know.

Methodology lives in `references/cost-models.md`. The canonical body of
the artifact lives in `templates/COST-ESTIMATE.md`.

## Platform Detection

! Before resolving any config paths, detect the host OS from your
environment context and resolve the `USER.md` path:

| Platform           | USER.md default path                                              |
|--------------------|-------------------------------------------------------------------|
| Windows            | `%APPDATA%\deft\USER.md` (e.g. `C:\Users\{user}\AppData\Roaming\deft\USER.md`) |
| Unix (macOS/Linux) | `~/.config/deft/USER.md`                                          |

- ! If `$DEFT_USER_PATH` is set, it takes precedence on any platform.

Path resolution mirrors `skills/deft-directive-build/SKILL.md` so the
two skills agree on the user's preferences file.

## Inputs

- ! `vbrief/specification.vbrief.json` MUST exist with `plan.status =
  "approved"`. If the spec is not yet approved, stop and redirect to
  `skills/deft-directive-setup/SKILL.md` Phase 3 / the spec approval
  gate.
- ~ `vbrief/PROJECT-DEFINITION.vbrief.json` (for tech-stack and
  architecture narratives). Optional but improves the estimate.
- ~ `templates/COST-ESTIMATE.md` (canonical artifact body).
- ~ `references/cost-models.md` (methodology).

## Phases

### Phase 1 -- Read the spec & detect categories

- ! Read the approved spec and the project definition.
- ! Walk the spec and identify which cost categories apply for this
  project: hosting / infrastructure, API / third-party fees, pre-flight
  account sign-ups, build & maintenance time. Drop categories that do
  not apply.
- ~ State each category's relevance to the user in one sentence (e.g.
  "Because the spec says we will use an LLM, the AI / LLM row applies
  and is usually the largest swing factor").

### Phase 2 -- Draft `COST-ESTIMATE.md`

- ! Copy `templates/COST-ESTIMATE.md` into the project root as
  `COST-ESTIMATE.md`.
- ! Fill in each category with a **low - typical - high** plain-English
  band. Use whole numbers where the precision does not matter.
- ! State the **scale assumption** beside the typical band (e.g. "About
  100 active users per day, each doing 5 main actions"). The same
  project shape can be \$10 / month or \$10,000 / month depending on
  traffic, so the assumption is required.
- ! Roll up into a **monthly band** (low / typical / high). Keep the
  roll-up loose -- adding a range to a range gives a range; do NOT
  collapse to a single number.
- ! When the high band is more than ~10x the typical band, surface a
  **scale considerations** note explaining what would push the project
  from typical to high (e.g. "media-heavy traffic blows up egress").
- ! USD-only first pass. The artifact MUST say "USD" up top so
  international users know to convert.
- ⊗ Quote single-point estimates ("this will cost $47.12 / month").
- ⊗ Cite live vendor pricing as if it were a guarantee. The artifact is
  a snapshot; vendor pricing changes.

### Phase 3 -- Read it back to the user

- ! Show the user the **TL;DR**, the **monthly band** (low / typical /
  high), and the **scale considerations** note (if present).
- ~ Offer to read any other section in full on request.
- ! Surface the explicit **decision point** menu in Phase 4.

### Phase 4 -- Decision point (build kickoff confirmation menu)

! Present the user with this exact, numbered menu. Per the framework
menu rule (#767), `Discuss` and `Back` MUST be the final two numbered
options. The four substantive choices come first.

```
This is your project's cost estimate. Pick one.

1. Build              -- accept the cost and start the build phase
2. Rescope            -- keep building but reduce cost first
3. No-build           -- stop here; record the reason
4. Skip               -- skip the cost phase; record a short reason
5. Discuss            -- ask follow-up questions before deciding
6. Back               -- return to the previous step (e.g. spec edits)
```

- ! `Discuss` MUST be option 5 and `Back` MUST be option 6 (the final
  two numbered options) per the #767 framework rule.
- ! The decision MUST be recorded in `COST-ESTIMATE.md` under
  **Decision recorded** (decision, date, recorded-by, reason). The
  reason field is REQUIRED for `rescope`, `no-build`, and `skip` (so
  that the artifact's existence is auditable). The reason field is
  optional for `build`.
- ! On `Rescope`, return the user to spec edits (chain back to
  `skills/deft-directive-refinement/SKILL.md` to pull spec scope back,
  or the interview), then re-run this skill from Phase 1.
- ! On `No-build`, write the decision to `COST-ESTIMATE.md`, mark the
  spec scope vBRIEF accordingly, exit, and do NOT chain into the build
  skill.
- ! On `Skip`, write the decision and skip reason to `COST-ESTIMATE.md`
  and proceed to the build kickoff.
- ! On `Build`, write the decision to `COST-ESTIMATE.md` and proceed
  to the build kickoff.
- ! On `Discuss`, take questions and re-show the same menu. Do NOT
  proceed without an explicit choice from options 1-4.
- ! On `Back`, return to the spec / setup phase. Do NOT proceed without
  re-running this skill.
- ⊗ Proceed to the build skill silently without surfacing the decision
  point to the user.

## Output Targets

- ! `COST-ESTIMATE.md` (in the project root). Created by Phase 2 and
  finalised in Phase 4 with the recorded decision.
- ~ Reference the artifact from `vbrief/PROJECT-DEFINITION.vbrief.json`
  via a `references` entry of type `x-vbrief/spec-section` so future
  agents discover the cost decision when re-reading the project
  definition.

## Anti-Patterns

- ⊗ Quote single-point cost estimates -- always use loose plain-English
  bands.
- ⊗ Use industry jargon (TCO, p50, FTE, OPEX vs CAPEX, etc.) in the
  artifact or skill prose -- the audience is non-technical.
- ⊗ Skip the decision point -- the build skill MUST refuse kickoff
  until the user has explicitly chosen build / rescope / no-build /
  skip(+reason).
- ⊗ Hide the `Discuss` and `Back` options or place them at the top of
  the menu -- they MUST be the final two numbered options per #767.
- ⊗ Generate `COST-ESTIMATE.md` and chain into build silently without
  surfacing the decision point.
- ⊗ Skip the `Skip` reason -- if the user opts to skip the cost phase,
  the reason MUST be recorded so the artifact's existence is auditable.
- ⊗ Cite live vendor pricing as a guarantee -- the artifact is a
  snapshot; pricing changes over time.
- ⊗ Localise to non-USD currency in the first pass -- USD-only is the
  contract; international users convert manually.
- ⊗ Promise a project will "definitely" stay within a band -- always
  say "expected", "typical", or "in our estimate".

## EXIT

When the user makes a decision in Phase 4 and the decision is recorded
in `COST-ESTIMATE.md`:

- ! Confirm exit explicitly: `deft-directive-cost complete -- exiting skill.`
- ! State the next step based on the decision:
  - `Build` or `Skip` -> chain into `skills/deft-directive-build/SKILL.md`
  - `Rescope` -> chain into `skills/deft-directive-refinement/SKILL.md`
    for targeted spec edits, then re-run this skill
  - `No-build` -> exit; do NOT chain into build
  - `Discuss` -> remain in this skill until the user picks 1-4
  - `Back` -> chain back to the previous skill (spec / setup)

⊗ Exit this skill silently without confirming completion or providing
next-step instructions.
