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

Dest-form target reconstruction (#3438) follows shell **precedence**, not separator order.
`|` binds tighter than `&&` / `||`, which bind tighter than `&`:

- Inheritance into a segment is unconditional — a subshell starts in the parent's cwd — so
  `cd sub && rm a | rm b` removes `sub/a` **and** `sub/b`
- A `cd` inside a pipeline member is confined to that member
- `&` closes the whole and-or list and backgrounds it, so `cd sub && rm a & rm b` removes
  `sub/a` but leaves `rm b` in the parent shell targeting root `b` — the `cd` never escapes
- `;` closes the list without backgrounding it, so its `cd` does carry forward
- `||` is the **failure** branch: reaching it means the `cd` did not happen, so
  `cd scoped || rm x` targets root `x`, not `scoped/x`

`git -C` composes (`git -C a -C b` → `a/b`; an absolute `-C` resets), and `--work-tree`
resolves against the `-C` chain preceding it. Targets the classifier cannot reconstruct stay
fail-closed: glob/variable dests, subshell grouping (`(`/`)`), and a work tree selected
through `-c core.workTree` / `--config-env` (resolution there depends on the git dir).
Known-open, denied not reconstructed: quoted literal metacharacters over-deny.

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
