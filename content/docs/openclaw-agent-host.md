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

| Host | Typical Tier-1 spawn primitive | Directive review-monitor path |
|------|--------------------------------|-------------------------------|
| Warp | `start_agent` | Approach 1 (orchestrated sub-agent) |
| Grok Build | `spawn_subagent` | Approach 1 |
| Cursor | `Task` (`run_in_background: true`) | Approach 1 |
| **OpenClaw** | **`sessions_spawn`** (optional visible subagent) | **Approach 1** |

! Treat OpenClaw with `sessions_spawn` as **Tier 1** — the same class as Warp / Grok Build / Cursor — not as an interactive-only shell that forces main-session poll loops.

! Gate tiers, dispatch primitives, and review Approaches are defined in shipped skill text (not invented here):

- Swarm capability matrix + launch path: [`skills/deft-directive-swarm/SKILL.md`](../skills/deft-directive-swarm/SKILL.md) (Phase 3 runtime detection / launch adapter).
- PR babysit / shepherd / watch: [`skills/deft-directive-review-cycle/SKILL.md`](../skills/deft-directive-review-cycle/SKILL.md) → **Review Monitoring** → **Approach 1**.
- Provider-neutral dispatch envelope: [`templates/agent-prompt-preamble.md`](../templates/agent-prompt-preamble.md).

⊗ Invent a parallel “OpenClaw-only” review gate that bypasses `deft-directive-review-cycle` or redefines Approach 1 semantics in this doc.

---

## First-session: babysit → `sessions_spawn`

**Operator says:** “babysit this PR”, “shepherd”, “watch the PR”, or equivalent PR-shepherding intent on a Deft-managed repo (`.deft/core/` present, or framework checkout with Directive skills).

**Expected path:**

1. ! Load **`deft-directive-review-cycle`** — not a host-global babysit skill and not a freestyle `gh` poll loop in the main session ([#2261](https://github.com/deftai/directive/issues/2261) class; same supersession idea as Cursor-global babysit).
2. ! When OpenClaw exposes **`sessions_spawn`**, use **Review Monitoring Approach 1**: background-spawn a review-monitor subagent via `sessions_spawn` (prefer **visible** when Control UI is the control plane — see below).
3. ! Register ownership with the shipped review-monitor gate after spawn (`task review-monitor:register` / `task verify:review-monitor`) as described in the review-cycle skill — do not claim “monitoring” without the skill’s register/verify contract.
4. ! Prefer deterministic wait language from the skill (`task pr:watch` when available) over inventing sleep/cron loops.
5. ⊗ Treat **OpenClaw cron alone** as Approach 1. Cron / scheduler re-invocation is a **fallback** class (closer to Approach 2) when spawn is unavailable — never a substitute for a live `sessions_spawn` review-monitor when spawn works.
6. ⊗ Block the main session with long `gh` poll + sleep while `sessions_spawn` is available (#1880 Gap D / incident class on epic #2874).

Authoritative wording for Approaches, register primitives, and exit predicates lives only in the skill files linked above. This section is the **discovery map**, not a second contract.

---

## Control plane preference (operator signal)

When multiple OpenClaw surfaces are available:

| Surface | Role |
|---------|------|
| **Control UI** | Default **control plane** for long infra work and **visible** subagent watch (review-monitors, swarm leaves). |
| **Telegram** (or similar mobile chat) | Remote/mobile chat; not the preferred surface for long blocking polls. |
| **TUI** | Break-glass local terminal — use when UI/channels are unavailable. |

~ Prefer **visible** `sessions_spawn` review-monitors when Control UI is in play so the operator can see the subagent without freezing the parent conversation.

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
3. On first PR shepherding request, open **`deft-directive-review-cycle`** and take **Approach 1 + `sessions_spawn`** when available (section above).
4. For multi-story parallel work, follow **`deft-directive-swarm`** — do not hand-roll worktree orchestration outside the skill.
5. Keep CHANGELOG / xBRIEF / branch gates the same as on Cursor or Warp; the host changes the **spawn primitive**, not the Directive lifecycle.

---

## Related epic slices (pointers only)

These siblings own implementation; this doc does not redefine them:

| Issue | Topic | Where the contract lives when shipped |
|-------|--------|----------------------------------------|
| [#2875](https://github.com/deftai/directive/issues/2875) | Swarm matrix + `openclaw` descriptor + `verify:openclaw-tier1` | `deft-directive-swarm` + engine launch adapter |
| [#2876](https://github.com/deftai/directive/issues/2876) | Review-cycle names OpenClaw `sessions_spawn` Approach 1; cron ≠ Approach 1 | `deft-directive-review-cycle` |
| [#2879](https://github.com/deftai/directive/issues/2879) | Poller/preamble templates + heartbeat mapping | `templates/*`, `docs/subagent-heartbeat.md` |
| [#2878](https://github.com/deftai/directive/issues/2878) | Consumer `pr:watch` / official gh fallback | skill or consumer Taskfile guidance |

---

## Anti-patterns

- ⊗ Main-session `gh` poll + **cron** as the default babysit path when `sessions_spawn` is available.
- ⊗ Inventing skill gate semantics in operator docs instead of linking to shipped `SKILL.md` text.
- ⊗ Treating `content/platforms/` hardware packs as the home for agent-host OpenClaw guidance.
- ⊗ Substituting host-native review theater for `deft-directive-review-cycle` on Deft-managed repos.

---

## See also

- [QUICK-START.md](../QUICK-START.md) — install / AGENTS.md refresh entry
- [getting-started.md](./getting-started.md) — orientation lifecycle
- [skill-pin-policy.md](./skill-pin-policy.md) — always-pin process skills (includes review-cycle)
- [`skills/deft-directive-review-cycle/SKILL.md`](../skills/deft-directive-review-cycle/SKILL.md)
- [`skills/deft-directive-swarm/SKILL.md`](../skills/deft-directive-swarm/SKILL.md)
- [`templates/agent-prompt-preamble.md`](../templates/agent-prompt-preamble.md)
