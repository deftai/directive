# Cross-Platform Agent-Driven Skills — Implementation Plan

**Date**: 2026-03-11
**Context**: todo.md item #1 — Land agent-driven skills (deft-setup + deft-build)
**Design**: `history/plan-2026-03-11-cross-platform-agent-skills.md`

---

## Phase 1 — Skills (No Dependencies)

Land the skill files from PR #18 with cross-platform additions.

### 1.1 Create `skills/deft-setup/SKILL.md`

- Port from PR #18 with these modifications:
  - Add platform detection section: agent must check OS and resolve USER.md path
    - Unix: `~/.config/deft/USER.md`
    - Windows: `%APPDATA%\deft\USER.md`
    - Override: `$DEFT_USER_PATH` if set
  - Update `$DEFT_PROJECT_PATH` references similarly
  - Remove any symlink/`.agents/skills/` references

### 1.2 Create `skills/deft-build/SKILL.md`

- Port from PR #18 with these modifications:
  - Add USER.md gate: if USER.md not found at platform-appropriate path,
    redirect to `deft-setup` Phase 1 before continuing
  - Add same platform detection section as deft-setup
  - Keep `task check` / `task test:coverage` references (Taskfile is a hard dep)

### 1.3 Tests for skills

- Verify SKILL.md files exist at expected paths
- Verify required sections present (platform detection, USER.md gate in deft-build)
- Verify RFC2119 legend present
- Add `skills/` to test suite awareness if needed

---

## Phase 2 — Installer (Depends on Phase 1)

Cross-platform Python installer with thin OS wrappers.

### 2.1 Create `install.py`

Responsibilities in order:
1. Detect OS via `platform.system()`
2. Validate Python version (≥3.13)
3. Validate `git` on PATH
4. Validate `task` on PATH:
   - If missing: inform user Taskfile is required, show install command
   - If user grants permission: run OS-appropriate install
     - macOS: `brew install go-task` (fall back to official installer if no brew)
     - Windows: detect available package manager in order:
       1. `choco install go-task` (if choco on PATH)
       2. `scoop install task` (if scoop on PATH)
       3. Fall back to Taskfile official installer (download binary from taskfile.dev)
     - Linux: `sh -c "$(curl ...)"` from taskfile.dev
   - If user declines: stop installation — do not proceed
5. Validate deft directory structure (skills/, core/, etc.)
6. Create/update AGENTS.md with deft entry point and skill references:
   ```
   See deft/main.md
   Skills: deft/skills/deft-setup/SKILL.md, deft/skills/deft-build/SKILL.md
   ```
7. Create USER.md config directory (platform-aware default or `$DEFT_USER_PATH`)
8. Print next steps

### 2.2 Create `install.bat`

- Mirror `run.bat` pattern (~10 lines)
- Check Python installed and ≥3.13
- If missing: open Microsoft Store link
- If present: `python.exe install.py %*`

### 2.3 Create `install` (Unix wrapper)

- `#!/usr/bin/env sh` (~10 lines)
- Check `python3` available
- Delegate to `python3 install.py "$@"`

### 2.4 Tests for installer

- Unit test `install.py` functions (OS detection, path resolution, prereq checks)
- Mock `shutil.which` for task/git detection
- Test AGENTS.md generation (create new, append to existing)
- Test config directory creation per platform
- Test decline-to-install-task stops cleanly

---

## Phase 3 — Taskfile Cross-Platform Fixes (Depends on Phase 1)

Fix bash-only tasks so `task check` works on Windows.

### 3.1 Fix `install` task

- Current: uses `ln -sf`, `if [ -w /usr/local/bin ]`, `sudo`
- Fix: add `platforms:` guard or replace with cross-platform logic
- This task may be superseded by `install.py` — evaluate whether to keep

### 3.2 Fix `build` task

- Current: uses `mkdir -p`, `tar -czf`
- Fix: use `platforms:` guard with PowerShell equivalents, or Python script

### 3.3 Fix `stats` task

- Current: uses `find`, `wc -l`, `tr -d`
- Fix: replace with Python one-liner or `platforms:` guard

### 3.4 Fix `uninstall` task

- Current: uses `if [ -L ... ]`, `rm`
- Fix: align with new install.py approach or remove

### 3.5 Verify cross-platform tasks

- `validate`, `test`, `test:coverage`, `fmt`, `lint`, `check` — these use
  `uv run` and should already work. Verify on Windows.

---

## Phase 4 — Documentation Updates (Depends on Phases 1–3)

### 4.1 Update README.md

- Replace `curl | sh` install instructions with cross-platform:
  - Windows: `git clone ... && deft\install`
  - Unix: `git clone ... && deft/install`
- Update "Getting Started" section
- Add note about Taskfile as a required dependency

### 4.2 Update todo.md

- Mark item #1 complete
- Move USER.md gate to completed (addressed in skill files)

---

## Phase 5 — spec:* Cross-Platform Fixes (Depends on Phase 3)

`spec:validate` and `spec:render` were intentionally left out of Phase 3 because they
are more complex and not required for `task check` (the agent quality gate). They still
contain POSIX shell syntax and will fail on Windows. Fix them here.

### 5.1 Extract `spec:validate` logic into `scripts/spec_validate.py`

- Current: inline `sh` block using `if [ ! -f "$SPEC_FILE" ]`, `$()` substitution, `$STATUS`
- Fix: create `scripts/spec_validate.py` that:
  - Accepts spec file path as CLI arg
  - Checks file exists (exit 1 with message if not)
  - Reads first line and checks for `status: approved`
  - Prints pass/fail message and exits with appropriate code
- Update `spec:validate` task to: `uv run python scripts/spec_validate.py {{.SPEC_FILE}}`

### 5.2 Extract `spec:render` logic into `scripts/spec_render.py`

- Current: inline `sh` block with heredoc `<<'EOF'`, `$STATUS` check, multi-step pipeline
- Fix: create `scripts/spec_render.py` that:
  - Accepts spec file path as CLI arg
  - Validates the spec file (reuse or call spec_validate logic)
  - Renders the spec to the output format
  - Uses Python stdlib only (no new deps)
- Update `spec:render` task to: `uv run python scripts/spec_render.py {{.SPEC_FILE}}`

### 5.3 Tests for spec scripts

- Unit test `scripts/spec_validate.py` (file missing, approved, not approved)
- Unit test `scripts/spec_render.py` (valid spec renders, invalid spec exits cleanly)
- Add to `tests/cli/` alongside existing installer tests

---

## Dependency Order

```
Phase 1 (skills) ──┬── Phase 2 (installer)
                   ├── Phase 3 (taskfile fixes)
                   └── Phase 4 (docs) — after 2 + 3

Phase 3 (taskfile) ── Phase 5 (spec:* fixes)
```

Phases 2 and 3 can proceed in parallel after Phase 1.
Phase 4 follows completion of Phases 2 and 3.
Phase 5 follows Phase 3 and can proceed in parallel with Phase 4.

---

## Workflow Rules

- **No auto-commit.** Stop and wait for explicit commit instruction.
- **No auto-push.** Commit locally, then STOP. Push only on explicit instruction.

*Created 2026-03-11 — Cross-platform agent-driven skills (beta branch)*
