# Path write fence (#516 / #2443 / #2948 Wave 3)

Unified **write-scope** enforcement for agents: project path policy and per-story
`file_scope` share one evaluation model. There is no third parallel `writeScope`
schema with its own matcher.

## Source of truth

| Layer | Where declared | Role |
| --- | --- | --- |
| **Project** | `plan.policy.runtimeAuthority` in `xbrief/PROJECT-DEFINITION.xbrief.json` | Session-level `allowPaths` / `denyPaths` + scopes (`edits` / `push` / `merge`) |
| **Story** | `plan.metadata.swarm.file_scope` on the active running xBRIEF | Per-story allow globs (swarm readiness already uses this list) |
| **Legacy alias** | `writeScope` on `plan.metadata` or `plan.metadata.swarm` | Read-time normalize to `file_scope` + deny globs only — **not** a second engine |

**Evaluation SoT (code):**

1. `resolveWriteFence(projectPolicy, storyFileScope?)` builds one `RuntimeAuthorityPolicy`
2. `evaluateRuntimeAuthorityPath` / `evaluateRuntimeAuthorityDirectWrite` decide allow/deny

## Intersection rules

- **Empty project `allowPaths` when enabled** → all paths allowed until a story narrows them
- **Empty story `file_scope`** → project policy only
- **Story alone** (project `runtimeAuthority.enabled: false`) → story fence still enables path checks for direct writes
- **Both non-empty** → path must match **project allow** *and* **story file_scope** (AND)
- **`denyPaths` always win** (project denys + any denys from normalized `writeScope.deny`)

## Runtime enforcement

When a fence is active, PreToolUse direct writes (Write / Edit / StrReplace / …) **fail closed**
for out-of-fence paths after ritual / scope / read-only / human-origin authz gates.

ApplyPatch is a direct write. Every path `hookMutationTargetPaths` returns — the declared
path plus every `*** Add/Update/Delete/Move/Rename File:` header and every `*** Move to:`
destination — must pass the same fence as Write (#3614). A mixed patch is denied if any
target is denied. An ApplyPatch body that names no classifiable mutation target fails closed
while the fence is active. ⊗ Authorize only the declared path when the patch body names
other targets.

Which tree the fence, occupancy, ritual and active scope are read from is decided before any of
them run, by root admission on the write target — including the deliberate payload-root fallback
for a target with no Git toplevel. Contract:
[`docs/hook-root-admission.md`](../docs/hook-root-admission.md) (#3794 / #4013).

Deny reasons are stable and name the fence source:

- `write fence project allowPaths (source: project)` or `project+story`
- `write fence story file_scope (source: story)` or `project+story`
- `write-fence denyPaths (source: …)`

Inspect project policy:

```bash
deft policy:show --field=runtimeAuthority
```

### Active-story seam

The hook dispatcher loads `file_scope` from the implementation-eligible active xBRIEF
path when `inspectActiveScope` reports one.

When more than one preflight-eligible artifact is in `xbrief/active/` (a cohort
sharing one tree), first-wins is **not** used: that would fence every worker to one
story's `file_scope` and over-permit the others (#4007). Bind the dispatched story:

- `DEFT_ACTIVE_SCOPE` (absolute, project-relative, or unique basename) must name
  one eligible running brief; that path's `file_scope` is the story fence
- On win32, pin matching is case-insensitive (the filesystem is). POSIX pins stay
  case-sensitive, and a backslash in a POSIX pin is a filename character, not a
  separator
- Missing pin + multiple eligible → fail closed (`scope-not-ready`). Recovery: set
  the pin, or keep one running brief in `xbrief/active/`
- A pin that does not name an eligible brief → fail closed

The filed `__tests__` matcher diagnosis is refuted: `matchAny` already admits that
exact path and `_` is literal. Do not invent a `__`-segment exception. Pre-`c99f6159`
worktree relativisation is a separate discriminator (the raw unedited deny string)
and is not closed here.

Residual gaps (document, not silent):

- Host / worktree cannot identify the active story → story layer omitted; project fence still applies
- Story JSON unreadable → story layer fail-open; project fence still applies

Shell/MCP push/merge scopes remain project-only (`runtimeAuthority.scopes`); they are not
re-scoped by `file_scope`. Recognized Shell dest-forms (`git checkout --`, `git restore`,
`rm`/`rmdir`) use the same write fence as Edit/Write, including story `file_scope` (#3438).

### Dest-form enforcement is opt-in (#3438 / #3594)

```jsonc
// xbrief/PROJECT-DEFINITION.xbrief.json
{ "plan": { "policy": { "runtimeAuthority": {
  "shellDestForms": "off"      // default — Shell exactly as before #3438
  // "shellDestForms": "enforce"  // opt in
} } } }
```

`off` is the default and leaves Shell mutations unrecognized and fail-open, as they were before
this gate existed, so landing the classifier denies nothing a consumer runs today. `enforce`
turns on **both** halves together: recognized dest-forms go through `inspectMutationGates`, and
targets that cannot be proved fail closed.

- ⊗ Do not split the two halves behind separate switches. Enforcing only resolved dests would
  allow `cd x && rm y` while denying `rm x/y`; enforcing only the fail-closed branch would deny
  the compound while letting the in-scope simple form through unchecked.
- Independent of `enabled` in both directions: opting into the gate does not require the
  `runtimeAuthority` grant ladder, and enabling the ladder does not silently opt into the gate.
- An unknown value (`"warn"`, `"on"`, a typo) resolves to `off` — the no-new-denials direction —
  and `validateRuntimeAuthority` reports it, so it is never silent.
- An unreadable policy also resolves to `off` rather than failing closed.
- Tracked project policy may only **enable** this gate. A tracked switch that *disabled* it would
  contradict `policy/deft-directive-disable.ts`, where repository-controlled content must not
  disable hooks for downstream clones.

⊗ There is no `warn` state. Its only purpose would be staging a breaking change, and with `off`
as the default there is nothing to stage. It is also unimplementable today: `renderHostDecision`
emits no text on the allow path for `tool.before`, so a warned denial would be
indistinguishable from `git status` in the decision record. Revisit only alongside an allow-path
sink (#3620).

### Dest-form threat model (#3438) — read this first

The Shell dest-form gate is a **guardrail for cooperative-but-careless agents, not a security
boundary against adversarial ones.** An agent that wants out of the fence has unbounded exits
and this layer cannot close them. State that plainly before reading the rules below, because
every rule is scoped by it.

Why the limit is structural: Edit/Write payloads are **declarative** — the target path is data
in the payload, so gating them is sound. Shell payloads are **imperative** — the target is the
output of running a program, so gating them by parsing the command string means predicting what
a program will do without running it. Recognition of *destructive spellings* is decidable;
prediction of *mutation* is not.

Tree-wide destructive git is **recognized and fail-closed**, always-on, independent of
`shellDestForms` (#3917). The forms are `git reset --hard`, `git clean -f` (including
combined `-fd` / `-fdx`), `git checkout -f` / `git switch --force` / `-B`, and
`git stash drop` / `git stash clear`. A simple command whose relocators (`-C`,
`--git-dir`, `--work-tree`, `GIT_DIR=`, `GIT_WORK_TREE=`) are all absolute paths
outside the project root is allowed as a throwaway fixture. Relative, in-project,
opaque (`GIT_CONFIG*`, `-c core.workTree`), and compound forms stay denied.

That close is a **guard**, not a root-cause claim. Every recognized form, deny or
fixture-allow, appends one JSONL line under the platform user-config dir
(`%APPDATA%\deft\logs\git-destructive.jsonl` / `~/.config/deft/logs/git-destructive.jsonl`,
overridable with `DEFT_GIT_DESTRUCTIVE_LOG`) so a later occurrence names host, actor,
command, project root, and disposition even if reflogs are gone.

What remains **fail-open today**:

- Unrecognized mutators: `git checkout` without `--` or `-f` (branch switch / ambiguous
  path checkout), `mv`, `cp`, `sed -i`, `truncate`, `find -delete`, and `>` / `>>` redirection
- Interpreters: `bash -c 'rm x'`, `python -c`, `node -e`, `cmd /c`
- Non-literal verbs: `\rm x`, `rm${IFS}x` — the tokenizer cannot see the verb, so even the
  fail-closed branch does not fire
- **cmd / PowerShell mutators are not recognized at all**: `del`, `erase`, `rd`, `move`,
  `copy /y`, `Remove-Item`, `Out-File`. Only POSIX-shaped verbs are on the list, and the hook
  cannot tell which shell will run the command (#3624)
- Mutations by allowed programs: `npm run build`, `node scripts/clean.js`, `make` — inherent
  to any string recognizer, since writing files is what those commands are *for*
- **Nothing on the dest-form allow path is audited** except the tree-wide destructive-git
  log above. A dest-form bypass still leaves no dest-form trace.

### Shell file-write reissue (#3983 / #3987)

This gate is a **cooperative guardrail**. It raises the cost of an accidental or
careless reissue -- a Write that occupancy, ritual, or scope already denied,
sent again through the host shell. It is **not** a boundary against a determined
caller. An agent that wants out of the fence has unbounded exits, and parsing
the command string cannot close them.

Grok Build shell is `run_terminal_command`. That name is in `SHELL_TOOL_NAMES`,
so PreToolUse fires. Recognized in-repo dests (`Set-Content`, `Out-File`,
`Add-Content`, python pathlib `write_text`/`write_bytes`, IO.File WriteAllText /
WriteAllBytes) are injected as Write targets and authorized through
`inspectMutationGates` -- occupancy, ritual, scope, and the path fence -- the
same way ApplyPatch authorizes every mutation target (#3614). Always-on,
independent of `shellDestForms`. Named PowerShell parameters are honoured in
any order: `-Value` before `-Path` is not taken as the dest.

OS-temp dests and commands with no recognized dest (`git status`,
`occupancy:release`, `git commit -F` of a temp body) stay fail-open.

**Measured limits** (bound #3997 arc: synthesis 5472062522, table 5472059705):

- Recogniser recall is about **47%**: 2,843 of 5,372 real file-writing commands
  were invisible to the classifier, and 17 of 29 probed in-repo write shapes
  yielded zero targets. Recall work stays on #3987.
- Destinations that are shell **variables** are not recovered. That is most
  logged shell: 1,089 of 1,131 calls were dynamic, compound, or emitted no
  target.
- A **directory junction** created without elevation defeats `provablyExternal`:
  the path is lexically outside the root and its realpath is inside. That is
  **re-entry** polarity. `#3186` `assertProjectionContained` is **escape**
  polarity (in-tree dest whose realpath leaves the tree) and does not close it.

Fail-open at this predicate is the bound posture (#3997). Inverting it to
fail-closed on dests the parser cannot prove external is that issue's refuted
proposal, not this gate's next patch.

Do not cite this merge as "the shell write path is gated." It narrows the
cooperative reissue hole. The residual class is every command whose dest is
not statically recoverable.

### Dest-form target recognition (#3438)

The fence resolves a target for exactly one shape: **a single simple command**. Everything
else that is *recognized* is denied rather than resolved. An **absolute** dest is checked
soundly; a **relative** dest is checked under the assumption that the shell's working
directory is the project root, which persistent-shell hosts do not guarantee across tool
calls (see the cwd residual below).

A command is simple when it has no unquoted `&&`, `||`, `|`, `&`, `;`, or newline, no
grouping or substitution (`(`, `)`, `{`, `}`, `` ` ``, `$`), and no git context option. Then
each dest token is checked against the same fence as Edit/Write.

Everything else **fails closed** — denied regardless of whether the path would have been in
scope:

| Fail-closed | Why |
| --- | --- |
| Any compound command (`cd x && rm y`, pipelines, `;`, `&`) | cwd is not provable |
| Grouping / substitution (`(…)`, `{…;}`, `$(…)`, backticks) | target is computed at runtime |
| Git context options (`-C`, `--work-tree`, `--git-dir`, `-c core.workTree`, `--config-env`, `GIT_WORK_TREE=`, `GIT_DIR=`) | relocates the tree; resolution depends on the git dir |
| Glob / variable dests, or a leading `~` | expands at runtime (a *trailing* `~` as in `foo.ts~` is an ordinary path) |
| A **retained** backslash — one not consumed as an escape (`rm C:\Repos\a.ts`, `rm foo\bar`) | dialect-ambiguous: a path separator on win32, an escape under a POSIX shell including Git Bash *on* win32, and the payload does not say which shell runs. Rewrite with forward slashes, which git and node accept on Windows (#3624) |
| `git checkout\|restore --pathspec-from-file=<f>` / `--pathspec-file-nul` | the targets live inside a file; reading it means hook-time I/O plus resolving against an unknown cwd (#3624) |

⊗ **Do not add cwd or git-context reconstruction back.** It was implemented and withdrawn
(#3438): the target depends on operator precedence (`&` binds looser than `&&`, which binds
looser than `|`), on exit status (`cd x || …` runs only when the `cd` failed), on subshell
boundaries, and on git config — and every resolution rule added produced its own fence
bypass. Recognition of a *legible* verb is cheap; resolution was not. Neither is total —
see the threat model above.

Rewrite guidance the deny message carries: name a concrete path in one simple command
(`rm x/y`, not `cd x && rm y`), or issue one command per tool call. Prefer an **absolute**
path: absolute dests are checked soundly, relative ones assume the shell is at the project
root.

**Cwd residual:** the classifier never consults the shell's working directory (`input.cwd`
only supplies project-root candidates). A relative dest is resolved against the project root
unconditionally, so whenever the shell's cwd differs — including a benign in-project `cd` in
an earlier tool call — the fence checks a different path from the one mutated. Absolute dests
are unaffected. Tracked in #3594.

**Cost of the narrowing, accepted deliberately:** legitimate compound commands are denied,
with the rewrite above. Cross-repo work has an escape: an absolute out-of-root dest is
allowed, so `cd /other/repo` then `git checkout -- /other/repo/f.ts` works where
`git -C /other/repo checkout -- f.ts` is denied. Quoting is honoured (an unquoted backslash
escapes only a character that needs escaping, so `rm protected\ file` is ONE dest while
`C:\Repos\file.ts` keeps its separators; `rm\ secret` is one word naming a nonexistent
program and is correctly not a dest-form).

**The fail-closed branch reaches no exemptions.** Because it never calls
`inspectMutationGates`, assist/scratch, proposed-lifecycle, and story `file_scope` do not
apply to it: `rm .deft-scratch/a.txt` is allowed under assist posture but
`rm .deft-scratch/a.txt && rm .deft-scratch/b.txt` is denied. Split the calls. This is
structural — a fail-closed dest has no path, so a path-conditional exemption cannot be
evaluated.

**Known-open — recognition, not resolution:** `python -c`, `cmd /c copy`, and obfuscated
`bash -c 'rm …'` are not recognized as dest-forms at all, so they stay fail-open. Narrowing
bounds what resolution can get wrong; it does not close the recognition gap.

## Skill behavior (build / swarm)

When a project or active-story fence is set:

- **build** and **swarm** workers MUST treat out-of-fence Write/Edit as refused (PreToolUse deny
  or equivalent product check)
- Prefer declaring intended paths in `plan.metadata.swarm.file_scope` before autonomous loops
- ⊗ Do not invent a second write-scope schema or dual matcher beside `resolveWriteFence` +
  `evaluateRuntimeAuthority*`

## writeScope alias (compatibility)

```json
{
  "plan": {
    "metadata": {
      "writeScope": {
        "allow": ["src/**", "tests/**"],
        "deny": [".env", "secrets/**"]
      }
    }
  }
}
```

Loaders map this to `file_scope` + deny globs at read time. If both `file_scope` and
`writeScope.allow` are present, **`file_scope` wins** for the allow list; `writeScope.deny`
still merges into denyPaths.

## Example

```json
// PROJECT-DEFINITION
{
  "plan": {
    "policy": {
      "runtimeAuthority": {
        "enabled": true,
        "allowPaths": ["packages/**", "src/**", "xbrief/**"],
        "denyPaths": [".env", "secrets/**"],
        "scopes": { "edits": true, "push": false, "merge": false }
      }
    }
  }
}

// Active story swarm block
{
  "plan": {
    "metadata": {
      "swarm": {
        "file_scope": [
          "packages/core/src/policy/**",
          "content/contracts/path-write-fence.md"
        ]
      }
    }
  }
}
```

With both set, a write to `packages/core/src/policy/write-fence.ts` is allowed;
`src/index.ts` is denied (outside story); `secrets/x` is denied (deny wins).

## Related

- Contract: `content/contracts/runtime-authority.md` (#1394 / #2711)
- Human-origin / UAT: `content/contracts/human-origin-authz.md` (#2944)
- Intent ceiling: `content/contracts/intent-ceiling.md` (#1193)
- Program: #2948 Wave 3

Refs #516, #2443, #2948, #1394.
