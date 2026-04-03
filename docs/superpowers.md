# Superpowers Adoption Plan

Patterns and techniques from [obra/superpowers](https://github.com/obra/superpowers) worth adopting into Deft Directive, prioritized by impact.

**Superpowers commit**: `eafe962b18f6c5dc70fb7c8cc7e83e61f4cdde06` (main branch, as of 2026-03-28)

---

## Priority 1: Systematic Debugging

**Gap**: Deft has no debugging guidance. Agents guess-and-fix instead of investigating root causes.

**What superpowers does**: A 4-phase process with an Iron Law ("no fixes without root cause investigation first"):

1. **Root Cause Investigation** — read errors carefully, reproduce consistently, check recent changes, gather evidence at component boundaries, trace data flow backward
2. **Pattern Analysis** — find working examples, compare against references, identify differences
3. **Hypothesis Testing** — form single hypothesis, test minimally, one variable at a time
4. **Implementation** — create failing test, implement single fix, verify

Key innovations:
- If 3+ fixes fail, stop fixing and question the architecture
- Multi-component systems: add diagnostic instrumentation at every boundary before proposing fixes
- Supporting techniques: backward call-stack tracing, defense-in-depth validation, condition-based waiting (replace arbitrary timeouts with polling)

**Where it goes**: `coding/debugging.md`

**Scope**: ~200 lines. The 4-phase process, the 3-fix architecture gate, diagnostic instrumentation pattern, and a rationalization prevention table.

---

## Priority 2: Verification Gate Function

**Gap**: Deft's `verification/verification.md` defines *what* to verify (truths, artifacts, key links) but not the *behavioral discipline* of when claims are allowed.

**What superpowers does**: A strict gate function that prevents agents from ever saying "should work now" or "looks correct":

```
IDENTIFY command → RUN it (fresh, this message) → READ output → VERIFY claim → THEN speak
```

Key rules:
- No completion claims without fresh verification evidence
- Forbidden words: "should", "probably", "seems to" when describing test/build results
- Previous run output doesn't count — must be re-run
- Agent success reports must be independently verified

**Where it goes**: New section in `verification/verification.md` — "Verification Gate" above existing content.

**Scope**: ~40 lines added. The gate function, forbidden-words rule, and a small rationalization table.

---

## Priority 3: Code Review Protocol

**Gap**: Deft has no code review workflow — neither requesting reviews nor responding to feedback.

**What superpowers does**: Two complementary skills:

### Requesting Review
- Get git SHAs (base + head)
- Dispatch reviewer with structured context: what was implemented, plan/requirements reference, commit range
- Triage feedback by severity: Critical (fix now), Important (fix before proceeding), Minor (note for later)
- Mandatory after each task in multi-agent work, after major features, before merge

### Receiving Review
- Anti-performative-agreement: never respond "great point!" or "you're absolutely right!" — just fix and move on
- Verify suggestions against codebase reality before implementing
- YAGNI check: if reviewer suggests "implementing properly" but the feature is unused, push back
- Clarify all unclear items before implementing any of them
- Implementation order: blocking issues → simple fixes → complex fixes, test each individually
- Push back with technical reasoning when reviewer is wrong or lacks context

**Where it goes**: `coding/code-review.md` (new file)

**Scope**: ~150 lines. Requesting protocol, receiving protocol, severity triage, anti-patterns.

---

## Priority 4: Rationalization Prevention Tables

**Gap**: Deft uses anti-pattern lists (⊗ markers) that describe forbidden *behaviors*. Superpowers adds rationalization tables that address the *thought patterns* leading to those behaviors.

**What superpowers does**: Consistently pairs anti-patterns with excuse→reality tables:

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll write tests after" | Tests passing immediately prove nothing. |
| "Quick fix for now, investigate later" | First fix sets the pattern. Do it right from the start. |
| "One more fix attempt" | 3+ failures = architectural problem. Question pattern. |
| "Should work now" | RUN the verification. |

This pattern is more effective than anti-patterns alone because it intercepts the rationalization before the behavior occurs.

**Where it goes**: Add rationalization tables to existing files:
- `coding/testing.md` — TDD rationalizations
- `verification/verification.md` — verification rationalizations
- `coding/debugging.md` (new, from Priority 1) — debugging rationalizations

**Scope**: ~30 lines per file (3 small tables).

---

## Priority 5: Subagent Dispatch with Two-Stage Review

**Gap**: Deft's `swarm/swarm.md` defines coordination protocols (handoff formats, conflict resolution, file locking) but lacks an operational *execution* workflow for dispatching and reviewing subagent work.

**What superpowers does**: A concrete execution loop:

1. Read plan, extract all tasks
2. Per task: dispatch fresh implementer subagent with precisely crafted context (not session history)
3. Implementer reports status: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`
4. **Stage 1 review**: Dispatch spec-compliance reviewer — does output match requirements?
5. **Stage 2 review**: Dispatch code-quality reviewer — is it well-written?
6. Fix loop if either reviewer rejects
7. After all tasks: final whole-implementation review

Additional insights:
- Model selection: cheap models for mechanical tasks (1-2 files, clear spec), capable models for design/architecture
- Controller curates exactly what context each subagent needs — subagents never inherit session history
- "Never ignore an escalation" — if implementer says stuck, something must change before retry

**Where it goes**: `swarm/subagent-execution.md` (new file), cross-referenced from `swarm/swarm.md`

**Scope**: ~180 lines. The execution loop, status handling, two-stage review, model selection guidance.

---

## Priority 6: No-Placeholders Rule + Plan Self-Review

**Gap**: Deft's interview strategy produces specs with phases/subphases/tasks and acceptance criteria, but doesn't enforce completeness at the step level or require self-review after generation.

**What superpowers does**:

### No Placeholders
Explicit list of forbidden patterns in plans:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the content — reader may be out of order)
- Steps that describe *what* without showing *how* (code blocks required for code steps)

### Plan Self-Review
After writing any plan/spec, run three checks:
1. **Spec coverage**: skim each requirement — can you point to a task that implements it?
2. **Placeholder scan**: search for forbidden patterns above
3. **Type consistency**: do function names, types, and signatures used in later tasks match earlier definitions?

**Where it goes**: Add to `strategies/interview.md` SPECIFICATION Guidelines section. Also reference from `commands.md` (change:apply reads the plan).

**Scope**: ~40 lines added to interview.md.

---

## Priority 7: Git Worktrees for Feature Isolation

**Gap**: Deft has no workspace isolation strategy. Feature work happens on branches in the same working directory.

**What superpowers does**:
- Systematic directory selection: check for existing `.worktrees/` → check config → ask user
- Safety verification: ensure worktree directory is gitignored before creation
- Auto-detect project setup (package.json → npm install, pyproject.toml → poetry install, etc.)
- Verify clean test baseline before starting work
- Paired with a finishing skill that offers merge/PR/keep/discard options and cleans up

**Where it goes**: `scm/worktrees.md` (new file), cross-referenced from `scm/git.md`

**Scope**: ~100 lines. Directory selection, safety checks, setup, baseline verification.

---

## Priority 8: Branch Completion Workflow

**Gap**: Deft's `/deft:change:archive` handles post-completion (move to archive, merge spec deltas, CHANGELOG entry) but doesn't structure the *decision point* of how to integrate.

**What superpowers does**: After all tasks verified:
1. Verify tests pass (gate — stop if failing)
2. Determine base branch
3. Present exactly 4 options: merge locally / push + PR / keep as-is / discard
4. Execute chosen option with appropriate safety (typed confirmation for discard)
5. Clean up worktree if applicable

**Where it goes**: Extend `commands.md` — add a "completion gate" step before `/deft:change:archive`.

**Scope**: ~50 lines added to commands.md.

---

## What NOT to Adopt

These superpowers patterns are already covered or don't fit Deft's architecture:

- **Brainstorming skill** — Deft's interview + discuss + research strategies are more sophisticated (chaining gate, sizing gate, strategy composition)
- **Writing-plans skill** — Deft's interview strategy already produces phased specs with task decomposition; the no-placeholders rule (Priority 6) captures the useful addition
- **Using-superpowers skill** (auto-triggering) — Deft uses explicit slash commands and strategy selection, which is more predictable
- **"Iron Law" framing** — Deft's RFC 2119 notation (!/⊗) is more nuanced; the rationalization tables (Priority 4) capture the useful behavioral insight without changing Deft's voice
- **Writing-skills as TDD** — interesting meta-pattern but Deft's skills aren't pressure-tested with subagents in the same way; lower priority
- **Visual companion** — Claude Code-specific browser integration; not portable

---

## Implementation Notes

- Each priority is independent — can be implemented in any order
- Priorities 1-4 are high-value, low-effort additions
- Priorities 5-6 enhance existing Deft files
- Priorities 7-8 add new capabilities
- All new files should follow Deft conventions: RFC 2119 legend, `⚠️ See also` cross-references, anti-patterns section
- Credit superpowers where adapted: `> Adapted from [superpowers](https://github.com/obra/superpowers) {skill-name} skill.`
