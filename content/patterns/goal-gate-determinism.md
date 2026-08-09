# Goal-gate determinism (#852)

Skills and agent playbooks MUST be rigid on **goals**, **acceptance criteria**,
and **quality gates**. They SHOULD leave the **execution path** flexible.

Step-by-step execution scaffolding can help weaker models for a while. Those
gains often vanish on the next model generation. Goal-and-gate specs survive
model diversity because the contract is the outcome, not the route.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Load when:** writing or revising skills, scope xBRIEFs, acceptance criteria,
agent playbooks, evaluator loops, or any guidance that mixes "what done means"
with "how to get there."

**Source material:** Boris Cherny (Claude Code), Lenny's Podcast, May 2026 —
prefer tools + a goal over brittle scaffolding; scaffolding wins are often
wiped by the next model. Complements agent-loop (#782: fixed evaluator +
mutable execution) and typed-skill-boundary (#805: typed result at the
boundary; path is free).

**⚠️ See also**:
- [../coding/coding.md](../coding/coding.md) — `## Fail Loud` (#1006): outcome
  evidence before completion claims (output-side complement)
- [../verification/verification.md](../verification/verification.md) — goal-backward
  verification; acceptance criteria as truths / artifacts / key links
- [../skills/deft-directive-write-skill/SKILL.md](../skills/deft-directive-write-skill/SKILL.md)
  — skill authoring; demote path steps that are not gates
- Content-manifest durability fields (#1669 v2) — file-granularity encoding of
  durable goal/gate vs ephemeral scaffolding; this file remains the doctrine SoT

## The tension

Directive needs **consistent** behavior across companies, engineers, models of
different strength, and teams of different skill. That consistency is real.

Tight **execution-path** scaffolding fights capable models and ages poorly when
models improve. The resolution is not "no structure" — it is structure on the
**right** axis.

## What MUST be rigid (deterministic)

These are the durable contract. Express them as `!` / `⊗` (and machine checks
when possible):

| Element | Meaning |
|---------|---------|
| **Goal** | What a successful outcome looks like |
| **Acceptance criteria** | Observable, testable conditions the output must satisfy |
| **Quality gates** | Deterministic pass/fail (`task check`, tests, lint, schema verify) |
| **Exit / handoff** | When the skill is done and what the next owner receives |
| **Scope boundaries** | What the skill MUST NOT touch |
| **Stop conditions** | When the agent MUST pause and ask (destructive ops, missing credentials, approval boundaries) |
| **Preserve** | Existing behavior that MUST NOT regress regardless of the goal |

- ! MUST specify goal, acceptance criteria, quality gates, exit/handoff, and
  scope boundaries for skills that authorize implementation or ship work
- ! MUST make "done" require **evidence**, not intent, elapsed time, or
  unrelated green checks (fail-loud #1006)
- ! MUST treat quality gates as living artifacts: when a pass is **spurious**
  (gate green, product wrong), **ratchet** the gate (add invariants, narrow
  edit surface, tighten validation) — do not only re-run the same check
- ~ SHOULD list **stop conditions** and **preserve** constraints explicitly
  (GOALCRAFT-style fields; distinct from "how to implement")
- ~ SHOULD co-locate per-requirement verification with the claim when cheap
  (e.g. a shell fact that exits 0 when the claim holds — phase-level
  `task check` remains complementary, not a replacement)

## What SHOULD be flexible (guidance)

These help navigation. Prefer `~` / `?` over `!` unless the step **is** a gate:

- Execution steps and phase order when order is not a safety invariant
- Tool-call order and intermediate scratch organization
- Model-specific scaffolding that only weaker models need

- ~ SHOULD demote detailed execution steps from MUST to SHOULD when they are
  navigation, not gates
- ~ SHOULD ask, for each new step: "is this a **gate** or **guidance**?"
  Gates stay rigid; guidance stays soft
- ≉ SHOULD NOT prescribe a single tool-call sequence as the only correct path
  when several paths satisfy the same gates
- ⊗ MUST NOT replace acceptance criteria with a checklist of intermediate
  steps ("all steps done" ≠ verified outcomes — see verification.md)

## Why this architecture

| Pattern | Same principle |
|---------|----------------|
| Agent-loop (#782) | Fixed evaluator + mutable execution path |
| Typed skill boundary (#805) | Typed result schema is rigid; path to produce it is not |
| Fail-loud (#1006) | Gate says what evidence is required; fail-loud requires producing it |
| Content-manifest v2 (#1669) | Durable vs demotable content units (consumes this doctrine; does not replace it) |

Execution scaffolding in skills still has two roles today:

1. **Guardrails for weaker models** — temporary; fade as models improve
2. **Clarity about the goal** — should live in acceptance criteria, not as
   rigid step lists

A weaker model uses guidance as a scaffold. A stronger model skips unneeded
guidance and still satisfies the gates. Both are correct. The acceptance
criteria are the single source of truth.

## Dual grade (execution vs implementation)

Do not conflate:

- **Execution grade** — did the agent follow the gate instructions faithfully?
- **Implementation grade** — is the output actually good?

A run can pass execution grade and fail implementation grade. When that
happens, ratchet the gate (or the acceptance criteria) rather than only
reprimanding the path. Related: green-loop / executable enforcement surface
(#971), agent-loop (#782).

## Skill design checklist

When authoring or editing a skill:

1. ! State the goal and exit/handoff in one place agents can find
2. ! List acceptance criteria that an outsider can falsify
3. ! Name the quality gates (`task check`, tests, schema, review verdict)
4. ! Name scope `⊗` boundaries and stop conditions
5. ~ Mark path steps as `~` unless skipping them breaks a gate or safety rule
6. ~ Prefer machine-checkable claims co-located with requirements when cheap
7. ⊗ Do not treat step completion as success without outcome verification

## Non-goals

- ⊗ Rewriting every existing skill in one PR — land the doctrine; migrate
  high-traffic skills incrementally
- ⊗ Removing all execution guidance — soft guidance remains valuable
- ⊗ Replacing `task check` with only per-fact commands, or the reverse
- ⊗ Treating content-manifest encoding as a substitute for this pattern doc
  (#1669 consumes #852; ownership stays under content-doctrine #1874)

## Related issues

- #852 (this pattern — doctrine SoT)
- #782 agent-loop · #805 typed-skill-boundary · #603 write-skill quality
- #590 anti-over-scaffolding · #465 vBRIEF intake gate
- #1006 fail-loud · #973 machine-verifiable-spec · #971 executable enforcement
- #980 STANDARDS.md (engagement-wide preserve) · #1669 / #1874 content doctrine
