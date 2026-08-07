> **Worked example** for **#3198** (portfolio prioritization). Process/skill ownership lives on that issue; this file is the dogfood artifact (patterns `no_match` cluster, 2026-08-07). Re-run by recipe on #3198 / agent handoff — not a `task` verb yet.
## Pilot priority brief — patterns cluster (propose-not-apply)

**Issue:** #3198 (this process)  
**Parent tracker:** #886  
**Generated:** 2026-08-07T18:02:11.340Z  
**Stance:** propose-not-apply (#3179) — **no SCM label writes**, no scope lifecycle  
**Epistemic method:** classify dry-run partition + cache bodies; **live `gh api` verify** for shortlist issue numbers/states/titles (2026-08-07 session)

### Dispose path (required close)

This brief is **not** a decision record. Operator should dispose shortlist/park rows into:

1. **#1396**-shaped decision log (or interim comment on #3198 / #886 until #1396 ships), and/or  
2. **plan-sequence** for promote candidates  

Without dispose → re-litigation forever (#2741 class).

---

## Scope of this pilot

| Filter | Result |
|--------|--------|
| Open issues with `patterns` / `patterns:*` label (cache) | **105** |
| Of those, mirror `no_match` | **92** |
| Of those, already planned (defer/escalate/…) | **13** |

**Not in this pilot:** full-repo portfolio, skills-only cluster, visionik author filter alone (many patterns authors overlap visionik).

### Label subbuckets (`no_match` only)

| Subbucket | Count (approx from pilot extract) |
|-----------|-------------------------------------:|
| patterns-bare | 40 |
| patterns:agent-app | 19 |
| patterns:multi-agent | 12 |
| patterns:contracts-verification | 11 |
| patterns:agent-memory | 10 |

### Title/theme families (`no_match`)

| Family | ~Count |
|--------|-------:|
| agent/harness | 34 |
| docs/patterns | 34 |
| skills | 10 |
| swarm/orchestration | 7 |
| review/ship | 2 |
| other | 5 |

---

## Interrupt / non-portfolio (do not rank against RFC park list)

These are **A-side** or already dispositioned — keep off the deep-dive shortlist:

| # | Verified state | Role |
|--:|----------------|------|
| **#3086** | open | Planned **escalate** (agent-safety) — harness tool-dialect failure catalog; human interrupt, not portfolio rank |
| **#3158** | open | Planned **defer** (hold-marker) — retained addressable sub-agents; review hold before stamp |
| **#3086 / #3155 / security swarm** | — | Safety-adjacent work belongs in escalate/human stack or swarm trackers, not “which pattern doc first” |

Live verify: #3086 open; #3158 open.

---

## Conflict / family matrix (verified bodies + live state)

### F1 — Agent-app architecture stack (Capsule-sourced pattern pack)

| # | State | Title (verified) | Body claim (cache) |
|--:|-------|------------------|--------------------|
| **#842** | open | four-layer-agent-app | Four layers; anti-pattern: all in message handler; refs #808,#820,#822,#839,#841 |
| **#841** | open | agent-app-state-taxonomy | Three state tiers; refs #833,#834,#809,#839 |
| **#840** | open | per-user-isolated-runtime | Isolate per user not per request; refs #679,#677,#708,#808 |
| **#839** | open | one-definition-multiple-surfaces | One app definition SoT; refs #807,#809,#517 |

**Conflict/overlap:** Not mutually exclusive — they form a **layer cake**. Risk is **four parallel pattern docs** without a single index epic, or implementing one without the state/isolation peers.

**Recommendation:** Treat as **one pack** under a thin tracker or ordered children: #839 (definition SoT) → #841 (state) → #840 (isolation) → #842 (layers). Park other agent-app atom issues (#819,#817,#809,…) until pack index exists.

### F2 — Tool surface / harness reliability

| # | State | Title | Notes |
|--:|-------|-------|-------|
| **#3085** | open | tool-surface grammar (flat params) | Body refs #1167,#2593,#1170,#3078,… — grammar for tool schemas |
| **#3086** | open | harness tool-dialect failure catalog | **Escalate** path; pairs with #3085 thematically but different urgency |

**Recommendation:** Shortlist **#3085** for patterns deep dive; keep **#3086** on interrupt/escalate queue (already matched agent-safety). Do not park #3086 as “later pattern content.”

### F3 — Local/CPU serving cost

| # | State | Title | Notes |
|--:|-------|-------|-------|
| **#3082** | open | **epic** local/CPU LLM serving cost | **Current shape (pass-1):** program home for local/CPU serving cost; S1 next = #3066; #3065 related not child; sibling #3078 |
| **#3066** | open | cost model (prefill, vocab, RAM↔speed) | Leaf model content (current-shape open child of #3082) |
| **#3065** | open | structural binding / fact-sheet form | Related context form; current-shape: prefill complement, **not** a child of #3082 |

**Recommendation:** Prefer **epic #3082 as home** (ownership/wave from **current-shape comment**, not issue body alone — #1152 / #2066). Deep-dive **#3066** as first child content; park #3065 as related root. Verify #3078 if claiming cost-stack separation (**follow-up probe before dispose**).

### F4 — Inter-run / agent memory

| # | State | Title | Notes |
|--:|-------|-------|-------|
| **#2741** | open | Epic: inter-run memory & learning | **Current shape (pass-2):** Memory SoR this epic (not #1545); Wave 0 includes #2742,#688,**#978**; Wave 1 #832–#834; closed #2700 abandoned |
| **#978** | open | agent-memory-selection decision guide | Current-shape open child of #2741 (Wave 0); no standalone current-shape comment |

**Recommendation:** **#2741** is directive product epic (ownership/children/wave from **current-shape**, not body alone — #1152 / #2066). Shortlist **#978** as portable patterns deliverable **under** #2741 Wave 0 narrative; do not open a second memory epic. Atom issues #832–#834 are Wave 1 children — park as standalone roots.

### F5 — Contracts / goals / verifiable specs

| # | State | Title | Notes |
|--:|-------|-------|-------|
| **#685** | open | agent-contracts (DbC) | Paper-sourced formal contracts |
| **#852** | open | goal-gate-determinism | Goals/gates rigid; path flexible; refs #782,#805,… |
| **#971** | open | executable-enforcement-surface | Handoff as CLI; refs #852,#782 |
| **#973** | open | machine-verifiable-spec | Atomic claims + shell gates; refs #852,#971 |

**Conflict:** #685 (formal behavioral contracts) vs #852/#971/#973 (goal-gate + executable verification) are **complementary** if scoped: #852 family is closer to current Directive skills/gates (#3179 propose-not-apply); #685 is heavier research.

**Recommendation:** Shortlist **#852 → #971 → #973** as a **verification spine** aligned with dogfood; park **#685** as research until spine exists (or merge as “formal methods appendix”).

### F6 — Multi-agent / A2A topology

| # | State | Title | Notes |
|--:|-------|-------|-------|
| **#3155** | open | nuclear-family A2A topology | Body: **Extends #2705** (verified open: A2A client posture ADR); related #2706,#2707 |
| **#2705** | open | A2A client posture ADR | Parent posture doc |

**Recommendation:** Shortlist only if swarm/security wave is active capacity; else **park under #2705**. Not first patterns-content win; topology is product-sensitive.

---

## Shortlist (deep dive / promote candidates)

Ordered for **maintainer capacity** this month — **proposal only**:

| Priority | # | Why |
|--------:|--:|-----|
| P1 | **#852** | Goal-gate determinism aligns with #3179 / skill quality; unlocks #971/#973 |
| P1 | **#3085** | Tool-surface grammar — high leverage for harness reliability; pairs with escalate #3086 |
| P2 | **#839+#841+#840+#842** | Agent-app pack (ordered as pack, not four competing roots) |
| P2 | **#978** (via #2741) | Memory selection guide; epic already owns directive memory |
| P3 | **#3066** (via #3082) | Local/CPU cost model when epic prioritized |
| P3 | **#971 / #973** | After #852 |

Live-verified open: #852, #3085, #839, #841, #840, #842, #978, #2741, #3066, #3082, #971, #973.

---

## Park list (do not deep-dive as roots now)

| Class | Examples (verified open unless noted) | Park reason |
|-------|----------------------------------------|-------------|
| Agent-app atoms without pack index | #819, #817, #809, #807, #780, #779, … | Fold into F1 pack later |
| Memory atoms | #832, #833, #834, #823, #821, #820 | Material for #2741 / #978 |
| Older multi-agent scatter | #519, #520, #521, #553, #687, #808, #822 | Superseded-in-spirit by later swarm work; **do not claim closed supersession without body proof** — park as “revisit after #3155/#2705” |
| Web stack opinions | #484, #544 | Different product surface; low urgency for framework core |
| Planned defer/hold patterns | #487, #621, #625, #853, #2436, … | A-side hold/rfc — fix false holds before stamp; not B shortlist |
| Research eval bias etc. | #683, #688 | Explicit research; park until product epic pulls them |

---

## Planned patterns rows (A-side — for hold preflight, not rank)

| # | Action | Rule |
|--:|--------|------|
| 3158 | defer | universal:hold-marker |
| 3086 | escalate | consumer[4] |
| 2966 | defer | consumer[13] |
| 2436 | defer | universal:hold-marker |
| 1975 | defer | consumer[9] |
| 1498 | defer | consumer[9] |
| 958 | defer | consumer[9] |
| 853 | defer | universal:hold-marker |
| 688 | defer | consumer[9] |
| 683 | defer | consumer[9] |
| 625 | defer | universal:hold-marker |
| 621 | defer | universal:hold-marker |
| 487 | defer | universal:hold-marker |

---

## Epistemic limits of this pilot

- Cluster membership from **cache labels** + classify `no_match`; cache may lag live labels (see #3197 visibility lesson).  
- Supersession among older multi-agent issues is **park-by-theme**, not “#X closes #Y” (would require per-issue comment proof).  
- #3078 cost-stack separation cited only via #3082 body — probe before investing.  
- Full 92-issue list not re-pasted; subbucket counts from pilot extract.

---

## Operator dispose checklist

- [ ] Accept / edit shortlist order  
- [ ] Accept park classes  
- [ ] Record dispose on #3198 or #1396 decision log  
- [ ] Optional: plan-sequence entries for P1 only  
- [ ] Do **not** treat this brief as mirror apply plan  

---

## Process verdict (dogfood of #3198)

**Useful?** Yes as a **slice**: families + shortlist + park + explicit non-goals beat a flat 92-issue queue.  
**Skill-ready?** After 1–2 more pilots (e.g. rfc/research family) and a fixed template + citation gate checklist in SKILL.md.  
**Does not replace:** #1423 apply preflight, `triage:queue`, or #1419/#1511 post-promotion prioritization.

