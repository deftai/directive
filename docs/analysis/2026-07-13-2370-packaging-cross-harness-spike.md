# Packaging cross-harness spike (#2370)

**Date:** 2026-07-13  
**Epic:** [#2369](https://github.com/deftai/directive/issues/2369) Wave 3  
**Issue:** [#2370](https://github.com/deftai/directive/issues/2370)  
**Status:** Research complete — **GO** for distribution-layer packaging action

## Executive summary

Wave 2 relocation compressed always-on guardrails but the **total injected always-on surface is still ~2.1× the ≤8192 B north-star** on every harness we measured. The dominant cost is the managed AGENTS.md section (~16.8 KB ratchet); on Cursor, DD-3 skill frontmatter adds another ~7.7 KB for all 20 live skills.

**Recommendation:** adopt **distribution-layer (A)** — not runtime-router (B) — with **OpenPackage as the primary cross-harness install/sync mechanism**. Bridge (`deftai/bridge`) remains an ACP transport/transceiver layer; it does not replace a packaging tool. Tier skills (daily-core vs standard vs advanced) inside the package manifest so native-skill harnesses do not pay frontmatter cost for deferred workflows.

Adjacent (cite only): [#2436 SkillOpt](https://github.com/deftai/directive/issues/2436), [#2437/#2438 host hooks](https://github.com/deftai/directive/issues/2437).

---

## 1. Distribution-layer (A) vs runtime-router (B)

| Criterion | A — Distribution-layer | B — Runtime-router |
|---|---|---|
| Model | Author once → install into each harness's **native** skill/rule format | Directive-owned router bypasses native discovery/routing |
| Routing | Harness native frontmatter + lazy skill load | Reimplements routing in always-on runtime |
| Risk | Low — uses platform UI, lazy-load, proven skill ecosystems | High — LCD degradation, maintenance treadmill, may **add** always-on weight |
| Fit with DD-1 | Workflows → skills (distributable); guardrails → gates + one-line imperatives | Collapses content types; guardrails become discretionary |

### Decision: **A (distribution-layer)**

Rationale:

1. **Do not let "handler" pre-decide B.** The npm engine (`@deftai/directive` / `.deft/core/`) is already the runtime handler for gates, lifecycle, and install refresh. That is not the same as a cross-harness skill router — conflating them would duplicate what Cursor/Claude Code/Codex already do well (native skill indexes, progressive disclosure).
2. **B adds weight, not removes it.** A router that intercepts skill selection must ship policy in the always-on envelope (or a bootstrap hook). Either path fights the epic's thin-always-on goal.
3. **Pointer-sufficient contract (#2371) assumes native homes.** Wave 2 moved bulk to `commands.md`, `scm/github.md`, and skills precisely because those surfaces lazy-load. A runtime router would undo that contract.

**Not chosen:** pure B. **Optional future:** Bridge as transport only (ACP proxy) where a harness lacks a native API — orthogonal to packaging.

---

## 2. OpenPackage vs Bridge-native

### OpenPackage ([openpackage.dev](https://openpackage.dev/docs))

- **Maturity:** Active OSS package manager (enulus/OpenPackage); documents 30+ platforms with directory/root-file mapping ([platforms table](https://openpackage.dev/docs/platforms)).
- **Cross-harness coverage:** Cursor (`.cursor/`, `AGENTS.md`, skills/, rules/), Claude Code, Codex CLI, OpenCode, Copilot, Cline, etc. — single `openpackage.yml` → platform-specific install paths.
- **Skill format:** Native `skills/` tree with SKILL.md — matches Directive's existing `content/skills/` shape and packs pipeline.
- **Longevity / lock-in:** Open spec + local `platforms.jsonc` overrides; packages are plain directories in-repo or registry snapshots. Lock-in is low — uninstall reverses file placement.
- **Directive fit:** Consumer install already deposits `.deft/core/` + rendered `AGENTS.md`; an OpenPackage layer can wrap **daily-core entrypoints** (thin AGENTS.md pointer + tiered skills + rules) without forking the npm engine.

### Bridge-native (`deftai/bridge`)

Research pulled from `deftai/bridge` via GitHub REST (README, `docs/BRIDGE-README.md`, `BRIDGE-PI-API-MODULE.md`, `packages/acp-tester-core/src/plugin-system.ts`):

- **What Bridge is:** TypeScript ACP heterogeneous adapter / LLM backend proxy (Rete.js pipeline graphs, OpenAI/Anthropic/Pi transports). Active implementation; **not** a skill or AGENTS.md packager.
- **Plugin surface:** `ToolTesterPlugin` in acp-tester is an **experimental trusted-code hook** for scenario/regression/conformance runs — not a cross-harness skill distribution channel.
- **Skills ecosystem doc:** `.deft/core/docs/thousand-skills.md` is a curated market survey (Claude Code skills repos) — research input, not a Bridge distribution API.
- **Cross-harness:** Bridge normalizes **LLM API** calls, not IDE skill installation. No manifest → `.cursor/skills` sync.

### Decision: **OpenPackage primary; Bridge orthogonal (hybrid at ecosystem level only)**

| Layer | Owner | Role |
|---|---|---|
| Engine / gates | `@deftai/directive` npm payload | Runtime handler, `task`/`deft` gates, xBRIEF lifecycle |
| Distribution / install sync | **OpenPackage** | Cross-harness file placement, tiered skill packages |
| Transport (optional) | Bridge | ACP/LLM proxy when a harness needs backend normalization — **not** Wave 3 packaging |

**Not chosen:** Bridge-native as the packaging mechanism — wrong abstraction layer; would require building a new distribution API on top of ACP plumbing.

---

## 3. Measured bootstrap (DD-3 included)

**Method:** `task verify:agents-md-budget` (2026-07-13, post-#2452) + local script `.deft-scratch/measure-bootstrap-2370.mjs` parsing all 20 `content/skills/*/SKILL.md` frontmatter descriptions in Cursor `<agent_skill>` injection shape. Bootstrap hooks: 0 B today (`deft-hook` #2438 not shipped).

**Budget references:**

- North-star: **≤8192 B / ~2000 tok** (#2372)
- Fail-closed ratchet: **absoluteMaxBytes = 16843** (managed section only; DD-3 excluded from meter today per `packages/core/src/agents-md-budget/evaluate.ts`)

### Prototype: daily-core tier

Epic DD-2 tiers **daily core** as always-on pointers. Prototype package = six skills: `setup`, `sync`, `build`, `pre-pr`, `review-cycle`, `triage` (orient / configure / scope / build / review entrypoints). Advanced skills (`release`, `swarm`, `debug`, `article-review`, …) ship in the package but **outside** the always-injected tier on native-skill harnesses.

### Measurement table

| Harness class | AGENTS.md managed (always-on) | Skill frontmatter injected (DD-3) | Bootstrap hooks | **Total always-on** | Δ vs 8192 B north-star | Δ vs absoluteMaxBytes |
|---|---:|---:|---:|---:|---:|---:|
| **Cursor** — all 20 skills | 16,843 B | 7,657 B | 0 B | **24,500 B** (~6.1k tok) | +16,308 B | +7,657 B |
| **Cursor** — daily-core tier (6) | 16,843 B | 2,080 B | 0 B | **18,923 B** (~4.7k tok) | +10,731 B | +1,080 B |
| **Codex CLI** — no native skill injection* | 16,843 B | 0 B | 0 B | **16,843 B** (~4.2k tok) | +8,651 B | at ratchet |
| **OpenCode** — no native skill injection* | 16,843 B | 0 B | 0 B | **16,843 B** | +8,651 B | at ratchet |

\*Skills on disk under harness-specific paths after OpenPackage install; descriptions are **not** injected into every session — discovery is on-demand via SKILL.md load or operator trigger. Fallback for non-native harnesses: one-line "scan skills before improvising" nudge in AGENTS.md (Q1 / DD-1) plus OpenPackage sync — no hand-maintained skill index in AGENTS.md.

### Interpretation

1. **Moving bulk to skills alone does not hit the north-star on Cursor.** Even after #2451 removed eight stub skills, 20 live skills cost ~7.7 KB of always-on frontmatter — DD-3 was correct to flag this.
2. **Daily-core tiering is necessary but not sufficient.** Tiering cuts frontmatter ~73% (7657 → 2080 B) yet total Cursor bootstrap stays ~18.9 KB because managed AGENTS.md dominates.
3. **Further managed-section thinning is the critical path** to ≤8192 B total — packaging enables tiered delivery but does not replace relocation/thinning work already tracked under #2369.
4. **No-native-skill harnesses look thinner on paper** but pay the same AGENTS.md managed cost and lose native discovery — OpenPackage install + pointer nudge is the fallback (Child A resolution for Q1).

Top frontmatter offenders (Cursor): `deft-directive-article-review` (608 B), `deft-directive-debug` (600 B), `deft-directive-release` (536 B) — candidates for **advanced/deferred** tier, not daily-core.

---

## 4. Go / no-go

### Verdict: **GO** — proceed with Wave 3 packaging action

Packaging is unblocked. The spike confirms:

- **A over B** is the correct architecture.
- **OpenPackage** is the viable cross-harness distribution path; Bridge is not a substitute.
- Measurements justify **tiered packages** and **DD-3 meter extension** before claiming north-star compliance.

### Blockers (none fatal — tracked as follow-ons)

| Blocker | Mitigation |
|---|---|
| Managed section still ~16.8 KB | Continue epic thinning; packaging ships tiered skills in parallel |
| DD-3 not in `verify:agents-md-budget` | Follow-on gate story |
| Tier-1 bootstrap hooks (#2438) | Adjacent; 0 B today |
| Non-native harness discovery | OpenPackage platform sync + one-line AGENTS.md nudge |

### Recommended follow-on actions

1. **OpenPackage manifest** for `@deftai/directive` consumer content: daily-core / standard / advanced skill tiers + thin AGENTS.md template.
2. **DD-3 gate extension** — include harness-injected skill frontmatter in budget reporting (and optionally fail-closed caps per tier).
3. **Install docs** — `deft setup` / UPGRADING path documents OpenPackage install alongside npm engine.
4. **Do not** build a Directive runtime skill router (B).

---

## 5. Adjacent trackers (cite only)

- [#2436](https://github.com/deftai/directive/issues/2436) — SkillOpt control stack for skill optimization pilots.
- [#2437](https://github.com/deftai/directive/issues/2437) / [#2438](https://github.com/deftai/directive/issues/2438) — Tier-1 agent host hooks (`deft-hook`); future bootstrap-hook bytes.
- [#2372](https://github.com/deftai/directive/issues/2372) — Layered budget instrument (north-star vs ratchet).

---

## Reproducibility

```bash
task verify:agents-md-budget
node .deft-scratch/measure-bootstrap-2370.mjs
```

Measurement captured at maintainer HEAD `f486303b` (post-#2452), branch `swarm/wave3-packaging-spike/2370-packaging-spike`, 2026-07-13.
