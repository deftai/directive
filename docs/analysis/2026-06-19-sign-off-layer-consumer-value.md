# Sign-off layer analysis — consumer-value pressure-test (2026-06-19)

Status: analysis only. **No issue filed yet.** This document records the reasoning so a
later issue (the L3 candidate below) can be seeded from it, or so the analysis can be
retired deliberately rather than lost.

## Source

Article: *"The Sign-Off Layer Is Becoming the Real Engineering System"* — Juan Cruz Martinez,
The Long Commit, 2026-06-09.
<https://newsletter.thelongcommit.com/p/the-sign-off-layer-is-becoming-the>

Reviewed via the `deft-directive-article-review` skill (two-axis evaluation: improve
directive's own implementation / improve the projects directive creates), followed by a
consumer-value deep-think requested by the maintainer.

Companion review the same morning: the New Stack "Cursor/Origin/GitLab/Zed" piece, which
produced filed issue **deftai/directive#1772** (token-cost-aware repo-content access). This
document is the *un-filed* counterpart and explains why it stayed un-filed.

## The article's diagnosis (broadly true, consumer-relevant)

Generation got cheap; ownership did not. The essay separates three layers:

1. **Generation** — the agent produces code/tests/docs/migrations/dashboards.
2. **Verification** — someone checks correctness/security/licensing/fit/operational risk.
3. **Sign-off** — a human accepts *auditable ownership* the org can reconstruct later.

The tooling conversation over-indexes on layer 1. The expensive part was always layers 2-3:
knowing what the text means inside a system that already exists. Named failure mode — the
**"approval behavior leak"**: a tired human clicking *yes* on a plausible, polished,
agent-shaped diff before actually understanding it. Good-looking generated code "asks for
trust before it has earned it." Supporting evidence cited: Linux kernel AI policy
(`Assisted-by` attribution tag; agents MUST NOT add `Signed-off-by`; only humans certify the
DCO), the Vella/Blincoe longitudinal study (82% report less time writing code; a
productivity-experience paradox), and Harness DevOps survey numbers (more deployment pain,
longer MTTR, ~31% of a dev's day in invisible AI-related validation work).

This diagnosis is sound and is, in effect, **external validation of directive's existing
thesis** — substitute determinism for fallible human review wherever possible.

## Axis map (initial proposals + ratings)

### Axis 1 — directive's own implementation

- **L1 — AI-assistance attribution + human sign-off convention** (initially rated HIGH/novel).
  `Assisted-by:` trailer (agent + model version + tools); agents never self-certify ownership.
  Verified genuinely absent from directive: `scm/git.md` / `scm/github.md` define commit
  prefixes only; the sole `Co-authored-by` reference is a one-off human-credit example in
  `SPECIFICATION.md`; no open issue matches `Assisted-by`/`Signed-off`/attribution.
- **L2 — name sign-off as a distinct third layer** (Medium). Extends the "two-layer
  verification" framing (#1500) and the owner-decision-brief work (#1590). Not standalone.
- **L3 — risk-tiered sign-off ceremony** (Medium initially; see deep-think — actually the
  highest consumer value). Threshold rises with blast radius; zero ceremony for low-risk
  changes. Adjacent to `coding/security.md` destructive-op guardrails (#587/#686/#708) and
  the merge-gate-readiness gate (#1517), but the risk-tiered *ceremony* framing is not there.
- **L4 — human-written rationale, not AI summary** (Medium, dedup). Extends #1590, #1580
  (fact vs judgment), #1533 (deslop). Drop as standalone.

### Axis 2 — projects directive creates

- **L5 — agent-created-artifact ownership metadata** (Medium → niche). Relates to #86
  (artifact↔commit binding), #1396 (decision log), #1498.
- **L6 — destructive/cross-boundary action gates** (Low — already covered by
  `coding/security.md` #587/#686/#708). Note only.
- **L7 — measure invisible validation work** (Low, dedup). #1709 (value-attribution epic),
  #1703 (perf eval). Note only.

## Consumer-value deep-think (the load-bearing part)

Key correction: **novelty != consumer usefulness.** The sign-off layer's value scales with
number of distinct humans, scarcity of reviewer attention, audit/incident accountability,
and production blast radius. The dominant directive consumer is a **solo dev / small team**;
a minority are multi-contributor/regulated orgs; some usage is disposable internal tooling
(the case the article itself says *not* to gate).

- **L1 re-rated LOW for consumers.** For a solo consumer, `Assisted-by` + a no-agent-sign-off
  rule is a multi-party trust protocol applied to one party — the author, owner, and reviewer
  are the same person. For the multi-contributor/regulated minority it does pay, but those
  consumers usually already have SCM-native governance (CODEOWNERS, required reviews, DCO
  bots, branch protection); directive reinventing a sign-off protocol risks duplicating or
  conflicting with the platform. **The only surviving slice is a zero-ceremony, default-off,
  auto-added `Assisted-by` trailer** (cheap longitudinal "how agent-shaped is this repo"
  record; free audit hook for the regulated minority) — not a gate, not a protocol.
  So the most *novel* idea is the *least* useful to the base.
- **L3 is the highest real consumer value.** It does the opposite of adding ceremony: it
  scales ceremony to zero for the common low-risk change and concentrates human attention
  only on high-blast-radius diffs (auth, prod config, migrations, billing, secrets). It
  targets the universal failure (the approval leak) and helps the *solo* dev who has no
  second-reviewer backstop. Caveat: hardest to make deterministic — "is this
  security-sensitive?" via path globs is crude and will misfire. The honest form is
  **advisory-first** (flag elevated-risk diffs, force a human-rationale STOP), not a hard gate
  feigning certainty.
- **L5 is niche** — real only for consumers building agent-*operated* systems
  (dashboards/workflows that write to prod). Most consumers build conventional software.

### The meta-risk: maintainer over-fit

For the directive repo *itself* (multi-agent swarms, PR-heavy, real team-like process) L1/L3
score much higher. That is the trap — shipping consumer ceremony that only the maintainer
benefits from. Directive already carries heavy ritual (session:start, story-start Gate 0,
preflight, cache-fresh, branch gate). The article's own warning ("don't turn every
autocomplete into a compliance event") applies recursively to directive: marginal consumer
process has a steep cost, and consumers respond to ceremony fatigue by disabling it. The
existing template-propagation discipline exists precisely to police this maintainer/consumer
boundary.

## Disposition / recommendation

- **L3** is the only thing worth filing for consumers, framed **advisory-first, risk-tiered,
  ceremony-zero-by-default**, as a consumer-facing extension of `coding/security.md`'s
  destructive-op guardrails. Not yet filed — pending design discussion on advisory-vs-gate.
- **L1** — do **not** file as a sign-off protocol. At most, file the zero-ceremony, opt-in
  `Assisted-by` trailer slice; acceptable to keep it as a maintainer-repo-only convenience and
  not ship to consumers at all.
- **L2 / L4 / L6 / L7** — extends-or-drop; tracked here, not filed.
- The article is best read as **validation of directive's determinism-over-review thesis**,
  not a feature gap. The only irreducibly-human slice is irreversible/destructive/
  ambiguous-trade-off decisions — exactly L3's target.

## Cross-references

- deftai/directive#1772 (companion article's filed issue — token-cost axis)
- #1500 (two-layer verification), #1590 (owner decision brief), #1499 (verification independence)
- #1580 (fact vs judgment), #1533 (deslop), #1396 (agent decision log), #86 (artifact↔commit binding)
- #587 / #686 / #708 (`coding/security.md` destructive-op guardrails), #1517 (merge-gate readiness)
- #1709 (value-attribution epic), #1703 (perf eval)
- `main.md` `## Agent Trap Defenses` (approval-fatigue defense — the agent-side analogue of the
  article's human-side approval leak)
