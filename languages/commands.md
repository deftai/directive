# Standard Task Commands

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

All language standards files use the task commands below. Language-specific files list only deviations or additions.

## Default Commands

```bash
task build              # Build
task test               # Run all tests (unit, integration)
task test:coverage      # Run tests with coverage report
task fmt                # Format
task lint               # Lint / static analysis
task quality            # All quality checks
task check              # Pre-commit (! run: fmt+lint+build+test)
```

## Naming Conventions

- ! Single-language projects use generic names: `build`, `fmt`, `lint`, `test`
- ! Multi-language projects use namespaced names: `go:fmt`, `py:lint`, `rs:build`
- See [taskfile.md](../tools/taskfile.md#naming-conventions) for full details
