# ARCHITECTURE.md — Deft Directive System Design

## Components

### 1. Markdown Framework (`/` root) — Primary Product
The core product is a tree of `.md` files consumed by AI agents at runtime.
Organized by domain:

| Directory | Purpose |
|-----------|---------|
| `main.md` | Root entrypoint — agent behavior, rule precedence, slash commands |
| `coding/` | Software development guidelines (coding.md, testing.md) |
| `languages/` | Per-language standards (go.md, python.md, etc.) — 20+ languages |
| `strategies/` | Workflow strategies (interview.md, yolo.md, speckit.md, map.md, etc.) |
| `templates/` | Reusable templates (make-spec.md, specification.md) |
| `skills/` | AgentSkills-spec SKILL.md files (deft-setup, deft-build) |
| `context/` | Context management strategies |
| `core/` | Glossary, versioning, project/user legacy paths |
| `meta/` | SOUL.md, morals.md, code-field.md — optional behavioral rules |
| `vbrief/` | vBRIEF taxonomy and lifecycle docs |

**New code goes in the most specific matching directory. New language support → `languages/`. New strategy → `strategies/`. New meta rule → `meta/`.**

---

### 2. Python CLI (`run`) — Setup & Spec Generation
Extension-less Python 3.11+ script. Entry point for terminal users.

**Commands:**
- `run bootstrap` → creates `USER.md` (user preferences)
- `run project` → creates `PROJECT.md` (project config)
- `run spec` → interview → `vbrief/specification.vbrief.json` → `SPECIFICATION.md`
- `run install <dir>` → installs deft into a project directory
- `run validate` / `run doctor` / `run reset` / `run update`

**Progressive enhancement tier:**
```
textual (TUI wizard) > prompt_toolkit > rich > stdlib fallback
```

**Internal pattern:**
- All commands are `cmd_<name>(args)` functions
- Helpers: `ask_input()`, `ask_choice()`, `ask_confirm()`
- Atomic writes via `_atomic_write()` (temp + rename)
- Resume support via `.{filename}.progress` JSON sidecar files
- Env vars (`DEFT_USER_PATH`, `DEFT_PROJECT_PATH`, etc.) override default paths

**Test shim:** `run.py` (importlib shim at repo root) loads `run` for `tests/`.

---

### 3. Go Installer (`cmd/deft-install/`) — Standalone Binary
Distributed as a pre-compiled binary for end-user install (no Python needed).

**Files:**
- `main.go` — entry point, flag parsing, Windows `/flag` normalization
- `wizard.go` — interactive wizard (`Wizard`, `WizardResult`, `Run()`)
- `setup.go` — `CloneDeft`, `WriteAgentsMD`, `WriteAgentsSkills`, `CreateUserConfigDir`
- `git.go` — `EnsureGit` check
- `drives_windows.go` / `drives_other.go` — platform-specific drive detection

**Install flow:**
```
Wizard.Run() → CloneDeft/UpdateDeft → WriteAgentsMD → WriteAgentsSkills → CreateUserConfigDir → PrintNextSteps
```

**Output written to user's project:**
- `{project}/deft/` — cloned framework
- `{project}/AGENTS.md` — deft entry block (idempotent)
- `{project}/.agents/skills/deft/SKILL.md` — thin pointer to `deft/SKILL.md`
- `{project}/.agents/skills/deft-setup/SKILL.md` — thin pointer to `deft/skills/deft-setup/SKILL.md`
- `{project}/.agents/skills/deft-build/SKILL.md` — thin pointer to `deft/skills/deft-build/SKILL.md`
- `~/.config/deft/` (or `%APPDATA%\deft\`) — user config directory

---

### 4. Test Suite (`tests/`)
Two categories:

**CLI tests** (`tests/cli/`): Test `cmd_*` functions from `run` directly.
- Use `run_command` fixture + `mock_user_input` fixture from `conftest.py`
- Env-isolated via `DEFT_USER_PATH` / `DEFT_PROJECT_PATH` monkeypatching

**Content tests** (`tests/content/`): Validate the `.md` framework files.
- `test_structure.py` — directory/file presence
- `test_shape.py` — markdown shape/structure rules
- `test_standards.py` — RFC2119 legend presence, naming conventions
- `test_contracts.py` — cross-file link validity
- `test_skills.py` — SKILL.md spec compliance
- `test_strategy_chaining.py` — strategy chaining gate rules
- `test_vbrief_schema.py` — vBRIEF JSON schema validation
- Snapshot baseline: `tests/content/snapshots/baseline.json`

---

## Data Flow

```
End user
  └─ deft-install binary
       └─ clones repo → writes AGENTS.md + .agents/skills/

AI agent (via AGENTS.md / SKILL.md)
  └─ reads main.md → USER.md → PROJECT.md → task-specific files
       └─ strategies/interview.md → spec interview
            └─ vbrief/specification.vbrief.json (draft)
                 └─ task spec:render → SPECIFICATION.md

Terminal user
  └─ run bootstrap → USER.md
  └─ run project   → PROJECT.md
  └─ run spec      → vbrief/specification.vbrief.json → SPECIFICATION.md
```

## Entry Points

| Entry | File | Audience |
|-------|------|---------|
| AI agent | `AGENTS.md` / `SKILL.md` | LLM agents |
| Terminal setup | `run` | Developer CLI |
| Binary install | `cmd/deft-install/main.go` | End users |
| Task runner | `Taskfile.yml` | Developers |
