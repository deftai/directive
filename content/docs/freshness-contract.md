# Freshness contract: bound vs live generation (#3117)

Long-lived multi-agent sessions can keep executing the pre-upgrade payload they
loaded earlier even after `directive update` / deposit apply succeeds and disk
probes report "up to date." This product **freshness contract** is host-agnostic:
it does not depend on any single host session-key mechanism.

## Readiness rule

Disk-only freshness is **insufficient**. A session is ready only when its
**bound** generation matches the **live** deposit generation for the surfaces
it uses.

## Generation token

On successful deposit apply (`directive init`) or payload refresh
(`directive update` when content swaps), Directive stamps a **monotonic** live
generation under:

```text
.deft/GENERATION.json
```

The file is outside `.deft/core/` so a full-tree payload replace does not wipe
the counter. Fields include `generation` (integer ≥ 1), `contentVersion`,
`stampedAt`, `stampedBy`, and per-surface fingerprints (`payload`, `version`,
`templates`, `skills`, `docs`).

Already-current update paths ensure the token exists without advancing the
counter when the content version is unchanged.

## Session bind

When a mutation `session:start` (cold or re-arm) loads payload surfaces into
runtime context, it binds the live generation:

```text
.deft/session-binds/<safe-session-id>.json   # multi-agent isolation (preferred)
.deft/session-bind.json                      # default / last-bind convenience
```

Multi-agent hosts **must** pin session identity so one session cannot certify
another as current:

1. Prefer `DEFT_SESSION_ID=<id>` in the process environment (printed by
   `session:start`), or
2. Pass `--session-id <id>` on every `freshness:report` / `freshness:bind`.

Trusted readiness (`state=current`, exit 0) requires a **pinned** identity
(explicit flag or `DEFT_SESSION_ID`). Bare report without a pin never returns
`ready=true` even if a ritual-recovered bind matches live — that prevents
cross-session false current when multiple agents share a worktree.

`session:start` binds the ritual `session_id` path and prints the
`DEFT_SESSION_ID=…` line for the operator or host to adopt.

Hosts and operators can rebind without restarting the shared host runtime:

```bash
# After re-loading payload surfaces into the session:
deft freshness:bind -- --confirm-payload-loaded
# multi-agent hosts MUST pin identity:
deft freshness:bind -- --session-id <host-session-id> --confirm-payload-loaded
export DEFT_SESSION_ID=<host-session-id>
deft freshness:report
# or
deft freshness:report -- --session-id <host-session-id>
```

`session:start` attests `payloadLoaded` automatically (payload load ceremony).
A bare bind without `--confirm-payload-loaded` never yields trusted readiness.

API (TypeScript): `bindSessionGeneration(projectRoot, options)` /
`reportFreshness(projectRoot, { sessionId })` from
`@deftai/directive-core/freshness`.

## Freshness report

```bash
deft freshness:report
task freshness:report
task session:freshness
deft freshness:report -- --json
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | `current` — bound matches live for used surfaces |
| 1 | `stale_soft` or `unbound` — caution / not yet bound |
| 2 | `stale_hard` — rebind before trusted work |

Report fields: bound generation, live generation, state, differing surfaces
(hard vs soft), rebind guidance, mid-mission safety note.

## State meanings

| State | Meaning | Operator action |
|-------|---------|-----------------|
| `current` | Bound matches live | Ready for trusted work |
| `stale_soft` | Additive / advisory drift (e.g. docs-only) | Safe to continue with caution; rebind when convenient |
| `stale_hard` | Evidence-untrustworthy drift (payload / version / templates / skills, or generation advance) | **Must rebind** before trusted work |
| `unbound` | No session bind recorded | Bind after loading surfaces |

Hard surfaces: `payload`, `version`, `templates`, `skills`.  
Soft surfaces: `docs` (advisory).

## Rebind without host restart

1. Park in-flight mission work (see mid-mission safety).
2. Re-load skill, ritual, template, and command bodies from the live deposit into
   the session context (host-specific load; product does not restart the host).
3. Run `deft freshness:bind` (or cold/re-arm `session:start`, which binds
   automatically).
4. Confirm with `deft freshness:report` → `current`.

Prefer `session:start --rearm` or `session:ready` when ritual state is still
valid on the same worktree — re-arm also rebinds generation.

## Mid-mission safety

- **Park and hand off** before a hard refresh or hard rebind.
- An empty session after refresh is **not** "work complete." Resume from the
  handoff artifact, not from a blank context.
- Consumer policy decides *when* to refresh; this product owns generation +
  honesty of bound-vs-live.

## Non-goals

- Restarting the whole shared runtime as the freshness mechanism.
- Auto-resetting sessions on any file mtime change.
- Bound proof for remote PR claims (see #3120).

## Related

- `content/commands.md` § Session-start ritual / freshness pointer
- Doctor `payload-staleness` (disk/registry currency) — complementary, not a substitute
- Issue #3117
