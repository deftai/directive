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

---

## Mental model (host class)

| Host | Host-native Tier-1 spawn (typical) | Directive review-monitor path |
|------|------------------------------------|-------------------------------|
| Warp | `start_agent` | Approach 1 (orchestrated sub-agent) |
| Grok Build | `spawn_subagent` | Approach 1 |
| Cursor | `Task` (`run_in_background: true`) | Approach 1 |
| **OpenClaw** | **`sessions_spawn`** (optional visible subagent) | **Approach 1** (when Tier 1 is available) |

OpenClaw’s native background-spawn tool is **`sessions_spawn`**. That places the host in the **same Tier-1 class** as Warp / Grok Build / Cursor — not an interactive-only shell that must degrade to main-session poll loops.

! Gate tiers, allowed register primitives, dispatch detection, and review Approaches are defined **only** in shipped skill + engine text (not invented in this doc):

- Swarm capability matrix + launch path: [`skills/deft-directive-swarm/SKILL.md`](../skills/deft-directive-swarm/SKILL.md) (Phase 3 runtime detection / launch adapter).
- PR babysit / shepherd / watch: [`skills/deft-directive-review-cycle/SKILL.md`](../skills/deft-directive-review-cycle/SKILL.md) → **Review Monitoring** → Approach selection.
- Provider-neutral dispatch envelope: [`templates/agent-prompt-preamble.md`](../templates/agent-prompt-preamble.md).
- Review-owner lease: `task review-monitor:register` / `task verify:review-monitor` (accept only the `--platform-primitive` values those commands document).

! When the live skill/matrix text and the OpenClaw runtime disagree, **prefer the shipped skill + register/verify output** over this host guide. This page is a discovery map and operator preference note.

⊗ Invent a parallel “OpenClaw-only” review gate that bypasses `deft-directive-review-cycle` or redefines Approach 1 / register semantics here.

⊗ Pass a host-native name (e.g. `sessions_spawn`) to `task review-monitor:register -- --platform-primitive …` unless that exact token appears in the **current** skill/CLI help for the installed Directive version.

---

## First-session: babysit → Approach 1 (not freestyle poll + cron)

**Operator says:** “babysit this PR”, “shepherd”, “watch the PR”, or equivalent PR-shepherding intent on a Deft-managed repo (`.deft/core/` present, or framework checkout with Directive skills).

**Expected path:**

1. ! Load **`deft-directive-review-cycle`** — not a host-global babysit skill and not a freestyle `gh` poll loop in the main session ([#2261](https://github.com/deftai/directive/issues/2261) class; same supersession idea as Cursor-global babysit).
2. ! Prefer **Review Monitoring Approach 1** (background review-monitor subagent) when the runtime can spawn independent subagents. On OpenClaw, the host-native spawn tool for that role is **`sessions_spawn`** (prefer **visible** when Control UI is the control plane — see below).
3. ! After spawn, claim ownership with the **shipped** review-monitor gate (`task review-monitor:register` / `task verify:review-monitor`) using a **`--platform-primitive` value accepted by the installed release** — see the review-cycle skill. Do not claim “monitoring” without a successful register/verify (or an explicit skill-allowed fallback path).
4. ! Prefer deterministic wait language from the skill (`task pr:watch` when available on the consumer Taskfile) over inventing sleep/cron loops.
5. ⊗ Treat **OpenClaw cron alone** as Approach 1. Cron / scheduler re-invocation is a **fallback** class (closer to Approach 2 / Approach 3 territory) when a live background review-monitor cannot be spawned — never a substitute for Approach 1 when spawn works.
6. ⊗ Block the main session with long `gh` poll + sleep while independent subagent spawn is available (#1880 Gap D / incident class on epic #2874).

### Epic wiring vs this doc

Sibling slices land the **matrix descriptor, skill naming, and register primitive** so OpenClaw is first-class in code — not only in this prose:

| Issue | Owns |
|-------|------|
| [#2875](https://github.com/deftai/directive/issues/2875) | Swarm capability matrix + `openclaw` descriptor + verify gate |
| [#2876](https://github.com/deftai/directive/issues/2876) | Review-cycle Approach 1 + #2261 text names OpenClaw / `sessions_spawn`; register accepts the OpenClaw primitive when shipped |
| [#2879](https://github.com/deftai/directive/issues/2879) | Poller/preamble templates + heartbeat mapping |
| [#2878](https://github.com/deftai/directive/issues/2878) | Consumer `pr:watch` / official gh fallback |

Until those skill/engine changes are in the version you run, ! still open **review-cycle** on babysit intent and follow **whatever Tier-1 primitive the installed skill lists**; ~ map OpenClaw’s `sessions_spawn` onto that Approach 1 *role* without inventing unregistered CLI tokens. After they ship, the same babysit entry point uses `sessions_spawn` end-to-end as the skill text states.

Authoritative wording for Approaches, register primitives, and exit predicates lives only in the skill files and CLI. This section is the **discovery map**, not a second contract.

---

## Control plane preference (operator signal)

When multiple OpenClaw surfaces are available:

| Surface | Role |
|---------|------|
| **Control UI** | Default **control plane** for long infra work and **visible** subagent watch (review-monitors, swarm leaves). |
| **Telegram** (or similar mobile chat) | Remote/mobile chat; not the preferred surface for long blocking polls. |
| **TUI** | Break-glass local terminal — use when UI/channels are unavailable. |

~ Prefer **visible** background review-monitors (OpenClaw: visible `sessions_spawn`) when Control UI is in play so the operator can see the subagent without freezing the parent conversation.

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
3. On first PR shepherding request, open **`deft-directive-review-cycle`** and take **Approach 1** (background review-monitor) when spawn is available — OpenClaw’s host-native spawn for that role is `sessions_spawn` (see sections above).
4. For multi-story parallel work, follow **`deft-directive-swarm`** — do not hand-roll worktree orchestration outside the skill.
5. Keep CHANGELOG / xBRIEF / branch gates the same as on Cursor or Warp; the host changes the **spawn surface**, not the Directive lifecycle.

---

## Anti-patterns

- ⊗ Main-session `gh` poll + **cron** as the default babysit path when independent subagent spawn is available.
- ⊗ Inventing skill gate semantics or unregistered `--platform-primitive` values in operator docs instead of linking to shipped `SKILL.md` / CLI text.
- ⊗ Treating `content/platforms/` hardware packs as the home for agent-host OpenClaw guidance.
- ⊗ Substituting host-native review theater for `deft-directive-review-cycle` on Deft-managed repos.
- ⊗ Claiming this doc alone makes `sessions_spawn` a shipped register/matrix primitive — that is epic skill/engine work (#2875 / #2876).

---

## See also

- [QUICK-START.md](../QUICK-START.md) — install / AGENTS.md refresh entry
- [getting-started.md](./getting-started.md) — orientation lifecycle
- [skill-pin-policy.md](./skill-pin-policy.md) — always-pin process skills (includes review-cycle)
- [`skills/deft-directive-review-cycle/SKILL.md`](../skills/deft-directive-review-cycle/SKILL.md)
- [`skills/deft-directive-swarm/SKILL.md`](../skills/deft-directive-swarm/SKILL.md)
- [`templates/agent-prompt-preamble.md`](../templates/agent-prompt-preamble.md)
