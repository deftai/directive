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

Produce `{feature}-research.md` with two mandatory sections:

### Don't Hand-Roll

Problems that look simple but have existing, battle-tested solutions.

- ! For each problem area, specify: **problem**, **recommended library/tool**, **why not hand-roll**
- ! Check the project's existing dependencies first — don't add a library when one is already available
- ~ Consult official docs for the recommended library (use Context7 or equivalent)

**Example:**
```
| Problem | Use This | Don't Hand-Roll Because |
|---------|----------|------------------------|
| JWT validation | jose | Edge cases in token expiry, key rotation, algorithm confusion |
| Email templates | react-email | HTML email rendering is notoriously broken across clients |
| Rate limiting | express-rate-limit | IP spoofing, distributed state, Redis integration |
```

### Common Pitfalls

What goes wrong in this domain, why, and how to avoid it.

- ! For each pitfall: **what happens**, **why it happens**, **how to avoid it**, **warning signs**
- ~ Informed by library docs, codebase patterns, and known failure modes
- ~ Prioritize pitfalls that agents specifically tend to hit (stubs, missing error handling, hardcoded values)

**Example:**
```
**Pitfall: Storing plain-text passwords**
- What: User passwords saved without hashing
- Why: Agent implements the happy path and forgets security
- Avoid: Use bcrypt/argon2, never store raw passwords
- Warning signs: No crypto import in auth module, password field stored as-is
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
- ~ Persist research in `docs/research/` or alongside feature planning artifacts

---

## Then: Chaining Gate

After research is complete, return to the [chaining gate](./interview.md#chaining-gate)
so the user can run additional preparatory strategies or proceed to spec generation.

- ! On completion, register artifacts in `./vbrief/plan.vbrief.json`:
  - Update `completedStrategies`: increment `runCount` for `"research"`,
    append artifact path (`{feature}-research.md`)
  - Append the path to the flat `artifacts` array
- ! Return to [interview.md Chaining Gate](./interview.md#chaining-gate)
- ! The research findings MUST inform subsequent strategies and spec generation:
  - "Don't Hand-Roll" items become constraints in the specification
  - "Common Pitfalls" become acceptance criteria or NFRs
- ⊗ End the session after research without returning to the chaining gate

---

## Workflow

1. **Scope** -- Identify the domain and feature boundaries for research
2. **Survey** -- Check existing project dependencies, official docs, and known pitfalls
3. **Document** -- Produce `{feature}-research.md` with Don't Hand-Roll and Common Pitfalls sections
4. **Chain** -- Return to [interview.md Chaining Gate](./interview.md#chaining-gate)

## Anti-Patterns

- ⊗ Building custom solutions for solved problems
- ⊗ Skipping research for unfamiliar domains ("how hard can auth be?")
- ⊗ Research that produces a reading list instead of actionable guidance
- ⊗ Research that doesn't flow into planning (written and never referenced)
- ⊗ Ending after research without chaining into specification generation
