# Agent host: OpenClaw

Consumer/operator guide for running **Deft Directive** under **OpenClaw** persistent-memory agents (`ape-deft`-class and peers).

This is an **agent-host** adapter note — not a product-UI design standard (those live under `interfaces/` for CLI/TUI/REST/Web) and not a hardware platform pack (`platforms/` is Atari/Unity-class). OpenClaw sits in the same mental model as Warp, Cursor, and Grok Build: a runtime that can host Directive skills, swarm launch, and PR review-monitors.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `≉`=SHOULD NOT, `⊗`=MUST NOT, `?`=MAY.

Epic spine: [#2874](https://github.com/deftai/directive/issues/2874). This doc is the discoverable operator path for [#2877](https://github.com/deftai/directive/issues/2877).

---

## Who this is for

- Operators running OpenClaw as the always-on agent runtime and wanting Directive lifecycle (xBRIEF, triage, swarm, review-cycle) without re-deriving host mappings every session.
- First-session agents that need a short answer to: **“What is babysit on OpenClaw?”**
- Maintainers comparing host primitives across Warp / Cursor / Grok Build / OpenClaw.

If you are installing Directive for the first time, start at [QUICK-START.md](../QUICK-START.md) or [getting-started.md](./getting-started.md), then return here for host-specific expectations.

Native **slash/prompt command registration** (multi-host thin wrappers under `.claude/commands/`, `.cursor/commands/`, and peers) is documented in [slash-multi-host.md](./slash-multi-host.md) (epic #55). That surface is separate from OpenClaw skill/spawn mapping and from skill-discovery residual [#75](https://github.com/deftai/directive/issues/75).

---

## Mental model (host class)

| Host | Host-native background spawn (typical) | Directive review-monitor role |
|------|----------------------------------------|-------------------------------|
| Warp | `start_agent` | Approach 1 when Tier 1 |
| Grok Build | `spawn_subagent` | Approach 1 when Tier 1 |
| Cursor | `Task` (`run_in_background: true`) | Approach 1 when Tier 1 |
| **OpenClaw** | **`sessions_spawn`** (optional visible) | Approach 1 when Tier 1 **in the installed skill/matrix** |

OpenClaw’s native background-spawn tool is **`sessions_spawn`**. Operator intent places that tool in the **same Tier-1 role** as Warp / Grok Build / Cursor — not “interactive shell only.” Whether a given Directive **release** classifies OpenClaw as Tier 1 is decided by the **shipped** swarm matrix and review-cycle skill, not by this page.

! Gate tiers, allowed register primitives, dispatch detection, and review Approaches are defined **only** in shipped skill + engine text:

- Swarm capability matrix + launch path: [`skills/deft-directive-swarm/SKILL.md`](../skills/deft-directive-swarm/SKILL.md) (thin skill: detect + route table) and OpenClaw adapter [`skills/deft-directive-swarm/references/host-openclaw.md`](../skills/deft-directive-swarm/references/host-openclaw.md) (Step 2f launch, worktree-before-spawn #2929, phase handoff #2934, parent-monitor tool-first after announce #2943). Skill text remains source of truth.
- PR babysit / shepherd / watch: [`skills/deft-directive-review-cycle/SKILL.md`](../skills/deft-directive-review-cycle/SKILL.md) → **Review Monitoring**.
- Provider-neutral dispatch envelope: [`templates/agent-prompt-preamble.md`](../templates/agent-prompt-preamble.md).
- Review-owner lease: `task review-monitor:register` / `task verify:review-monitor` (only `--platform-primitive` values those commands accept in your install).

! When this host guide and the installed skill/CLI disagree, **the skill and CLI win**.

⊗ Invent a parallel “OpenClaw-only” review gate that bypasses `deft-directive-review-cycle`.

⊗ Pass `sessions_spawn` (or any host-native name) to `task review-monitor:register -- --platform-primitive …` unless that exact token is listed in the **installed** skill/CLI help.

---

## First-session: babysit on OpenClaw

**Operator says:** “babysit this PR”, “shepherd”, “watch the PR”, or equivalent PR-shepherding intent on a Deft-managed repo (`.deft/core/` present, or framework checkout with Directive skills).

### Executable path (any installed Directive version)

1. ! Load **`deft-directive-review-cycle`** — not a host-global babysit skill and not a freestyle `gh` poll loop in the main session ([#2261](https://github.com/deftai/directive/issues/2261) class).
2. ! Select monitoring Approach using **runtime detection in that skill** (and the swarm Phase 3 matrix when relevant). Do not invent a host path outside the skill.
3. ! If the installed skill reports Tier 1, use **Approach 1** (background review-monitor) and register with a **`--platform-primitive` value accepted by the installed CLI**.
4. ! Prefer deterministic wait language from the skill (`task pr:watch` when the consumer Taskfile exposes it) over inventing sleep/cron loops.
5. ⊗ Treat **OpenClaw cron alone** as Approach 1. Cron / scheduler re-invocation is fallback territory when a live background review-monitor cannot be spawned per the skill — not a substitute for Approach 1 when the skill says spawn is available.
6. ⊗ Block the main session with long `gh` poll + sleep when the skill’s Tier 1 / background path is available (#1880 Gap D / incident class on epic #2874).

### Operator expectation: babysit → `sessions_spawn` (epic target)

Epic [#2874](https://github.com/deftai/directive/issues/2874) sets the **intended** OpenClaw mapping:

> On OpenClaw, PR babysit/shepherd/watch routes into **`deft-directive-review-cycle` Approach 1** using the host-native **`sessions_spawn`** (prefer **visible** when Control UI is the control plane), not main-session `gh` poll + cron.

That expectation is for operators and first-session agents to **find and remember**. It becomes the **executable** default only when the installed Directive version’s swarm matrix + review-cycle skill name OpenClaw / `sessions_spawn` as Tier 1 Approach 1 (sibling work):

| Issue | Lands |
|-------|--------|
| [#2875](https://github.com/deftai/directive/issues/2875) | Swarm matrix + `openclaw` descriptor + verify gate |
| [#2876](https://github.com/deftai/directive/issues/2876) | Review-cycle Approach 1 + register primitive for OpenClaw `sessions_spawn`; cron ≠ Approach 1 |
| [#2879](https://github.com/deftai/directive/issues/2879) | Poller/preamble templates + heartbeat mapping |
| [#2878](https://github.com/deftai/directive/issues/2878) | Consumer `pr:watch` / official gh fallback |

~ After those slices are in your Directive version, follow the **updated skill text** end-to-end (including any new register token). Until then, still open review-cycle on babysit intent and use only primitives the **current** skill accepts — while keeping the `sessions_spawn` expectation as the design north star (do not freestyle a weaker path when you could wait for / upgrade to the OpenClaw-capable release).

This section is a **discovery map**. Authoritative Approaches, register primitives, and exit predicates live only in skill files and CLI.

---

## Control plane preference (operator signal)

When multiple OpenClaw surfaces are available:

| Surface | Role |
|---------|------|
| **Control UI** | Default **control plane** for long infra work and **visible** subagent watch (review-monitors, swarm leaves). |
| **Telegram** (or similar mobile chat) | Remote/mobile chat; not the preferred surface for long blocking polls. |
| **TUI** | Break-glass local terminal — use when UI/channels are unavailable. |

~ Prefer **visible** background review-monitors when Control UI is in play so the operator can see the subagent without freezing the parent conversation. Once OpenClaw Approach 1 is skill-backed, that usually means visible `sessions_spawn`.

! Keep long-running review-monitors and implementation leaves on independent/background dispatch so the parent session stays interactive (Gap D — see preamble and review-cycle skill).

---

## Bot identity vs human GitHub identity

OpenClaw agents often act under a **bot / service identity** (e.g. `ape-deft`-class) that is distinct from the human operator’s GitHub login.

- ! Assume the agent’s `gh` auth may be a bot account with different permissions than the human (merge rights, org SSO, protected-branch rules).
- ~ Prefer bot-owned comments, review-monitor leases, and PR status updates when the bot is the active worker; do not silently switch identities mid-loop.
- ⊗ Mandate merge rights for bot accounts in this doc — merge policy is per-repo ops, not an OpenClaw host requirement (epic #2874 out of scope).
- ~ When a merge or ruleset action requires a human, surface a clear handoff instead of retrying with the wrong identity.

---

## Directive-for-OpenClaw-users (onboarding blurb)

1. Install / refresh Directive like any other host ([QUICK-START.md](../QUICK-START.md), `directive init` / `directive update`).
2. Confirm skills resolve under the deposit (consumer: `.deft/core/.agents/skills/…`; framework checkout: `content/skills/…`).
3. **Wire always-pin skills into the OpenClaw workspace** (see next section) so session `available_skills` can load cold-start paths.
4. On first PR shepherding request, open **`deft-directive-review-cycle`** and follow its Review Monitoring section for **your** install. Remember the epic expectation: OpenClaw → Approach 1 via `sessions_spawn` once skill wiring ships (#2875 / #2876).
5. For multi-story parallel work, follow **`deft-directive-swarm`** — do not hand-roll worktree orchestration outside the skill.
6. Keep CHANGELOG / xBRIEF / branch gates the same as on Cursor or Warp; the host changes the **spawn surface**, not the Directive lifecycle.

---

## Wire skills into OpenClaw workspace (#3001)

OpenClaw is a **session-first** host: installing `@deftai/directive` puts pin skills in the content package / deposit, but the **main** OpenClaw workspace may still only list host-global skills until something bridges them into `~/.openclaw/workspace/skills` (or `$OPENCLAW_STATE_DIR/workspace/skills`).

Always-pins required for cold-start / process gates ([skill-pin-policy.md](./skill-pin-policy.md) #2508):

- `deft-directive-build`
- `deft-directive-pre-pr`
- `deft-directive-review-cycle`
- `deft-directive-swarm`

### Detect

When OpenClaw signals are present (`OPENCLAW` / `DEFT_PROBE_OPENCLAW` / `DEFT_AGENT_RUNTIME=openclaw`, or `~/.openclaw` / `OPENCLAW_STATE_DIR`), `deft doctor` checks the **main** workspace skills root for those four pins.

- **Miss:** warning + remediation `deft doctor --fix` (plus pointers to this page and [host-lifecycle-duties.md](../contracts/host-lifecycle-duties.md)).
- **Hit:** success line — OpenClaw host pins present.

### Fix

```text
deft doctor --fix
```

Doctor **copies** the four pin directories from the installed content package (`@deftai/directive-content` / `content/skills/…`) into the main OpenClaw skills root as **real directories** (#3008). It does **not** symlink into the npm tree — OpenClaw 2026.7.x skips workspace skills that resolve outside the skills root (`reason=symlink-escape`), which made pre-#3008 symlink installs look healthy in doctor while `openclaw skills list` never loaded the pins. It does **not** delete other user skills (e.g. a local `vbrief` skill stays). Divergent same-named directories **and escaping symlinks** are left alone unless you pass `--force` or confirm on a TTY (then replaced with a real copy).

After a successful wire: **restart the OpenClaw gateway or start a new session** so host `available_skills` refreshes. Confirm with `openclaw skills list` that the four always-pins are **ready**, not skipped.

### Multi-seat / crew workspaces

Default scope is **main only** (`workspace/skills`). Crew seats (`workspace-scotty`, `workspace-pike`, …) are **not** rewritten unless you opt in:

```text
deft doctor --fix --openclaw-all-agents
```

⊗ Silent rewrite of every `workspace-*` seat without that flag.

---

## Swarm on OpenClaw (#2929 / #2934 / #2943)

! For **parallel** swarm leaves on OpenClaw:

1. Create worktrees (or consume a worktree-map) **before** any `sessions_spawn`.
2. Set each worker cwd to that worktree — not the shared repo root.
3. Prefer `task swarm:launch` + manifest; DIY multi-leaf `sessions_spawn` without worktree prep is forbidden.

! After a coding cohort completes, dispatch the next phase with a **real tool call in the same turn**, or write explicit terminal status (`blocked` / `awaiting-human` / `done`). Do not end on narrative-only “I will spawn…”.

### Parent-monitor after `subagent_announce` (#2943)

OpenClaw parents can lock into a **text-only repetition hang** after thin leaf completions: the model regenerates the same “checking worktrees / open PRs next” sentence with **zero tool calls** until length cap or abort. Subagents may still be healthy; only the parent appears hung.

! After any leaf completion event (`subagent_announce` / parent-push completion), the parent’s **first response** MUST be **tool-first** or **yield**:

1. **Tool-first ground-truth batch** — one same-turn tool batch that inspects reality (`gh` PR/issue status, `git` / worktree status, or file/xBRIEF state), **or**
2. **`sessions_yield`** (or host equivalent yield) — leave the turn steerable without narrating unfinished work.

⊗ Open the first response after announce with multi-sentence progress-only prose (“Two leaves look unfinished…”, “Checking worktrees next…”, “Implementing both myself…”) and **zero** tool calls / yield.

! **Thin DONE = failed leaf:** a completion without PR URL / merge evidence (and without a structured `BLOCKED` / `FAILED` terminal) is **not** success. Treat as failed: re-dispatch or take over after the ground-truth batch. Do not celebrate thin DONE as shipped.

~ Prefer structured completion fields when present (`prUrl`, `mergeStatus`, `emptyDiff`); never model free-text thin DONE as success.

Full rules: [`skills/deft-directive-swarm/references/host-openclaw.md`](../skills/deft-directive-swarm/references/host-openclaw.md), thin swarm SKILL hard-gates, and [`templates/agent-prompt-preamble.md`](../templates/agent-prompt-preamble.md) §11. This page does not fork a second source of truth.

## Anti-patterns

- ⊗ Main-session `gh` poll + **cron** as the default babysit path when the installed skill offers a Tier 1 / background monitor.
- ⊗ Inventing skill gate semantics or unregistered `--platform-primitive` values in operator docs instead of linking to shipped `SKILL.md` / CLI text.
- ⊗ Treating `content/platforms/` hardware packs as the home for agent-host OpenClaw guidance.
- ⊗ Substituting host-native review theater for `deft-directive-review-cycle` on Deft-managed repos.
- ⊗ Claiming this doc alone makes `sessions_spawn` a shipped register/matrix primitive — that is epic skill/engine work (#2875 / #2876).
- ⊗ Multi-sentence progress-only first response after `subagent_announce` with zero tools / yield (#2943 text-repetition hang).
- ⊗ Treating thin DONE (no PR URL / merge evidence) as success (#2943).
- ⊗ Assuming package install alone populates OpenClaw `available_skills` — wire main workspace pins via `deft doctor --fix` (#3001).
- ⊗ Auto-enumerating every `workspace-*` seat without `--openclaw-all-agents` (#3001).

---

## See also

- [QUICK-START.md](../QUICK-START.md) — install / AGENTS.md refresh entry
- [getting-started.md](./getting-started.md) — orientation lifecycle
- [skill-pin-policy.md](./skill-pin-policy.md) — always-pin process skills (includes review-cycle)
- [`skills/deft-directive-review-cycle/SKILL.md`](../skills/deft-directive-review-cycle/SKILL.md)
- [`skills/deft-directive-swarm/SKILL.md`](../skills/deft-directive-swarm/SKILL.md)
- [`skills/deft-directive-swarm/references/host-openclaw.md`](../skills/deft-directive-swarm/references/host-openclaw.md) — OpenClaw swarm adapter
- [`templates/agent-prompt-preamble.md`](../templates/agent-prompt-preamble.md)
