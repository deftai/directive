# Host-surface assumptions: file gates vs REPL / self-mutating hosts (#3162)

Directive control surfaces assume two host behaviors that **some** modern agent hosts break by design.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `≉`=SHOULD NOT, `⊗`=MUST NOT, `?`=MAY.

Parent epic: [#3179](https://github.com/deftai/directive/issues/3179) (self-improving under gates). Stance: [#3164](https://github.com/deftai/directive/issues/3164) (**shipped** — do not reverse). Skill pins: [#830](https://github.com/deftai/directive/issues/830) / [#2508](https://github.com/deftai/directive/issues/2508). Tier-1 hooks: [#2437](https://github.com/deftai/directive/issues/2437) / [#2438](https://github.com/deftai/directive/issues/2438). Capability descriptor: [#1461](https://github.com/deftai/directive/issues/1461) / [#1357](https://github.com/deftai/directive/issues/1357).

---

## Two broken assumptions

| Assumption | What Directive built on it | Host classes that break it |
|------------|---------------------------|----------------------------|
| **(a) Content ownership** | Constitution (managed AGENTS.md, pinned skills, policy) is not rewritten mid-run by the host kernel | **Self-mutating** hosts (Continual-Harness-class refine) that CRUD prompts, skills, or memory mid-run |
| **(b) Gate visibility** | Work product is filesystem-visible before quality gates run | **REPL-first** hosts where artifacts live as kernel variables and can execute **before any file exists** |

This doc names the honesty surface. It does **not** reverse [#3164](https://github.com/deftai/directive/issues/3164): Directive still improves through issues, PRs, and quality gates (**propose-not-apply**), not mid-run constitution self-edit.

---

## Host content-surface classes

| Class | Meaning | Gate honesty |
|-------|---------|--------------|
| **file-first** | Host edits land on disk; tools write files; git sees work product | File gates (pre-commit, `task check`, content lint, pre-pr) apply as designed |
| **repl-first** | Executable work product may exist only in host kernel / REPL state | File/git gates **do not see** kernel-only artifacts until someone materializes them to disk |
| **self-mutating** | Host refine path may change skills, prompts, or memory without agent Write/Edit | Agent-only pin rules and `agents:refresh` **fight the host** for the same bytes; pins are constitution locks **only when the host honors them** |
| **unknown** | No capability signal | Operators must not assume either ideal |

! Operators and hosts MUST set an explicit class when the runtime is not file-first (see [Capability detection](#capability-detection-14611357)).

~ Prefer file-first deposit hosts when Directive lifecycle gates are the control plane you need.

⊗ Assume `task check`, pre-commit, or content lint saw work that never touched the filesystem.

⊗ Treat #830 / always-pin names as host-kernel enforcement when only agent edit tools are blocked.

---

## What still enforces (file-first)

On a **file-first** host with cooperative tools:

| Surface | Still works |
|---------|-------------|
| Managed AGENTS.md section + `agents:refresh` | Framework-owned constitution bytes between markers |
| Always-pin skill names (#2508) | Process skills load when agents follow AGENTS.md |
| PreToolUse path fence / runtime authority | Direct Write/Edit on disk paths the host exposes to hooks |
| `task check`, git hooks, pre-pr | Files on disk in the worktree |
| #3164 stance | Agents still must not self-edit live constitution mid-run |

---

## What cannot enforce alone

| Claim | Honest limit |
|-------|----------------|
| Skill pin forbids edits | Only forbids **agent** edit tools the host routes through hooks. Host refine / kernel CRUD is outside that path until Tier-1 hooks cover it. |
| Managed-section `sha=` marker | Tamper-evident vs template / deposit; does not stop a host from rewriting bytes between refreshes. |
| File quality gates | Blind to REPL-kernel variables and in-memory executables that never became files. |
| `agents:refresh` | Restores framework-owned managed section; on self-mutating hosts the harness may rewrite the same region again. |

Full pin product (#830 immunity from lifecycle demotion **and** host-path deny) is **out of scope** for #3162. This story documents limits and surfaces drift; it does not ship the complete pin mechanism.

---

## Capability detection (#1461 / #1357)

Session start records a **host content-surface class** next to the existing runtime capability probe (`packages/core/src/platform/platform-capabilities.ts`, #1357 formalization; #1461 orchestration capability posture).

### Explicit env (preferred)

| Variable | Values |
|----------|--------|
| `DEFT_HOST_CONTENT_SURFACE` | `file-first` \| `repl-first` \| `self-mutating` \| `unknown` (aliases: `continual-harness` → self-mutating) |
| `DEFT_HOST_REPL_FIRST` | truthy (`1` / `true` / `yes` / `on`) → `repl-first` |
| `DEFT_HOST_SELF_MUTATE` | truthy → `self-mutating` (wins over REPL-first when both set) |

When unset, Directive **assumes** `file-first` (historical default) and records `source=assumed`.

### Session lines

```text
[deft host-surface] class=file-first source=assumed managed=current sha=… body=…
[deft host-surface] class=repl-first source=env:DEFT_HOST_CONTENT_SURFACE managed=stale …
[deft host-surface] honesty: file gates and agent-only pins do not see host-kernel …
[deft host-surface] managed AGENTS section drift — run `deft agents:refresh`
```

Structured JSON on `session:start` includes `host_content_surface` (class, source, managed state, embedded sha, body hash). Advisory only — never fails the ritual.

---

## Tamper-evident managed section (not full #830)

v1 drift surface:

1. Compare managed AGENTS.md body to the current agents-entry template (`agents:refresh` plan: `current` / `stale` / …).
2. Report embedded marker `sha=` and a short body hash on the session line.
3. On `stale` or `missing`, nudge `deft agents:refresh` / `task agents:refresh`.

This is **tamper-evident**, not a full pin product. Always-pin skill **bodies** are not content-addressed here; pin **pointers** live in the managed section and ride that hash.

Approval-fatigue: honesty and refresh lines print only when class is non-file-first or managed state is drifted; the one-line summary always records class + managed state.

---

## Enforcement home: Tier-1 host hooks (#2437 / #2438)

Where the host supports hooks, **deny writes to directive-managed paths** without cooperation:

| Layer | Role |
|-------|------|
| **Tier-1 host hooks** | PreToolUse / equivalent intercept Write/Edit/Shell that target managed paths (AGENTS managed section, deposit, pin skill paths the host exposes) |
| **Path write fence** | Project + story `file_scope` evaluation — [`path-write-fence.md`](../contracts/path-write-fence.md) |
| **Agent hook readiness** | `deft verify:hooks-installed --scope=agent --live` — [`agent-hook-readiness.md`](../contracts/agent-hook-readiness.md) |
| **Policy** | `plan.policy.hostHooks.<host>` — inspect with `deft policy:show --field=hostHooks` |

! When hooks are available, treat managed-path deny as the enforcement home for constitution bytes — not agent good behavior alone.

~ On hosts without hooks, document the honesty gap; do not claim file-gate parity.

⊗ Claim that pins alone stop Continual-Harness-class host refine.

Named hook home for managed-path deny: **Tier-1 host hooks** (`packages/core/src/hooks/`, deposit via `hostHooks` / `deft update`, readiness via `verify:hooks-installed --scope=agent`). Residual path policy rides runtime authority / path write fence when enabled.

---

## Cross-links

| Topic | Where |
|-------|--------|
| Self-improving, not self-editing stance | [main.md § Self-Improving, Not Self-Editing (#3164)](../../main.md#self-improving-not-self-editing-3164), [philosophy.md](../meta/philosophy.md) |
| Skill pin tiers (process pins, not full #830) | [skill-pin-policy.md](./skill-pin-policy.md) |
| Host lifecycle duty list | [host-lifecycle-duties.md](../contracts/host-lifecycle-duties.md) |
| OpenClaw / session-first family | [openclaw-agent-host.md](./openclaw-agent-host.md) |
| Parent epic | [#3179](https://github.com/deftai/directive/issues/3179) |
| Implementation pointer | `packages/core/src/platform/host-content-surface.ts` |

---

## Non-goals (#3162)

- ⊗ Full skill pin mechanism (#830)
- ⊗ Mandating one commercial host as product shape (#3179 non-goal)
- ⊗ Replacing sandbox taxonomy (#542 / #543)
- ⊗ Reversing #3164 propose-not-apply stance
