# Host lifecycle duty list (#2968 / A3)

Stable moments where a **host** (IDE deposit or session-first workspace) must load
Directive’s portable brain (Skills Index, pins, main.md / AGENTS.md) before freestyle
tools. Short duty list — not a multi-host platform RFC.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `≉`=SHOULD NOT, `⊗`=MUST NOT, `?`=MAY.

Related: OpenClaw cold-start adapter
[`../skills/deft-directive-swarm/references/host-openclaw.md`](../skills/deft-directive-swarm/references/host-openclaw.md) (A7),
skill pins [`../docs/skill-pin-policy.md`](../docs/skill-pin-policy.md) (#2508),
session routing in AGENTS.md (#2176), cold-start algorithm orientation (#609).

## Two host families

| Family | Typical hosts | How Directive loads |
|--------|---------------|---------------------|
| **1 — IDE / repo deposit** | Cursor, VS Code-class | Open folder → installer rails / deposit → agent already on project root |
| **2 — Session / workspace / companion** | OpenClaw, Buzz-class | Agent awake in workspace home; host skill list ≠ Directive Skills Index until bridged |

! Directive **writes** host adapters. Host vendors expose extension points; they are not required to ship Directive adapters.

⊗ Wait on Cursor / OpenClaw / Buzz vendors to implement our adapter for cold-start correctness.

## Duty table (stable moments)

| Moment | Duty |
|--------|------|
| **Session start** | Resolve **project root** (WSL / dual-path SoT when applicable). Know how to reach the **Skills Index** (consumer: `npx deft packs:slice skills list` text form, not `--json`; framework: root `REFERENCES.md`). Optional session ritual when mutation intent applies (`session:start` / `#1149`). Confirm Deft alignment when USER.md is present (#2176). |
| **Deft-shaped user intent** | Route via **Skills Index / skill trigger path before freestyle host tools**. Prefer **pinned Directive skills** over same-named host skills (e.g. Cursor `/review` or host “review” ≠ `deft-directive-article-review` / `deft-directive-review-cycle`). |
| **Tool boundary** (optional) | Classifier hook / write-intent path when installed (#2967 A2 class). Graph append when installed (#2966 A1 class). Not required for this first cut. |
| **Turn / session end** (optional) | Evidence flush / MEMORY note of which skill path ran, for APE continuity. |

### Deft-shaped intent (examples)

Treat as Deft-shaped when the user asks for skills, review, triage, swarm, build, pre-PR, article review, consumer-repo Directive work, xBRIEF lifecycle, or equivalent process verbs.

! On Deft-shaped intent: scan Skills Index (Level-0) → open matching `SKILL.md` (Level-1) **before** freestyle `gh` / shell / host-global skill improvisation.

! Prefer always-pin Directive skills (`deft-directive-build`, `deft-directive-pre-pr`, `deft-directive-review-cycle`, `deft-directive-swarm`) when the work type matches (#2508).

⊗ Answer a Deft-shaped request with only host-global tools or same-named host skills when a Directive skill is in the Skills Index for that intent (2026-07-30 miss class: “use review skill” + URL never entered `deft-directive-article-review`).

## Family-1 reference: Cursor deposit

Cursor / project-deposit remains the **family-1 reference adapter**:

1. Open repo at project root.
2. Deposit / AGENTS managed section points at Skills Index and pins.
3. Session routing loads main → USER → PROJECT-DEFINITION before mutation.

### Cursor parity checklist

| Check | Status |
|-------|--------|
| Project root = opened workspace folder | **Pass** (host default) |
| Skills Index reachable from AGENTS managed section | **Pass** when deposit current |
| Always-pin names for process skills | **Pass** when AGENTS pin section present (#2508) |
| Plan-mode / product action bypass of skill path | **Known gap** — plan-mode and host product actions can skip skill load (#1708 class); fix on Cursor adapter only when cold-start or skill route still fails |
| Same-named host skill vs Directive skill | **Known gap** — prefer Directive pin / Skills Index match over host `/review`-class labels |

## Family-2 first ship: OpenClaw (A7)

OpenClaw cold-start steps live in the swarm host adapter (source of truth for spawn + cold-start on that host):

[`../skills/deft-directive-swarm/references/host-openclaw.md`](../skills/deft-directive-swarm/references/host-openclaw.md) § Cold-start.

Operator map (non-authoritative discovery): [`../docs/openclaw-agent-host.md`](../docs/openclaw-agent-host.md).

### OpenClaw pin wire (doctor) (#3001)

Session-first hosts still need a **bridge** from the installed content package into the host workspace skills root. On OpenClaw:

- ! `deft doctor` detects missing always-pins under `$OPENCLAW_STATE_DIR/workspace/skills` or `~/.openclaw/workspace/skills` when OpenClaw signals are present.
- ! `deft doctor --fix` deposits/links the four always-pins (build, pre-pr, review-cycle, swarm) into that main skills root (symlink preferred; copy fallback). Non-destructive of other user skills.
- ⊗ Rewrite every `workspace-*` crew seat by default — multi-seat only with `deft doctor --fix --openclaw-all-agents`.

Full operator steps: [`../docs/openclaw-agent-host.md`](../docs/openclaw-agent-host.md) § Wire skills into OpenClaw workspace.

## Extension notes (out of first ship)

| Host / class | Note |
|--------------|------|
| **Buzz / Pi** | Session-first family-2 peers. Implement a dedicated `host-*.md` adapter when scheduled; reuse this duty table. Do not invent full platform abstraction in this cut. |
| **Warp / Grok Build** | Family-1-adjacent spawn hosts; deposit + AGENTS still own session orientation. Swarm launch adapters are separate from cold-start Skills Index load. |

## Content-surface honesty (#3162)

Session start records a **host content-surface class** (`file-first` / `repl-first` / `self-mutating` / `unknown`) and managed AGENTS section drift. Operators set `DEFT_HOST_CONTENT_SURFACE` (or REPL / self-mutate env flags) when the host is not file-first.

! Do not assume file gates or agent-only pins see host-kernel work product or host refine CRUDs.

Full honesty matrix and Tier-1 hook home: [`../docs/host-surface-assumptions.md`](../docs/host-surface-assumptions.md). Stance #3164 unchanged.

## Anti-patterns

- ⊗ Freestyle host tools first on Deft-shaped intent, then maybe open a skill.
- ⊗ Treat host skill inventory (`available_skills`, workspace skill folders) as the Directive Skills Index without a bridge.
- ⊗ Assume IDE deposit behavior on a session-first host that started outside the project root.
- ⊗ Abstract multi-host portability RFC with zero OpenClaw (or second-family) behavior change.
- ⊗ Assume file/git gates saw REPL-kernel or mid-run host-refine work product (#3162).

## Acceptance pointer

Issue [#2968](https://github.com/deftai/directive/issues/2968): A3 = this contract; A7 = OpenClaw cold-start in `host-openclaw.md`. First cut closes when both surfaces land and `task verify:openclaw-tier1` stays green.
