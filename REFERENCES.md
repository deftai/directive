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

**[core/glossary.md](./content/glossary.md)** - Authoritative vocabulary
- Load: When any term is undefined or used ambiguously; before introducing a new term
- Contains: work decomposition hierarchy, hygiene terms, framework design terms, GSD → Deft mapping

## 📋 Task-Based Loading

### When Writing Code

1. **[coding/coding.md](./content/coding/coding.md)** - General coding guidelines
   - Load: For any software development task
   - Contains: modularity, contracts, error handling, change management

2. **Language file** - Load based on language:
   - [languages/python.md](./content/languages/python.md) - When writing Python
   - [languages/go.md](./content/languages/go.md) - When writing Go
   - [languages/typescript.md](./content/languages/typescript.md) - When writing TypeScript/JavaScript
   - [languages/officejs.md](./content/languages/officejs.md) - When writing Office.js add-ins (Excel JavaScript API)
   - [languages/cpp.md](./content/languages/cpp.md) - When writing C++
   - [languages/vba.md](./content/languages/vba.md) - When writing VBA (Excel macros)

3. **[vbrief/PROJECT-DEFINITION.vbrief.json](./content/vbrief/vbrief.md#project-definitionvbriefjson)** - Project identity gestalt
   - Load: When unsure about project standards (tech stack, architecture, risks)
   - Contains: project identity narratives (overview, tech stack, architecture, risks/unknowns, config) + scope registry across all lifecycle folders
   - Replaces: the former `PROJECT.md` (deprecated)

### When Building Interfaces

Load based on interface type:

- **[interfaces/cli.md](./content/interfaces/cli.md)** - Building command-line tools
- **[interfaces/rest.md](./content/interfaces/rest.md)** - Designing/implementing REST APIs
- **[interfaces/tui.md](./content/interfaces/tui.md)** - Building terminal UIs (Textual, ink)
- **[interfaces/web.md](./content/interfaces/web.md)** - Building web UIs (React, etc.)

### When Working with Deployment Platforms

Load when working on platform-specific deployment guidance:

- **[deployments/README.md](./content/deployments/README.md)** - Overview and structure
- **[deployments/<platform>/README.md]** - Platform module (e.g., cloud.gov)

### When Working with Tools

Load as needed:

- **[scm/git.md](./content/scm/git.md)** - Before committing (commit conventions)
- **[scm/github.md](./content/scm/github.md)** - When setting up CI/CD, PRs, issues
- **[tools/taskfile.md](./content/tools/taskfile.md)** - When creating/modifying tasks
- **[coding/testing.md](./content/coding/testing.md)** - When writing tests or checking coverage
- **[coding/security.md](./content/coding/security.md)** - When handling untrusted input, auth, secrets, dependencies, or building agent surfaces (#661)
- **[tools/telemetry.md](./content/tools/telemetry.md)** - When implementing logging, tracing, metrics

### When Working in a Swarm

**[swarm/swarm.md](./content/swarm/swarm.md)** - Multi-agent coordination
- Load: Only when multiple agents working on same codebase
- Contains: communication protocols, conflict resolution, handoff patterns

### When Building LLM Applications

**[patterns/llm-app.md](./content/patterns/llm-app.md)** - LLM application standards (#481)
- Load: When the project calls any LLM API (OpenAI, Anthropic, Cohere, local models, etc.), builds agentic functionality, or implements RAG
- Contains: prompt construction (delimiters, parameterized templates), explicit trust tiers (system > few-shot > user > retrieved > web), tool/function-call validation (confused-deputy mitigation), RAG hygiene (no LLM-write-back, provenance), output handling (schema validation, XSS sanitization), multi-agent orchestration (sub-agent-output-is-untrusted), LLM-specific observability
- Source material: AI Agent Traps paper (`docs/ssrn-6372438.pdf`)

**[patterns/role-as-overlay.md](./content/patterns/role-as-overlay.md)** - Role as overlay (#816)
- Load: When the project applies a persona / role / stance to an LLM call (skill-defined reviewer / builder / summarizer roles, agent-level identities, per-call stance overrides) or designs a multi-turn agent that persists message history across turns
- Contains: the role-as-system-overlay rule (never role-as-user-message), failure modes of role-injection-as-messages (history pollution, retrieval corruption, context-rot acceleration, false-memory propagation, resumption breakage), the call > session > agent precedence chain, the implementation contract for skills and sub-agent dispatch, and a provider-surface mapping (Anthropic `system`, OpenAI Chat `messages[0] role:system` / Responses `instructions`, Gemini `system_instruction`)
- Source material: Flue SDK ([withastro/flue](https://github.com/withastro/flue)) README

**[patterns/prompt-assembly-layer-ordering.md](./content/patterns/prompt-assembly-layer-ordering.md)** - Prompt assembly layer ordering (#836)
- Load: When the project assembles a system prompt from more than one fragment, relies on provider-side prompt caching (Anthropic / OpenAI / local), or operates an agent across more than one user turn per session
- Contains: the cached-prefix-vs-ephemeral-injection invariant, canonical content for each layer, most-stable-first ordering inside the cached prefix, observability fields for cache-tier telemetry, and the load-bearing link to frozen-memory-snapshot (#832)
- Extends: `patterns/llm-app.md` `## Prompt construction` + `## LLM-specific observability`

### When Managing Context or Long Tasks

- **[context/context.md](./content/context/context.md)** - Core context engineering strategies (Write, Select, Compress, Isolate)
- **[context/working-memory.md](./content/context/working-memory.md)** - Scratchpad and externalization patterns with vBRIEF; plan.vbrief.json + scope vBRIEF relationship
- **[context/long-horizon.md](./content/context/long-horizon.md)** - Multi-session checkpoint/resume patterns; lifecycle folder conventions
- **[context/tool-design.md](./content/context/tool-design.md)** - Designing AI-consumable tools
- **[context/deterministic-split.md](./content/context/deterministic-split.md)** - LLM vs deterministic responsibility boundaries
- **[context/fractal-summaries.md](./content/context/fractal-summaries.md)** - Hierarchical memory compression (task → feature → release)
- **[context/examples.md](./content/context/examples.md)** - Few-shot and behavioral example guidance
- Load: When tasks are complex, multi-phase, or when context budget is a concern

### When Verifying Agent Work

- **[verification/verification.md](./content/verification/verification.md)** - Verification ladder, acceptance criteria, stub detection
- **[verification/uat.md](./content/verification/uat.md)** - Auto-generated user acceptance test scripts
- **[verification/plan-checking.md](./content/verification/plan-checking.md)** - Pre-execution plan verification (coverage, completeness, wiring, scope)
- **[verification/integration.md](./content/verification/integration.md)** - Cross-feature wiring verification (export→import, API→consumer, E2E flow)
- Load: When completing tasks/features, before marking work done

### When Handling Session Interruptions

- **[resilience/continue-here.md](./content/resilience/continue-here.md)** - Interruption recovery protocol with vBRIEF; continue.vbrief.json + scope vBRIEF relationship
- **[resilience/context-pruning.md](./content/resilience/context-pruning.md)** - Fresh context per task, eliminating context rot
- Load: On session end, context exhaustion, or when resuming interrupted work

### When Planning Multi-Feature Work

- **[contracts/boundary-maps.md](./content/contracts/boundary-maps.md)** - Explicit produces/consumes declarations between features
- **[strategies/discuss.md](./content/strategies/discuss.md)** - Structured alignment phase with Feynman technique
- **[strategies/map.md](./content/strategies/map.md)** - Codebase mapping for existing projects (stack, architecture, conventions, concerns)
- **[strategies/research.md](./content/strategies/research.md)** - Structured research: Don't Hand-Roll + Common Pitfalls output
- **[core/glossary.md](./content/glossary.md)** - Authoritative vocabulary (release, feature, task, demo sentence, context rot, etc.)
- Load: When planning features with multiple phases or gray areas

### When Working with Changes

- **[commands.md](./content/commands.md)** - Change lifecycle workflows (create, apply, verify, archive)
- **[history/README.md](./history/README.md)** - Change folder structure and conventions
- **[context/spec-deltas.md](./content/context/spec-deltas.md)** - Spec delta format, vBRIEF chain pattern, reading/writing deltas
- Load: When using `/deft:change` commands

### When Creating Specifications

**[templates/make-spec.md](./content/templates/make-spec.md)** - Specification generation
- Load: When user asks to create a project specification
- Contains: interview process, scope vBRIEF output format

**[vbrief/vbrief.md](./content/vbrief/vbrief.md)** - Canonical vBRIEF usage
- Load: Whenever creating, reading, or managing vBRIEF files in a project
- Contains: file taxonomy (root-level files + scope vBRIEFs in lifecycle folders), naming conventions, lifecycle rules, specification flow, tool mappings
- Key rules: all vBRIEF files live in `./vbrief/` or lifecycle subfolders — never workspace root; scope vBRIEFs use `YYYY-MM-DD-descriptive-slug.vbrief.json` naming; `plan.status` inside each scope vBRIEF is the source of truth — not the folder location

**[vbrief/schemas/vbrief-core.schema.json](./content/vbrief/schemas/vbrief-core.schema.json)** — vBRIEF JSON Schema
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
(any file) → vbrief/PROJECT-DEFINITION.vbrief.json (check for project identity + overrides)
~/.config/deft/USER.md (check for personal preferences)
```

## ⚠️ Don't Load Unless Needed

**[core/ralph.md](./content/meta/ralph.md)** - Ralph loop concept
- Status: Draft, not implemented
- Load: Only if exploring self-correction loops

**[meta/code-field.md](./content/meta/code-field.md)** - Coding philosophy
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
6. vbrief/PROJECT-DEFINITION.vbrief.json (check for project overrides)

### Scenario: "Add tests to existing Go code"
Load order:
1. main.md (always)
2. ~/.config/deft/USER.md (always)
3. coding/testing.md (testing standards)
4. languages/go.md (Go-specific testing)
5. vbrief/PROJECT-DEFINITION.vbrief.json (coverage requirements)

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
4. context/long-horizon.md (checkpoint/resume patterns; lifecycle folder conventions)
5. context/working-memory.md (scratchpad patterns; plan.vbrief.json + scope vBRIEF relationship)
6. `./vbrief/plan.vbrief.json` (if resuming — read checkpoint, don't replay history)
7. Scope vBRIEFs in `./vbrief/active/` (the durable scope records being implemented)

## 💡 Tips for Agents

**Minimize Context Window Usage:**
- Don't load all files speculatively
- Load files only when their content is needed
- Use this guide to determine what to load

**Check Precedence:**
- Always check `~/.config/deft/USER.md` first (highest precedence)
- Check `./vbrief/PROJECT-DEFINITION.vbrief.json` for project identity and overrides
- Follow most specific → most general

**Update Meta Files Freely:**
- meta/ideas.md, meta/lessons.md, meta/suggestions.md can be updated without permission
- These are for continuous improvement

**When In Doubt:**
- Start with main.md and coding/coding.md
- Add language/interface files as task becomes clear
- Check `vbrief/PROJECT-DEFINITION.vbrief.json` if behavior seems inconsistent
