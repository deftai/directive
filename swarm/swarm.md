# Swarm Coordination Guidelines

Multi-agent coordination patterns for parallel software development.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Scope:** Guidelines for multiple AI agents working on the same codebase concurrently.

**⚠️ See also**: [coding.md](../coding/coding.md) | [taskfile.md](../tools/taskfile.md) | [git.md](../scm/git.md)

## Communication Protocols

**Explicit Context:**
- ! Never assume previous agent "knew" something implicit
- ! Spell out all assumptions and context
- ! Reference relevant files, functions, and decisions explicitly
- ⊗ Assume shared state or memory between agents

**Documentation:**
- ! Document decisions in commit messages
- ! Reference task/plan IDs in all commits
- ~ Update shared documentation (README, docs/) with architectural decisions
- ! Leave breadcrumbs for subsequent agents (comments, TODO markers)

## Task Structure

**Scoping:**
- ! Explicit file scope in task description: `scope: [src/auth.py, tests/test_auth.py]`
- ! Clear task boundaries (what's in, what's out)
- ! List dependencies on other tasks explicitly
- ! State acceptance criteria clearly

**Task IDs:**
- ! Every task has unique ID (e.g., `T-001`, `PLAN-1.2.3`)
- ! Reference task ID in commit messages: `feat(auth): implement JWT validation [T-001]`
- ! Reference task ID in code comments for temporary/WIP items

## Output Formatting

**Code Changes:**
- ! Use structured diff format for existing files
- ! Provide complete file content when creating new files
- ! Include file path, line numbers, and context in diffs
- ~ Use unified diff format when possible

**Change Description:**
- ! Summarize what changed and why
- ! List affected files explicitly
- ! Note any breaking changes or migration requirements
- ! Include testing performed

## Change Impact Analysis

**Before Changing Shared Code:**
- ! Identify all affected downstream modules/files
- ! List functions/classes that depend on changes
- ! Check for usage across codebase (use grep/ast-grep)
- ! Document impact in commit message

**Coordination:**
- ~ Check for concurrent changes to same files (git status, git log)
- ! Prefer additive changes over breaking renames
- ~ Communicate large refactors before starting
- ! Use feature flags for incremental rollout

## Handoff Patterns

**Structured Input:**
```python
class AgentTaskInput(BaseModel):
    model_config = ConfigDict(frozen=True)  # ! Immutable for shared state
    
    task_id: str
    agent_id: str  # ! For traceability
    description: str
    files_scope: list[str]
    dependencies: list[str]  # Other task IDs
    context: dict[str, Any]
```

**Structured Output:**
```python
class AgentTaskOutput(BaseModel):
    model_config = ConfigDict(frozen=True)  # ! Immutable for shared state
    
    task_id: str
    agent_id: str  # ! For traceability
    status: Literal['done', 'blocked', 'skip']  # vBRIEF status vocabulary
    changes: list[FileChange]
    tests_passed: bool
    notes: str  # For next agent — persist to vBRIEF task narrative
    blocking_issues: list[str]
```

**Status Values (aligned with vBRIEF):**
- `done` - Task completed fully
- `blocked` - Cannot proceed, needs resolution; record reason in task narrative
- `skip` - Intentionally not done; record reason in task narrative

**Note:** `partial` maps to `doing` in vBRIEF (task started but not done). `failed` should be `blocked` with a narrative explaining the failure.

## Model Best Practices

**Validation:**
- ! Validate all output models before writing to files
- ! Use `model.model_dump(mode='json')` for serialization
- ! Use `model.model_copy(deep=True)` for copying (not manual dict copying)

**Immutability:**
- ! Use `frozen=True` for all shared state passed between agents
- ! Prevents accidental mutation and race conditions
- ! Create new instances for modifications

**Traceability:**
- ! Add `task_id` field to every important model
- ! Add `agent_id` field to every important model
- ! Include timestamps for state changes
- ~ Add `created_at`, `updated_at` for audit trail

**Example:**
```python
from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime

class SharedState(BaseModel):
    model_config = ConfigDict(frozen=True)
    
    task_id: str
    agent_id: str
    status: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    
# Serialize to file
state_json = state.model_dump(mode='json')
with open('swarm/state.json', 'w') as f:
    json.dump(state_json, f, indent=2)

# Create modified copy
new_state = state.model_copy(deep=True, update={'status': 'completed'})
```

## Conflict Resolution

**File Conflicts:**
- ! Check git status before starting work
- ! Pull latest changes before committing
- ! If conflict detected, document and request manual resolution
- ⊗ Silently overwrite or force-push

**Logical Conflicts:**
- ! If two agents modify related code differently, flag for human review
- ~ Use integration tests to detect logical conflicts
- ! Document conflicting approaches in issue/PR

**Deadlock Prevention:**
- ! Declare file locks at task start (in shared doc/state)
- ~ Work on disjoint file sets when possible
- ! Maximum task duration before check-in/handoff
- ~ Prefer small, frequent commits over large batches

## Coordination Artifacts

**Shared State (`./vbrief/plan.vbrief.json`):**
- ! Use `./vbrief/plan.vbrief.json` for active task tracking — NOT a custom `swarm/state.json`
- ! Update task status on start (`doing`) and complete (`done` / `blocked`)
- ! Record `agent_id` and `files_locked` in the task narrative
- ! Record blockers as `blocked` status with narrative explaining the issue
- ⊗ Create a separate `swarm/state.json` or `swarm/progress.md` — vBRIEF is the shared state

**Architecture Decisions:**
- ! Document in `docs/decisions/ADR-NNN.md` (Architecture Decision Records)
- ! Reference ADRs in relevant code
- ~ Update when decisions change

## Testing in Swarm Context

**Test Ownership:**
- ! Agent modifying code updates/adds tests
- ! Run relevant test suite before marking task complete
- ! Document test coverage for changed code

**Integration Testing:**
- ~ Run full integration suite periodically
- ! Report integration test failures to all agents
- ! Don't merge if integration tests fail

**Test Isolation:**
- ! Tests are independently runnable
- ! No shared mutable state between tests
- ! Use fixtures/factories for test data

## Git Workflow

**Branches:**
- ! One branch per agent/task (e.g., `agent-1/T-001-auth-jwt`)
- ! Merge to main/develop only after review
- ~ Use feature flags for incomplete features

**Commits:**
- ! Atomic commits (one logical change)
- ! Reference task ID: `feat(auth): add JWT [T-001]`
- ! Follow Conventional Commits (see [git.md](../scm/git.md))
- ⊗ Force-push to shared branches

**Merging:**
- ! Rebase on latest main before merge request
- ! Squash commits if multiple for same task
- ~ Request human review for cross-cutting changes

## Anti-Patterns

- ⊗ Assuming previous agent's context
- ⊗ Modifying files without declaring scope
- ⊗ Committing without task ID reference
- ⊗ Ignoring impact on downstream modules
- ⊗ Silent conflicts (overwriting without coordination)
- ⊗ Large batch changes without intermediate commits
- ⊗ Changing shared interfaces without versioning
- ⊗ Tests that depend on execution order

## Example Task Workflow

**1. Receive Task:**
```
Task ID: T-042
Description: Implement user authentication with JWT
Scope: [src/auth.py, tests/test_auth.py]
Dependencies: [T-038 (database models)]
```

**2. Declare Intent (update `./vbrief/plan.vbrief.json`):**
```json
{
  "id": "T-042",
  "do": "Implement user authentication with JWT",
  "status": "doing",
  "narrative": "agent-3 | files: src/auth.py, tests/test_auth.py | started: 2026-01-16T04:20:00Z"
}
```

**3. Check Dependencies:**
```bash
# Verify T-038 is complete
git log --grep="T-038" --oneline
```

**4. Implement:**
```bash
# Create branch
git checkout -b agent-3/T-042-auth-jwt

# Make changes, commit frequently
git commit -m "feat(auth): add JWT token generation [T-042]"
git commit -m "test(auth): add JWT validation tests [T-042]"
```

**5. Verify:**
```bash
task test:coverage
task lint
task check
```

**6. Report (update `./vbrief/plan.vbrief.json`):**
```json
{
  "id": "T-042",
  "status": "done",
  "narrative": "JWT auth complete. tests_passed: true. Ready for T-043 (role-based permissions)."
}
```

## References

- [coding.md](../coding/coding.md) - General coding standards
- [git.md](../scm/git.md) - Commit conventions, branch strategy
- [taskfile.md](../tools/taskfile.md) - Build and test automation
- [testing.md](../coding/testing.md) - Testing requirements
