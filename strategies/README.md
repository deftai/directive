# Strategies

Development strategies define the workflow from idea to implementation.

## Available Strategies

| Strategy | Command | Use Case | Phases |
|----------|---------|----------|--------|
| [interview.md](./interview.md) | `/deft:run:interview` | Standard projects (default) | Sizing gate: Light (Interview → SPECIFICATION) or Full (Interview → PRD → SPECIFICATION) |
| [yolo.md](./yolo.md) | `/deft:run:yolo` | Quick prototyping | Auto-pilot sizing gate: Light or Full (Johnbot picks) |
| [speckit.md](./speckit.md) | `/deft:run:speckit` | Large/complex projects | Principles → Specify → Plan → Tasks → Implement |
| [map.md](./map.md) | `/deft:run:map` | Existing codebases | Map → Plan → Implement |
| [discuss.md](./discuss.md) | `/deft:run:discuss` | Alignment before planning | Feynman technique → locked decisions |
| [research.md](./research.md) | `/deft:run:research` | Pre-implementation research | Research → Don't Hand-Roll + Common Pitfalls |
| rapid.md | `/deft:run:rapid` | Quick prototypes | Forced-Light path (future) |
| enterprise.md | `/deft:run:enterprise` | Compliance-heavy | Forced-Full path (future) |

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
