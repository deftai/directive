# Strategies

Development strategies define the workflow from idea to implementation.

## Available Strategies

| Strategy | Command | Type | Use Case | Phases |
|----------|---------|------|----------|--------|
| [interview.md](./interview.md) | `/deft:run:interview` | spec-generating | Standard projects (default) | Sizing gate: Light (Interview → SPECIFICATION) or Full (Interview → PRD → SPECIFICATION) |
| [yolo.md](./yolo.md) | `/deft:run:yolo` | spec-generating | Quick prototyping | Auto-pilot sizing gate: Light or Full (Johnbot picks) |
| [speckit.md](./speckit.md) | `/deft:run:speckit` | spec-generating | Large/complex projects | Principles → Specify → Plan → Tasks → Implement |
| [map.md](./map.md) | `/deft:run:map` | preparatory | Existing codebases | Map → Chaining Gate |
| [discuss.md](./discuss.md) | `/deft:run:discuss` | preparatory | Alignment before planning | Feynman technique → locked decisions → Chaining Gate |
| [research.md](./research.md) | `/deft:run:research` | preparatory | Pre-implementation research | Research → Don't Hand-Roll + Common Pitfalls → Chaining Gate |
| [roadmap.md](./roadmap.md) | `/deft:run:roadmap` | preparatory | Roadmap maintenance | Discover → Triage → Cleanup |
| [bdd.md](./bdd.md) | `/deft:run:bdd` | preparatory | Acceptance-test-first development | Scenarios → Failing Tests → Lock Decisions → Spec → Chaining Gate |
| [rapid.md](./rapid.md) | `/deft:run:rapid` | spec-generating | Quick prototypes | Forced-Light path |
| [enterprise.md](./enterprise.md) | `/deft:run:enterprise` | spec-generating | Compliance-heavy | Forced-Full path |

## Strategy Types

Every strategy has a **Type** that determines its behavior in the
[chaining gate](./interview.md#chaining-gate):

- **`preparatory`** — Produces artifacts that inform spec generation (research docs,
  context files, mapping docs). On completion, returns to the chaining gate so the user
  can run additional strategies or proceed to spec generation. Can be run multiple times.
- **`spec-generating`** — Produces a SPECIFICATION.md (or equivalent). Selecting one at
  the chaining gate switches the pipeline to that strategy’s spec flow.

Custom strategies MUST declare their type in this table. If the `Type` column is missing,
the chaining gate cannot include the strategy.

## Selecting a Strategy

Use a slash command:

```
/deft:run:interview my-project
```

Or specify in `project.md`:

```markdown
## Strategy
Use [strategies/interview.md](../strategies/interview.md) for this project.
```

**Naming rule:** `/deft:run:<x>` always maps to `strategies/<x>.md`. Custom strategies follow the same pattern.

## Creating Custom Strategies

A strategy file defines:

1. **When to use** — project types, team sizes, constraints
2. **Workflow phases** — ordered steps with transition criteria
3. **Artifacts** — what documents are produced
4. **Agent behavior** — how AI should conduct each phase

Name your file `strategies/<name>.md` and invoke it with `/deft:run:<name>`.
