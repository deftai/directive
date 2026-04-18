# Domain Events

Named occurrences in an agent session that trigger specific, mandatory behaviour.

When an event fires, the listed response is not optional — it is the correct action. Agents must not proceed past an event without executing its response.

Legend (from RFC2119): !=MUST, ~=SHOULD, ⊗=MUST NOT.

**⚠️ See also**: [commands.md](../commands.md) | [resilience/continue-here.md](../resilience/continue-here.md) | [verification/verification.md](../verification/verification.md) | [coding/hygiene.md](../coding/hygiene.md)

---

## `spec:approved`

**When**: The `status` field in `./vbrief/specification.vbrief.json` is set to `"approved"` by the user.

**Response**:
- ! Run `task spec:render` (or `python scripts/spec_render.py`) to generate `SPECIFICATION.md`
- ! Proceed to the build phase
- ⊗ Edit `SPECIFICATION.md` directly — edit the vBRIEF source and re-render

---

## `coverage:dropped`

**When**: `task test:coverage` reports coverage below the project threshold (default ≥85%).

**Response**:
- ! Block task/phase completion
- ⊗ Claim the task or phase is done
- ! Fix coverage before marking work complete

---

## `stub:detected`

**When**: Scan of completed code reveals: `TODO`/`FIXME`/`HACK`/`XXX` comments, `return null`/`return {}`/`pass`/`unimplemented!()` placeholders, or functions under ~8 lines returning only hardcoded/empty values.

**Response**:
- ! Block completion
- ⊗ Mark the task done
- ! Implement fully, or explicitly defer with documented rationale in the task's vBRIEF narrative
- See [verification/verification.md](../verification/verification.md) for full stub detection criteria

---

## `session:interrupted`

**When**: Agent context is exhausted, the user asks to pause, or `/deft:checkpoint` is invoked.

**Response**:
- ! Write `./vbrief/continue.vbrief.json` with current task state and exact next action
- ⊗ Continue implementation after context exhaustion
- ⊗ Leave the session without a checkpoint when mid-task
- See [resilience/continue-here.md](../resilience/continue-here.md) for checkpoint format

---

## `session:resumed`

**When**: User invokes `/deft:continue`.

**Response**:
- ! Read `./vbrief/continue.vbrief.json` to restore context
- ! Resume from the recorded next action — do not replay prior history or re-read completed work
- See [resilience/continue-here.md](../resilience/continue-here.md)

---

## `legacy:detected`

**When**: Review of any file reveals legacy indicators: comments containing `LEGACY`, `COMPAT`, `OLD_`, `TODO: remove`; commented-out code blocks (>1 line); always-on or always-off feature flag branches; or parallel implementations without a documented migration path.

**Response**:
- ~ File a hygiene task in the active `./vbrief/plan.vbrief.json` if one exists, otherwise note in `meta/improvements.md`
- ⊗ Ignore and continue — legacy accumulation is a defect, not background noise
- See [coding/hygiene.md](../coding/hygiene.md) for the full legacy removal protocol

---

## `plan:approved`

**When**: The user explicitly approves a `/deft:change` proposal.

**Response**:
- ! Set `tasks.vbrief.json` plan `status` to `"approved"`
- ! Begin `/deft:change:apply`
- ⊗ Begin implementation without explicit approval
- ⊗ Treat silence as approval

---

## `change:verified`

**When**: All tasks in `tasks.vbrief.json` reach `status: completed`.

**Response**:
- ! Run `/deft:change:verify` before archiving
- ⊗ Archive directly without verification
- ! Record the verification tier reached per task in `tasks.vbrief.json` metadata
- See [verification/verification.md](../verification/verification.md) for the verification ladder

---

## `toolchain:missing`

**When**: A required tool (task runner, compiler, test framework, platform SDK) is not found at the pre-implementation gate.

**Response**:
- ! Stop immediately — do not begin implementation
- ! Report exactly which tools are missing with install guidance
- ⊗ Proceed with implementation while bypassing quality gates
- ⊗ Partially implement using available tools while skipping coverage or lint
- See [coding/toolchain.md](../coding/toolchain.md)
