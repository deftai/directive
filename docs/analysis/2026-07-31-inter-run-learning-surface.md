# Inter-run learning surface (Directive-native memory contract)

**Status:** Accepted design note (Wave 0 on-ramp)  
**Issue:** [#2742](https://github.com/deftai/directive/issues/2742)  
**Epic:** [#2741](https://github.com/deftai/directive/issues/2741)  
**Supersedes:** [#2700](https://github.com/deftai/directive/issues/2700) memory-contracts RFC solution shape  
**Date:** 2026-07-31  
**Audience:** Maintainers and pattern authors attaching memory work under epic #2741

---

## 1. Problem

Recurring agent work (daily loops, weekly refinement, multi-PR review cycles) restarts cold. Agents lack a durable, bounded record of what was tried, what feedback arrived, and what to try next. They re-solve the same problem, miss change signals, and cannot compound strategy.

#2700 proposed free-floating **memory contracts** (`swarm/agent-memory.md`, `x-vbrief/agent-memory`). That solution shape is abandoned. The **problem statement is preserved**. This note defines Directive’s inter-run learning surface as a contract over **existing sources of truth**, with explicit tiers, budgets, and freeze rules.

---

## 2. Design principles (binding)

These match epic #2741 principles and bind pattern issues under this epic:

1. **Git-inspectable by default** — Prefer files + `grep` / FTS until a documented step-up signal (#688).
2. **Budgets are real** — Always-in-context stores declare ceilings and consolidate before append (#833).
3. **Freeze at session start** — Hot memory for a session is a snapshot; mid-session disk writes do not mutate the injected hot view until the next session (#832).
4. **Agent-written memory is not ground truth** — Trust, confidence, and false-memory controls are first-class (#479, #835).
5. **Operator closes the learning loop** — Epoch improvements are reviewed, not silently self-reinforced.

**Memory definition (Directive):** curated, bounded, git-inspectable state with operator feedback — not an unbounded retrieval corpus the agent writes into freely.

---

## 3. Inventory of existing memory-like SoTs

These surfaces already act as inter-run memory. Wave 1+ work attaches budgets and freeze rules to them; it does not invent a parallel “agent-memory” store.

| Surface | Path / command | Memory role | Default tier |
|---------|----------------|-------------|--------------|
| **USER.md Personal** | Win: `%APPDATA%\deft\USER.md`; Unix: `~/.config/deft/USER.md`; override `$DEFT_USER_PATH` | Operator prefs that always win over project and framework rules (addressing name, custom rules). Highest-precedence durable identity. | Hot (always-in at session start) |
| **Lessons / content packs** | `content/packs/lessons/`, `task packs:slice`, `meta/lessons.md` lineage | Codified institutional lessons and pack slices loaded on demand or by skill trigger. Durable, versioned knowledge. | Cold (on-demand); selected slices may promote to hot only under budget |
| **Triage / issue cache** | `xbrief/.triage-cache/`, `task triage:queue`, `task cache:fetch-all` | Cross-session ranked work selection and issue metadata so agents do not re-fetch GraphQL/REST every turn. Cache is operational memory of “what next,” not free-form narrative memory. | Cold (loaded by triage / cache verbs) |
| **Session ritual outputs** | `task session:start`, `.deft/ritual-state.json`, `task verify:session-ritual` | Worktree- and HEAD-bound alignment state, tool/doctor/cache freshness stamps, branch-policy disclosure. Ensures the session starts from a known hygiene baseline. | Hot for the session after ritual (frozen stamp; re-arm on compact) |
| **Decision / continue artifacts** | `xbrief/continue.xbrief.json` (legacy `vbrief/continue.*`), scope xBRIEF lifecycle, decision narratives on plan items | Interruption recovery and in-flight decisions. Continue is **ephemeral** (consumed on resume). Scope xBRIEFs and durable plan decisions are **durable** work memory. | Continue: cold/ephemeral; durable decisions: cold (load with scope) |
| **Working-memory scratchpads** | Ad-hoc files; `content/context/working-memory.md` | Intermediate externalization during a task. Not inter-run SoR; cleanup after task. | Ephemeral / not a memory tier |
| **Prompt-assembly / working context** | `content/patterns/prompt-assembly-layer-ordering.md` (#836) | How hot content is placed in the cached prefix vs ephemeral per-turn injections. Mechanism for freeze, not a store. | Cross-cutting (assembly) |

### Ranking guidance

| Priority for always-in (hot) | Rationale |
|-----------------------------|-----------|
| 1. USER.md Personal | Operator identity and always-wins rules |
| 2. Session ritual stamp + small active-scope summary | Hygiene + current work identity |
| 3. Explicitly selected pack/lesson slices under budget | Only when operator or skill pins them into hot |
| Rest | Cold retrieval: triage cache, full packs, continue, historical xBRIEF, docs |

⊗ Promote full triage caches, full conversation history, or unbounded lesson dumps into the always-in hot set.

---

## 4. Contract: hot / cold / operator-gated

### 4.1 Tier table

| Tier | Role | Bound / freeze / retrieval | Concrete budget or freeze rule |
|------|------|----------------------------|--------------------------------|
| **Hot** | Always-in-context for the session; highest leverage facts only | **Freeze at session start:** capture the hot snapshot once (ritual + USER.md + any pinned hot slices). Mid-session writes may land on disk but **must not** mutate the already-built system/hot injection until the next session (or an explicit re-arm such as post-compact ritual). | Declare a hard char/token ceiling for the hot set (Wave 1 implements numbers on Directive surfaces; Hermes-class reference: ~1.3k tokens total hot, USER.md-class ~500 tokens — #833). At ≥80% capacity, consolidate before append — never silent unbounded growth. |
| **Cold** | On-demand recall (“did we decide X last week?”) | **Retrieval-first:** `grep` / FTS / task verbs over git-inspectable files. No always-in injection. | Cold starts with **grep/FTS** over files under the repo and documented cache dirs. Step up to vector / graph only with a documented signal from #688 / #978 selection matrix. No default RAG over conversation logs. |
| **Operator-gated** | Learning that changes the next epoch’s strategy or hot set | Agent may **propose** (draft lesson, proposed USER.md edit, pack slice, epic note). Human **reviews and accepts** before the change enters the next session’s hot or durable cold corpus. | Epoch boundary = operator accept (PR merge, `USER.md` edit, pack promotion, explicit grant). Silent self-reinforcement of agent-written facts into hot is forbidden. |

### 4.2 Freeze-at-session-start (detail)

Aligned with #832 and #836 (cached prefix vs ephemeral injection):

- ! Build the hot snapshot once after session ritual (or read-only alignment for read-only sessions).
- ! Persist mid-session learning to disk (continue checkpoint, scope xBRIEF narratives, draft lesson files) without rewriting the live hot injection.
- ! After context compact / resume, re-arm ritual (`session.compact` → re-run gated ritual) so freeze semantics restart cleanly.
- ⊗ Mutate always-in hot memory mid-session as if it were a chat log.

### 4.3 Prefer git-inspectable files (#688)

Until Wave 0 decision framework (#688) and selection guide (#978) document a step-up:

1. **Tier 1:** Files in git or well-known project paths + `grep` / FTS.
2. **Tier 2:** Local structured indexes that remain inspectable (task/triage cache JSON).
3. **Tier 3:** Vector / graph / external memory services — only after an explicit selection decision for a **consumer project**, not as Directive’s default SoR.

Directive core memory SoR stays at Tier 1–2.

### 4.4 Trust posture

- Agent-written entries that will be re-injected later are **untrusted** relative to operator-authored USER.md and reviewed packs (#479, #835).
- Write path for durable memory: scan for injection / exfiltration patterns before accept (#835); prefer human or dual-control promotion for hot-tier content.
- False-memory controls: confidence, provenance, and invalidation paths belong on durable decision/lesson artifacts (#479) — not implicit chat retention.

---

## 5. Non-goals

| Non-goal | Why |
|----------|-----|
| **Mem0-style conversation RAG as default memory** | Unbounded retrieval corpus; fights budgets, freeze, and operator review. Consumer projects may choose RAG under #978; Directive itself does not default to it. |
| **`x-vbrief/agent-memory` / `swarm/agent-memory.md` pattern family** | Abandoned with #2700. Do not revive parallel vocabulary. |
| **Mid-session mutable always-in hot memory** | Breaks prefix cache and freeze contract (#832, #836). |
| **Full two-tier storage backend implementation in #2742** | This issue is design + docs only. Storage backends are later waves. |
| **Treating #1545 as memory SoR** | Orchestration contracts are adjacent; they do not own memory. |
| **Consumer Obsidian vault (#76) as core SoR** | Optional Wave 4 consumer guidance only. |

---

## 6. Retarget map (epic children → contract sections)

Pattern and research issues attach to this contract. They do **not** invent a second memory vocabulary.

| Issue | Title (short) | Wave | Target contract section | Implementation note |
|-------|---------------|------|-------------------------|---------------------|
| **#688** | Memory architecture decision framework (git+grep vs vector vs graph) | 0 | §4.3 Prefer git-inspectable; §4.1 Cold retrieval ladder | Write the decision tree for *when not* to escalate tiers; default remains files + grep. |
| **#978** | Agent-memory-selection guide (multi-session projects) | 0 / 4 | §4.1 Cold; §5 Non-goals (Mem0 not default); Wave 4 consumer guidance | Selection matrix for **projects built with** Directive; keep Directive core on this contract. |
| **#832** | Frozen-memory-snapshot | 1 | §4.2 Freeze-at-session-start; §4.1 Hot freeze | Apply to USER.md + ritual + pinned hot slices on Directive surfaces first. |
| **#833** | Bounded-agent-memory (hard budget, 80% consolidate) | 1 | §4.1 Hot budgets | Put concrete ceilings on USER.md Personal / hot assembly; consolidate before append. |
| **#834** | Two-tier-agent-memory (hot + cold FTS) | 1 | §4.1 Hot + Cold rows | Map Hermes hot/cold onto Directive SoTs in §3; no new store type required for v1. |
| **#835** | Memory-write-security-scan | 2 | §4.4 Trust posture | Scan agent-written durable memory before persistence/re-injection. |
| **#479** | Prevent false memory propagation / context rot | 2 | §4.4 Trust; §2 principle 4 | Provenance, confidence, invalidation on decision/lesson artifacts; anti-FMP rules. |
| **#1513** | Explicit knowledge codification after session | 3 | §4.1 Operator-gated; §3 Lessons/packs | Session-end propose → operator accept → packs/lessons. |
| **#1396** | Structured agent decision log | 3 | §3 Decision/continue; Cold | Durable decision log as cold git-inspectable artifact (not hot dump). |
| **#76** | Obsidian vault as structured agent memory | 4 | §5 Non-goals / optional consumer | Optional consumer pattern only; not Directive core SoR. |
| **#2700** | Agent memory contracts RFC | closed | Superseded by this note | Solution shape abandoned; problem preserved in #2742 / this doc. |

### Wave order (from epic #2741)

0. Decision framework + this bridge contract (#2742, #688, #978)  
1. Hot-path freeze / bound / consolidate on Directive surfaces (#832–#834)  
2. Safety and trust (#479, #835)  
3. Compounding after work (#1513, #1396)  
4. Consumer guidance / optional (#978 matrix, #76)

---

## 7. Vocabulary (use these terms; do not fork)

| Term | Meaning |
|------|---------|
| **Inter-run learning surface** | This contract: how Directive carries state across agent process restarts. |
| **Hot / cold / operator-gated** | The three tiers in §4.1. |
| **Memory SoT** | An existing Directive surface listed in §3 that holds durable or session-scoped learning. |
| **Freeze** | Hot snapshot fixed at session start (#832). |
| **Budget** | Hard ceiling on always-in content with consolidate-before-append (#833). |
| **Step-up signal** | Documented reason to leave git+grep for richer stores (#688). |

⊗ Introduce `agent-memory` file types, `x-vbrief/agent-memory` reference kinds, or Mem0-as-default as peer vocabulary for Directive core.

---

## 8. Discovery and linkage

- **Canonical design note:** this file — `docs/analysis/2026-07-31-inter-run-learning-surface.md`
- **Short discovery pointer:** `content/docs/inter-run-learning.md`
- **Skills Index entry:** `REFERENCES.md` (When Managing Context or Long Tasks)
- **Epic SoR:** #2741 current-shape comment (must link this path after merge)
- **Bridge issue:** #2742 (closes when this design is accepted via PR)

---

## 9. Exit criteria for #2742

- [x] Inventory of existing memory SoTs (§3)
- [x] Hot / cold / operator-gated contract with budgets and freeze (§4)
- [x] Non-goals including Mem0-default, x-vbrief/agent-memory, mid-session mutable hot (§5)
- [x] Retarget map for #688, #978, #832, #833, #834, #835, #479 (§6)
- [x] Discovery pointer (`content/docs/inter-run-learning.md`, `REFERENCES.md`) + CHANGELOG [Unreleased]
- [x] No storage backend implementation in this change set
- [x] Epic #2741 current-shape link (pass-2 comment edit on issue #2741)

---

## 10. References

- Epic #2741, bridge #2742, superseded #2700  
- Article cluster origin: `docs/article-review-2026-05-01-03.md` (Hermes memory issues #832–#835)  
- `content/patterns/prompt-assembly-layer-ordering.md` (#836)  
- `content/resilience/continue-here.md`, `content/context/working-memory.md`  
- `content/commands.md` (session ritual, triage)  
- `content/docs/writing-ste100.md` (prose bar for follow-on pattern docs)
