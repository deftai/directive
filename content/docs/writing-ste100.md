# Controlled English for docs and issues

Directive uses a short **controlled-English** bar for product docs, issues, PRs, and agent-facing prose.

**ASD-STE100** is Simplified Technical English (aerospace controlled language). Here it means a practical subset. It is not a certification program.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `≉`=SHOULD NOT, `⊗`=MUST NOT, `?`=MAY.

Tracker: [#2927](https://github.com/deftai/directive/issues/2927).

---

## Rules (minimum bar)

1. **Short sentences.** Prefer one main idea per sentence.
2. **Active voice.** Prefer "The agent runs the gate" over "The gate is run by the agent."
3. **One term = one meaning.** Keep product terms stable (`xbrief`, host, skill pack, swarm, deposit). Do not reuse one word for two concepts.
4. **First-use definitions.** Define a tech term the first time it appears when the reader may not know it.

! Apply these four rules to **new and touched** prose that maintainers or agents author for this repo.

~ Prefer clarity over ceremony. When a product term already has a glossary or category note, reuse that meaning.

---

## Where it applies

- Agent and maintainer communications about Directive
- Product docs (including `content/docs/` and related guides)
- GitHub issues, PRs, and review comments that maintainers or agents author here
- Skill and strategy prose where clarity matters for agent load

---

## Non-goals

- ⊗ Full ASD-STE100 dictionary compliance or formal STE tooling certification
- ⊗ A big-bang rewrite of the historical issue corpus
- ⊗ A red CI style gate in v1 that blocks merges on style nitpicks

Process expectation only: follow the bar by default. Do not invent a merge blocker from this page alone.

---

## Related

| Issue | Role |
|-------|------|
| [#740](https://github.com/deftai/directive/issues/740) | Plain-English UX pass (closed; interview-focused) |
| [#865](https://github.com/deftai/directive/issues/865) | Every rule is a token tax |
| [#847](https://github.com/deftai/directive/issues/847) | Lean context first |
| [#2484](https://github.com/deftai/directive/issues/2484) | Progressive disclosure for large skills |
| [#2905](https://github.com/deftai/directive/issues/2905) | Category terms (host vs skill pack vs practice layer) |
