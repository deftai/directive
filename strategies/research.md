# Research Strategy

Look before you leap — investigate the domain before planning.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/interview.md](./interview.md) | [strategies/discuss.md](./discuss.md) | [strategies/map.md](./map.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) research phase.

---

## When to Use

- ~ Before planning a feature in an unfamiliar domain (auth, payments, real-time, etc.)
- ~ When the feature involves libraries or APIs the agent hasn't used in this project
- ? Skip for well-understood domains where the agent has strong existing context

## Output

! Before writing output artifacts, follow the [Preparatory Guard](./artifact-guards.md#preparatory-guard-light).

Produce `vbrief/proposed/{feature}-research.vbrief.json` with two mandatory narratives:

### `DontHandRoll` narrative

Problems that look simple but have existing, battle-tested solutions.

- ! For each problem area, specify: **problem**, **recommended library/tool**, **why not hand-roll**
- ! Check the project's existing dependencies first -- don't add a library when one is already available
- ~ Consult official docs for the recommended library (use Context7 or equivalent)

**Example narrative content:**
```
Problem: JWT validation
Use: jose
Rationale: Edge cases in token expiry, key rotation, algorithm confusion

Problem: Email templates
Use: react-email
Rationale: HTML email rendering is notoriously broken across clients

Problem: Rate limiting
Use: express-rate-limit
Rationale: IP spoofing, distributed state, Redis integration
```

### `CommonPitfalls` narrative

What goes wrong in this domain, why, and how to avoid it.

- ! For each pitfall: **what happens**, **why it happens**, **how to avoid it**, **warning signs**
- ~ Informed by library docs, codebase patterns, and known failure modes
- ~ Prioritize pitfalls that agents specifically tend to hit (stubs, missing error handling, hardcoded values)

**Example narrative content:**
```
Pitfall: Storing plain-text passwords
What: User passwords saved without hashing
Why: Agent implements the happy path and forgets security
Avoid: Use bcrypt/argon2, never store raw passwords
Warning signs: No crypto import in auth module, password field stored as-is
```

---

## How Research Feeds Downstream

- ! **Planning** reads research before task decomposition — acceptance criteria account for pitfalls
- ! **Execution** references "Don't Hand-Roll" — agent uses recommended libraries, not custom code
- ~ **Verification** checks for pitfall warning signs during stub detection

## Research Scope Rules

- ! Research the **current feature only** — not the entire project
- ! Time-box research — if it takes longer than the feature, scope is wrong
- ⊗ Research as a reason to delay execution indefinitely
- ~ Research persists as a vBRIEF in `vbrief/proposed/`

---

## Then: Chaining Gate

After research is complete, return to the [chaining gate](./interview.md#chaining-gate)
so the user can run additional preparatory strategies or proceed to spec generation.

- ! On completion, register artifacts in `./vbrief/plan.vbrief.json`:
  - Update `completedStrategies`: increment `runCount` for `"research"`,
    append artifact path (`vbrief/proposed/{feature}-research.vbrief.json`)
  - Append the path to the flat `artifacts` array
- ! Return to [interview.md Chaining Gate](./interview.md#chaining-gate)
- ! The research findings MUST inform subsequent strategies and spec generation:
  - "Don't Hand-Roll" items become constraints in the specification
  - "Common Pitfalls" become acceptance criteria or NFRs
- ⊗ End the session after research without returning to the chaining gate
  or the invoking strategy's next-step menu

! **Standalone context:** If invoked from a standalone strategy (e.g. map's
  standalone next-step menu) rather than from the interview chaining gate,
  return to the invoking strategy's menu instead.

---

## Workflow

1. **Scope** -- Identify the domain and feature boundaries for research
2. **Survey** -- Check existing project dependencies, official docs, and known pitfalls
3. **Document** -- Produce `vbrief/proposed/{feature}-research.vbrief.json` with `DontHandRoll` and `CommonPitfalls` narratives
4. **Chain** -- Return to [interview.md Chaining Gate](./interview.md#chaining-gate), or -- if invoked from a standalone strategy (e.g. map's standalone next-step menu) -- return to the invoking strategy's menu per the [standalone-context rule](#then-chaining-gate) above

## Anti-Patterns

- ⊗ Building custom solutions for solved problems
- ⊗ Skipping research for unfamiliar domains ("how hard can auth be?")
- ⊗ Research that produces a reading list instead of actionable guidance
- ⊗ Research that doesn't flow into planning (written and never referenced)
- ⊗ Ending after research without chaining into specification generation (chained mode; in standalone context, returning to the invoking strategy's menu satisfies the completion requirement per the [standalone-context rule](#then-chaining-gate))
