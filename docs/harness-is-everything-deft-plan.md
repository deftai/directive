# Harness Engineering — Deft Implementation Plan

> **Source**: Analysis of SWE-agent (Princeton NLP, 2024), Anthropic Claude Code harness engineering, and OpenAI Codex team learnings.
> **Principle**: The harness, not the model, determines long-horizon agent performance.

---

## Prerequisites

**All work in this plan begins after PR #403 (Phase 2: vBRIEF Architecture Cutover, v0.20.0) lands.**

PR #403 is a 90-file cutover that modifies most files this plan targets. Implementing against pre-#403 file content will produce conflicts. The key changes in #403 that affect this plan:

- `resilience/continue-here.md` — updated with scope vBRIEF lifecycle folders (`vbrief/{proposed,pending,active,completed,cancelled}/`)
- `skills/deft-build/SKILL.md` and `skills/deft-swarm/SKILL.md` — significantly rewritten
- `strategies/interview.md` — updated chaining gate
- `tasks/vbrief.yml` — new file (currently contains only `vbrief:validate`)
- New scope vBRIEF lifecycle model — features progress through filesystem folders, not just status fields

**Rule before starting any PR:** Re-read all target files from the post-#403 master baseline. Do not implement against snapshots taken before #403 lands.

---

## Context

This plan translates harness engineering lessons into concrete directive improvements. Deft already has the right core abstraction in vBRIEF — the work here is to make tasks, skills, and docs consistently treat vBRIEF as the single source of truth for session state.

---

## vBRIEF Alignment

vBRIEF already maps directly onto the harness concepts from the article. Post-#403, the mapping is richer:

| Article concept | vBRIEF equivalent |
|---|---|
| Anthropic `feature_list.json` (pass/fail per feature) | Scope vBRIEFs in `vbrief/{proposed,pending,active,completed,cancelled}/` — lifecycle folder IS the status |
| Anthropic `claude-progress.txt` (session progress log) | `vbrief/plan.vbrief.json` — active work plan with per-task status |
| Anthropic session recovery checkpoint | `vbrief/continue.vbrief.json` |
| Anthropic `init.sh` (deterministic environment startup) | `vbrief/playbook-dev-setup.vbrief.json` |

**Rule for all PRs below:** Read from and write to these vBRIEF files and lifecycle folders. Do not invent parallel progress or status formats.

---

## PR 1 — Rebase probe/GitHub skills PR

PR #440 (probe strategy + deft-gh-slice + deft-gh-triage) was opened before master advanced significantly and before #403 lands. Rebase `feat/probe-gh-skills` onto master **after #403 merges**, validating against #403's updated `strategies/interview.md` chaining gate and `skills/deft-setup/SKILL.md`.

**Files:** `strategies/probe.md`, `skills/deft-gh-slice/SKILL.md`, `skills/deft-gh-triage/SKILL.md`, `strategies/README.md`, `strategies/interview.md`, `skills/deft-setup/SKILL.md`

---

## PR 2 — Add `task prebrief` and `task debrief`

`tasks/vbrief.yml` exists post-#403 with a `vbrief:validate` task. Add the two session lifecycle tasks as top-level tasks (not namespaced) — they are the most-run agent tasks and short names reduce friction.

**`task prebrief`** — Start-of-session briefing sourced from vBRIEF lifecycle folders:
- Recent git log (`--oneline -10`) and git status
- Active scope vBRIEFs in `vbrief/active/` (agent-readable summary of what's in progress)
- Count of scope vBRIEFs by lifecycle folder (proposed / pending / active / completed / cancelled)
- Warning if `vbrief/continue.vbrief.json` exists — unfinished prior session, must resume before new work
- Any `blocked` items in `vbrief/plan.vbrief.json`

**`task debrief`** — End-of-session handoff enforcement:
- Run `task check`
- Show git dirty state
- Verify `plan.vbrief.json` task statuses reflect actual work done
- If work is incomplete, require `continue.vbrief.json` to be written before exiting

**Files:** `tasks/vbrief.yml`, `Taskfile.yml`

---

## PR 3 — Strengthen interruption and clean-handoff rules

`resilience/continue-here.md` post-#403 already covers scope vBRIEF lifecycle folder awareness. Build on that foundation — do not revert or replace it. Add a new **Pre-Interruption Obligation** section:

1. Before any session ends: `plan.vbrief.json` MUST reflect actual task state; active scope vBRIEFs MUST be in the correct lifecycle folder
2. If work is incomplete: `continue.vbrief.json` MUST record the precise resume point AND which scope vBRIEF(s) were being worked on
3. A session is not "done" until state is committed and vBRIEF reflects reality

Goal: eliminate archaeology at the next session boundary.

**Files:** `resilience/continue-here.md`, `vbrief/vbrief.md` (cross-link if needed)

---

## PR 4 — Feature verification via lifecycle folders

Add `task vbrief:features` to `tasks/vbrief.yml`. Post-#403, feature completeness is expressed by lifecycle folder position, not just item status fields. The task should:

- Count scope vBRIEFs in each lifecycle folder
- Print a completion summary: `N completed / M total (X active, Y pending, Z proposed)`
- Exit non-zero if any `active` scope vBRIEF has been in `active/` longer than a configurable threshold (signals stall)

Then update `vbrief/vbrief.md` to state explicitly: **an agent MUST NOT infer feature completeness from code.** A feature is complete when and only when its scope vBRIEF is in `vbrief/completed/`.

**Files:** `tasks/vbrief.yml`, `vbrief/vbrief.md`

---

## PR 5 — Context window discipline in coding standards

Add a `Context Window Discipline` section to `coding/coding.md` based on the SWE-agent findings:

- ⊗ `cat`-ing whole files when a targeted line-range read would do
- ⊗ Consuming search output > ~50 results — treat this as a signal to narrow the query, not more data to read
- ! Prefer targeted reads; read files in bounded chunks when they are large
- ~ When exploring, confirm relevance before expanding scope

**Files:** `coding/coding.md`

---

## PR 6 — `task search` and agent-facing task design

Add `task search` — a capped `rg` wrapper that refuses to produce unbounded output:

```yaml
search:
  desc: Capped codebase search — fails with guidance if > 50 results
  cmds:
    - |
      count=$(rg "{{.CLI_ARGS}}" --count-matches 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')
      if [ "$count" -gt 50 ]; then
        echo "⚠ $count matches — too broad. Narrow your query and retry."
        exit 1
      fi
      rg "{{.CLI_ARGS}}" -n
```

Add an **Agent-Facing Tasks** section to `tools/taskfile.md`. Tasks designed to be run *by* agents follow different design rules:
- Output must be parseable, not decorative
- Failures must include remediation instructions in the error output
- Names must be natural-language imperatives the agent would think to type
- Behavior must be deterministic

Canonical examples: `task prebrief`, `task debrief`, `task search`, `task swarm:new`.

**Files:** `tasks/core.yml` (for `search`), `tools/taskfile.md`

---

## PR 7 — SCM abstraction via `scm:` task namespace

Skills `deft-gh-slice`, `deft-gh-triage`, `deft-gh-arch`, and `deft-gh-refactor` hardcode `gh` CLI commands. Introduce a `scm:` task namespace that makes directive VCS-agnostic.

Add `SCM` field to `PROJECT.md` convention:
```markdown
**SCM**: github  # github | gitlab | linear | jira | bitbucket
```

Create `tasks/scm.yml` with abstract operations (default: GitHub via `gh`):
```yaml
scm:issue:create:
  requires: { vars: [TITLE, BODY] }
  cmds: [gh issue create --title "{{.TITLE}}" --body "{{.BODY}}"]

scm:issue:view:
  requires: { vars: [NUMBER] }
  cmds: [gh issue view {{.NUMBER}} --comments]

scm:pr:create:
  requires: { vars: [TITLE, BODY] }
  cmds: [gh pr create --title "{{.TITLE}}" --body "{{.BODY}}"]

scm:pr:view:
  requires: { vars: [NUMBER] }
  cmds: [gh pr view {{.NUMBER}}]
```

Update `skills/deft-gh-slice/SKILL.md`, `skills/deft-gh-triage/SKILL.md`, `skills/deft-gh-arch/SKILL.md`, and `skills/deft-gh-refactor/SKILL.md` to call `task scm:issue:create` / `task scm:pr:create` instead of direct `gh` commands.

Document the SCM abstraction and swap pattern in `tools/taskfile.md` — provide `tasks/scm-gitlab.yml` as a reference alternative backend.

**Files:** `tasks/scm.yml` (new), `skills/deft-gh-slice/SKILL.md`, `skills/deft-gh-triage/SKILL.md`, `skills/deft-gh-arch/SKILL.md`, `skills/deft-gh-refactor/SKILL.md`, `tools/taskfile.md`, `scm/git.md`

---

## PR 8 — Git worktree isolation for swarm

Re-read `skills/deft-swarm/SKILL.md` post-#403 before starting. Update `swarm/swarm.md` to make git worktrees the standard isolation model — replacing conceptual branch-per-agent guidance with explicit filesystem isolation.

Add `tasks/swarm.yml`. Each worktree gets its own scoped `plan.vbrief.json`, using the scope vBRIEF lifecycle model from #403:

```yaml
swarm:new:
  desc: Create isolated git worktree for a parallel agent task
  requires: { vars: [BRANCH] }
  cmds:
    - git worktree add .worktrees/{{.BRANCH}} -b {{.BRANCH}}
    - mkdir -p .worktrees/{{.BRANCH}}/vbrief/pending
    - echo '{"vBRIEFInfo":{"version":"0.5"},"plan":{"title":"{{.BRANCH}}","status":"pending","items":[]}}' > .worktrees/{{.BRANCH}}/vbrief/plan.vbrief.json
    - echo "Worktree ready at .worktrees/{{.BRANCH}}"

swarm:clean:
  desc: Remove a completed agent worktree and its branch
  requires: { vars: [BRANCH] }
  cmds:
    - git worktree remove .worktrees/{{.BRANCH}}
    - git branch -d {{.BRANCH}}
```

**Files:** `swarm/swarm.md`, `tasks/swarm.yml` (new), `Taskfile.yml`

---

## PR 9 — Orientation step in `deft-build`

Re-read `skills/deft-build/SKILL.md` post-#403 before starting. Add a Step 0 before reading the spec:

1. Run `task prebrief` if available
2. Or manually: check `vbrief/continue.vbrief.json` (prior interruption?), read active scope vBRIEFs in `vbrief/active/`, check `plan.vbrief.json` for blocked items
3. Check for `vbrief/playbook-dev-setup.vbrief.json` — use it to start the dev environment rather than figuring it out from scratch each session
4. If `continue.vbrief.json` exists, resume from its recorded point before starting any new feature work

**Files:** `skills/deft-build/SKILL.md`

---

## PR 10 — Harness audit methodology

Update `verification/verification.md` with a **Harness Audit** section. When an agent fails repeatedly, the diagnostic questions are structural:

1. What information did the agent lack? → add it to vBRIEF lifecycle folder or docs
2. What feedback loop was missing? → add a test, linter, or task
3. What constraint needed mechanical enforcement? → add a CI check or task gate
4. Was vBRIEF state stale or a scope vBRIEF in the wrong lifecycle folder? → fix the state update protocol

Update `meta/lessons.md` guidance: every new lesson should record not only *what went wrong* but *what harness gap caused it*.

**Files:** `verification/verification.md`, `meta/lessons.md`

---

## PR 11 — Finalize the article and add design rationale

Finalize `docs/the-harness-is-everything.md`. Then add a short design rationale to `README.md` or `main.md`: directive treats harness engineering as a first-class concern — vBRIEF is the state substrate, taskfile tasks are the operational interface, and skills are the workflow layer on top. The `scm:` abstraction makes the toolchain VCS-agnostic.

**Files:** `docs/the-harness-is-everything.md`, `README.md` or `main.md`

---

## Sequencing

```
[Wait for #403] → PR 1 → PR 2 → PR 3 → PR 4 → PR 5 → PR 6 → PR 7
                                                               ↓
                                              PR 11 ← PR 10 ← PR 9 ← PR 8
```

PR 2 (`task prebrief`, `task debrief`) is the substrate for PRs 6, 8, and 9.
PRs 3, 4, and 5 can be done in parallel after PR 2.
PR 7 (SCM abstraction) is independent and can run in parallel after PR 1.
PRs 8 and 9 must wait for PR 2 and for post-#403 file baselines.

---

## Expected outcome

After these changes, directive will use vBRIEF lifecycle folders as the single harness state layer across planning, execution, interruption, and parallel swarm work. Agents will have a standardized startup path, a standardized clean handoff, a bounded search discipline, explicit feature completion semantics, a reliable swarm isolation model, and a VCS-agnostic issue/PR interface.

Most importantly: failures become diagnosable as harness problems, not model mysticism.

---

## Appendix — Go-task upstream improvements to consider

These are feature requests or contributions worth raising with the go-task project. None block the PRs above.

**`remediation:` field on tasks** — When a task exits non-zero, automatically surface a remediation string alongside the error. Aligns with the harness article's "errors must include remediation instructions" principle. Currently requires manual `echo` in `cmds`.

**`--output=json`** — Structured task output in a machine-readable envelope (`{status, output, error, remediation}`). Agent-facing tasks need parseable output; human-readable text is an anti-pattern for programmatic consumers.

**`audience:` metadata** — Beyond `desc`, a declared consumer type (`audience: agent | human | ci`). Enables `task --list --audience=agent` and allows tooling to validate design rules per audience.

**`requires: files:`** — First-class file-existence precondition. `requires: files: [vbrief/plan.vbrief.json]` produces a clear error instead of a cryptic shell failure.

**Conditional `includes`** — Include a sub-Taskfile only when a condition is true (file exists, env var set). Would enable `tasks/scm.yml` to be swapped based on `SCM` project setting without wrapper tasks.

**`task doctor`** — Built-in command that walks all `requires` declarations across the full Taskfile graph and reports missing binaries, files, and env vars without running anything. Direct implementation of the harness article's toolchain validation principle.

**`task --metadata <name>`** — Returns full task metadata as JSON. Enables agents and tooling to introspect task contracts without parsing YAML.

**Per-task `dir:` override** — Working directory per task, not just per Taskfile. Critical for worktree-based swarm work where each agent task runs in `.worktrees/<branch>/`.
