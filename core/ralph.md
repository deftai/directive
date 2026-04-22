# The Ralph Wiggum Loop

**⚠️ DRAFT - EARLY VERSION - TBD**

This is an early draft describing the Ralph Wiggum loop process for agentic coding. Implementation in Warp is TBD.

## 🎭 What is the Ralph Wiggum Loop?

Named after the Simpsons character known for his innocent observations ("I'm in danger!"), the Ralph Wiggum loop is a continuous self-assessment cycle where AI coding agents detect when they're "in danger" of producing poor quality code, going off-track, or missing requirements.

**The core concept**: The agent re-attempts the **same prompt/task multiple times** until it "really gets it right"—passing all quality checks before presenting any work to the user.

The loop embodies Ralph's characteristic trait: **honest, immediate recognition of problematic situations without ego or defensiveness**.

## 🔄 The Loop Process

**Critical**: This is a loop over the **same task**, not a conversation back-and-forth with the user. The agent keeps retrying internally until success or escalation.

### 1. **Code Generation**

The agent writes code based on specifications and context.

### 2. **Self-Assessment** ("Am I in danger?")

Before presenting code to the user, the agent evaluates:

- **Specification alignment**: Does this match the spec?
- **Test coverage**: Are tests comprehensive? Do they pass?
- **Quality metrics**: Does it meet linting, typing, formatting standards?
- **Edge cases**: Have I considered failure modes?
- **Technical debt**: Am I introducing maintainability issues?
- **Dependencies**: Have I created coupling problems?
- **Security**: Are there obvious vulnerabilities?

### 3. **Danger Detection** ("I'm in danger!")

If ANY assessment criterion fails, the agent recognizes the danger state:

```
🚨 Ralph Mode Activated
Issue detected: [specific problem]
Fixing before presentation...
```

### 4. **Self-Correction**

The agent re-attempts the **original task** with fixes:

1. Identifies the specific issue
2. Regenerates/edits code to address the problem
3. Re-runs quality checks
4. Returns to step 2 (Self-Assessment) with the same task context

**Key**: The user's original prompt remains constant. The agent loops through generate → assess → fix until the output meets all criteria.

### 5. **Loop Exit Conditions**

**Success Exit**: All criteria pass → present code to user

**Escalation Exit**: After N iterations (default: 3), if still failing:

- Present current state
- Explain what's blocking success
- Ask user for guidance

## 🎯 Key Principles

### Innocent Honesty

Like Ralph, the agent has no ego about admitting problems:

- No defensive justifications
- No hiding issues
- Immediate recognition of danger

### Pre-Emptive Quality

The loop runs **before** presenting work:

- User sees quality code by default
- No "here's broken code, please fix it" interactions
- Respectful of user time
- **The user never sees the intermediate failed attempts**—only the final working solution

### Bounded Iteration

The loop prevents infinite cycles:

- Maximum 3 self-correction attempts
- After that, escalate to user
- Never silently struggle

### Transparent Operation

When Ralph mode activates, tell the user:

```
🚨 Detected test failures. Running Ralph loop...
Iteration 1: Fixed import issue, re-running tests...
Iteration 2: All tests pass. Coverage: 82%. ✓
```

## 📋 Assessment Checklist

For each code generation, check:

- [ ] **Tests exist** and pass
- [ ] **Coverage ≥75%** (overall + per-module)
- [ ] **Linting passes** (ruff/eslint/golangci-lint)
- [ ] **Type checking passes** (mypy/tsc/go build)
- [ ] **Formatting applied** (black/prettier/gofmt)
- [ ] **Spec requirements met**
- [ ] **Error handling present**
- [ ] **Edge cases considered**
- [ ] **Documentation complete**
- [ ] **No obvious security issues**
- [ ] **Dependencies justified**
- [ ] **Files <500 lines** (must be <1000)

## 🛠️ Implementation in Warp (TBD)

### Current State

The Ralph loop is **not yet implemented** in Warp AI. This is a design document for future functionality.

### Proposed Implementation

**Option 1: Explicit Ralph Mode**

```
User: "Implement feature X in ralph mode"
Agent: Activates loop, runs self-assessment, presents only quality code
```

**Option 2: Always-On Background**

```
Agent automatically runs loop on all code generation
Shows "🚨 Ralph loop: iteration N" when corrections happen
```

**Option 3: Configurable in user.md**

```markdown
## Ralph Loop

Enabled: true
Max iterations: 3
Verbose: true # Show each iteration
```

### Open Questions

1. **Performance**: Does the loop slow down responses too much?
2. **Context limits**: Does self-assessment consume too many tokens?
3. **False positives**: When is "danger" too sensitive?
4. **User control**: Should users be able to skip the loop?
5. **Metrics**: What do we measure to validate Ralph's effectiveness?

## 🎬 Example Session

**The key**: User gives ONE prompt. Agent loops INTERNALLY multiple times on that same prompt until quality checks pass.

```
User: "Add a CSV export feature to the app"

Agent (internal - re-attempting same task):
  ATTEMPT 1:
    Generating code for CSV export... Done.
    Running Ralph assessment...
    🚨 Danger detected: No tests for CSV export
    RETRY with test generation included...

  ATTEMPT 2:
    Generating code + tests for CSV export... Done.
    Running tests... 2 failures.
    🚨 Danger detected: Tests failing
    RETRY with quote escaping fix...

  ATTEMPT 3:
    Generating code + tests with escaping fix... Done.
    Running tests... All pass. Coverage: 68%
    🚨 Danger detected: Coverage below 75%
    RETRY with edge case tests...

  ATTEMPT 4:
    Generating code + comprehensive tests... Done.
    Running tests... All pass. Coverage: 81%. ✓
    All Ralph checks passed!

Agent (to user):
  Added CSV export feature with:
  - Export to CSV with proper escaping
  - Comprehensive test coverage (81%)
  - Error handling for file I/O

  [presents code]
```

**What the user sees**: Just the final message with working code. The 4 internal attempts are invisible (or optionally shown if verbose mode is on).

## 🚧 Future Work

- [ ] Define precise assessment criteria per language
- [ ] Implement loop in Warp AI agent system
- [ ] Add telemetry to measure effectiveness
- [ ] Create user controls for Ralph behavior
- [ ] Integrate with deft quality standards
- [ ] Determine optimal max iteration count
- [ ] Handle multi-file changes in loop
- [ ] Define escalation UX patterns

## 📚 References

- **Simpsons Reference**: Ralph Wiggum's "I'm in danger!" meme captures the spirit of honest self-assessment
- **Related**: Test-Driven Development (TDD) in [README.md](../README.md)
- **Related**: Quality standards in [main.md](../main.md)
- **Related**: Language-specific checks in [python.md](../languages/python.md), [go.md](../languages/go.md)

---

**Status**: Draft concept, implementation TBD
**Feedback welcome**: This is an early idea. Suggestions and improvements encouraged.
