# Reference Guide - When to Load Which Files

**Lazy Loading Principle**: Only read files that are relevant to your current task. Don't load entire framework upfront.

## 🎯 Always Start Here

**[main.md](./main.md)** - Entry point
- Load: Always (defines agent behavior and general guidelines)
- ~100 lines, quick read

**`~/.config/deft/USER.md`** - User preferences
- Load: Always (highest precedence, overrides everything)
- Check for custom rules and preferences
- Override path via `DEFT_USER_PATH` env var

**[core/glossary.md](./core/glossary.md)** - Term definitions
- Load: When encountering unfamiliar terms (release, feature, demo sentence, context rot, etc.)
- Contains: work decomposition hierarchy, GSD → Deft term mapping

## 📋 Task-Based Loading

### When Writing Code

1. **[coding/coding.md](./coding/coding.md)** - General coding guidelines
   - Load: For any software development task
   - Contains: modularity, contracts, error handling, change management

2. **Language file** - Load based on language:
   - [languages/python.md](./languages/python.md) - When writing Python
   - [languages/go.md](./languages/go.md) - When writing Go
   - [languages/typescript.md](./languages/typescript.md) - When writing TypeScript/JavaScript
   - [languages/cpp.md](./languages/cpp.md) - When writing C++

3. **[PROJECT.md](./PROJECT.md)** - Project-specific rules
   - Load: When unsure about project standards
   - Contains: project tech stack, coverage requirements, telemetry config

### When Building Interfaces

Load based on interface type:

- **[interfaces/cli.md](./interfaces/cli.md)** - Building command-line tools
- **[interfaces/rest.md](./interfaces/rest.md)** - Designing/implementing REST APIs
- **[interfaces/tui.md](./interfaces/tui.md)** - Building terminal UIs (Textual, ink)
- **[interfaces/web.md](./interfaces/web.md)** - Building web UIs (React, etc.)

### When Working with Deployment Platforms

Load when working on platform-specific deployment guidance:

- **[deployments/README.md](./deployments/README.md)** - Overview and structure
- **[deployments/<platform>/README.md]** - Platform module (e.g., cloud.gov)

### When Working with Tools

Load as needed:

- **[scm/git.md](./scm/git.md)** - Before committing (commit conventions)
- **[scm/github.md](./scm/github.md)** - When setting up CI/CD, PRs, issues
- **[tools/taskfile.md](./tools/taskfile.md)** - When creating/modifying tasks
- **[coding/testing.md](./coding/testing.md)** - When writing tests or checking coverage
- **[tools/telemetry.md](./tools/telemetry.md)** - When implementing logging, tracing, metrics

### When Working in a Swarm

**[swarm/swarm.md](./swarm/swarm.md)** - Multi-agent coordination
- Load: Only when multiple agents working on same codebase
- Contains: communication protocols, conflict resolution, handoff patterns

### When Managing Context or Long Tasks

- **[context/context.md](./context/context.md)** - Core context engineering strategies (Write, Select, Compress, Isolate)
- **[context/working-memory.md](./context/working-memory.md)** - Scratchpad and externalization patterns with vBRIEF
- **[context/long-horizon.md](./context/long-horizon.md)** - Multi-session checkpoint/resume patterns
- **[context/tool-design.md](./context/tool-design.md)** - Designing AI-consumable tools
- **[context/deterministic-split.md](./context/deterministic-split.md)** - LLM vs deterministic responsibility boundaries
- **[context/fractal-summaries.md](./context/fractal-summaries.md)** - Hierarchical memory compression (task → feature → release)
- **[context/examples.md](./context/examples.md)** - Few-shot and behavioral example guidance
- Load: When tasks are complex, multi-phase, or when context budget is a concern

### When Verifying Agent Work

- **[verification/verification.md](./verification/verification.md)** - Verification ladder, acceptance criteria, stub detection
- **[verification/uat.md](./verification/uat.md)** - Auto-generated user acceptance test scripts
- **[verification/plan-checking.md](./verification/plan-checking.md)** - Pre-execution plan verification (coverage, completeness, wiring, scope)
- **[verification/integration.md](./verification/integration.md)** - Cross-feature wiring verification (export→import, API→consumer, E2E flow)
- Load: When completing tasks/features, before marking work done

### When Handling Session Interruptions

- **[resilience/continue-here.md](./resilience/continue-here.md)** - Interruption recovery protocol with vBRIEF
- **[resilience/context-pruning.md](./resilience/context-pruning.md)** - Fresh context per task, eliminating context rot
- Load: On session end, context exhaustion, or when resuming interrupted work

### When Planning Multi-Feature Work

- **[contracts/boundary-maps.md](./contracts/boundary-maps.md)** - Explicit produces/consumes declarations between features
- **[strategies/discuss.md](./strategies/discuss.md)** - Structured alignment phase with Feynman technique
- **[strategies/map.md](./strategies/map.md)** - Codebase mapping for existing projects (stack, architecture, conventions, concerns)
- **[strategies/research.md](./strategies/research.md)** - Structured research: Don't Hand-Roll + Common Pitfalls output
- **[core/glossary.md](./core/glossary.md)** - Term definitions (release, feature, task, demo sentence, etc.)
- Load: When planning features with multiple phases or gray areas

### When Working with Changes

- **[commands.md](./commands.md)** - Change lifecycle workflows (create, apply, verify, archive)
- **[history/README.md](./history/README.md)** - Change folder structure and conventions
- **[context/spec-deltas.md](./context/spec-deltas.md)** - Spec delta format, vBRIEF chain pattern, reading/writing deltas
- Load: When using `/deft:change` commands

### When Creating Specifications

**[templates/make-spec.md](./templates/make-spec.md)** - Specification generation
- Load: When user asks to create a project specification
- Contains: interview process, output format

**[vbrief/vbrief.md](./vbrief/vbrief.md)** - Canonical vBRIEF usage
- Load: Whenever creating, reading, or managing vBRIEF files in a project
- Contains: 5-type taxonomy, naming conventions, lifecycle rules, specification flow, tool mappings
- Key rule: all vBRIEF files live in `./vbrief/` — never workspace root

**[vbrief/schemas/vbrief-core.schema.json](./vbrief/schemas/vbrief-core.schema.json)** — vBRIEF JSON Schema
- Load: When creating, validating, or debugging `.vbrief.json` files
- Contains: JSON Schema (draft 2020-12) defining `vBRIEFInfo`, `Plan`, `PlanItem`, `Status` enum
- Source: [github.com/deftai/vBRIEF](https://github.com/deftai/vBRIEF)

## 🔄 Reference Chains

Follow these chains only as needed:

### Coding → Language → Interface
```
coding.md → (pick language) → python.md → (pick interface) → rest.md
```

### Coding → Tools
```
coding.md → testing.md (when writing tests)
coding.md → telemetry.md (when adding logging)
coding.md → git.md (before committing)
```

### Project Overrides
```
(any file) → PROJECT.md (check for overrides)
~/.config/deft/USER.md (check for personal preferences)
```

## ⚠️ Don't Load Unless Needed

**[core/ralph.md](./core/ralph.md)** - Ralph loop concept
- Status: Draft, not implemented
- Load: Only if exploring self-correction loops

**[meta/code-field.md](./meta/code-field.md)** - Coding philosophy
- Load: For mindset/philosophy, not technical rules
- Complements technical standards, doesn't replace them

**[meta/ideas.md](./meta/ideas.md)** - Future directions
- Load: When agent wants to add new ideas
- AI can update without permission

**[meta/lessons.md](./meta/lessons.md)** - Codified learnings
- Load: When agent discovers repeated pattern/correction
- AI can update without permission

**[meta/suggestions.md](./meta/suggestions.md)** - Improvement suggestions
- Load: When agent has suggestions for project improvements
- AI can update without permission

## 🎯 Common Scenarios

### Scenario: "Write a Python REST API"
Load order:
1. main.md (always)
2. ~/.config/deft/USER.md (always)
3. coding/coding.md (writing code)
4. languages/python.md (Python-specific)
5. interfaces/rest.md (REST API design)
6. PROJECT.md (check for overrides)

### Scenario: "Add tests to existing Go code"
Load order:
1. main.md (always)
2. ~/.config/deft/USER.md (always)
3. coding/testing.md (testing standards)
4. languages/go.md (Go-specific testing)
5. PROJECT.md (coverage requirements)

### Scenario: "Fix a bug"
Load order:
1. main.md (always)
2. ~/.config/deft/USER.md (always)
3. (language file if fixing code)
4. scm/git.md (before committing fix)

### Scenario: "Multi-agent coordination"
Load order:
1. main.md (always)
2. ~/.config/deft/USER.md (always)
3. swarm/swarm.md (swarm patterns)
4. coding/coding.md (coding standards)
5. scm/git.md (commit conventions with task IDs)

### Scenario: Long multi-phase task
Load order:
1. main.md (always)
2. ~/.config/deft/USER.md (always)
3. context/context.md (context engineering strategies)
4. context/long-horizon.md (checkpoint/resume patterns)
5. context/working-memory.md (scratchpad patterns)
6. `./vbrief/plan.vbrief.json` (if resuming — read checkpoint, don't replay history)

## 💡 Tips for Agents

**Minimize Context Window Usage:**
- Don't load all files speculatively
- Load files only when their content is needed
- Use this guide to determine what to load

**Check Precedence:**
- Always check `~/.config/deft/USER.md` first (highest precedence)
- Check `./PROJECT.md` for project-specific overrides
- Follow most specific → most general

**Update Meta Files Freely:**
- meta/ideas.md, meta/lessons.md, meta/suggestions.md can be updated without permission
- These are for continuous improvement

**When In Doubt:**
- Start with main.md and coding/coding.md
- Add language/interface files as task becomes clear
- Check project.md if behavior seems inconsistent
