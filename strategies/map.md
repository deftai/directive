# Map Strategy

Structured analysis of an existing codebase before adding features.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/interview.md](./interview.md) | [strategies/discuss.md](./discuss.md) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) map-codebase workflow.

---

## When to Use

- ! When adding features to an existing codebase the agent hasn't seen before
- ~ When onboarding to a project with unknown conventions
- ? Skip if the codebase is small (<10 files) or the agent already has context

## Workflow

```
Map Codebase → Discuss → Plan → Execute
```

Mapping produces artifacts that feed into planning so the agent **follows existing conventions** instead of inventing new ones.

---

## Mapping Artifacts

Produce these in `.planning/codebase/` (or `docs/codebase/`):

### STACK.md — Technology inventory

- ! Languages, versions, runtimes
- ! Frameworks and key dependencies
- ! Build tools and package managers
- ~ Environment configuration approach

### ARCHITECTURE.md — System design

- ! Layers/components and their responsibilities
- ! Data flow between components
- ! Entry points (API routes, CLI, server start)
- ~ Error handling strategy

### CONVENTIONS.md — How code is written here

- ! Naming conventions (files, functions, variables)
- ! Import patterns and module organization
- ! Testing patterns (framework, file naming, assertion style)
- ! **Be prescriptive**: "Use camelCase for functions" not "some functions use camelCase"

### CONCERNS.md — Technical debt and risks

- ~ TODO/FIXME/HACK inventory with file paths
- ~ Large files (>500 lines) that may need splitting
- ~ Stubs and placeholder implementations
- ~ Missing test coverage areas

---

## Mapping Rules

- ! Include **file paths** with backticks — vague descriptions are not actionable
- ! Write **current state only** — never what was or what you considered
- ! Be **prescriptive** — "Use X pattern" guides future work; "X pattern is used" doesn't
- ! Answer **"where do I put new code?"** — not just what exists
- ⊗ Read `.env` contents or expose secrets — note existence only
- ~ Keep each artifact under 200 lines — detail over brevity, but focused

## How Artifacts Feed Downstream

- ! **Planning** loads relevant mapping docs based on feature type
- ! **Execution** references CONVENTIONS.md to match existing patterns
- ! **Verification** uses CONCERNS.md to avoid introducing more debt

---

## Then: Specification

After mapping is complete, the project still needs a SPECIFICATION.md.
Chain into the [interview strategy](./interview.md) sizing gate to generate one.

- ! On completion, ask: "Codebase mapped. Ready to start the specification interview?"
- ! If yes, follow [interview.md](./interview.md) starting at the **Sizing Gate**
- ! The mapping artifacts MUST inform the interview and specification:
  - CONVENTIONS.md → implementation constraints
  - ARCHITECTURE.md → where new code fits
  - CONCERNS.md → things to avoid or fix
- ⊗ End the session after mapping without offering specification generation

---

## Invoking This Strategy

```
/deft:run:map
```

Or set in PROJECT.md:
```markdown
**Strategy**: [strategies/map.md](./deft/strategies/map.md)
```

Or explicitly:
```
Map this codebase, then use the interview strategy to plan [feature].
```
