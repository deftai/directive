# Runtime authority policy (#1394 / #2711)

Typed session-level enforcement under `plan.policy.runtimeAuthority` in `xbrief/PROJECT-DEFINITION.xbrief.json`.

## Defaults

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | Opt-in — existing projects unchanged until enabled |
| `allowPaths` | `[]` | Empty = allow all paths (when enabled) |
| `denyPaths` | `[]` | Deny wins over allow |
| `scopes.edits` | `true` | Direct Write/Edit/StrReplace tools |
| `scopes.push` | `false` | Shell/Bash `git push` and classifiable MCP push tools (#2711) |
| `scopes.merge` | `false` | Shell/Bash `gh pr merge` and classifiable MCP merge tools (#2711) |

## Path globs

Gitignore-style globs via the shared `matchPath` helper (`src/**`, `**/AGENTS.md`, etc.). Paths are normalized to project-relative POSIX before matching.

## Unified write fence (#516 / #2443 / #2948 Wave 3)

Path checks for direct writes go through **one** evaluation SoT:

1. `resolveWriteFence(projectPolicy, storyFileScope?)` intersects this project policy with the active story’s `plan.metadata.swarm.file_scope` (optional `writeScope` alias normalizes at read-time — not a second engine)
2. `evaluateRuntimeAuthorityPath` / `evaluateRuntimeAuthorityDirectWrite` decide allow/deny

Rules: empty project `allowPaths` when enabled = all paths until story narrows; empty story scope = project only; **denyPaths always win**; when both allow layers are non-empty, a path must match **both**. Full contract: `content/contracts/path-write-fence.md`.

## Evaluation order (PreToolUse)

1. Ritual / scope / read-only / spawn gates (existing #2438 / #1185 stack)
2. **Human-origin authz / UAT lease** (#2944 Wave 1) — when UAT is active, product mutations require a named fix-cohort human-origin grant (see `content/contracts/human-origin-authz.md`). Composes with this policy; does not re-own Shell matchers.
3. Runtime authority path + story write fence + `scopes.edits` for direct-write tools (`resolveWriteFence` → `evaluateRuntimeAuthorityDirectWrite`)
4. Runtime authority `scopes.push` / `scopes.merge` for Shell/Bash and classifiable MCP tools (#2711)

Policy load failures fail open (host crash behavior unchanged).

## Shell / MCP classification (#2711)

When `enabled: true`:

| Classified as | Examples | Scope |
| --- | --- | --- |
| **push** | `git push …`, `git -C <path> push`, env-prefixed `FOO=1 git push`, after `&&` / `;` / `\|` | `scopes.push` |
| **merge** | `gh pr merge …`, `gh.exe pr merge …` | `scopes.merge` |
| **MCP merge** | tool names matching `merge_pull_request`, `pr_merge`, … | `scopes.merge` |
| **MCP push** | tool names matching `git_push`, `push_branch`, … | `scopes.push` |

**Fail open (allow)** when:

- the tool is Shell/MCP but the command/tool name is **not** classifiable as push or merge (e.g. `git status`, unrelated MCP tools)
- the host payload omits a command string
- policy load throws

**Install note:** agent-host PreToolUse deposits include a Shell/Bash matcher (`SHELL_HOOK_MATCHER`) so classifiable shell ops reach `hook:dispatch` (#2711). MCP tools are classified when the host invokes the hook for that tool name; hosts that never fire PreToolUse for MCP remain a residual gap.

**Not enforced** (document as residual host gap):

- WebSearch / non-shell non-MCP tools
- Obfuscated shell (`bash -c "$(echo Z2l0IHB1c2g=|base64 -d)"`) — not a complete substitute for Tier-2 git hooks
- Every MCP host spelling — only patterns above; unknown MCP tools fail open
- MCP tools on hosts that do not install/subscribe a PreToolUse matcher for those tool names
Tier-2 git hooks remain authoritative for commit/push on the working tree. This layer is session-time PreToolUse only.

## Inspection

```bash
deft policy:show --field=runtimeAuthority
```

## Example

```json
{
  "plan": {
    "policy": {
      "runtimeAuthority": {
        "enabled": true,
        "allowPaths": ["src/**", "xbrief/**", "packages/**"],
        "denyPaths": [".env", "secrets/**"],
        "scopes": { "edits": true, "push": false, "merge": false }
      }
    }
  }
}
```

With that shape, a PreToolUse `Bash` / `Shell` invocation of `git push` or `gh pr merge` is denied when the matching scope is `false`.

Refs #2437 Core T1 Wave C residual, #2711, #2948 Wave 0; Wave 3 path fence #516 / #2443 — `content/contracts/path-write-fence.md`.
