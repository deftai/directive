# Cost Model Methodology (cost-models.md)

This reference describes how Deft estimates pre-build cost & budget for a
project produced through the deft-directive workflow. It is the canonical
methodology consumed by `skills/deft-directive-cost/SKILL.md` and the
`templates/COST-ESTIMATE.md` artifact body.

Audience: agents producing cost estimates AND non-technical end users
reading the resulting `COST-ESTIMATE.md`. Plain-English voice throughout
(no spreadsheets, no scientific notation, no industry jargon).

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Scope

This document covers cost estimation for the **pre-build phase** of a
deft project -- after the spec is approved but before any build work
starts. Its purpose is to give the user enough cost information to
decide whether to proceed (build), pull back scope (rescope), or stop
(no-build).

Out of scope:

- Hard cost numbers tied to specific 2026 vendor pricing
- Real-time pricing API integration
- Currency / region localisation -- USD-only first pass
- Cost forecasting beyond a 12-month horizon
- Cost optimisation / FinOps for already-running projects

## Core Principles

- ! Use **loose ranges**, not single point estimates. A \$5-\$20 / month
  band is more honest than \$12.50 / month for a category whose real
  variance is huge (e.g. egress, LLM tokens, image generation).
- ! Express ranges as plain-English bands: **low**, **typical**, **high**.
  Avoid "p10 / p50 / p90" or other statistical jargon.
- ! Always state the **assumption** behind each range (e.g. "100 daily
  active users, 5 saved photos each"). The same project shape can be
  \$10/month or \$10,000/month depending on traffic.
- ! USD-only first pass. The artifact MUST say "USD" explicitly so
  international users know to convert.
- ⊗ Do NOT pretend a range is exact. If the agent does not know, write
  "unknown -- ask vendor" rather than guessing a number.

## Where Costs Come From

For a typical deft project, costs roll up into a small number of
categories. The agent walks the spec and identifies which categories
apply, then fills in plain-English bands for each.

### 1. Pre-flight account / sign-up costs

Things the user must sign up for before the project can run at all.
Often \$0 to start (free tier), but the user needs to know the list of
accounts up front so they are not surprised mid-build.

Examples (loose, illustrative):

- Cloud hosting account (free tier ~\$0; paid tier varies)
- Domain name (typical: \$10-\$20 / year)
- Email-sending provider (free tier; paid tier ~\$10-\$50 / month)
- Payment processor (no monthly fee; ~3% per transaction)
- LLM / AI API account (pay-as-you-go; can be \$0 if unused)

### 2. Hosting / infrastructure

The recurring monthly cost of running the application. Bands:

- **Static site / serverless** (low-traffic): \$0-\$10 / month typical
- **Single small VM / app service**: \$5-\$30 / month typical
- **Managed database** (small): \$10-\$50 / month typical
- **CDN / edge** (low-traffic): \$0-\$10 / month typical
- **Egress at scale**: this is where the high band can blow up; flag if
  the project shape involves serving large media to many users

### 3. API / third-party fees

Per-call or per-event fees for services the project depends on.
Examples (illustrative bands, not authoritative):

- LLM API calls (text): a few cents to a few dollars per 1M tokens,
  depending on model tier
- Image generation: a few cents per image typical
- Search / embeddings: a few cents per 1M tokens typical
- Telephony (SMS / voice): a few cents per message / minute typical
- Maps / geocoding: free tier exists; can scale to \$ hundreds / month
  for high-volume apps

### 4. Build & maintenance time

Not strictly a recurring cost, but worth surfacing so the user
understands the time cost too:

- Initial build effort (rough hours)
- Ongoing maintenance (rough hours / month)

## Building the Monthly Band

After categories are filled in, the artifact rolls them up into a single
**monthly band**:

- **Low**: free tier / minimal usage (e.g. demo, internal use only)
- **Typical**: realistic everyday usage as described in the spec
- **High**: stretch scenario (popular launch, viral spike, growth)

Rules:

- ! The roll-up MUST stay loose. Adding a range to a range gives a
  range; do NOT collapse to a single number.
- ! State the **scale assumption** (e.g. "100 daily users") in the same
  block as the typical band so the reader can scale up or down.
- ~ When the high band is more than ~10x the typical band, surface a
  separate **scale considerations** note explaining what would push the
  project from typical -> high (e.g. "media-heavy traffic blows up
  egress").

## Decision Point

Every cost estimate ends with an explicit, four-way decision. All four
options are first-class outcomes; the build skill's Cost Phase Gate
treats each one as a recorded decision (a `skip` with no reason is the
same as no decision and the gate refuses kickoff).

1. **Build** -- user accepts the cost and proceeds to the build phase.
2. **Rescope** -- user wants to keep building but reduce cost (drop a
   feature, swap a vendor, lower the scale assumption). Loops back to
   spec edits, then re-runs the cost phase.
3. **No-build** -- user stops the project at this stage. Recorded
   explicitly so the deft project history shows the decision.
4. **Skip** -- explicit escape hatch (e.g. hobby project where cost is
   irrelevant, or a follow-up project where cost was already estimated
   for the parent project). The skip MUST record a short skip reason so
   the artifact's existence is auditable.

## Plain-English Voice

The artifact and skill prose are read by non-technical users. Hard
rules:

- ! Use **dollars, not "USD"** in body text where it reads naturally
  (the artifact still states "all figures in USD" up top).
- ! Use **whole numbers** in bands where the precision does not matter
  (\$5-\$20, not \$5.37-\$19.84).
- ! When using a technical term that the user might not know, define it
  in a short parenthetical (e.g. "egress (data leaving the cloud)").
- ⊗ Do not use jargon like "TCO", "burn rate", "p50", "OPEX vs CAPEX",
  "amortised", "blended rate", "unit economics", or "FTE".

## Anti-Patterns

- ⊗ Quote single-point estimates ("this will cost \$47.12 / month")
- ⊗ Quote ranges without an assumption (e.g. \$5-\$5,000 with no
  context is useless)
- ⊗ Cite live vendor pricing as if it were a guarantee (vendor pricing
  changes; the artifact must read as a snapshot)
- ⊗ Skip the decision point -- the build skill MUST refuse kickoff
  until the user has explicitly chosen build / rescope / no-build /
  skip(+reason)
- ⊗ Use jargon that a non-technical user will not understand
- ⊗ Promise that the project will "definitely" stay within a band --
  always say "expected", "typical", or "in our estimate"
- ⊗ Generate the artifact and proceed silently to build without
  surfacing the decision point to the user
