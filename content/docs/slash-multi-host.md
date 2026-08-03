# Multi-host native slash-command registration

Operator guide for **host-native** Directive slash and prompt files after epic [#55](https://github.com/deftai/directive/issues/55).

This surface is **not** skill auto-discovery ([#75](https://github.com/deftai/directive/issues/75)). Skills stay under skill deposit paths. Slash registration writes thin command/prompt wrappers so hosts can show `/deft…` (or the host equivalent) in autocomplete.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `≉`=SHOULD NOT, `⊗`=MUST NOT, `?`=MAY.

Product locks: **LockedDecisions L1–L10** on [#55](https://github.com/deftai/directive/issues/55). Code waves: [#3052](https://github.com/deftai/directive/issues/3052) generator, [#3053](https://github.com/deftai/directive/issues/3053) emitters, [#3054](https://github.com/deftai/directive/issues/3054) deposit. This page is the docs/dogfood child [#3055](https://github.com/deftai/directive/issues/3055).

Prose SoT for routing and deprecation aliases: [commands.md § Slash Command Namespaces](../commands.md#slash-command-namespaces-418--1670).

---

## What you get

On `directive init` and `deft update`, Directive deposits **exactly 13** thin wrappers (L2) for every **enabled** host that has a real emitter (L6).

| Host id | Directory | Surface |
|---------|-----------|---------|
| `claude` | `.claude/commands/` | commands |
| `cursor` | `.cursor/commands/` | commands |
| `grok` | `.grok/commands/` | commands |
| `codex` | `.codex/prompts/` | prompts |
| **OpenClaw** (adapter, not file emitter) | OpenClaw **workspace skills** (`~/.openclaw/workspace/skills` or `$OPENCLAW_STATE_DIR/...`) | user-invocable skills + router |

File hosts use portable hyphen filenames (L4), for example `deft-directive-run-interview.md` and `deft-continue.md`. Logical slash ids keep the namespace form (`/deft:directive:run:interview`).

**OpenClaw** is **not** a fifth row in `SLASH_EMITTER_HOSTS` / `HOST_COMMAND_LAYOUTS`. There is no project-tree `.openclaw/commands/` deposit (that would be stub theater — Gateway does not load that path). OpenClaw L2 parity ships as a **skills/plugin adapter** ([#3064](https://github.com/deftai/directive/issues/3064)): thin **user-invocable** skills under the main workspace skills root, with a stable `logicalId → openClawSlug` map (`a-z0-9_`, max 32). See [openclaw-agent-host.md](./openclaw-agent-host.md) § L2 product commands.

⊗ Treat last-writer-wins single-host install as the product default. One repo may use many hosts; deposit targets the **configured set** in one pass.

---

## Product set (L2 — exactly 13)

| # | Logical slash id | Filename stem |
|---|------------------|---------------|
| 1 | `/deft:directive:change` | `deft-directive-change` |
| 2 | `/deft:directive:change:apply` | `deft-directive-change-apply` |
| 3 | `/deft:directive:change:verify` | `deft-directive-change-verify` |
| 4 | `/deft:directive:change:archive` | `deft-directive-change-archive` |
| 5 | `/deft:directive:run:interview` | `deft-directive-run-interview` |
| 6 | `/deft:directive:run:yolo` | `deft-directive-run-yolo` |
| 7 | `/deft:directive:run:map` | `deft-directive-run-map` |
| 8 | `/deft:directive:run:discuss` | `deft-directive-run-discuss` |
| 9 | `/deft:directive:run:research` | `deft-directive-run-research` |
| 10 | `/deft:directive:run:speckit` | `deft-directive-run-speckit` |
| 11 | `/deft:directive:run:probe` | `deft-directive-run-probe` |
| 12 | `/deft:continue` | `deft-continue` |
| 13 | `/deft:checkpoint` | `deft-checkpoint` |

⊗ Auto-register every `deft-directive-*` skill as a slash entry.  
⊗ Expand N without an amendment to L2 on #55.

Legacy prose aliases (`/deft:change`, `/deft:run:…`) remain accepted in agent text with deprecation guidance. Native host files emit **canonical names only** (L3) — no second set of alias files.

---

## Thin wrappers (L5)

Each managed file is a short pointer, not a copy of a strategy or skill:

- YAML frontmatter: `description` (and `argument-hint` when needed)
- Body: load the content-relative target under `.deft/core/` when installed; honor `$ARGUMENTS`; do not inline the target body

Token intent (catalog ≤ ~1k tok for the set; invoke body ~40–100 tok). Real cost is the strategy/skill after invoke.

Contributors: keep wrappers thin. Emitters consume `generateThinWrappers()` / `listProductCommands()` — do not maintain a second name table.

---

## Policy opt-out (`plan.policy.hostSlashCommands`)

Default: all emitter hosts enabled (`claude`, `cursor`, `grok`, `codex`).

Set a host to `false` in `xbrief/PROJECT-DEFINITION.xbrief.json` (or consumer deposit layout) to skip that host:

```json
{
  "plan": {
    "policy": {
      "hostSlashCommands": {
        "claude": true,
        "cursor": true,
        "grok": false,
        "codex": true
      }
    }
  }
}
```

Inspect:

```bash
deft policy:show --field=hostSlashCommands
```

On opt-out, init/update **removes only** Directive-managed thin wrappers for that host. Consumer-customized files at the same path are left alone. Unknown host keys fail validation.

This policy is parallel to `plan.policy.hostHooks` (enforcement hooks). Hooks and slash deposit are separate surfaces.

### OpenClaw adapter opt-out (`plan.policy.openClawProductCommands`)

OpenClaw L2 deposit is **separate** from the four file emitters. Default **on** when the adapter is real and OpenClaw is detected.

```json
{
  "plan": {
    "policy": {
      "openClawProductCommands": false
    }
  }
}
```

```bash
deft policy:show --field=openClawProductCommands
```

When false, init/update/doctor **removes only** Directive-managed OpenClaw L2 thin skills (router + 13 product slugs). Consumer-customized skills at the same slug are left alone. Deposit **does not write** OpenClaw artifacts when OpenClaw is not detected (fail-closed).

Primary recovery: `deft doctor --fix` (optional `--openclaw-all-agents` for multi-seat).

---

## Git policy (L8 — prefer commit)

! **Prefer committing** managed product command/prompt files so every clone and every host share the same `/deft…` surface.

- Managed paths are exact product filenames (installer allowlist), not “claim the whole `.claude/commands/` tree.”
- Custom files you add next to managed ones stay app-owned.
- Idempotent rewrite on init/update keeps managed thin wrappers current either way.

? Personal gitignore of host command dirs remains an escape for machine-local only setups. That is **not** the default team recommendation. Multi-host shared repos benefit most from a committed deposit.

⊗ Do not use single-host last-writer-wins as the team sharing model.

---

## Prose fallback (L9)

File hosts without native registration (or with all file hosts opted out) still use the agent text convention in [commands.md](../commands.md). AGENTS.md and skills routing continue to work without native autocomplete files.

**OpenClaw** after [#3064](https://github.com/deftai/directive/issues/3064): when the adapter has deposited L2 skills, operators should prefer the invocable skills / router — not prose-only discovery. Prose `/deft:directive:…` remains accepted in agent text when skills are not yet wired (doctor not run, policy off, or host without OpenClaw signals).

---

## Slash registration vs skill discovery (#55 vs #75 vs #3064)

| Concern | Tracker | What lands |
|---------|---------|------------|
| Native slash / prompt **command files** | #55 | Thin wrappers under host command/prompt dirs; multi-host deposit |
| Skill auto-discovery paths | #75 | `SKILL.md` discovery under `.agents/skills/`, `.claude/skills/`, etc. |
| OpenClaw L2 product commands | #3064 | Thin **user-invocable** skills + router in OpenClaw workspace skills (not a file emitter) |

! Do not treat skill discovery alone as “slash registration done.”  
! Do not dual-maintain full skill bodies as command file contents (L7).  
! Do not invent project `.openclaw/commands/` for L2 parity.

Agent-host runtime notes (OpenClaw spawn/review + L2 skills) live under [openclaw-agent-host.md](./openclaw-agent-host.md).

---

## Dogfood checklist (multi-host clone)

Use this after install or upgrade when two or more hosts share one repo.

1. **Upgrade / deposit**

   ```bash
   npm i -g @deftai/directive@latest   # when using the npm channel
   directive update                    # or directive init on a new project
   ```

2. **Confirm policy**

   ```bash
   deft policy:show --field=hostSlashCommands
   ```

   Expect enabled hosts = emitters you want (default: all four true).

3. **Smoke paths on disk** (enabled hosts only)

   ```text
   .claude/commands/deft-continue.md
   .cursor/commands/deft-continue.md
   .grok/commands/deft-continue.md
   .codex/prompts/deft-continue.md
   ```

   Spot-check count: **13** managed files per enabled host. Bodies stay short (description + dispatch pointer).

4. **Two-host UI check**

   - Open the same clone in host A (for example Claude Code) and host B (for example Cursor).
   - Type `/` (or the host prompt picker) and confirm Directive entries such as `deft-directive-run-interview` / `/deft:continue` appear on **both** hosts when both are enabled.
   - Invoke one strategy command and one session command; agent should load the pointed strategy/resilience doc, not a fat inlined body.

5. **Opt-out smoke (optional)**

   - Set one host to `false`, run `directive update`, confirm that host’s **managed** product files were removed and other hosts remain.
   - Restore `true` and update again to redeposit.

6. **Git**

   - Stage managed product paths (or let the installer staging path include them) and commit so teammates inherit the surface.
   - ~ Avoid gitignoring the whole host command directory on team repos.

7. **Hooks still separate**

   - `deft verify:hooks-installed --scope=agent` checks hooks, not slash files.
   - Missing autocomplete after a clean deposit is a host UI/cache issue or policy opt-out — re-run update and re-check policy before filing a deposit bug.

---

## Related surfaces

| Surface | Role |
|---------|------|
| [commands.md § Slash Command Namespaces](../commands.md#slash-command-namespaces-418--1670) | Prose namespaces, routing, deprecation aliases, deposit pointer |
| `packages/core/src/slash/` | Generator IR + emitters + OpenClaw adapter (maintainers) |
| `writeSlashCommandDeposit` | init/update file-host deposit |
| `depositOpenClawL2ProductCommands` / doctor OpenClaw L2 check | OpenClaw skills adapter (#3064) |
| `plan.policy.openClawProductCommands` | OpenClaw L2 adapter opt-out |
| `plan.policy.hostHooks` | Host enforcement hooks (#2438) — not slash files |
| [#75](https://github.com/deftai/directive/issues/75) | Skill discovery residual |
| [#3064](https://github.com/deftai/directive/issues/3064) | OpenClaw L2 product-command adapter |

---

## Design reading order (#55)

1. LockedDecisions L1–L10 on #55  
2. Multi-host deposit amendment on #55  
3. Token / context design rules on #55  
4. This page + `commands.md`  

Issue body (2026-03) on #55 is historical intent only.
