# Authoring agent docs (AGENTS.md) for a project

Guidance for structuring the AGENTS.md (and its reference docs) of a project directive creates or maintains. Unlike most style advice, the patterns here are **empirically measured**, not opinion: Augment Code's April 2026 AuggieBench study ran real PRs with and without each pattern and scored the agent's output against the human-reviewed golden PR. Full write-up: [good-agents-md.md](./good-agents-md.md).

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `≉`=SHOULD NOT, `⊗`=MUST NOT, `?`=MAY.

> The headline finding: a good AGENTS.md gave the agent a quality jump equivalent to a model upgrade; a bad one made output **worse than no AGENTS.md at all**. The same file boosted `best_practices` +25% on a routine bug fix and dropped `completeness` -30% on a complex feature in the same module. Structure is the difference.

## The pattern (what the study measured)

| Pattern | Measured effect |
|---|---|
| 100–150 line main file + a handful of focused reference files | Top performers; **10–15%** improvement across all metrics in mid-size modules. Gains **reverse** once the main file grows past ~150 lines. |
| Numbered procedural workflows for multi-step tasks | Missing-wiring PRs **40% → 10%**; correctness **+25%**, completeness **+20%**. |
| Decision tables for common ambiguities (2–3 reasonable options) | **+25%** best-practices adherence — resolves the choice before the agent writes a line. |
| 3–10 line snippets from the **real** codebase | Improved reuse and pattern adherence. More than a few, and the agent pattern-matches on the wrong thing. |
| Paired don't/do rules | Warning-only docs underperform; **15+ unpaired don'ts** measurably cause overexploration. |
| Module-level files over a root cross-cutting file | Root-level cross-cutting AGENTS.md underperforms module-scoped files. |

## How to structure a project's AGENTS.md

1. ! Keep the always-loaded AGENTS.md to **~100–150 lines**. It is a map (what exists, where to look, the few load-bearing rules), not a manual.
2. ! Push detail into **focused reference files** the agent loads on demand, each with a clear "load when…" scope. See the reference-chain contract below.
3. ~ Express multi-step tasks (deploy an integration, add a migration, wire a new endpoint) as **numbered workflows**, not prose. Keep branching cases in reference files.
4. ~ For each recurring "which of these two approaches?" ambiguity, add a **decision table** that forces the choice up front.
5. ~ Include a few **short, real** code snippets (3–10 lines) for the patterns you most want reused. Do not paste large or duplicative examples.
6. ! Write rules as **paired don't/do**, not lone warnings — an unpaired "don't" leaves the agent to guess the "do", and a pile of them triggers overexploration.
7. ~ Prefer **module-level** agent docs (scoped to the package/app the agent is working in) over one root file that tries to cover everything.

## The reference-chain contract

The discovery-rate principle that governs *what to reference* is named in `REFERENCES.md` ("The reference-chain contract", #644) — read it there rather than duplicating it here. In one line: **if a rule must be followed, it must be reachable in the reference chain; orphan docs (<10% discovery) are effectively invisible, and reachable-but-unreferenced docs are still found and still cost context.**

## The overexploration trap (measured failure modes, not style)

These are the specific blocks the study measured *hurting* agent quality — treat them as defects, not taste:

- ⊗ Do **not** add an "architecture overview" / broad-context section to an always-loaded agent file. On complex tasks it pulls the agent into the reference section to verify its approach against every guideline, producing unnecessary abstractions and incomplete solutions (the measured -30% completeness case).
- ⊗ Do **not** accumulate 15+ unpaired warnings. Past that threshold the agent over-explores instead of acting.
- ≉ Avoid stacking dozens of domain-specific gotchas. Domain rules help when specific and enforceable; they stop helping when piled up. Prefer a deterministic gate over prose where one exists (the gate is platform-correct by construction and travels with the repo).

## Skill pins for process-critical workflows (#2508)

When a workflow skill must not be skipped on trigger miss (implementation, pre-PR, review-cycle, swarm), name it in AGENTS.md as an **always-pin** — not by pasting the skill body. Tier definitions, default pin list, and anti-patterns (do not pin entire language packs): [`skill-pin-policy.md`](./skill-pin-policy.md).

## Relationship to directive's own dogfooding

Directive holds its own AGENTS.md to this bar via the `verify:agents-md-budget` ratchet (#645) and the consumer-side advisory signal (`agentsMdAdvisory`, #2155). The doc-sprawl awareness step in the `deft-directive-sync` skill (#647) surfaces reachable-doc-volume drift before it silently degrades agent quality. This doc is the "how to structure it well" companion to those "keep it from bloating" guards.
