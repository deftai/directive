# OVPR harness primer (AI audience only)

**Audience:** AI agents / alternate harnesses about to triage, plan, implement, or design anything that intersects Directive install, pin, hooks deposit, entry guards, upgrade/repair/uninstall/doctor, or Windows/macOS invocation when the pin is missing.

**Human-facing folder map:** see [`README.md`](./README.md). This file is a denser machine-oriented context dump. Prefer it as the first read before inventing options.

**Status:** Active harness primer (not requirements). Normative ACs remain in `install-ovpr-requirements.md` / `install-ovpr-architecture.md`. Recent cohort closeouts are operator-supplied separately; do not invent ticket status from this file.

**Address the human operator as `polfer`.**

---

## 0. Why this primer exists

Harnesses repeatedly re-open settled OVPR decisions:

- Single exact pin under `node_modules/@deftai/directive-runtime`
- Global launcher `@deftai/directive` vs project runtime split
- What `install` / `install --repair` / `upgrade` / `uninstall` / `doctor` each mutate
- Dependabot (or any pin-only bump) + project PM install + AC8.6 automatic setup
- Committed thin host `.mjs` outer when the pin package is absent (macOS and Windows)
- How missing-pin recovery is worded (project `npm`/`pnpm` install first)

Those re-litigations burn context, spawn duplicate mega-specs (class: #5956), and collide with sealed tickets. **Treat OVPR requirements+architecture as closed design.** Implement residuals. Do not redesign the pin model to fit a wrapper, timeout, dispatcher, or dogfood convenience.

---

## 1. Authority order (fail closed on conflict)

| Rank | Artifact | Role |
| --- | --- | --- |
| 1 | [`install-ovpr-requirements.md`](./install-ovpr-requirements.md) (rev **v261027**) | **Normative product SoT** for install/upgrade/uninstall/repair/doctor/hook-deposit/entry guards |
| 2 | [`install-ovpr-architecture.md`](./install-ovpr-architecture.md) (same rev tags) | Compact shape (packages, verbs, host-hook outer map) |
| 3 | [`install-ovpr-human-test-plan.md`](./install-ovpr-human-test-plan.md) | HT cases; does not waive ACs |
| 4 | [`LLM-CONTEXT.md`](./LLM-CONTEXT.md) (this file) | AI harness primer / ownership boundary / anti-rathole — **not ACs** |
| 5 | [`install-ovpr-problem-ledger-2026-10-23.md`](./install-ovpr-problem-ledger-2026-10-23.md) | **Decision record / ticket map only** — not requirements |
| 6 | GitHub **Locked disposition** / `TRIAGED — do not re-adjudicate` comments | Seal projections of the ledger walk; implement, do not re-ARC |
| 7 | [`install-ovpr-implementation-strategy.md`](./install-ovpr-implementation-strategy.md) | Historical delivery narrative only |
| 8 | Epics / chat / ARC/APE drafts / bot redesigns | Advisory until folded into (1)/(2) by polfer |

**Conflict rule:** requirements win. Architecture explains shape. Ledger and Locked stamps explain *why a ticket was sealed*. They never relax an AC. Epics that contradict AC14.10 / AC8.6 / AC9.1 / AC9.12 lose.

**Closed design statement (requirements header):** Parts A–D / §A9 limitations are **accepted weighed decisions**. Do not re-adjudicate, “solve,” or reopen the overall solution because a limitation is inconvenient for a new harness idea.

**Rejected mega-spec:** `#5956` (tiered deadlines, D-9/AC8.6 rewrite, E1–E3 repair-primary allow-list, 0.129.x as SoT) is **COMPLETELY REJECTED / not_planned**. Do not reopen it. Do not import its items into OVPR docs.

---

## 2. OVPR definition (definitive scope)

**OVPR = One Version Per Repo.**

It is the **definitive product architecture** for how Directive is:

- installed
- pointed at
- repaired
- upgraded
- doctor’d
- uninstalled
- invoked so every surface uses the **project pin**

### Two packages only

| Package | Role | Where | Version that matters? |
| --- | --- | --- | --- |
| `@deftai/directive` | Thin **global launcher** | Once per machine (`npm i -g`) | Day-to-day: largely no |
| `@deftai/directive-runtime` | Exact **project pin** (commands, hooks payload, content, engine) | `package.json` + lockfile + `node_modules` | **Yes — this is the pin** |

Retired as consumer installs: `@deftai/directive-core`, `-content`, `-types`, Go `cmd/deft-install`, vendored `.deft/core` content copy.

### Five locked rules

1. **The repo decides.** Exact pin in package.json + lockfile is the only version statement for that repo.
2. **The runtime runs from the repo.** Inside a repo, product behavior comes from that pin’s `node_modules` tree.
3. **Everything product-content points into the package** under `node_modules/@deftai/directive-runtime/…` (skills, AGENTS managed section, git-hook/Taskfile resolution, pin `hook-bin.js` after guards).
4. **The global launcher is required** for named CLI bookends. Standard wiring recovery after packages exist: `npm i -g @deftai/directive` then `directive install --repair`. Do not teach npx/pnpm-exec as day-to-day identity.
5. **Mutating install commands** show a bounded plan, take one approval, verify. Doctor is read-only.

### OVPR vs DOGFOOD (do not conflate)

| Term | Meaning |
| --- | --- |
| **OVPR** | Consumer architecture: launcher + exact pin; hooks/skills/gates use that pin |
| **DOGFOOD** | Policy for `deftai/directive` itself: maintainers use the **released pin** path like any consumer; no tip-HEAD day-to-day special-case |

Tip has a gate fix the pin lacks → usually **DOGFOOD / release-SLA**, not “OVPR is broken.” Prefer-A / pin-behind-tip pain is often dogfood while the *mechanism* is OVPR pin invoke. See workspace memory topic `ovpr-vs-dogfood.md`. `#5929` sealed: tip/pin lag until release+pin bump is intended; unlock = maintainer release + deliberate pin bump.

---

## 3. Verb matrix (locked — do not redesign)

| Verb | Mutates pin? | Mutates wiring / GENERATION / readiness? | Migrates xbrief/vbrief data? | Notes |
| --- | --- | --- | --- | --- |
| `directive install` | First-time yes | Setup yes | No (may **seed** missing initial project-data on first install only) | Bare `install` on already-configured project → exit 2 naming repair |
| `directive install --repair` | Restore pin via PM if needed | Setup refresh | **Never** | Restores pin/wiring; does not migrate schemas/data |
| `directive upgrade` | Yes (V→W) when target differs | Setup when stale | **Yes** — only install-management path that migrates | Equal-version upgrade may migrate residual hybrids/schema behind |
| `directive uninstall` | Removes runtime pin | Removes owned wiring | No (preserves `xbrief/`) | |
| `directive doctor` | No | No | No | Read-only; names `upgrade` / `install --repair`; never self-repairs (AC8.8 / AC9.10) |

Aliases: `init`→install, `update`→upgrade, `remove`→uninstall. No `sync`, no `migrate`, no `bootstrap`, no `doctor fix`.

**Remedy map (failure-shaped doctor — sealed Problem 9 / #5798 class):**

| Finding class | Correct remedy |
| --- | --- |
| Pin / `node_modules` desync or missing pin | **Project** `npm install` / `pnpm install` |
| Wiring / hooks / skills / GENERATION damaged with good pin | `directive install --repair` |
| Schema / project data behind runtime | `directive upgrade` |
| Global launcher itself missing | `npm i -g @deftai/directive` |

Do not always compose global-install + repair for every doctor red. After packages exist, AC9.7 launcher+repair remains for wiring/pin problems.

---

## 4. Entry guards + host `.mjs` outer (v261027 — locked)

### AC9.12 order (same on host outer, git-hook helper, Taskfile pin entry, launcher paths that delegate to pin)

1. Untracked `.deft-directive-disable` → tool-appropriate stop; **no** pin policy load
2. Else missing/unusable pin under `node_modules/@deftai/directive-runtime` → **fail closed** with clear **project** `npm install` / `pnpm install` guidance
3. Else run the pin

**Do not** treat empty `node_modules` as a default global-launcher+repair (AC9.7) story when the only gap is unsynchronized project install. Launcher-only verbs (install/repair/upgrade/uninstall/doctor/version/help) remain available without a pin per existing ACs. `.no-deft-directive` = permanent project opt-out of install/session/setup.

### AC9.1 registered host hooks

```text
Host (Grok / Claude / Cursor / Codex)
  → node <host-deposit>/deft-hook-<sha8>.mjs --host … --event …
       → entry guards (AC9.12)
       → load node_modules/@deftai/directive-runtime/dist/hook-bin.js
            → policy / allow-deny (dispatcher)   ← Scott ownership starts HERE
```

Locked form:

- Committed per-host Node **`.mjs` outer** (e.g. `.grok/hooks/deft-hook-<sha8>.mjs`)
- Node only — **no** shell `.sh` as registered command
- **No** bare `deft-hook` on PATH as registered command
- **No** direct registered `hook-bin.js` as the host command (direct pin registration cannot run guards when pin absent)
- Full product logic stays in pin `hook-bin.js` — do not duplicate full hook-bin into `.agents` / `.deft`

This is how macOS **and** Windows behave when the pin package is absent: the outer still runs under Node and fails closed with project PM install guidance. Git hooks may use a deposited `.githooks` helper (Git provides `sh` on Windows); that is a different runner from no-shell host exec.

### AC8.6 automatic setup

On an eligible ordinary runtime command or registered hook: if readiness for the installed pinned version is missing/stale → complete **local** wiring / GENERATION / readiness (including Git-hook activation as applicable). Does **not** move the pin. Does **not** migrate xbrief data. Does **not** create first-time seed project-data. Doctor probes set `DEFT_DOCTOR_HOOK_DIAGNOSTIC` and suppress writes (AC9.10).

### AC14.10 Dependabot / pin-only bump (locked)

Scenario: Dependabot (or human) changed **only** pin + lockfile to W; project PM installed W; GENERATION/wiring still describe V.

**Required behavior:** first eligible runtime command or registered hook completes wiring/readiness at W, then proceeds. Pin and existing xbrief data unchanged.

If W has a newer xbrief schema → doctor/session-start report data behind and name `directive upgrade` (AC14.11).

**Do not** redefine “pin bump PR must also deposit/refresh all wiring in the same PR.” Broken auto-setup is a product defect to fix under AC8.6 — not a reason to rewrite AC14.10. Epic exit criteria that contradict AC14.10 lose (see #5952 note).

---

## 5. Ownership boundary — leave OVPR / installer lifecycle to polfer

Instructions given to Scott (@Scott Adams / Enterprise Grok Bot stack) for ticket split. **Other harnesses must honor the same boundary.**

### Split in one sentence

**Scott owns decisions (allow/deny once the hook payload is already in the decision engine). polfer owns invocation and install (how the hook/CLI/skill path is installed or started, and what happens when the pin is missing/disabled).**

### Scott owns

- `packages/core/src/hooks/dispatcher.ts` and tightly related decide/policy code
- Authz, scope, occupancy, write fences, policy reasons **after** the hook is already running
- Free refactor of that allow/deny brain

### polfer owns (OVPR / installer lifecycle) — do not touch

- Global launcher vs project pin; bookends (`install` / `upgrade` / `uninstall` / `doctor` / `install --repair`)
- Deposit and regenerate of host hook configs and commands (e.g. `.grok/hooks/deft.json`, wrappers, hook-bin command shape, `.mjs` outers)
- Generator / init-deposit / setup-wiring / git-hook helpers (e.g. `.githooks/_directive-run.sh`, pre-commit/pre-push templates)
- Self-complete / wiring-ready / GENERATION / readiness when framed as install or pin activation
- Missing `node_modules` / pin-absent fail-closed messaging and project npm/pnpm install recovery
- `.deft-directive-disable` / `.no-deft-directive` early guards on entry points
- Taskfile/`includes.deft` pin targeting; Windows PM `.CMD` spawn for install/upgrade; bot-visible OVPR split / launcher-vs-runtime bin messaging
- Locked OVPR docs under `docs/installer-refactor-ovpr/` and installer/OVPR problem-ledger dispositions

### Tickets Scott (and other non-polfer harnesses) must leave alone

Do not refile, reopen option analysis, redesign, duplicate, implement, ARC, APE, design-critique, or “improve the Locked disposition” on:

- Any issue with `assignee:polfer`, or labeled for installer/OVPR lifecycle (`area:installer`, `promise:lifecycle` when it is install/pin/hooks-deposit work)
- Any issue whose body starts with **Locked disposition** / **TRIAGED — do not re-adjudicate** / Seal date referencing the installer/OVPR problem-ledger
- Known sealed cohort examples (non-exhaustive): `#5383`, `#5807`, `#5808`, `#5809`, `#5869`, and related OVPR install/hooks-deposit tickets; do not absorb their scope into a dispatcher PR

If work looks like one of those already-open tickets: **add a short comment linking evidence. Stop.** Do not invent a competing design. Do not change the Locked disposition. Do not open a duplicate. Do not run ARC/APE on it.

### Truly new OVPR-shaped bug (not a duplicate)

1. Open a new GitHub issue  
2. Assign to **polfer**  
3. Label appropriately (`area:installer` / lifecycle as fits)  
4. Describe **symptoms and evidence only** — no solution redesign, no ARC/APE, no Locked disposition of your own  
5. Continue your own non-OVPR work; **do not implement** that issue  

### Explicit non-goals for Scott / dispatcher harnesses

- Do not amend OVPR requirements to fit a wrapper/timeout/self-complete redesign
- Do not treat host fail-open / missing-pin / disable-order as dispatcher ownership
- Do not merge install/hooks-deposit fixes into a dispatcher PR “while you’re there”
- Coordinate in prose if a change might touch deposit/command form — then stop at the boundary and hand invocation/install to polfer

Thin runtime edge (`hook-bin` / `hook-dispatch`: stdin, timeouts, missing package, self-complete before `decideHook`) sits between host command run and `decideHook` and is closer to **invocation/transport (polfer)** than to the decide brain (Scott).

---

## 6. Anti-rathole checklist (read before any install-adjacent design)

Before proposing options, ask:

1. Does this change what `install` / `repair` / `upgrade` / `uninstall` / `doctor` mutate? → Stop. Requirements already define it. Punch out to polfer.
2. Does this re-argue global launcher vs `directive-runtime`? → Stop. Split is locked.
3. Does this require depositing full hook policy outside `node_modules`? → Stop. Dual-copy drift is forbidden.
4. Does this replace the `.mjs` outer with `.sh`, bare `deft-hook`, or direct registered `hook-bin.js`? → Stop. AC9.1 locked.
5. Does this make missing-pin recovery “global install + repair” as the primary hatch? → Stop. Project PM install first (AC9.12); AC9.7 after packages exist.
6. Does this require pin-bump PRs to include deposit refresh “because auto-setup is flaky”? → Stop. Fix AC8.6; keep AC14.10.
7. Does this reopen #5956 deadlines / allow-lists / D-9? → Stop. Rejected.
8. Is the pain “tip has a gate the pin lacks”? → Classify **DOGFOOD**; release+pin bump. Do not invent tip-track for day-to-day.
9. Is the ticket already Locked / assignee:polfer / area:installer? → Comment evidence only; do not re-adjudicate.
10. Would a normal consumer on the published pin hit this? → OVPR. Would it vanish if maintainers ran tip runtime? → lean DOGFOOD.

**Punch-out rule:** Any proposed solution that conflicts with locked requirements/architecture, or that would require changing those docs outside an operator-approved revision delta (pattern: in-place tagged replace like v261027), must stop and discuss with polfer. Collisions are not silent fixes.

---

## 7. How a harness should use this file

**Before triage of an install-adjacent issue**

1. Read this primer §0–§6  
2. Open requirements § verb/AC sections cited by the issue (at least AC8.6, AC9.1, AC9.12, AC14.10 if hooks/pin/Dependabot)  
3. Fetch issue body **and** comments; prefer Locked disposition over epic narrative  
4. Classify OVPR vs DOGFOOD  
5. If assignee:polfer / Locked / area:installer → evidence comment only unless you **are** polfer’s implement harness  

**Before planning a new feature that intersects install**

1. Map the feature onto the verb matrix: which verb owns the mutation?  
2. If it needs a new mutation class, punch out — do not silently widen repair or auto-setup  
3. If it needs host command form changes, plan against AC9.1 `.mjs` outer + AC9.12 guards  
4. Assume Dependabot pin-only bumps remain legal  

**Before implementing**

1. Confirm you are on the correct side of the ownership boundary  
2. Prefer thin tickets with Locked Done-when over mega-specs  
3. Cite ACs in the PR; use `Refs`/`Closes` correctly for forge closer / `scope:complete`  
4. Do not “help” by rewriting deposit/generator paths from a dispatcher PR  

---

## 8. Sibling docs in this folder

| File | Use |
| --- | --- |
| [`README.md`](./README.md) | Short human folder map + authority split + HT harness pointer |
| [`LLM-CONTEXT.md`](./LLM-CONTEXT.md) | This file — AI harness anti-rathole primer |
| [`install-ovpr-requirements.md`](./install-ovpr-requirements.md) | Full ACs (Parts A–D); edit only with operator-approved tagged revision |
| [`install-ovpr-architecture.md`](./install-ovpr-architecture.md) | Compact package/verb/outer map |
| [`install-ovpr-problem-ledger-2026-10-23.md`](./install-ovpr-problem-ledger-2026-10-23.md) | Problems 1–33 disposition history |
| [`install-ovpr-human-test-plan.md`](./install-ovpr-human-test-plan.md) | HT-00–HT-17 |
| [`install-ovpr-implementation-strategy.md`](./install-ovpr-implementation-strategy.md) | Historical YOLO/cutover narrative |

Installer automation: `tools/install-harness/` (ht-auto + repo-upgrade).

Product epic: [#5490](https://github.com/deftai/directive/issues/5490). Methodology/cutover: [#5514](https://github.com/deftai/directive/issues/5514).

---

## 9. One-line operating principle

**OVPR requirements define install/upgrade/repair/uninstall/doctor and pin invocation. Implement residuals. Leave Locked tickets alone. Scott decides allow/deny; polfer owns install and start.**
