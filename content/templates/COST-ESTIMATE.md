<!-- deft:template -->
<!-- This is the canonical body for a project's COST-ESTIMATE.md, produced -->
<!-- by skills/deft-directive-cost/SKILL.md after spec approval and before -->
<!-- build kickoff. Methodology: ../references/cost-models.md.            -->

# Cost & Budget Estimate

> All figures in **US dollars (USD)**. Loose ranges, not exact numbers.
> Built from the approved project spec. If the spec changes, redo this
> estimate before building.

## TL;DR

In one or two sentences: what is the realistic monthly cost band for
this project, and what is the biggest thing that would push it higher?

> _Example -- replace before saving:_
> _Most months: about $10 - $30. Costs go up if many users save photos
> or if the AI gets used a lot. Worst case: a few hundred dollars._

## What you will need to sign up for

A short, plain-English list of accounts the project needs. One line
each. Mark `(free tier OK)` where the free tier covers the typical
usage we expect.

- Cloud host (free tier OK)
- Domain name (typical: $10 - $20 / year)
- _Add or remove rows so this matches the actual project_

## Hosting & infrastructure

The recurring monthly cost of running the app. Pick the rows that
match the spec; delete the rest.

- **Hosting / app server**: estimated $X - $Y / month
- **Database**: estimated $X - $Y / month
- **CDN / file storage**: estimated $X - $Y / month
- **Domain & TLS**: ~$1 - $2 / month (annual cost spread out)
- **Email / notifications**: estimated $X - $Y / month
- **Other (describe)**: estimated $X - $Y / month

## API & third-party fees

Per-call or per-event fees that scale with usage. Pick rows that
match the spec; delete the rest. State the **assumption** so the
reader can scale up or down.

> _Assumption used for the numbers below: about 100 active users per
> day, each doing 5 main actions. Adjust to match this project._

- **AI / LLM (text)**: estimated $X - $Y / month
- **Image generation**: estimated $X - $Y / month
- **Search or embeddings**: estimated $X - $Y / month
- **SMS / phone calls**: estimated $X - $Y / month
- **Maps / location**: estimated $X - $Y / month
- **Payments**: usually a percentage of each transaction (typical:
  about 3%)
- **Other (describe)**: estimated $X - $Y / month

## Monthly band

Pull the rows above into a single estimate.

- **Low** _(quiet month / demo / internal use)_: ~$X / month
- **Typical** _(everyday use as described in the spec)_: ~$Y / month
- **High** _(busy month / launch spike / growth)_: ~$Z / month

If the **high** band is much bigger than **typical** (more than about
10x), call out _why_ in the next section.

## Scale considerations

What would push this project from typical into high? Plain language
only. Examples to delete or replace:

- Lots of users uploading photos (the cloud charges for data leaving
  its servers, sometimes called "egress")
- A viral moment that drives 100x normal traffic for a few days
- A feature that uses the AI on every page view instead of on demand

## Build & maintenance time

A rough sense of effort, not a quote.

- **Build**: about _N_ - _M_ hours of focused work
- **Maintenance**: about _N_ - _M_ hours / month after launch

## Decision point

Pick **one**. The build phase will refuse to start until this is
recorded.

1. **Build** -- proceed to build with this cost expectation.
2. **Rescope** -- keep building but reduce cost first. List the spec
   changes, then redo this estimate.
3. **No-build** -- stop here. Record the reason below.
4. **Skip** -- skip the cost phase. Record a short reason
   (e.g. "hobby project, cost is not a concern", or "cost already
   estimated as part of parent project X").

### Decision recorded

- **Decision**: _build / rescope / no-build / skip_
- **Date**: _YYYY-MM-DD_
- **Recorded by**: _name or handle_
- **Reason** (required for skip / no-build / rescope): _one or two
  sentences in plain language_

---

_This estimate is a snapshot. Vendor pricing changes over time. Redo
this file before any major scope change. Methodology lives in
[references/cost-models.md](../references/cost-models.md)._
