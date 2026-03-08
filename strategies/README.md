# Strategies

Development strategies define the workflow from idea to implementation.

## Available Strategies

| Strategy | Use Case | Phases |
|----------|----------|--------|
| [default.md](./default.md) | Standard projects | Interview → PRD → SPECIFICATION |
| [speckit.md](./speckit.md) | Large/complex projects | Principles → Specify → Plan → Tasks → Implement |
| [brownfield.md](./brownfield.md) | Existing codebases | Map → Plan → Implement |
| [research.md](./research.md) | Pre-implementation research | Research → Don't Hand-Roll + Common Pitfalls |
| rapid.md | Quick prototypes | SPECIFICATION only (future) |
| enterprise.md | Compliance-heavy | PRD → ADR → SPECIFICATION (future) |

## Selecting a Strategy

By default, Deft uses `strategies/default.md`. To use a different strategy:

```
Use the rapid strategy for this project.
```

Or specify in `project.md`:

```markdown
## Strategy
Use [strategies/rapid.md](../strategies/rapid.md) for this project.
```

## Creating Custom Strategies

A strategy file defines:

1. **When to use** — project types, team sizes, constraints
2. **Workflow phases** — ordered steps with transition criteria
3. **Artifacts** — what documents are produced
4. **Agent behavior** — how AI should conduct each phase
