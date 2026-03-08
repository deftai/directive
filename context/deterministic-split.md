# LLM / Deterministic Split

If you could write an if-else for it, the LLM shouldn't do it.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [context/tool-design.md](./tool-design.md) | [context/context.md](./context.md) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) LLM/deterministic split principle.

---

## Core Principle

Every token the model spends on mechanical operations is a token wasted and a failure mode introduced. Reserve the LLM for **judgment work**. Everything else is deterministic code, tool calls, or automation.

---

## What Must Be Deterministic

These operations should be handled by tools, scripts, or task automation — not LLM reasoning:

- ! **Git operations** — branching, checkpoints, commits, squash merges, rollback
- ! **State transitions** — next task, complete task, advance phase
- ! **File parsing/formatting** — reading/writing structured artifacts, frontmatter
- ! **Directory scaffolding** — creating folders and files with correct structure
- ! **State derivation** — reconstructing current position from files on disk
- ! **Context assembly** — loading summaries, budgeting tokens, dropping old context
- ! **Static verification** — file existence, export checks, import wiring, stub detection

## What the LLM Handles

These require judgment and should use the model's reasoning:

- ~ **Scope decomposition** — breaking work into features/tasks (architectural judgment)
- ~ **Acceptance criteria authoring** — understanding what observable outcomes matter
- ~ **Gray area discussion** — interpreting user intent (see [strategies/discuss.md](../strategies/discuss.md))
- ~ **Codebase scouting** — judging relevance during research
- ~ **Failure diagnosis** — abductive reasoning when verification fails
- ~ **Summary writing** — compressing what happened and why it matters
- ~ **Writing code** — the actual creative implementation work

## Decision Test

For any operation the agent is about to perform:

- ? **Could an if-else handle it correctly every time?** → Make it deterministic
- ? **Does it require weighing tradeoffs or interpreting ambiguity?** → LLM does it
- ? **Is it formatting, parsing, or file management?** → Deterministic
- ? **Is it deciding *what* to build or *how* to approach a problem?** → LLM does it

## Practical Application in Deft

- ~ Use `task` targets for repeatable operations (see [tools/taskfile.md](../tools/taskfile.md))
- ~ Use vBRIEF for state management — don't ask the LLM to reconstruct state from memory
- ~ Use tool calls for git, file creation, and scaffolding — don't have the LLM construct bash commands for these
- ~ Use static analysis tools (`rg`, `ast-grep`) for verification — don't have the LLM manually read files to check wiring

---

## Anti-Patterns

- ⊗ LLM constructing git commands from scratch each time
- ⊗ LLM parsing markdown to figure out which task is next
- ⊗ LLM formatting frontmatter or structured files by hand
- ⊗ LLM re-reading project structure to determine current state
- ⊗ LLM performing file-existence checks by reading directories
