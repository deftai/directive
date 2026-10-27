# Installer / OVPR problem ledger (seal 2026-10-23)

> **DECISION RECORD ONLY — NOT REQUIREMENTS.**  
> This file records operator FINAL dispositions from the 2026-10 installer/OVPR dogfood walk (Problems 1–33) and the ticket map used to seal GitHub issues.  
> It is **not** a set of acceptance criteria and must not be treated as product requirements.  
> **All normative OVPR requirements are self-contained in** [`install-ovpr-requirements.md`](./install-ovpr-requirements.md) **and** [`install-ovpr-architecture.md`](./install-ovpr-architecture.md) (including revision **v261027** where tagged).  
> On conflict, those two documents win. Do not re-adjudicate sealed tickets via ARC/design-critique; implement Locked dispositions that align with the requirements/architecture SoT.

**Seal date:** 2026-10-23  
**Source walk:** operator-led problem analysis (historical working copy was `~/Downloads/problem-analysis-and-resolution-plan.md`)  
**Persisted:** 2026-10-27 as `install-ovpr-problem-ledger-2026-10-23.md`

---

## How to use this record

- GitHub issues sealed in this walk carry **Locked disposition** text and `TRIAGED — do not re-adjudicate` with seal date 2026-10-23.
- Implementers follow **install-ovpr-requirements.md** / **install-ovpr-architecture.md**. Use this ledger to understand *why* a ticket was sealed and which problem number it maps to.
- Host-hook **entry-guard** / committed **`.mjs` outer** end-state (when normative) lives in requirements revision **v261027**, not as a silent override from this ledger alone.
- **#5956** mega-design (tiered deadlines, D-9 AC8.6 rewrite, E1–E3 repair-primary allow-list, 0.129.x SoT) is **not** adopted from this ledger; see issue close disposition.

---

**Scope:** OVPR / Directive 0.127.0 + open `assignee:polfer` issues with `area:installer` OR `promise:lifecycle` (40) + SLizard/Greptile on `deftai/deftSE#9`  
**Updated:** 2026-10-22  
**Status:** Iterating — dispositions filled as confirmed

## How to read this document

## Standing mandate (from Problem 4 disposition — applies to all remaining walks)

**Eat your own dogfood with OVPR.** The `deftai/directive` repository must run Directive the same way any customer project folder does: a proper install of the thin launcher + exact project pin into `node_modules/@deftai/directive-runtime`.

- Do **not** prioritize a local/source build for running product code, including when maintaining Directive itself.
- Launcher and task runners must **not** detect or special-case “we are inside the directive repo / maintainer context.”
- There is one resolution path: use the pinned `node_modules` install.
- When judging tickets going forward: prefer close/supersede/retarget anything that assumes engine-ladder, PATH/@latest day-to-day identity, vendored `.deft/core` as SoT, or maintainer-only execution shortcuts.

- A **problem** is a distinct product failure mode, design risk, or *stale-ticket cluster* that needs a single disposition.
- A **ticket / bot finding / chat note** is an *instance* of a problem.
- One ticket can span more than one problem (notably #5808, #4701 tracker children).

## Guiding principle — pin-present or clear install error (from Problem 5 discussion)

Every entry point must reach the pinned/installed package under `node_modules/@deftai/directive-runtime` (dogfood OVPR). Before that pin exists, each entry point must still work **enough** to fail in a controlled, AI-recognizable way that demands a project package-manager install (`npm install` / `pnpm install` / equivalent) — not a cryptic crash, not a silent `dist/` overlay, not “you are in the directive monorepo so use source,” and not a default steer to `npm i -g` + repair when the leftover is simply “pin not installed in this clone/worktree.”

Applies to all of:
1. Global launcher (locate repo root → `node_modules` pin)
2. `AGENTS.md` / session guidance
3. Harness SKILL invocations
4. Git hooks (relative into `node_modules`)
5. Taskfile tooling (no autobuild / local `dist` over the pin)

Failure modes that must get a clear install message include: fresh clone then harness before `npm install`; worktree without copied `node_modules` / without install; direct Taskfile use on that tree; and similar “wiring present, pin absent” cases.


## Unified local entry guards (from Problem 6 FINAL)

When fixing disable + missing-pin behavior, use one compact **local** guard pattern shared across footprints (launcher bootstrap, git-hook helper, host-hook outer wiring, Taskfile preamble):

1. Check untracked `.deft-directive-disable` → tool-appropriate disabled response (no Directive enforcement load).
2. Else check pinned `node_modules/@deftai/directive-runtime` → clear project `npm`/`pnpm` install error if missing.
3. Else run the pin.

Footprint solutions must be similar (same order, same recovery shape, minimal duplication). Do not ship one-off git-hook-only order fixes that leave launcher/Taskfile/host wrappers divergent. Couples Problems 6, 4b, 4c, and hook deposit work (#5807).


## Urgency callouts

- **Problem 21 (#4750):** Advertised docs URL 404 — **hold + urgent**; leave open; do not close in this pass.

- **Problems 7 + 8 (#5808):** OVPR hook-template regressions (brief gates + refspec-aware pre-push). Treat as **urgent Upgrade Blockers**. Restore 0.126 feature coverage under pin-relative helpers ASAP.


## Query coverage

Open issues matching:
`is:issue state:open assignee:polfer (label:promise:lifecycle OR label:area:installer)` → **40 issues**

Numbers: 554, 804, 945, 946, 1439, 1560, 1660, 1979, 1999, 2173, 2354, 3513, 3770, 3863, 4121, 4372, 4538, 4546, 4655, 4657, 4658, 4662, 4666, 4701, 4750, 4885, 4887, 4960, 5383, 5540, 5543, 5603, 5710, 5795, 5796, 5797, 5798, 5807, 5808, 5809

Plus review instances from deftSE#9 (SLizard/Greptile) and this chat.

## Distinct problem ledger

### A. Obsolete / superseded clusters (likely comment + close)

| # | Problem (short name) | Need? | Driving instances | Disposition |
|---|----------------------|-------|-------------------|-------------|
| 1 | Go installer backlog still open after product deletion | CLOSE? | #1439, #1560, #1660, #1979 | **CLOSED 2026-10-22** — comment+close all four as obsolete/superseded by OVPR (#5490 / 0.127); npm launcher + runtime pin |
| 2 | `deft-sync` skill work still open (sync removed) | CLOSE? | #554 | **CLOSED 2026-10-22** — Option 1 comment+close obsolete/superseded by OVPR |
| 3 | `.deft/core`-centric install/docs/SUPPORT still open under OVPR | CLOSE/REWRITE? | #945, #4538, #4885, #4887, #4546 → closed; removal follow-up **#5835** | **DONE 2026-10-22** — Option 1 + mint #5835 |
| 3b | Remove retired deft-core-guard emitter/refs/delete-on-upgrade | WORK | **#5835** (from Problem 3) | *open — work* |
| 4 | Pre-OVPR global-engine / vendored-core upgrade model tickets | CLOSE/RETARGET? | #1999, #2173, #3863 | **CLOSED 2026-10-22** — Option 1 + dogfood-pin mandate |

### B. Active product problems (likely work)

| # | Problem (short name) | Need? | Driving instances | Disposition |
|---|----------------------|-------|-------------------|-------------|
| 4b | Taskfile/launcher prefers local `dist` over `node_modules` pin (dogfood break) | WORK | chat (Problem 5 discussion); SLizard missing-path class | *open — walk later; separate from #5807* |
| 4c | Entry points lack clear “run npm/pnpm install” when pin missing | WORK | chat principle; SLizard path failures; overlaps #5809/#5798 recovery shape | *open — walk later; coupled AC on #5807* |
| 5 | Grok upgrade dual PreToolUse / deft-hook deny | WORK | #5807, Greptile P1 wrapper, SLizard C adjacent | **FINAL 2026-10-22** — Option 1/2 + pin-missing install AC; keep #5807 open |
| 6 | Kill-switch unreachable / hooks load under disable | WORK | #5809, #5543, Greptile P2 disable | **FINAL 2026-10-22** — Option 1 expanded + unified local entry-guard plan; keep open |
| 7 | Pre-commit template drops brief gates | WORK | #5808 (part), Greptile P2 briefs | **FINAL 2026-10-22 URGENT** — restore 0.126 brief gates (OVPR regression); #5808 open |
| 8 | Pre-push lost refspec-aware protection | WORK | #5808 (part), SLizard Pass2 E | **FINAL 2026-10-22 URGENT** — restore 0.126 refspec pre-push; #5808 open |
| 9 | Doctor recovery not failure-shaped | WORK | #5798, SLizard Pass1 #1 rhyme | **FINAL 2026-10-22** — Option 1 failure-shaped remedy map; #5798 open |
| 10 | Hybrid / mis-keyed xBRIEF migrate stuck | WORK | #5795 | **FINAL 2026-10-22** — runtime/core history coverage (bookend OK); #5795 open |
| 11 | Migrated completed history rejected by write-guard | VERIFY→CLOSE | #5540 | **FINAL 2026-10-22** — migration stamp is SoT; Prefer-A superseded; verify then close as fixed |
| 12 | Taskfile wiring probe comment false positive | WORK | #5796 | **FINAL 2026-10-22** — YAML AST doctor+mutate; own only includes.deft; #5796 open |
| 13 | Upgrade writes placeholder allowBuilds | WORK | #5797 | **FINAL 2026-10-22** — PM-owned allowBuilds UX; Directive must not edit; #5797 open |
| 14 | Windows upgrade lockfile refresh fails on `pnpm.CMD` | WORK | #5383 | **FINAL 2026-10-22** — Option 1 shell .CMD like #5082; verify tip then close |
| 15 | Managed workflow update clobbers newer action pins | CLOSE | #4121 | **CLOSED 2026-10-22** — obsolete under OVPR; core-guard → #5835 |
| 16 | Init classifies empty repo as brownfield | WORK | #4655 | **FINAL 2026-10-22** — litmus + dual wording new/existing (green/brown)field |
| 17 | Init/doctor UX unusable (noise, ladder, naming) | CLOSE | #4701, #4657, #4658 | **CLOSED 2026-10-22** — obsolete; residual doctor → #5798 |
| 18 | Windows README missing execution-policy / `.cmd` shims | WORK | #4662 | **FINAL 2026-10-22** — Windows note; single path npm i -g → directive; no npx |
| 19 | OVPR greenfield seed+stage miss (PD, lifecycle, staging; schemas→pin) | WORK | #4666 | **FINAL 2026-10-22** — expand #4666; significant 126→127 retain miss |
| 20 | `core.hooksPath=.githooks` silently disables global commit-msg | WORK | #4960 | **FINAL 2026-10-22** — plan/postop warning; no chain; repair yes; upgrade no |
| 21 | Advertised docs URL 404 | HOLD | #4750 | **FINAL 2026-10-22** — leave open; hold+urgent; do not resolve now |
| 22 | npm-publish post-publish fixture red after successful publish | WORK | #5603 | **FINAL 2026-10-22** — Option 1 fix fixture/types resolution; keep urgent |
| 23 | No first-class yank/rollback for bad npm release | CLOSE | #2354 | **CLOSED 2026-10-23** — runbook (retag+deprecate), not product yank; #2354 not planned |
| 24 | Pin inventories rot (scaffolds + tool pins) | WORK | #3513 | **FINAL 2026-10-23** — strip language version pins; remove ghx from product (setup + PATH prefer); no freshness engine; ticket stays open for implement |
| 25 | Doctor tests leak real OpenClaw home state | OUT | #3770 | **FINAL 2026-10-23** — not installer; unassign + strip lifecycle labels; open, no hold; out of work set |
| 26 | `scope:complete` has no PR-only delivery path | OUT | #5710 | **FINAL 2026-10-23** — not installer/OVPR; unassign + strip lifecycle/core-capabilities; open, no hold; out of work set |
| 27 | Missing `cache:doctor` diagnostic surface | OUT | #946 | **FINAL 2026-10-23** — not installer/OVPR; unassign + strip lifecycle labels; open, no hold; out of work set |
| 28 | First-run skill should decide whether to `directive init` | CLOSE | #4372 | **CLOSED 2026-10-23** — chicken-and-egg; activation is directive install; not planned |
| 29 | Tiny README quick-start path wording → human README revamp | WORK | #5867 (was #804) | **FINAL 2026-10-23** — #804 closed; #5867 urgent+hold README revamp, assignee polfer |

### C. Review MAY items (deftSE#9 / SLizard, not already absorbed)

| # | Problem (short name) | Need? | Driving instances | Disposition |
|---|----------------------|-------|-------------------|-------------|
| 30 | agents-entry work-claim not propagated | DISMISS | SLizard AGENTS P2 | **FINAL 2026-10-23** — tip already has Work-claim in agents-entry + contract; SLizard P2 not an open gap; out of installer round |
| 31 | Project pin missing `directive`/`deft` CLI bins + reviewer calm / PM escape hatch | WORK | #5869 | **FINAL 2026-10-23** — keep open: educate SLizard/Greptile on OVPR bins + node_modules path+PM-install hatch; not a dismiss |
| 32 | Grok hook concurrency / no serialization | WORK | #5807 | **FINAL 2026-10-23** — bind to #5807 dual PreToolUse upgrade; no duplicate ticket |
| 33 | Direct `hook-bin.js` vs wrapper fail-closed path | WORK | #5809 | **FINAL 2026-10-23** — bind to #5809 disable-before-bin + PM-install hatch; cross-link #5869 |

### Dismissed review noise (unless reopened)

| Candidate | Why parked |
|-----------|------------|
| SLizard Pass1 #2 Claude cwd path | fp |
| SLizard Pass1 #3/#4 manifest undeclared runtime | fp |
| SLizard Pass1 #5 kill-switch semantic mismatch (tracked/symlink) | fp; distinct from Problem 6 order bug |
| SLizard Pass1 #1 as “hard-coded path won’t get global binary” | fp; recovery prose → Problem 9 |

## Ticket → problem map (quick)

| Ticket | Problem(s) |
|--------|------------|
| #554 | 2 |
| #804 | 29 (closed→#5867) |
| #5867 | 29 |
| #945 | 3 (closed) |
| #946 | 27 |
| #1439 | 1 |
| #1560 | 1 |
| #1660 | 1 |
| #1979 | 1 |
| #1999 | 4 |
| #2173 | 4 |
| #2354 | 23 |
| #3513 | 24 |
| #3770 | 25 |
| #3863 | 4 |
| #4121 | 15 |
| #4372 | 28 |
| #4538 | 3 (closed) |
| #4546 | 3 (closed) |
| #4655 | 16 |
| #4657 | 17 |
| #4658 | 17 |
| #4662 | 18 |
| #4666 | 19 |
| #4701 | 17 |
| #4750 | 21 |
| #4885 | 3 (closed) |
| #4887 | 3 (closed) + 17 (hybrid UX remainder if any) |
| #4960 | 20 |
| #5383 | 14 |
| #5540 | 11 |
| #5543 | 6 |
| #5603 | 22 |
| #5710 | 26 |
| #5795 | 10 |
| #5796 | 12 |
| #5797 | 13 |
| #5798 | 9 |
| #5807 | 5 |
| #5808 | 7 + 8 |
| #5809 | 6 |
| #5835 | 3-follow-up (remove deft-core-guard) |

## Walk log

### Problem 1 of 33 — DONE

Comment + close #1439, #1560, #1660, #1979 as obsolete / superseded by OVPR (#5490 / 0.127), with pointer to npm `@deftai/directive` launcher + project `@deftai/directive-runtime` pin. Verified `cmd/deft-install` already removed (AC10.10); #1979 delete decision already executed.

### Problem 2 of 33 — DONE

Comment + close #554 as obsolete / superseded by OVPR (#5490 / 0.127). No deft-sync / directive sync path; refresh via npm launcher + runtime pin.

### Problem 3 of 33 — DONE

Option 1 close of #945 #4538 #4885 #4887 #4546 as obsolete/superseded by OVPR. Minted #5835 to remove retired deft-core-guard emitter, references, and consumer delete-on-upgrade (inventory already `na-retired-copy-model`; code still emits on legacy tracked-core path).

### Problem 4 of 33 — DONE

Option 1: comment + close #1999, #2173, #3863 as superseded by OVPR. Established standing mandate: Directive repo dogfoods OVPR like any customer project; no maintainer-context / local-build special-case in launcher or task runners; always the `node_modules` pin.

### Problem 5 of 33 — DONE (work remains on #5807)

FINAL: Option 1 or 2 on #5807 (fix upgrade merge / pin-relative hook-bin; no deft-hook). Coupled AC: missing pin → clear project npm/pnpm install message. 4b Taskfile dist overlay and 4c cross-entry install messaging tracked separately. Comment posted on #5807.

### Problem 6 of 33 — DONE (work remains on #5809/#5543)

FINAL: Option 1 expanded — early kill-switch + pin check on all entry points; tool-appropriate disabled responses; unified compact local guard shared across launcher/git hooks/host outer wiring/Taskfile (same pattern as pin-present principle). Comments on #5809 and #5543.

### Problem 7 of 33 — DONE (work remains on #5808 part A)

FINAL: Restore 0.126 pre-commit brief-gate coverage under pin-relative hooks. OVPR regression (wiring rewrite lost feature work that requirements said to retain). Operator shocked. Comment on #5808.

### Problem 8 of 33 — DONE (work remains on #5808 part B)

FINAL: Restore 0.126 refspec-aware pre-push under pin-relative hooks. OVPR regression. **URGENT** with Problem 7 — huge hole for 0.127 upgrades. Comment on #5808.

### Problem 9 of 33 — DONE (work remains on #5798)

FINAL: Option 1 — failure-shaped doctor remedy map. Comment on #5798.

### Problem 10 of 33 — DONE (work remains on #5795)

FINAL: Bookend already correct; fix incomplete history in runtime/core xbrief-migrate. Doctor read-only must match upgrade. No failing upgraded briefs. Comment on #5795.

### Problem 11 of 33 — DONE (verify→close #5540)

FINAL: Shipped `lifecycleWrite` `{ action: complete, migration: true }` is the product direction. Prefer-A Git-witness lean is superseded/subpar. Comment on #5540; hold removed. Next: verify on master/0.127, document, close as fixed if green.

### Problem 12 of 33 — DONE (work remains on #5796)

FINAL: Comment-aware YAML AST for doctor + setup/upgrade mutate; own only `includes.deft`; no checksum blocks. Comment on #5796.

### Problem 13 of 33 — DONE (work remains on #5797)

FINAL: `pnpm-workspace.yaml` / `allowBuilds` is PM-owned; Directive did not write the placeholder (pnpm approve-builds). No hand-edit; clear PM recovery; prefer no runtime postinstall need. Comment on #5797.

### Problem 14 of 33 — DONE (work/verify on #5383)

FINAL: Option 1 — shell-spawn Windows `pnpm.CMD` like #5082 `gh.cmd`. Comment on #5383; hold removed. Verify tip completeness → close if green.

### Problem 15 of 33 — DONE

FINAL: Closed #4121 as obsolete under OVPR 0.127 (deft-core-guard clobber; removal #5835).

### Problem 16 of 33 — DONE (work remains on #4655)

FINAL: Fix classifier (git OK; litmus = no project material yet) + dual wording `new project (greenfield)` / `existing project (brownfield)`. Comment on #4655.

### Problem 17 of 33 — DONE

FINAL: Closed #4701, #4657, #4658 as obsolete/superseded by OVPR + install/doctor language simplification. Residual doctor remedy work stays on #5798.

### Problem 18 of 33 — DONE (work remains on #4662)

FINAL: Windows cold-start docs for single identity (npm i -g → directive …); .cmd = same command; no npx path. Comment on #4662.

### Problem 19 of 33 — DONE (work remains on #4666)

FINAL: Expanded #4666 — 0.126→0.127 OVPR retain miss. Restore PD seed + lifecycle dirs + staging; do not copy xbrief/schemas; retarget skills/content schema refs to pin. Comment + retitle on #4666.

### Problem 20 of 33 — DONE (work remains on #4960)

FINAL APPROVED: one plan/confirm/postop with conditional hooks takeover warning; install+repair; not upgrade; uninstall careful on hooksPath; no chaining; Husky tip only. Comment on #4960.

### Problem 21 of 33 — DONE (deferred)

FINAL: Leave #4750 open; added hold+urgent; do not resolve in this pass. Docs URL still 404.

### Problem 22 of 33 — DONE (work remains on #5603)

FINAL: Option 1 — fix post-publish fixture / `@deftai/directive-types` resolution under OVPR publish. Comment on #5603.

### Problem 23 of 33 — DONE

FINAL: Close #2354 as not planned. No shipped `release:yank`. Maintainer runbook = dist-tag move + deprecate + security-regression check; copy comment into docs later. Related publish-tag choice stays on #5852. Comment+close 2026-10-23.

### Problem 24 of 33 — DECISION RECORDED (implement open)

FINAL (2026-10-23): Recorded on #3513. (1) Strip version pins from language scaffolds (TS/Python samples); recommend tools + PM install current. (2) Eliminate ghx from shipping product: setup:ghx, PATH preference, CI install, live docs/rules — gh + .deft-cache only. No pin-freshness detector. Ticket **stays open** for implementation; historical CHANGELOG/xbrief mentions OK. Coordination with 0.129.0 later as needed.

### Problem 25 of 33 — PARKED (out of round)

FINAL (2026-10-23): #3770 is niche doctor/OpenClaw **test hermeticity**, not installer. Unassigned polfer; removed core-capabilities/promise:lifecycle; open, **no hold**. Out of OVPR/installer work set. Tip may already stub openclawHomeDir; residual openclawEnv optional later.

### Problem 26 of 33 — PARKED (out of round)

FINAL (2026-10-23): #5710 is niche scope:complete delivery-identity, not installer/OVPR. Unassigned polfer; stripped core-capabilities/promise:lifecycle/area:installer; open, **no hold**. Removed from this work set.

### Problem 27 of 33 — OUT OF WORK SET

FINAL (2026-10-23): #946 cache:doctor is cache diagnostics, not installer/OVPR. Unassigned; stripped core-capabilities/promise:lifecycle; left open with **no hold**. Same amendment for #3770 / #5710 (hold removed).

### Problem 28 of 33 — DONE

FINAL (2026-10-23): Close #4372 not planned. No pre-deposit skill/markers can discover or decide install; solution is documented `directive install` (+ upgrade/repair/uninstall). Web discovery ≠ this ticket.

### Problem 29 of 33 — DECISION RECORDED

FINAL (2026-10-23): Close #804. Open #5867 for human-approachable README revamp (hold+urgent, assignee polfer, area:installer + core-capabilities + promise:lifecycle + documentation).

### Problem 30 of 33 — DISMISSED

FINAL (2026-10-23): SLizard AGENTS P2 on work-claim/agents-entry — **not an open product gap**. Tip `content/templates/agents-entry.md` already includes Work-claim (#4200); `agents_entry_contract` requires those strings (landed with #4207, 2026-09-06). No new ticket. Out of installer/OVPR work set. Soft busy-flag reminder prose only; not install lifecycle.

### Problem 31 of 33 — DECISION RECORDED (implement open)

FINAL (2026-10-23): Not a false-positive dismiss. Open #5869 (assignee polfer): bot-visible OVPR split (runtime description/README, agents-entry, README/#5867, optional Greptile/SLizard rules) + consistent project PM-install escape hatch on relative node_modules runtime touchpoints so reviewers stop flipping out. Stays open as WORK.

### Problem 32 of 33 — DECISION RECORDED

FINAL (2026-10-23): Bind to existing #5807 (Grok dual PreToolUse / wrapper deny on 0.127 upgrade). SLizard “concurrency” = overlapping hook registrations. No new ticket.

### Problem 33 of 33 — DECISION RECORDED (walk complete)

FINAL (2026-10-23): Bind to #5809. Disable + project PM-install remediation before requiring runtime `dist/bin.js`. Cross-linked #5869 for reviewer/messaging consistency. **End of 33-problem disposition walk.**

### Walk complete — implement from open WORK tickets



















## Confirmed dispositions

### Problem 1 — Go installer backlog
- **FINAL:** Comment + close all four as obsolete / superseded by OVPR (#5490 / 0.127); one-line pointer to npm launcher + runtime pin.
- **Tickets closed:** #1439, #1560, #1660, #1979 (`not planned`)
- **Date:** 2026-10-22

### Problem 2 — deft-sync skill still open
- **FINAL:** Option 1 — comment + close #554 as obsolete / superseded by OVPR; pointer to launcher + runtime pin / upgrade-repair.
- **Tickets closed:** #554 (`not planned`)
- **Date:** 2026-10-22

### Problem 3 — `.deft/core`-centric tickets under OVPR
- **FINAL:** Option 1 + mint removal ticket #5835; then close the five.
- **Tickets closed:** #945, #4538, #4885, #4887, #4546 (`not planned`)
- **Ticket opened:** #5835 — remove retired deft-core-guard (emitter, references, delete-on-upgrade)
- **Date:** 2026-10-22

### Problem 4 — Pre-OVPR global-engine / vendored-core model
- **FINAL:** Option 1 — comment + close #1999, #2173, #3863 as superseded by OVPR.
- **Standing mandate recorded:** eat-your-own-dogfood OVPR; Directive checkout installs/runs like any customer repo; no local-build priority; launcher/task runners never special-case directive-repo context; always `node_modules` pin.
- **Tickets closed:** #1999, #2173, #3863 (`not planned`)
- **Date:** 2026-10-22

### Problem 5 — Grok dual PreToolUse / deft-hook deny
- **FINAL:** Option 1 or 2 on #5807; coupled pin-missing → project `npm`/`pnpm` install AC; 4b/4c separate.
- **Tickets:** #5807 kept open (work); comment recorded 2026-10-22.
- **Principles applied:** dogfood OVPR; pin-present or clear install error across entry points.

### Problem 6 — Kill-switch / entry guards
- **FINAL:** Option 1 expanded. Early disable then pin check; per-tool default responses; **unified local entry-guard plan** (same compact code pattern across launcher, git hooks, host outer wiring, Taskfile) covering both disable and `node_modules` checks. Couples 4b/4c/#5807 deposit work.
- **Tickets:** #5809, #5543 kept open; comments recorded 2026-10-22.

### Problem 7 — Pre-commit brief gates dropped
- **FINAL:** Restore 0.126 brief-gate verbs in deposited pre-commit (regression under OVPR; not by-design). Template SoT + upgrade/repair redeposit tests required.
- **Tickets:** #5808 kept open (part A); comment 2026-10-22. Part B = Problem 8.
- **Note:** Operator shocked this was lost despite OVPR “retain feature points; fix version source.”
- **Urgency:** **URGENT / Upgrade Blocker** with Problem 8.

### Problem 8 — Pre-push refspec protection lost
- **FINAL:** Restore 0.126 refspec-aware pre-push (not checkout-only `verify:branch`). OVPR regression.
- **Urgency:** **URGENT / Upgrade Blocker** together with Problem 7 — unacceptable hole on 0.127 consumer upgrades.
- **Tickets:** #5808 kept open (part B); comment 2026-10-22. Prefer one template restore covering parts A+B.

### Problem 9 — Doctor recovery not failure-shaped
- **FINAL:** Option 1 — map each finding class to the correct remedy (project PM install vs repair vs upgrade/migrate vs probe fix); stop always composing global+repair.
- **Tickets:** #5798 kept open; comment 2026-10-22.
- **Aligns with:** Problems 6 / 4c entry-guard messaging.

### Problem 10 — Hybrid / mis-keyed xBRIEF migrate stuck
- **FINAL:** Extend runtime/core migrate history coverage so bookended `directive upgrade` clears doctor schema findings; never emit failing upgraded briefs; archive only rare approved escape.
- **Confirmed:** Launcher bookends already; runtime does material xBRIEF work — not a massive refactor.
- **Tickets:** #5795 kept open; comment 2026-10-22.

### Problem 11 — Migrated completed history / write-guard
- **FINAL:** Bound remedy is the generated `lifecycleWrite` stamp `complete` + `migration: true` (cleared on later ordinary stamps). Prefer-A five-limb Git admission is **not** the forward direction.
- **Built:** `maybeStampMigratedCompletedArtifact` + carve-outs; commit `41c3d4f18` on HEAD; YOLO claimed PASS.
- **Next:** Verify current master/0.127 dogfood; document stamp contract; **close #5540 as fixed** if verification holds.
- **Tickets:** #5540 open pending verify-close; disposition comment 2026-10-22; `hold` removed.

### Problem 12 — Taskfile wiring / brownfield YAML
- **FINAL:** One comment-aware YAML AST for doctor (ignore comments; structural `includes.deft` only) and mutate (edit only that key; preserve customer content; conflict if unsafe). Clear Directive-owned stale `.deft/core` comments on upgrade. No checksum/marker slabs; string surgery not the end state.
- **Tickets:** #5796 kept open; comment 2026-10-22.

### Problem 13 — Placeholder allowBuilds / pnpm-workspace
- **FINAL:** PM-owned file; Directive must not edit `allowBuilds`. Placeholder came from pnpm approve-builds during ignored-builds, not a Directive writer. Fix messaging / eliminate runtime postinstall need where possible; regression that Directive never writes the map.
- **Tickets:** #5797 kept open; comment 2026-10-22.

### Problem 14 — Windows pnpm.CMD EINVAL on lockfile refresh
- **FINAL:** Option 1 — same as #5082: shell-safe spawn for `.CMD`/`.bat` PM shims on all pin/lockfile call sites. Option 2 (exe/Corepack first) deferred enhancement only.
- **Tickets:** #5383 kept open pending verify/finish; comment 2026-10-22; `hold` removed.

### Problem 15 — Managed workflow action pin clobber
- **FINAL:** Close #4121 as obsolete under OVPR 0.127. Surface was `deft-core-guard.yml`; removal tracked in #5835. No new pin-preservation work for a deleted workflow.
- **Tickets closed:** #4121 (`not planned`) — 2026-10-22.

### Problem 16 — Init empty repo classified brownfield
- **FINAL:** Option 1+2. Simple litmus: greenfield = no project material yet (`git` allowed); brownfield = existing project material. Wording: `new project (greenfield)` / `existing project (brownfield)`.
- **Tickets:** #4655 kept open; comment 2026-10-22.

### Problem 17 — Init/doctor UX unusable (UAT cluster)
- **FINAL:** Close #4701, #4657, #4658 as obsolete/superseded (OVPR quiet defaults, DEFT-INSTALL-MSG / ladder passes, doctor rewrite; header-drift class #3637). Residual failure-shaped doctor recovery → #5798 only.
- **Tickets closed:** #4657, #4658, #4701 (`not planned`) — 2026-10-22.

### Problem 18 — Windows README / shims docs
- **FINAL:** Short Windows subsection aligned with single path (`npm i -g @deftai/directive` then `directive` verbs). Document `npm.cmd` / `directive.cmd` only as same commands under picky PowerShell; never reintroduce npx identity. Relies on #4654 ps1 strip for our bins.
- **Tickets:** #4662 kept open; comment 2026-10-22.

### Problem 19 — OVPR greenfield PROJECT-DEFINITION / lifecycle / staging
- **FINAL:** Significant 0.126→0.127 retain miss. Restore: (1) minimal PROJECT-DEFINITION seed on first install, (2) five lifecycle folders, (3) auto-stage managed paths including PD+lifecycle (fix 126 untracked-PD hole), (4) **no** `xbrief/schemas/` deposit — point skills/content at pin schemas instead. Non-goals: `.deft/core` and protectors; no auto-commit.
- **Evidence:** isolated 0.126.2 vs 0.127.0 empty-folder compare 2026-10-22.
- **Tickets:** #4666 kept open / expanded; disposition comment 2026-10-22.

### Problem 20 — hooksPath takeover / global commit-msg
- **FINAL APPROVED:** Disclose in the **same** install/repair plan + post-op (not a second confirmation). On yes/--yes, take over `.githooks`; do not chain. Tip Husky/Lefthook in post-op only. Upgrade: no takeover warning (missing ours → repair). Uninstall: do not touch hooksPath if not ours.
- **Tickets:** #4960 kept open; comment 2026-10-22.

### Problem 21 — Advertised docs URL 404
- **FINAL:** Leave #4750 **open**. Do not resolve now. Labeled **hold** + **urgent**. Must be fixed later (Pages and/or stop advertising dead URL).
- **Date:** 2026-10-22

### Problem 22 — npm-publish fixture red after successful publish
- **FINAL:** Option 1 — fix fixture resolution/order for `@deftai/directive-types` (OVPR multi-package publish). Keep urgent; hold OK until release window.
- **Tickets:** #5603 kept open; comment 2026-10-22.


## Draft ticket reorganization proposal

*(Filled after walks. Expected themes: close obsolete clusters with OVPR supersession comments; split #5808 into two work items or keep one epic with two ACs; merge #5543+#5809; keep #5795 vs #5540 related-but-distinct; optional PROBLEM tickets.)*

## Execution options (end state)

1. Comment on existing tickets with problem IDs + disposition.
2. Retag / relabel for problem grouping.
3. Close obsolete clusters with supersession rationale.
4. Optionally open a clean set of PROBLEM tickets with suggested actions.

### Problem 23 — Yank / bad npm release
- **FINAL:** Close #2354 (`not planned`). No product yank verb (dogfood / public-repo). Maintainer runbook: retag `latest` (both packages), `npm deprecate`, security-regression check before rolling back, announce/GHSA. Copy close comment into CONTRIBUTING/release docs when convenient. Publish dist-tag choice (#5852) stays separate.
- **Tickets closed:** #2354
- **Date:** 2026-10-23

### Problem 24 — Pin inventories / ghx
- **FINAL:** Retarget #3513 (stays open): strip language-scaffold versions; remove ghx from product (setup:ghx, PATH chooser, CI, live prefer-ghx docs). Reject freshness-detector design. Cache story = `.deft-cache` + `gh`. Implement later; coordinate cuts as needed.
- **Ticket:** #3513 (comment 2026-10-23)
- **Date:** 2026-10-23

### Problem 25 — OpenClaw doctor test hermeticity
- **FINAL:** HOLD / out of installer round. Not area:installer. #3770 stays open with `hold`, unassigned; lifecycle/core-capabilities labels stripped. Niche OpenClaw runtime test isolation.
- **Ticket:** #3770
- **Date:** 2026-10-23

### Problem 26 — scope:complete PR-only path
- **FINAL:** HOLD / out of installer-OVPR work set. #5710 open + hold, unassigned; lifecycle/core-capabilities/area:installer stripped.
- **Ticket:** #5710
- **Date:** 2026-10-23

### Problem 27 — cache:doctor
- **FINAL:** OUT of installer-OVPR work set. #946 open, unassigned, no hold; core-capabilities/promise:lifecycle stripped.
- **Ticket:** #946
- **Date:** 2026-10-23
- **Policy note:** For 25–27 out-of-set parks, do **not** apply `hold` — leave open for others to pick up.

### Problem 28 — First-run skill / init decision
- **FINAL:** Close #4372 (`not planned`). Chicken-and-egg; polite close cites `directive install` as activation; markers are opt-out not discovery; web/agent lookup is separate.
- **Tickets closed:** #4372
- **Date:** 2026-10-23

### Problem 29 — README front door
- **FINAL:** Close #804; successor #5867 human README revamp (hold+urgent, assignee polfer).
- **Tickets:** closed #804; open #5867
- **Date:** 2026-10-23

### Problem 30 — agents-entry work-claim
- **FINAL:** Dismiss. Tip already propagates Work-claim text; contract-enforced. SLizard P2 stale/wrong as open gap. No GitHub ticket.
- **Date:** 2026-10-23

### Problem 31 — OVPR bins + node_modules path reviewer calm
- **FINAL:** Keep WORK. Ticket #5869: educate SLizard/Greptile on launcher vs runtime; PM-install hatch beside relative runtime paths; do not add fake bins.
- **Ticket:** #5869 (open, assignee polfer)
- **Date:** 2026-10-23

### Problem 32 — Grok hook dual PreToolUse
- **FINAL:** WORK via #5807 only. Comment recorded on #5807.
- **Ticket:** #5807
- **Date:** 2026-10-23

### Problem 33 — hook-bin fail-closed / disable order
- **FINAL:** WORK via #5809. Comment on #5809 + cross-link on #5869.
- **Ticket:** #5809
- **Date:** 2026-10-23

## End-of-walk work set (open tickets to resolve)

Disposition walk finished 2026-10-23. Implement / merge from these clean open tickets (plus any earlier FINALs still open on the ledger):

| Issue | Problem | Notes |
|------|---------|-------|
| #5867 | 29 | Human README revamp — **hold** + urgent; assignee polfer |
| #5869 | 31 | OVPR SLizard/Greptile calm + PM-install hatch messaging |
| #5807 | 32 / earlier | Grok dual PreToolUse upgrade blocker |
| #5809 | 33 | Disable before missing runtime bin; PM-install recovery |
| #3513 | 24 | Strip language-scaffold versions; remove ghx from product |
| #2354 | 23 | **Closed** — yank runbook only |
| #804 | 29 | **Closed** → #5867 |
| #4372 | 28 | **Closed** — chicken-and-egg first-run skill |
| #3770 / #5710 / #946 | 25–27 | Open, unassigned, out of this work set (no hold) |

Re-check full ledger table in this file for earlier Problems 1–22 FINALs and any still-open WORK from that pass.

## GitHub tickets sealed (arc-proof pass)

**Sealed:** 2026-10-23 — Locked disposition prepended on in-set open tickets; TRIAGED + `design-critique: not warranted` comments; `design-critique:ingest-ready` removed from #5808 and #5540; #5543 closed → #5809; #4662↔#5867 cross-linked; out-of-set #3770/#5710/#946 noted.

Implement from issue **bodies** (Locked disposition). Living plan remains the walk audit log only.

