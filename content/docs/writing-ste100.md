# Controlled English for docs and issues

Directive's writing bar is **clarity, simplicity, and brevity**.

Use that outcome bar for documents and user communications, including sub-agent status and handbacks.

**ASD-STE100** is Simplified Technical English (aerospace controlled language). Here it means a practical subset. It is not a certification program. The four rules below are the how.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `≉`=SHOULD NOT, `⊗`=MUST NOT, `?`=MAY.

Tracker: [#3368](https://github.com/deftai/directive/issues/3368). Mechanics from [#2927](https://github.com/deftai/directive/issues/2927).

---

## Rules (minimum bar)

1. **Short sentences.** Prefer one main idea per sentence.
2. **Active voice.** Prefer "The agent runs the gate" over "The gate is run by the agent."
3. **One term = one meaning.** Keep product terms stable (`xbrief`, host, skill pack, swarm, deposit). Do not reuse one word for two concepts.
4. **First-use definitions.** Define a tech term the first time it appears when the reader may not know it.

! Apply these four rules to documents and user communications, including sub-agent status and handbacks — not only new-and-touched files.

~ Prefer clarity over ceremony. When a product term already has a glossary or category note, reuse that meaning.

---

## Ceremony vs required fields

! Cut ceremony, not required protocol fields. Keep these complete:

- `DONE` / `BLOCKED` / `FAILED` status lines
- Allocation context
- SHAs
- Exit codes
- Evidence cites

⊗ Drop a required field to look brief.

---

## Where it applies

- Agent and maintainer communications about Directive
- Product docs (including `content/docs/` and related guides)
- GitHub issues, PRs, and review comments that maintainers or agents author here
- Skill and strategy prose where clarity matters for agent load
- Sub-agent status, handbacks, and sibling reports

! The bar governs communication **about** the work, not the work itself.

! Product content with its own specified voice (fiction, game dialogue, marketing, brand copy) follows the scope's style requirements. No toggle: this is a scoping sentence, not a config flag.

---

## Reasoning is out of scope

! The bar does not govern reasoning itself. Thinking budgets are harness knobs (effort tier, per-role routing #1739), not prose rules.

⊗ Extend the bar to thinking. Terse reasoning trades correctness for style.

---

## Non-goals

- ⊗ Full ASD-STE100 dictionary compliance or formal STE tooling certification
- ⊗ A big-bang rewrite of the historical issue corpus
- ⊗ A red CI style gate in v1 that blocks merges on style nitpicks
- ⊗ A second `[AXIOM]` label
- ⊗ Prefacing the rule ("per the writing bar…")

Process expectation only: follow the bar by default. Do not invent a merge blocker from this page alone.

---

## Related

| Issue | Role |
|-------|------|
| [#3368](https://github.com/deftai/directive/issues/3368) | Always-on outcome bar (clarity, simplicity, brevity) |
| [#2927](https://github.com/deftai/directive/issues/2927) | Four STE mechanics (closed) |
| [#740](https://github.com/deftai/directive/issues/740) | Plain-English UX pass (closed; interview-focused) |
| [#865](https://github.com/deftai/directive/issues/865) | Every rule is a token tax |
| [#847](https://github.com/deftai/directive/issues/847) | Lean context first |
| [#2484](https://github.com/deftai/directive/issues/2484) | Progressive disclosure for large skills |
| [#2905](https://github.com/deftai/directive/issues/2905) | Category terms (host vs skill pack vs practice layer) |
| [#1739](https://github.com/deftai/directive/issues/1739) | Per-role routing (thinking budgets; not this bar) |
