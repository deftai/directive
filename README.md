# Warping Process

**A layered framework for AI-assisted development with consistent standards and workflows.**

Copyright © 2025-2026 Jonathan Taylor (visionik@pobox.com). See [LICENSE.md](./LICENSE.md) for usage terms.

## 🎯 What is Warping?

Warping is a structured approach to working with AI coding assistants (particularly Warp AI) that provides:

- **Consistent coding standards** across languages and projects
- **Reproducible workflows** via task-based automation
- **Self-improving guidelines** that evolve with your team
- **Hierarchical rule precedence** from general to project-specific
- **Lazy loading** - only read files relevant to current task (see [REFERENCES.md](./REFERENCES.md))

## 📝 Notation Legend

Warping uses compact notation for requirements:

- **!** = MUST (required, mandatory)
- **~** = SHOULD (recommended, strong preference)
- **≉** = SHOULD NOT (discouraged, avoid unless justified)
- **⊗** = MUST NOT (forbidden, never do this)

This notation appears in technical standard files (python.md, go.md, etc.) for scanability. Based on RFC 2119.

## 📚 The Layers

Warping uses a layered architecture where more specific rules override general ones:

```
USER.md          ← Highest precedence (~/.config/deft/USER.md)
  ↓
project.md       ← Project-specific rules and workflows
  ↓
python.md        ← Language-specific standards
go.md
  ↓
taskfile.md      ← Tool-specific guidelines
  ↓
main.md          ← General AI guidelines and agent behavior
  ↓
specification.md ← Lowest precedence (project requirements)
```

### 📁 Directory Structure

```
warping-0.2.0/
├── README.md              # This file
├── main.md                # Entry point - general AI guidelines
│
├── core/                  # Core framework files
│   ├── project.md         # Project template
│   ├── (user.md)          # Legacy location; now at ~/.config/deft/USER.md
│   └── ralph.md           # Ralph loop concept (draft)
│
├── coding/                # Coding standards
│   ├── coding.md          # General coding guidelines
│   └── testing.md         # Testing standards
│
├── languages/             # Language-specific standards
│   ├── cpp.md
│   ├── go.md
│   ├── python.md
│   └── typescript.md
│
├── interfaces/            # Interface types
│   ├── cli.md             # Command-line interfaces
│   ├── rest.md            # REST APIs
│   ├── tui.md             # Terminal UIs
│   └── web.md             # Web UIs
│
├── verification/          # Agent work verification
│   ├── verification.md    # 4-tier verification ladder, must-haves, stubs
│   └── uat.md             # User acceptance test generation
│
├── resilience/            # Session continuity & recovery
│   ├── continue-here.md   # Interruption recovery protocol
│   └── context-pruning.md # Fresh context per task
│
├── contracts/             # Interface contracts
│   └── boundary-maps.md   # Produces/consumes between slices
│
├── deployments/           # Platform-specific deployment guidance
│   └── cloud-gov/          # cloud.gov module (optional)
│
├── tools/                 # Tooling and workflow
│   ├── git.md             # Git conventions
│   ├── github.md          # GitHub workflows
│   ├── taskfile.md        # Task automation
│   └── telemetry.md       # Observability
│
├── swarm/                 # Multi-agent coordination
│   └── swarm.md           # Swarm guidelines
│
├── templates/             # Templates and examples
│   ├── make-spec.md       # Spec generation guide
│   ├── make-spec-example.md
│   └── specification.md   # Project spec template
│
└── meta/                  # Meta/process files
    ├── code-field.md      # Coding mindset
    ├── ideas.md           # Future directions
    ├── lessons.md         # Learnings
    └── suggestions.md     # Improvements
```

### 🔧 Core Files

**main.md** - Entry point, general AI guidelines
**coding/coding.md** - Software development standards
**coding/testing.md** - Testing standards
**core/project.md** - Project-specific template
**~/.config/deft/USER.md** - Your personal preferences (highest precedence)

### 🐍 Languages

**languages/python.md** - Python standards (≥85% coverage, mypy strict, ruff/black)
**languages/go.md** - Go standards (≥85% coverage, Testify)
**languages/typescript.md** - TypeScript standards (strict mode, Vitest)
**languages/cpp.md** - C++ standards (C++20/23, Catch2/GoogleTest)

### 💻 Interfaces

**interfaces/cli.md** - Command-line interface patterns
**interfaces/rest.md** - REST API design
**interfaces/tui.md** - Terminal UI (Textual, ink)
**interfaces/web.md** - Web UI (React, Tailwind)

### 🛠️ Tools

**tools/taskfile.md** - Task automation best practices
**scm/git.md** - Commit conventions, safety
**scm/github.md** - GitHub workflows
**tools/telemetry.md** - Logging, tracing, metrics

### 🐝 Swarm

**swarm/swarm.md** - Multi-agent coordination patterns

### ✅ Verification

**verification/verification.md** - 4-tier verification ladder, must-haves, stub detection
**verification/uat.md** - Auto-generated user acceptance test scripts

### 🛡️ Resilience

**resilience/continue-here.md** - Interruption recovery protocol (vBRIEF-based)
**resilience/context-pruning.md** - Fresh context per task, eliminating context rot

### 📜 Contracts

**contracts/boundary-maps.md** - Explicit produces/consumes declarations between slices

### 📝 Templates

**templates/make-spec.md** - Specification generation
**templates/specification.md** - Project spec template

### 🧠 Meta

**meta/code-field.md** - Coding mindset and philosophy
**meta/lessons.md** - Codified learnings (AI-updatable)
**meta/ideas.md** - Future directions
**meta/suggestions.md** - Improvement suggestions

## 🚀 Getting Started

### 1. Set Up Your User Preferences

Run `deft/run bootstrap` to create USER.md at `~/.config/deft/USER.md`, or edit it directly:

```markdown
# User Preferences

## Name

Address the user as: **YourName**

## Custom Rules

- Your custom preferences here
```

### 2. Understand the Hierarchy

Rules cascade with precedence:

1. **USER.md** (highest) - your personal overrides (`~/.config/deft/USER.md`)
2. **project.md** - project-specific rules
3. **Language files** (python.md, go.md) - language standards
4. **Tool files** (taskfile.md) - tool guidelines
5. **main.md** - general AI behavior
6. **specification.md** (lowest) - requirements

### 3. Reference in Warp

Upload these files to **Warp Drive** so they're available to AI sessions:

1. Open Warp
2. Access Warp Drive (notebooks feature)
3. Upload relevant warping/\*.md files
4. Reference them in your Warp rules/agent instructions

### 4. Use in Projects

For each project:

1. Copy or link the warping directory
2. Create/update `project.md` with project-specific rules
3. Create/update `specification.md` or link to specs
4. Let the AI reference these during development

### 5. Evolve Over Time

The warping process improves continuously:

- AI updates `lessons.md` when learning better patterns
- AI notes ideas in `ideas.md` for future consideration
- AI suggests improvements in `suggestions.md`
- You update `~/.config/deft/USER.md` with new preferences
- You update language/tool files as standards evolve

## 💡 Key Principles

### Task-Centric Workflow with Taskfile

**Why Taskfile?**

Warping uses [Taskfile](https://taskfile.dev) as the universal task runner for several reasons:

1. **Makefiles are outdated**: Make syntax is arcane, portability is poor, and tabs vs spaces causes constant friction
2. **Polyglot simplicity**: When working across Python (make/invoke/poetry scripts), Go (make/mage), Node (npm scripts/gulp), etc., each ecosystem has different conventions. Taskfile provides one consistent interface
3. **Better than script sprawl**: A `/scripts` directory with dozens of bash files becomes chaotic—hard to discover, hard to document, hard to compose. Taskfile provides discoverability (`task --list`), documentation (`desc`), and composition (`deps`)
4. **Modern features**: Built-in file watching, incremental builds via checksums, proper error handling, variable templating, and cross-platform support

**Usage:**

```bash
task --list        # See available tasks
task check         # Pre-commit checks
task test:coverage # Run coverage
task dev           # Start dev environment
```

### Test-Driven Development (TDD)

Warping embraces TDD as the default development approach:

1. **Write the test first**: Define expected behavior before implementation
2. **Watch it fail**: Confirm the test fails for the right reason
3. **Implement**: Write minimal code to make the test pass
4. **Refactor**: Improve code quality while keeping tests green
5. **Repeat**: Build features incrementally with confidence

**Benefits:**

- Tests become specifications of behavior
- Better API design (you use the API before implementing it)
- High coverage naturally (≥85% is easy when tests come first)
- Refactoring confidence
- Living documentation

**In Practice:**

```bash
task test          # Run tests in watch mode during development
task test:coverage # Verify ≥75% coverage
task check         # Pre-commit: all quality checks including tests
```

### Quality First

- ≥85% test coverage (overall + per-module)
- Always run `task check` before commits
- Run linting, formatting, type checking
- Never claim checks passed without running them

### Spec-Driven Development (SDD)

Before writing any code, warping uses an AI-assisted specification process:

**The Process:**

1. **Start with make-spec.md**: A prompt template for creating specifications

   ```markdown
   I want to build **\_\_\_\_** that has the following features:

   1. Feature A
   2. Feature B
   3. Feature C
   ```

2. **AI Interview**: The AI (Claude or similar) asks focused, non-trivial questions to clarify:
   - Missing decisions and edge cases
   - Implementation details and architecture
   - UX considerations and constraints
   - Dependencies and tradeoffs

   Each question includes numbered options and an "other" choice for custom responses.

3. **Generate SPECIFICATION.md**: Once ambiguity is minimized, the AI produces a comprehensive spec with:
   - Clear phases, subphases, and tasks
   - Dependency mappings (what blocks what)
   - Parallel work opportunities
   - No code—just the complete plan

4. **Multi-Agent Development**: The spec enables multiple AI coding agents to work in parallel on independent tasks

**Why SDD?**

- **Clarity before coding**: Catch design issues early
- **Parallelization**: Clear dependencies enable concurrent work
- **Scope management**: Complete spec prevents scope creep
- **Onboarding**: New contributors/agents understand the full picture
- **AI-friendly**: Structured specs help AI agents stay aligned

**Example**: See `make-spec.md` template in Warp Drive for the interview process

### Convention Over Configuration

- Use Conventional Commits for all commits
- Use hyphens in filenames, not underscores
- Keep secrets in `secrets/` directory
- Keep docs in `docs/`, not project root

### Safety and Reversibility

- Never force-push without permission
- Assume production impact unless stated
- Prefer small, reversible changes
- Call out risks explicitly

## 📖 Example Workflows

### Starting a New Python Project

1. AI reads: `main.md` → `python.md` → `taskfile.md`
2. AI sets up: pytest, ruff, black, mypy, Taskfile
3. AI configures: ≥85% coverage, PEP standards
4. You customize: `project.md` with project specifics

### Working on an Existing Go Project

1. AI reads: `USER.md` → `PROJECT.md` → `go.md` → `main.md`
2. AI follows: go.dev/doc/comment, Testify patterns
3. AI runs: `task check` before suggesting changes
4. AI respects: your USER.md overrides

### Code Review Session

1. AI references quality standards from language file
2. AI runs `task quality` and `task test:coverage`
3. AI checks Conventional Commits compliance
4. AI suggests improvements → adds to `suggestions.md`

## 🔗 Integration with Warp AI

The warping process is designed for Warp AI's rule system:

1. **Upload to Warp Drive**: Keep main.md and relevant files in Warp Drive
2. **Create Warp Rules**: Reference warping files in your Warp rules
3. **Project-Specific Rules**: Add `AGENTS.md` or `WARP.md` in project root that references warping
4. **Automatic Context**: Warp AI loads rules automatically when working in your projects

## 📝 Contributing to Warping

As you use warping:

1. **lessons.md**: AI adds patterns discovered during development
2. **ideas.md**: AI notes potential improvements
3. **suggestions.md**: AI records project-specific suggestions
4. Review these periodically and promote good ideas to main guidelines

## 🎓 Philosophy

Warping embodies:

- **Correctness over convenience**: Optimize for long-term quality
- **Standards over flexibility**: Consistent patterns across projects
- **Evolution over perfection**: Continuously improve through learning
- **Clarity over cleverness**: Direct, explicit, maintainable code

---

**Next Steps**: Read [main.md](./main.md) for comprehensive AI guidelines, then run `deft/run bootstrap` to create your USER.md.
