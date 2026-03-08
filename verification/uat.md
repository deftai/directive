# User Acceptance Testing (UAT)

Auto-generated, human-readable verification scripts for completed work units.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [verification/verification.md](./verification.md) | [coding/testing.md](../coding/testing.md) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) UAT model.

---

## Core Principle

When the agent says "done," the user needs a way to **see it with their own eyes** — without reading code.

---

## When to Generate

- ! Generate a UAT script when a feature completes
- ~ Generate on release completion as a rollup
- ? Generate per-task for high-risk changes

## UAT Script Format

```markdown
## UAT: [Feature Name]
Date: YYYY-MM-DD

### Test 1: [Scenario Title]
**Do:**
1. [Specific action — copy-pasteable command or UI step]
2. [Next action]

**Expected:**
- [Exact observable outcome — specific text, URL, behavior]
- [What success looks like, not "it should work"]
```

## Guidelines

- ! Every step is a **specific action** — copy-pasteable command or precise UI instruction
- ! Every expected result describes **what you see** — exact text, URL, behavior
- ! Derive tests from the feature's acceptance criteria and demo sentence
- ⊗ Include implementation details the user doesn't need ("verify JWT is valid")
- ⊗ Use vague expectations ("it should work", "page loads correctly")
- ~ Cross-reference against task summaries for what was actually built

## Workflow

- ! UAT generation is **non-blocking** — agent writes the script and moves on
- ~ User tests when convenient (between features, end of release, whenever)
- ! If UAT reveals issues, create fix tasks — don't block the pipeline
- ~ Keep UAT scripts in `docs/uat/` or alongside the feature artifacts

## vBRIEF Integration

- ~ Reference UAT script path in the vBRIEF feature/release summary narrative
- ~ On UAT failure, create vBRIEF fix items with `blocked` status and failure narrative
