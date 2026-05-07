# Valuable Go-Task Improvements

> Proposed upstream enhancements to [go-task/task](https://github.com/go-task/task), motivated by agent-facing task design patterns.

---

## Goal

Taskfiles are already ideal for humans. A developer runs `task build`, reads the output, and ships. The design is clean, the ergonomics are excellent, and the tool gets out of the way.

Taskfiles are also an ideal *foundation* for determinism in AI agent harnesses. Unlike prose instructions or shell scripts scattered across a repo, tasks are named, discoverable, composable, and version-controlled. An agent that can run `task prebrief` to orient itself, `task search` to find code, and `task scm:issue:create` to file a ticket has a stable, predictable interface to the environment — exactly what the harness engineering research shows separates high-performing agent systems from fragile ones.

With a small set of additive enhancements, Taskfiles can be even more ideal for *both* audiences simultaneously. None of these proposals change existing behavior. They extend the schema to close the gap between what humans need (readable output, good UX) and what agents need (parseable output, structured errors, introspectable contracts).

---

## TL;DR

The eight improvements below fall into three themes:

1. **Better error communication** — tasks should be able to tell callers (human or agent) *how to fix the problem*, not just *that there is one* (`remediation:`, `task doctor`)
2. **Structured I/O** — agent consumers need parseable output, not text formatted for humans (`--output=json`, `task --metadata`)
3. **Richer task contracts** — tasks should be able to declare their constraints and targeting without shell workarounds (`audience:`, `requires: files:`, conditional `includes`, per-task `dir:`)

---

## Context: The Agent-Facing Task Problem

Taskfiles were designed with human operators in mind. A developer runs `task build`, reads the output, and reacts. For this use case, the current design is excellent.

AI agents have a different interaction model. An agent may run `task prebrief` to orient itself before starting work, `task search` to find relevant code, or `task scm:issue:create` to file a GitHub issue. The agent needs to:

- **Parse task output programmatically**, not read it for meaning
- **Receive actionable remediation** when a task fails, not just an exit code
- **Know in advance what a task requires** before running it
- **Target specific environments** (e.g., a git worktree) without re-implementing directory management

The improvements below remove the current friction at each of these interaction points. They also benefit CI systems and tooling authors for the same reasons.

---

## 1. `remediation:` field on tasks

### What it is
A string field on any task declaration that is automatically surfaced when the task exits non-zero.

```yaml
search:
  desc: Capped codebase search
  vars:
    QUERY: '{{.CLI_ARGS}}'
  remediation: "Too many results — use a more specific pattern, e.g. 'task search -- MyClass'"
  cmds:
    - |
      count=$(rg "{{.QUERY}}" --count-matches | awk -F: '{s+=$2} END{print s+0}')
      if [ "$count" -gt 50 ]; then exit 1; fi
      rg "{{.QUERY}}" -n
```

### Why it matters
Currently, actionable error guidance requires manual `echo` commands before `exit 1` calls — mixing presentation logic into task commands. The remediation message is tightly coupled to the failure condition but structurally separate from it, making Taskfiles harder to read and maintain.

For agents, the distinction is critical: an agent that receives an exit code can retry, but an agent that receives a remediation string can *fix the problem* before retrying. This is the "errors must include remediation instructions" principle from modern harness engineering.

### Current workaround
```yaml
cmds:
  - |
    if [ condition ]; then
      echo "Error: X failed. To fix: do Y instead."
      exit 1
    fi
```
Works, but embeds presentation in logic. Remediation text is not machine-discoverable via `task --metadata`.

### Proposed behavior
- `remediation:` is optional on any task
- When the task exits non-zero, the runner appends the remediation string to its error output
- `task --metadata <name>` (see item 7) exposes the remediation string in the JSON envelope so callers can surface it before running the task

---

## 2. `--output=json` / structured task output

### What it is
A `--json` flag (or `--output=json` to match existing `--output` patterns) that wraps task execution results in a structured envelope:

```json
{
  "task": "search",
  "status": "failed",
  "exit_code": 1,
  "output": "52 matches found",
  "error": "exit status 1",
  "remediation": "Too many results — use a more specific pattern"
}
```

### Why it matters
Agent consumers cannot reliably parse human-readable task output. The current output format mixes task runner chrome (task name banners, timing, color codes) with actual command output. An agent trying to extract the number of search results from `task search` output is parsing something designed for humans.

Structured output would allow agents to:
- Detect success/failure without relying on exit codes alone
- Extract specific fields from output without regex
- Log task results in a structured format alongside other telemetry
- Chain tasks where the output of one informs the input of another

### Current workaround
Agents parse stdout with fragile regex, or tasks are written to emit JSON themselves (which couples every task to a specific output format).

### Proposed behavior
- `task --json <task-name>` runs the task normally and wraps the result in the JSON envelope above
- Existing behavior unchanged without the flag
- Works with `--dry` to return the metadata envelope without executing

---

## 3. `audience:` metadata field

### What it is
An optional metadata field on tasks that declares the intended consumer type:

```yaml
prebrief:
  desc: Orient the agent at session start — git state, vBRIEF snapshot, continue checkpoint
  audience: agent
  cmds: [...]

fmt:
  desc: Format all source files
  audience: human
  cmds: [ruff format .]

ci:validate:
  desc: Validate spec files in CI
  audience: ci
  internal: true
  cmds: [...]
```

### Why it matters
`task --list` currently shows all non-internal tasks regardless of who should be running them. An agent scanning available tasks cannot distinguish between tasks designed for agent consumption (with parseable output, deterministic behavior, remediation strings) and tasks designed for human use (with decorative output, interactive prompts, side effects).

This creates two problems:
1. Agents may invoke human-facing tasks and fail to parse their output
2. Humans see agent-facing tasks in `--list` that are confusing out of context

### Current workaround
Naming conventions and `internal: true`. Neither is precise — internal hides tasks entirely, naming conventions are not enforced.

### Proposed behavior
- `task --list --audience=agent` shows only agent-facing tasks
- `task --list --audience=human` shows only human-facing tasks (default behavior unchanged)
- `task --metadata <name>` exposes audience in the JSON envelope
- Linting tools can validate that `audience: agent` tasks follow agent design rules (no interactive prompts, parseable output, `remediation:` present)

---

## 4. `requires: files:`

### What it is
A first-class precondition for file existence, alongside the existing `requires: vars:`:

```yaml
prebrief:
  desc: Orient the agent at session start
  requires:
    vars: []
    files:
      - vbrief/plan.vbrief.json
      - vbrief/specification.vbrief.json
  cmds: [...]
```

### Why it matters
Many tasks require specific files to exist before they can run meaningfully. Currently, file existence checks require explicit shell commands, which produce cryptic errors when they fail:

```
task: Failed to run task "prebrief": exit status 1
```

A `requires: files:` precondition would produce a clear, structured error:

```
task: prebrief requires file "vbrief/plan.vbrief.json" which does not exist.
Run "task vbrief:init" to create it.
```

This is especially important for agents: a cryptic shell failure causes the agent to spend tokens diagnosing what went wrong. A structured precondition failure tells the agent exactly what to do next.

### Current workaround
```yaml
cmds:
  - |
    test -f vbrief/plan.vbrief.json || (echo "Missing vbrief/plan.vbrief.json. Run task vbrief:init first." && exit 1)
```
Works but is repetitive, not composable, and not discoverable via metadata.

### Proposed behavior
- `requires: files:` takes a list of paths (relative to `{{.USER_WORKING_DIR}}`)
- Task fails before executing `cmds:` if any required file is missing
- Error message names the missing file and (optionally) the `remediation:` string
- `task --metadata <name>` exposes required files in the JSON envelope

---

## 5. Conditional `includes`

### What it is
An `if:` or `when:` condition on `includes:` entries that controls whether a sub-Taskfile is loaded:

```yaml
includes:
  scm:
    taskfile: ./tasks/scm-github.yml
    when:
      env: SCM_PLATFORM
      equals: github

  scm:
    taskfile: ./tasks/scm-gitlab.yml
    when:
      env: SCM_PLATFORM
      equals: gitlab

  session:
    taskfile: ./tasks/session.yml
    when:
      files: [vbrief/plan.vbrief.json]
```

### Why it matters
Directive uses a `scm:` task namespace to abstract the underlying VCS platform (GitHub, GitLab, Linear, Jira). Currently, swapping the backend implementation requires either:

1. Maintaining a single `tasks/scm.yml` with platform detection logic inside every task (verbose, hard to maintain)
2. Requiring users to manually edit `Taskfile.yml` to swap includes (fragile, not automated)

Conditional includes would allow the Taskfile to automatically select the right backend based on a project-level env var or config field, with no user intervention.

The same pattern applies to optional features: include `tasks/session.yml` only if `vbrief/plan.vbrief.json` exists, so the tasks are only advertised when the infrastructure they depend on is present.

### Current workaround
Wrapper tasks that check the condition and delegate:
```yaml
scm:issue:create:
  cmds:
    - |
      if [ "$SCM_PLATFORM" = "gitlab" ]; then
        glab issue create --title "{{.TITLE}}"
      else
        gh issue create --title "{{.TITLE}}"
      fi
```
Works but duplicates the condition across every SCM task and is not composable.

### Proposed behavior
- `includes:` entries accept an optional `when:` block with `env`, `files`, and `vars` conditions
- Only matching includes are loaded; `task --list` reflects the active set
- Multiple entries with the same namespace key are allowed if their `when:` conditions are mutually exclusive

---

## 6. `task doctor`

### What it is
A built-in command that walks the full Taskfile graph, collects all `requires:` declarations (vars, files, bins), and reports what is missing — without running any tasks:

```
$ task doctor

task doctor — checking all task requirements

✓ task check — all requirements met
✓ task test  — all requirements met
✗ task prebrief
    missing file: vbrief/plan.vbrief.json
    (run "task vbrief:init" to create it)
✗ task scm:issue:create
    missing binary: gh
    (install from https://cli.github.com)

2 issues found. Fix before running affected tasks.
```

### Why it matters
The harness engineering principle of "toolchain validation before execution" is currently manual — agents must run `task toolchain:check` or equivalent scripts, and there is no built-in way to verify all task requirements at once.

`task doctor` would make the full dependency graph inspectable before any execution begins. This is particularly valuable for:
- New developer/agent onboarding (know what to install before anything breaks)
- CI pre-flight (detect missing tools before spending time on a build)
- Agent session startup (confirm the environment is ready before starting work)

### Current workaround
Custom `task toolchain:check` scripts that manually verify each dependency — not comprehensive, not auto-updating as tasks change.

### Proposed behavior
- `task doctor` reads all `requires:` declarations in the Taskfile graph
- Reports missing bins (from PATH), missing env vars, and missing files
- Optionally accepts `--task <name>` to check only a specific task and its transitive deps
- Exits non-zero if any requirement is unmet; suitable for use in CI pre-flight

---

## 7. `task --metadata <task-name>`

### What it is
A command that returns the full metadata for a named task as JSON, without executing it:

```json
{
  "name": "search",
  "desc": "Capped codebase search — fails with guidance if > 50 results",
  "audience": "agent",
  "requires": {
    "vars": ["CLI_ARGS"]
  },
  "remediation": "Too many results — use a more specific pattern",
  "sources": [],
  "generates": [],
  "deps": []
}
```

### Why it matters
Agents and tooling authors currently have no way to introspect a task's contract without parsing YAML. This means:
- Agents cannot discover what a task requires before running it
- Tooling cannot validate that agent-facing tasks follow the right design rules
- Documentation generators must parse YAML directly rather than using a stable API

`task --metadata` would provide a stable, structured interface to the Taskfile graph that tooling can depend on.

### Current workaround
Parse `Taskfile.yml` directly with a YAML library. Breaks on includes, variable interpolation, and templating.

### Proposed behavior
- `task --metadata <name>` returns the fully-resolved metadata for that task
- `task --metadata --all` returns metadata for all non-internal tasks
- Combines with `--json` output from item 2 for a complete introspection API

---

## 8. Per-task `dir:` override

### What it is
A `dir:` field on individual tasks (not just at the Taskfile level) that sets the working directory for that task's execution:

```yaml
swarm:verify:
  desc: Run checks inside a specific agent worktree
  dir: .worktrees/{{.BRANCH}}
  requires:
    vars: [BRANCH]
  cmds:
    - task check
    - task test
```

### Why it matters
Directive's swarm pattern uses git worktrees for parallel agent isolation — each agent works in `.worktrees/<branch>/` with its own copy of the codebase, its own vBRIEF state, and its own running processes.

Currently, tasks that need to run inside a worktree must either:
1. `cd .worktrees/{{.BRANCH}} && task check` — spawns a subshell, loses task runner context
2. Accept a `DIR` variable and prefix every command with `cd {{.DIR}} &&` — verbose and error-prone

A per-task `dir:` field would make worktree-scoped tasks first-class, with the same directory semantics as Taskfile-level `dir:`.

### Current workaround
```yaml
swarm:verify:
  cmds:
    - cmd: task check
      dir: .worktrees/{{.BRANCH}}
```
This works per-command but requires repeating `dir:` on every command in the task, and doesn't apply to `deps`.

### Proposed behavior
- `dir:` on a task applies to all `cmds:` and `deps:` within that task
- Supports variable interpolation: `dir: .worktrees/{{.BRANCH}}`
- Overrides the Taskfile-level `dir:` for that task only
- Works with `task --dry` to show the resolved directory

---

## Contributing

The go-task project accepts feature requests via [GitHub Issues](https://github.com/go-task/task/issues) and contributions via PRs. When filing a feature request, the go-task maintainers generally want:

1. A concrete use case (not just "would be nice")
2. The current workaround and why it is insufficient
3. A proposed syntax that fits the existing Taskfile schema

The items in this document include all three. Items 4 (`requires: files:`), 6 (`task doctor`), and 8 (per-task `dir:`) are likely the most tractable starting points — they have clear, bounded scope and obvious implementation paths within the existing schema.
