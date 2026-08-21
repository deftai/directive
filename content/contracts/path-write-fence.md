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
path when `inspectActiveScope` reports one. Residual gaps (document, not silent):

- Host / worktree cannot identify the active story → story layer omitted; project fence still applies
- Multiple active artifacts → first preflight-eligible path wins (same as scope gate)
- Story JSON unreadable → story layer fail-open; project fence still applies

Shell/MCP push/merge scopes remain project-only (`runtimeAuthority.scopes`); they are not
re-scoped by `file_scope`. Recognized Shell dest-forms (`git checkout --`, `git restore`,
`rm`/`rmdir`) use the same write fence as Edit/Write, including story `file_scope` (#3438).

### Dest-form target recognition (#3438)

The fence resolves a target for exactly one shape: **a single simple command**. Everything
else is recognized and denied, never resolved.

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

⊗ **Do not add cwd or git-context reconstruction back.** It was implemented and withdrawn
(#3438): the target depends on operator precedence (`&` binds looser than `&&`, which binds
looser than `|`), on exit status (`cd x || …` runs only when the `cd` failed), on subshell
boundaries, and on git config — and every resolution rule added produced its own fence
bypass. Recognition is total and cheap; resolution was neither.

Rewrite guidance the deny message carries: name a concrete path in one simple command
(`rm x/y`, not `cd x && rm y`), or issue one command per tool call.

**Cost of the narrowing, accepted deliberately:** legitimate compound and cross-repo
commands are denied — notably `git -C /other/repo checkout -- f.ts`, which resolution used
to allow. Quoting is honoured (an unquoted backslash escapes only a character that needs
escaping, so `rm protected\ file` is ONE dest while `C:\Repos\file.ts` keeps its separators).

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
