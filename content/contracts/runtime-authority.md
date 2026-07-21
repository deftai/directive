# Runtime authority policy (#1394)

Typed session-level enforcement under `plan.policy.runtimeAuthority` in `xbrief/PROJECT-DEFINITION.xbrief.json`.

## Defaults

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | Opt-in — existing projects unchanged until enabled |
| `allowPaths` | `[]` | Empty = allow all paths (when enabled) |
| `denyPaths` | `[]` | Deny wins over allow |
| `scopes.edits` | `true` | Direct Write/Edit/StrReplace tools |
| `scopes.push` | `false` | Schema only — Shell matcher TODO |
| `scopes.merge` | `false` | Schema only — Shell matcher TODO |

## Path globs

Gitignore-style globs via the shared `matchPath` helper (`src/**`, `**/AGENTS.md`, etc.). Paths are normalized to project-relative POSIX before matching.

## Evaluation order (PreToolUse)

1. Ritual / scope / read-only / spawn gates (existing #2438 / #1185 stack)
2. Runtime authority path + `scopes.edits` (this policy)

Policy load failures fail open (host crash behavior unchanged).

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

## Deferred (host gap)

- Shell/Bash `git push`, `gh pr merge`, MCP mutations — not on the direct-write PreToolUse matcher today. `scopes.push` / `scopes.merge` are reserved for a follow-on Shell matcher (#1394 phase 2).

Refs #2437 Core T1 Wave C.
