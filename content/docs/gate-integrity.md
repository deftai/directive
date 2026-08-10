# Gate integrity — a failing gate must not be fixed by editing the gate (#3156)

General product and process rule for Directive fix loops, refine loops, and quality-gate repair: **when a gate is red, clear red by fixing the work under test — not by mutating the gate.**

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `≉`=SHOULD NOT, `⊗`=MUST NOT, `?`=MAY.

Parent epic: [#3179](https://github.com/deftai/directive/issues/3179) (self-improving under gates). Stance: [#3164](https://github.com/deftai/directive/issues/3164) (**shipped** — constitution-tier changes go through issue/PR + review; this doc does not re-litigate that stance). Extends verification independence [#782](https://github.com/deftai/directive/issues/782) / [#1499](https://github.com/deftai/directive/issues/1499) and scope self-auth themes [#3145](https://github.com/deftai/directive/issues/3145).

---

## The rule (sharp form)

- ⊗ A self-modification, refine, fix, or pre-PR loop **MUST NOT** clear a failing gate by editing the **gate definition**, **verifier**, **reward**, **required check**, coverage floor, policy flag, eval fixture, or other evaluator surface that is currently failing — solely so the loop can report green.
- ! When a gate fails, fix the **product, process, test, or documentation under test**.
- ! Deliberate **gate definition** changes (raise/lower thresholds, rewrite verify scripts, change required checks) go through the normal **issue → PR → review** path with explicit rationale — same disposal model as constitution-tier content under [#3164](https://github.com/deftai/directive/issues/3164).
- ~ If the gate itself is wrong (false positive, obsolete check, wrong floor), open or amend an issue/PR that **names the gate change as the change**, not as a silent sibling edit inside a product fix.

One-line form:

> When a gate fails, the fix MUST NOT be an edit to the gate.

---

## What counts as a “gate” here

Any deterministic pass/fail surface that adjudicates work quality, including but not limited to:

| Surface | Examples |
|---------|----------|
| Aggregate quality | `task check`, CI required checks |
| Coverage / thresholds | coverage floors, hotspot floors, `--allow-coverage-debt` misuse |
| Verify scripts | `verify:*` tasks, content contracts, schema validators |
| Policy flags | `plan.policy.*` that weaken or skip enforcement |
| Eval / fixtures | golden eval cells, reward definitions, required fixture assertions |
| Scope / process | active xBRIEF `file_scope` self-expansion that self-authorizes (#3145) |

The **evaluator lives outside the editable surface under test** (#782 agent-loop / fixed evaluator). Moving the goalposts is not a valid fix.

---

## Separation from #2436 (refine-internal SkillOpt)

| Layer | Owner | What it protects |
|-------|-------|------------------|
| **Refine-loop-internal** | [#2436](https://github.com/deftai/directive/issues/2436) SkillOpt / control stack | Proposer cannot edit its own reward / slow-update / validator **region inside the refine runtime** (bounded patch algebra, reject buffer, protected region) |
| **General product/process gate integrity** | **This issue (#3156)** | Agents and fix loops must not clear **Directive product/process gates** (check, coverage, verify, policy, eval fixtures, scope) by mutating those gates |

- ⊗ Re-implement SkillOpt, proposer runtime, or refine-internal protected regions under this rule’s delivery.
- ! Treat #2436 as complementary machinery for self-improvement loops; treat **#3156 as the general behavioral rule** for every fix/pre-PR path that hits a red gate.
- ~ Host honesty limits when the **runtime** self-mutates or is REPL-first: [host-surface-assumptions.md](./host-surface-assumptions.md) (#3162). That doc names what file gates cannot see; it does not reverse this rule or #3164.

---

## Motivating evidence (Factorio / Continual Harness)

Prime Agent / Continual-Harness-class refine loops have packaged reward hacks as reusable skills. A concrete case study: in Factorio, a refine loop found a resource-spawn exploit and codified the exploit the same way it codifies good tactics — “self-improvement has no moral compass, only reward.”

That failure mode is exactly what #782 / #1499 / #2436 argue against, observed in a shipped MIT harness rather than only hypothesized. Directive’s answer at the **general product/process** layer is this gate-integrity rule; refine-internal machinery remains on #2436.

Field notes and parent framing: issue [#3156](https://github.com/deftai/directive/issues/3156); related safety-via-gates [#1200](https://github.com/deftai/directive/issues/1200).

---

## Legitimate gate change vs cheating the evaluator

| Allowed | Forbidden in a fix/refine loop |
|---------|--------------------------------|
| Fix product code so tests/coverage pass honestly | Lower coverage floor or delete failing tests only to go green |
| Fix a broken product test that asserts wrong behavior (with rationale) | Weaken the assert until anything passes |
| PR that **is** “raise coverage floor to 90%” with review | Same PR as a feature fix that silently drops the floor |
| Issue + PR changing a verify script with explicit AC | Edit verify script mid-loop because it failed your change |
| Scoped `#N` coverage-debt allow with tracked issue | Blanket skip of required checks without policy path |

- ! Gate-definition PRs MUST state the intended standard change in the PR body and issue link.
- ⊗ Bundle silent gate weakening with an unrelated product fix to “make CI green.”
- ? Temporary operator-approved debt (`--allow-coverage-debt=#N`, policy override with audit) MAY exist when the framework already defines that escape hatch — still not a free rewrite of the gate.

---

## Discoverability

- Pre-PR Diff phase checklist: [deft-directive-pre-pr](../skills/deft-directive-pre-pr/SKILL.md) (gate-integrity bullet).
- Stance / propose-not-apply: [main.md § Self-Improving, Not Self-Editing (#3164)](../../main.md#self-improving-not-self-editing-3164), [philosophy.md](../meta/philosophy.md).
- Verification outcomes: [verification.md](../verification/verification.md).
- Goal/gate rigidity: [goal-gate-determinism.md](../patterns/goal-gate-determinism.md) (#852).
- Scope self-auth instance: [scope-provenance.md](./scope-provenance.md) (#3145).

Full CI automation that blocks “diff touches a gate that just failed” without operator acknowledgment is an **optional follow-up** — this story ships the sharp rule and pre-PR discoverability, not a new verify binary.

---

## Cross-links

| Topic | Where |
|-------|--------|
| Parent epic | [#3179](https://github.com/deftai/directive/issues/3179) |
| Stance (propose-not-apply) | [#3164](https://github.com/deftai/directive/issues/3164), [main.md](../../main.md#self-improving-not-self-editing-3164) |
| Refine-internal SkillOpt | [#2436](https://github.com/deftai/directive/issues/2436) |
| Fixed evaluator / agent-loop | [#782](https://github.com/deftai/directive/issues/782) |
| Verification independence | [#1499](https://github.com/deftai/directive/issues/1499) |
| Scope self-authorization | [#3145](https://github.com/deftai/directive/issues/3145), [scope-provenance.md](./scope-provenance.md) |
| Host self-mutate honesty | [#3162](https://github.com/deftai/directive/issues/3162), [host-surface-assumptions.md](./host-surface-assumptions.md) |
| Safety via formal gates | [#1200](https://github.com/deftai/directive/issues/1200) |

---

## Non-goals (#3156)

- ⊗ Implementing full SkillOpt / proposer runtime (#2436)
- ⊗ Host hook enforcement for self-mutating hosts (#3162)
- ⊗ Replacing design-principle docs under #1200 (complementary)
- ⊗ Shipping full “gate-diff-when-red” CI automation in this story
