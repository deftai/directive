# STACK.md — Deft Directive Technology Inventory

## Languages & Runtimes

| Language | Version | Role |
|----------|---------|------|
| Python | ≥3.11 | CLI (`run`), test suite (`tests/`) |
| Go | 1.22 | Standalone installer binary (`cmd/deft-install/`) |
| Shell / Bash | n/a | Framework content (`run` shebang, script examples in .md files) |
| Markdown | n/a | Primary product — all framework content |

## Key Dependencies

### Python (`pyproject.toml`)
- **Runtime** (all optional — `run` degrades gracefully):
  - `rich` — enhanced terminal output, panels, prompts
  - `prompt_toolkit` — inline editing, history (best UX tier)
  - `textual` — full TUI wizard mode (highest tier)
- **Dev**:
  - `pytest ≥7.4` + `pytest-cov ≥4.1` + `pytest-mock ≥3.12`
  - `ruff ≥0.1` — lint
  - `black ≥23` — format
  - `mypy ≥1.7` — type check

### Go (`go.mod`)
- Module: `github.com/deftai/directive`
- **No external dependencies** — stdlib only

### vBRIEF (`https://github.com/deftai/vBRIEF`)
- JSON schema for structured task plans and specifications
- Stored in `vbrief/` directory at project root
- Files: `plan.vbrief.json`, `specification.vbrief.json`, `continue.vbrief.json`

## Build & Tooling

| Tool | Purpose |
|------|---------|
| `task` (Taskfile.yml) | Universal task runner — `task check`, `task test`, `task build` |
| `uv` | Python package/runtime manager (replaces pip/venv for task invocations) |
| `go build` | Compiles `cmd/deft-install/` to standalone binary |

## Environment Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEFT_USER_PATH` | `~/.config/deft/USER.md` (Unix) / `%APPDATA%\deft\USER.md` (Windows) | User preferences |
| `DEFT_PROJECT_PATH` | `./PROJECT.md` | Project config override |
| `DEFT_PRD_PATH` | `./PRD.md` | PRD output path override |
| `DEFT_SPECIFICATION_PATH` | `./SPECIFICATION.md` | Spec output path override |

## Version

- Framework: `0.5.2` (Taskfile.yml `VERSION`)
- Python package: `0.5.0` (pyproject.toml)
- `run` CLI: `0.4.2` (VERSION constant in `run`)
- Go installer: set via ldflags at build time, default `"1.0.0"`
