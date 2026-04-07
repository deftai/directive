# BDD Strategy

Behaviour-Driven Development -- failing acceptance tests drive requirements.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/interview.md](./interview.md) | [strategies/discuss.md](./discuss.md) | [core/glossary.md](../core/glossary.md)

> Acceptance tests are the specification. Write them first, let failures surface ambiguity, then lock decisions before generating a formal spec.

---

## When to Use

- ~ Features where expected behaviour is easier to express as examples (Given/When/Then) than as written requirements
- ~ Teams wanting executable specifications that double as regression tests
- ~ Projects where acceptance tests will be the source of truth for feature correctness
- ? Skip when requirements are already unambiguous and a formal spec exists

---

## Workflow

### Step 1: Identify User Scenarios

! Write Given/When/Then scenarios for the feature before any implementation or specification work.

- ! Each scenario covers one behaviour -- avoid multi-assertion scenarios
- ~ Capture happy path, edge cases, and error cases as separate scenarios
- ~ Use concrete values, not placeholders (e.g. "Given a user with 3 items in cart" not "Given a user with items")
- ! Store scenarios in `specs/{feature}/acceptance-tests/`

### Step 2: Write Failing Acceptance Tests

! Translate scenarios into executable test code before writing any implementation.

- ! Tests MUST fail when first written -- a passing test before implementation means the test is wrong or the feature already exists
- ~ Use the project's test framework (pytest, go test, jest, etc.)
- ! Place test files in `specs/{feature}/acceptance-tests/`
- ⊗ Write implementation code at this step

### Step 3: Run Tests -- Surface Ambiguity

! Run the failing tests. Use the failures to surface missing decisions and ambiguity in requirements.

- ! Each test failure is a question: "What should happen here?"
- ~ Group failures by theme (data model gaps, API contract gaps, business rule gaps)
- ! Record every ambiguity discovered -- these become decision items in Step 4

### Step 4: Lock Decisions

! Resolve all ambiguities surfaced by Step 3. Record decisions in `{feature}-bdd-context.md`.

- ! Each decision includes: **what** was decided, **why**, and **alternatives considered**
- ! Decisions are **locked** -- downstream tasks inherit them, do not re-debate
- ! Format follows the same structure as `{scope}-context.md` from [strategies/discuss.md](./discuss.md)
- ⊗ Leave ambiguities unresolved -- every question surfaced in Step 3 must have a locked answer

### Step 5: Generate Spec

! Derive SPECIFICATION.md tasks from the now-stable test scenarios and locked decisions.

- ! Each scenario maps to one or more spec tasks with traceability (`traces: scenario-N`)
- ! Locked decisions from `{feature}-bdd-context.md` flow into the spec as constraints
- ~ Use the Light or Full path from [strategies/interview.md](./interview.md) based on project size

### Step 6: Chain into Interview Sizing Gate

! Follow [strategies/interview.md](./interview.md) sizing gate for SPECIFICATION.md finalisation.

- ! On completion, register artifacts in `./vbrief/plan.vbrief.json`:
  - Update `completedStrategies`: increment `runCount` for `"bdd"`, append artifact paths
  - Append all new artifact paths to the flat `artifacts` array
- ! Return to [interview.md Chaining Gate](./interview.md#chaining-gate)
- ! The locked decisions from `{feature}-bdd-context.md` and the acceptance tests MUST flow into subsequent strategies and spec generation

---

## Output Artifacts

- `specs/{feature}/acceptance-tests/` -- executable test files derived from Given/When/Then scenarios
- `{feature}-bdd-context.md` -- locked decisions surfaced by test failures (same format as discuss strategy's context.md)

---

## Fits into Chaining Gate

BDD is a **preparatory** strategy. It can be combined with other preparatory strategies (research, discuss, map) before spec generation. On completion, the chaining gate reappears so the user can run additional strategies or proceed to specification.

⊗ End the session after BDD without returning to the chaining gate.

---

## Anti-Patterns

- ⊗ Writing implementation before acceptance tests -- tests must come first
- ⊗ Writing acceptance tests that pass immediately -- a passing test before implementation indicates a wrong test or pre-existing feature
- ⊗ Leaving ambiguities unresolved after Step 3 -- every surfaced question must be locked in Step 4
- ⊗ Skipping the context.md file -- decisions that exist only in conversation history will be lost
- ⊗ Writing scenarios with vague placeholders instead of concrete values
- ⊗ Combining multiple behaviours into a single scenario -- one scenario, one behaviour
- ⊗ Ending after BDD without chaining into specification generation
