# Install OVPR — Human Test Plan

**Status:** Active test plan for the OVPR installer (HT-00–HT-17).

**Harness:** After wave4j lands, prefer in-repo `tools/install-harness/` (see folder README). During YOLO, runners lived under `~/yolo-5490/ht-auto` and `~/yolo-5490/repo-upgrade`.

**Authority:** Product pass/fail follows [install-ovpr-requirements.md](./install-ovpr-requirements.md). This plan does not waive ACs.

---

# HUMAN-TEST-PLAN — OVPR beta readiness (tip `yolo-cp-wave2zb`)

Rank-ordered **high-value human** tests for declaring public npm **`beta`** from the current YOLO tip.  
Authority: `UNIFIED-GITHUB-V2.md` / #5490 · lifecycle: `IMPLEMENTATION-LIFECYCLE-CHEATSHEET-V1.md` · process: YOLO sterile field.  
Outside checker: `~/Projects/directive-install-sanity` (read-only sidecar; not a substitute for `directive doctor`).

**Tip under test (default):**

| | |
| --- | --- |
| Git CP | `yolo/cp-wave2zb` @ `0be7813c4…` |
| Verdaccio tag | `yolo-cp-wave2zb` |
| Version | `0.0.0-yolo.cp-wave2zb.1` |
| Patient WIP (if still open) | `yolo/wip-wave2zb` — freeze/publish before treating tip as immutable |

---

## 0. Open issues / todos (snapshot)

Update this section when the tip or inbox changes. Do **not** file GitHub tickets until the operator asks; use `/yolo-cp-finding` for product defects found here.

### Product findings inbox

| State | Item |
| --- | --- |
| **Open** | _(none — F-001…F-008 closed on tip)_ |
| Closed (regression watch) | F-001 UX-INT-TTY · F-002 UX-PRESENT · F-003 CLI-PARSE · F-004 AGENTS-STUB · F-005 SKILL-INV · F-006 OWN-SKILLS · F-007 FEAT-PRESERVE · F-008 GIT-HOOKS-INACTIVE |
| Known residual (non-blocker) | Uninstall success report still pre-§C9 dump style; Greptile slash/OpenClaw rewrite notes |

### Process / release todos (not HT failures)

| ID | Item | Blocks beta? |
| --- | --- | --- |
| **P-BETA** | Happy-path human suite below green → `/yolo-beta-release` | **Yes** (this plan) |
| **P-CONTRACT-SO** | Contract 1 operator sign-off (`CONTRACT-v1.md`) | No (process; note in CP) |
| **P-1E** | Slice **1e** GA release skill in-repo | No for tip→`beta`; yes before trusted GA |
| **P-WAVE3** | Historical layout/schema survey (AC10.8 / AC14.32 / AC15.2) | **No** (deferred by design) |
| **P-MATRIX** | Win/Linux × Node live matrix (AC15.1 partial) | No for initial beta; UNVERIFIED |
| **P-HOSTS** | Full AC9.8 per-host open proof | Soft; spot in HT-07/08 |
| **P-SYNC** | Keep `master` → `yolo/5490` sync while soaking | Ops hygiene |
| **P-STERILE** | Stay sterile on this checkout until cutover | Ops hygiene |

### How this plan is meant to be used

1. Run tests **in ID order** (HT-00 → …). Stop or file findings on FAIL; do not skip ahead to pad coverage.
2. Operator + agent iterate **one test at a time**: fill that test’s `<!-- HT-RESULT:HTxx -->` block, append a line to §8 Session log, then decide next.
3. After Tier A (HT-00…HT-06) is green, beta cut is **credible**. Tier B–D push toward ~80% of due-now AC surface.
4. New defects → `/yolo-cp-finding` (inbox), then optional `/yolo-fix-pass` — do not invent GitHub issues here.

---

## 1. Authoring rules (adapted from test-audit)

Reference only: `~/Projects/test-audit/SKILL.md` Authoring Gate, Junk Patterns, Value / Retention bars. Applied here to **human** tests.

**Keep a test only if you can answer:**

1. What **observable** user/install behaviour or contract does it protect?
2. What **credible regression** makes it fail (something that already bit us, or would block shop beta)?
3. Why do **smokes / doctor / sanity alone** not already catch it at this boundary?
4. Does it avoid needing a fake production seam just for the test?

**Junk for this plan (do not add):**

- Replaying the same install path under every PM/OS “because matrix”
- Assertion-free “looks fine” walkthroughs with no Expected
- Ganging install+upgrade+uninstall into one mega-script that hides which AC failed
- Exact source/string greps of launcher internals as the only proof
- Duplicating an earlier HT with only fixture rename
- Capability inventories that restate flags without exercising delivery

**Value bar:** each HT below is a **primary owner** for a beta-blocking or high-trust shop path. One HT may cover several ACs when they share one real journey.

---

## 2. Coverage model

**Denominator ≈ “due now” for initial beta** (REQUIREMENTS R1–R14 MUST rows that are not Wave-3 follow-up / not Win-only matrix). Roughly the wave2s coverage-ledger “Due now? = yes” surface, after tip fixes for F-001…F-008.

| After completing… | Cumulative estimate | Meaning |
| --- | --- | --- |
| Tier A HT-00…HT-06 | **~45%** | Cold start, plan UX, doctor, repair, uninstall — **beta bar** |
| + Tier B HT-07…HT-10 | **~65%** | Git hooks, clone activation, equal-version, configured menus |
| + Tier C HT-11…HT-14 | **~75%** | Refuse / non-TTY / yarn / no-git disclosure |
| + Tier D HT-15…HT-17 | **~80%+** | Legacy convert (if fixture), multi-project, Dependabot rewire |

Estimates are **operator judgment aids**, not a formal ledger. When an HT is SKIP (no fixture), do not count its ACs as covered.

**Out of this plan (by design):** full OS×PM×Node matrix, Wave 3 historical shapes, public `@latest` GA, dogfood against the Directive checkout, emergency `@latest` flips.

---

## 3. Shared bootstrap (every session)

**Preferred:** put `~/yolo-5490/bin` on your PATH once, then at the start of each HT (and safely any time you open a new shell):

```bash
# one-time per login shell (or add to ~/.zshrc for YOLO days):
export PATH="$HOME/yolo-5490/bin:$PATH"

# shared env only (refreshes HT_VER / PATH; leaves CONSUMER alone):
eval "$(ht-prep)"

# new empty consumer for this HT (writes hybrid .npmrc, exports CONSUMER + HT_VER, cds there):
eval "$(ht-prep ht-02)"

# new consumer with git:
eval "$(ht-prep ht-07 --git)"

# keep an existing tree (e.g. continue HT-01 → HT-02):
eval "$(ht-prep --reuse "$CONSUMER")"
# or: eval "$(ht-prep --reuse /path/to/prior-consumer)"
```

Script: `~/yolo-5490/bin/ht-prep` (stdout = `export`/`cd` for `eval`; status on stderr). Always sets `HT_TAG`, `HT_VER`, `HT_SANITY`, `PATH`, `NPM_CONFIG_USERCONFIG`, `YOLO_5490`.

**Manual equivalent** (if you cannot use the script):

```bash
source ~/yolo-5490/env.sh
export PATH="$YOLO_5490/prefix/bin:$PATH"
export NPM_CONFIG_USERCONFIG="$YOLO_5490/.npmrc-yolo"
export HT_TAG="${HT_TAG:-yolo-cp-wave2zb}"
export HT_VER="$(npm view "@deftai/directive@$HT_TAG" --registry http://127.0.0.1:4873 version)"
export HT_SANITY="${HT_SANITY:-$HOME/Projects/directive-install-sanity}"
```

**Hybrid consumer `.npmrc`** (written by `ht-prep` for you):

```text
registry=https://registry.npmjs.org/
@deftai:registry=http://127.0.0.1:4873/
```

**Throwaway consumers** live under `~/yolo-5490/fixtures/ht-*/`. Never use `~/Projects/directive` as the install target.

**Sanity after a successful install** (strict):

```bash
cd "$HT_SANITY" && npx tsx src/cli.ts --root "$CONSUMER"
# expect: Summary … 0 failed (warnings OK, e.g. LAUNCHER-SPOT soft)
```

**Finding on FAIL:**

```text
/yolo-cp-finding
```

---

## 4. Progress board (update as you go)

| ID | Title | Tier | Status | Cumul. % | Result block |
| --- | --- | --- | --- | --- | --- |
| HT-00 | Load tip launcher globally | A | `PASS` | 5% | § HT-00 |
| HT-01 | Empty folder clean install + sanity | A | `PASS` (F-009 filed) | 20% | § HT-01 |
| HT-02 | Doctor after greenfield | A | `FAIL` (F-010 filed) | 28% | § HT-02 |
| HT-03 | Interactive [y/N] live TTY | A | `PASS` | 35% | § HT-03 |
| HT-04 | Dry-run + §C9 plan presentation | A | `PASS` | 40% | § HT-04 |
| HT-05 | Repair idempotent on healthy tree | A | `PASS` | 43% | § HT-05 |
| HT-06 | Uninstall preserves xbrief + reinstall | A | `PASS` (F-012/013/014 filed) | 45% | § HT-06 |
| HT-07 | Git repo install activates hooksPath | B | `PASS` (F-015 filed) | 52% | § HT-07 |
| HT-08 | Fresh clone first activation | B | `PASS` | 58% | § HT-08 |
| HT-09 | Equal-version upgrade spot | B | `PASS` | 62% | § HT-09 |
| HT-10 | Configured install without --repair | B | `PASS` | 65% | § HT-10 |
| HT-11 | Refuse `$HOME` / `/` as destination | C | `NOT_RUN` | 68% | § HT-11 |
| HT-12 | Non-TTY without --yes → exit 2 | C | `NOT_RUN` | 71% | § HT-12 |
| HT-13 | Yarn project refused | C | `NOT_RUN` | 73% | § HT-13 |
| HT-14 | No-git install disclosure | C | `NOT_RUN` | 75% | § HT-14 |
| HT-15 | Latest legacy convert (if fixture) | D | `NOT_RUN` | 78% | § HT-15 |
| HT-16 | Two projects, one launcher | D | `NOT_RUN` | 79% | § HT-16 |
| HT-17 | Dependabot-style pin bump rewire | D | `NOT_RUN` | 80%+ | § HT-17 |

**Status values:** `NOT_RUN` · `PASS` · `FAIL` · `BLOCKED` · `SKIP`

---

## 5. Uniform result marker (every HT)

Copy this shape into each test’s result fence. Agent/operator updates **only** the fence for the test just run so restarts can `grep 'HT-RESULT:HT-'`.

```markdown
<!-- HT-RESULT:HT-XX -->
| Field | Value |
| --- | --- |
| Status | NOT_RUN |
| Ran | |
| Tip tag / version | |
| Consumer path | |
| Commands exit codes | |
| Sanity summary | n/a \| N passed, 0 failed, W warnings |
| Expected met? | yes / no / partial |
| Notes (symptoms, quotes) | |
| Finding keys (`F-…` or none) | |
| Evidence paths | |
<!-- /HT-RESULT:HT-XX -->
```

---

## 6. Tier A — beta bar (do these first)

### HT-00 — Load tip launcher globally

**Why first:** Every later HT assumes `directive` on PATH is the tip under test, not public `@latest` / old fat package.

**Steps**

1. `source ~/yolo-5490/env.sh` and export `PATH` / `NPM_CONFIG_USERCONFIG` as in §3.
2. Confirm Verdaccio is up: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4873/` → `200`.
3. `npm view @deftai/directive@$HT_TAG version --registry http://127.0.0.1:4873`
4. `npm i -g @deftai/directive@$HT_TAG --prefix "$YOLO_5490/prefix" --registry http://127.0.0.1:4873`
5. `which directive` → under `$YOLO_5490/prefix/bin`
6. `directive --version` → reports launcher `0.0.0-yolo.cp-wave2zb.1` (or current `$HT_VER`)

**Expected**

- Global install succeeds; `directive` / `deft` resolve from YOLO prefix.
- Version line names the tip launcher (no project pin yet is fine).

**ACs covered:** AC3.5, AC3.14 (launcher half), AC13.4 (pair exists on registry)

**Cumul. %:** ~5%

<!-- HT-RESULT:HT-00 -->
| Field | Value |
| --- | --- |
| Status | PASS |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb (operator confirmed) |
| Consumer path | n/a |
| Commands exit codes | 0 |
| Sanity summary | n/a |
| Expected met? | yes |
| Notes (symptoms, quotes) | Operator: Pass. |
| Finding keys (`F-…` or none) | none |
| Evidence paths | |
<!-- /HT-RESULT:HT-00 -->

---

### HT-01 — Empty folder clean install + sanity

**Why:** Highest-value cold-start path. Empty folder, **no** `git init`, create `{private:true}`, pin exact runtime, setup, then outside sanity. This is the shop “try beta” journey.

**Steps**

1. `CONSUMER=$(mktemp -d "$YOLO_5490/fixtures/ht-01-empty-XXXXXX") && cd "$CONSUMER"`
2. Write hybrid `.npmrc` (see §3). Do **not** run `git init`. Do **not** create `package.json`.
3. `directive install --root "$CONSUMER" --dry-run --target-version "$HT_VER"` — read the plan; change nothing yet (spot-check only; full dry-run ownership is HT-04).
4. `directive install --root "$CONSUMER" --yes --target-version "$HT_VER"`
5. Confirm no CLI errors; note completion / Next / Review style (§C9, not `operation:` / `created=[…]` dumps).
6. Spot-check: `package.json` has exact `@deftai/directive-runtime@$HT_VER`; no `.deft/core`; `AGENTS.md` exists with package-relative pointers.
7. `cd "$HT_SANITY" && npx tsx src/cli.ts --root "$CONSUMER"`

**Expected**

- Exit 0 from install.
- Manifest created as tooling-only private project; exact pin; lockfile records pin; `node_modules/@deftai/directive-runtime` matches.
- Human §C9-style plan/progress (titles like Set up / Project / Install command / ✓ / Next).
- Sanity: **0 failed** (warnings allowed).

**ACs covered:** AC1.1, AC1.2, AC1.3 (via NEST-ONE), AC5.1/5.3/5.16, AC6.1, AC6.12, AC8.1 (wiring deposited), AC13.1, AC14.40; sanity PIN-EXACT…LAUNCHER-SPOT

**Cumul. %:** ~20%

<!-- HT-RESULT:HT-01 -->
| Field | Value |
| --- | --- |
| Status | PASS |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb / 0.0.0-yolo.cp-wave2zb.1 |
| Consumer path | ~/yolo-5490/fixtures/ht-01-* (operator) |
| Commands exit codes | install succeeded (operator) |
| Sanity summary | (operator; see walkthrough) |
| Expected met? | yes (mechanical); plan copy filed as F-009 |
| Notes (symptoms, quotes) | Install worked; plan language jargon → F-009. |
| Finding keys (`F-…` or none) | F-009 |
| Evidence paths | INBOX F-009; dogfood-notes §F-009 |
<!-- /HT-RESULT:HT-01 -->

---

### HT-02 — Doctor after greenfield

**Why:** AC6.2 — after first install, doctor must report in sync with **no writes**. Catches “install looked OK but sync definition broken.”

**Steps**

1. Reuse HT-01 `$CONSUMER` (or re-run HT-01 if discarded).
2. Snapshot quickly: `find "$CONSUMER" -type f ! -path '*/node_modules/*' | sort > /tmp/ht02-before.txt`
3. `directive doctor --root "$CONSUMER"` (or `cd "$CONSUMER" && directive doctor`)
4. Re-diff files vs snapshot (ignore readiness markers only if doctor is allowed to leave them untouched — doctor must write **nothing**).
5. Confirm doctor claims in sync / healthy for pin `$HT_VER`.

**Expected**

- Exit 0; in sync; no file mutations (AC12.1).
- Remedies, if any informational lines, must not invent “run upgrade” when repair is the truth.

**ACs covered:** AC2.1, AC2.3, AC6.2, AC12.1–12.3, AC12.7

**Cumul. %:** ~28%

<!-- HT-RESULT:HT-02 -->
| Field | Value |
| --- | --- |
| Status | FAIL |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb / 0.0.0-yolo.cp-wave2zb.1 |
| Consumer path | /Users/polfer/yolo-5490/fixtures/ht-01-empty-WBLqsq |
| Commands exit codes | doctor non-zero / not in sync |
| Sanity summary | n/a |
| Expected met? | no (on no-git greenfield) |
| Notes (symptoms, quotes) | readiness FAIL missing wiring-ready; Recovery wrongly suggests npm i -g + repair. Tip withholds readiness without git. Operator: consistent WARN through plan/doctor; AC6.2 only if preconditions met; open Q require-git warn vs refuse. Before/after find on $CONSUMER: no file differences (doctor wrote nothing — AC8.8/AC12.1 OK). |
| Finding keys (`F-…` or none) | F-010 |
| Evidence paths | INBOX F-010; dogfood-notes §F-010 |
<!-- /HT-RESULT:HT-02 -->

---

### HT-03 — Interactive [y/N] live TTY

**Why:** Live regression of F-001 / AC5.2. Injected smokes are not enough; human terminal must wait for `y` / `N`.

**Steps**

1. New empty consumer with hybrid `.npmrc` (no prior pin):  
   `CONSUMER=$(mktemp -d "$YOLO_5490/fixtures/ht-03-int-XXXXXX")`
2. In a **real interactive TTY** (Terminal.app / Warp / iTerm — not a pipe):  
   `cd "$CONSUMER" && directive install --target-version "$HT_VER"`
3. Confirm prompt waits: `Set up Directive in this project? [y/N]` (wording may say Deft Directive).
4. Press **Enter** alone (default No) → expect cancel, no files.
5. Re-run; type **`n`** → cancel, no files.
6. Re-run; type **`y`** → install proceeds to success.
7. Optional: sanity on the successful tree.

**Expected**

- Prompt **blocks** until Enter; no instant `Cancelled` without keystrokes.
- Cancel paths: message includes `Cancelled. No project files were changed.`; exit 0; tree unchanged aside from nothing meaningful.
- Accept path: install completes like HT-01.

**ACs covered:** AC5.2, AC14.39, AC6.1 (interactive half)

**Cumul. %:** ~35%

<!-- HT-RESULT:HT-03 -->
| Field | Value |
| --- | --- |
| Status | PASS |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb / 0.0.0-yolo.cp-wave2zb.1 |
| Consumer path | ht-03 via ht-prep (operator) |
| Commands exit codes | Enter/n cancel OK; y install OK |
| Sanity summary | (optional; operator) |
| Expected met? | yes |
| Notes (symptoms, quotes) | Live TTY waits; cancel paths clean. Operator noted long plan lines wrap at terminal width (COLUMNS=134) — see F-011 wrap finding. |
| Finding keys (`F-…` or none) | none for HT-03 AC; F-011 noted from same session |
| Evidence paths | |
<!-- /HT-RESULT:HT-03 -->

---

### HT-04 — Dry-run + §C9 plan presentation

**Why:** Separates plan UX (F-002) from mutation. Dry-run must be plan-only; default stdout must be human §C9, not keyed debug.

**Steps**

1. New empty consumer + hybrid `.npmrc`.
2. `directive install --root "$CONSUMER" --dry-run --target-version "$HT_VER"`
3. Confirm exit 0; read plan sections (operation framing, project path, PM, version, install command, disclosures).
4. `find "$CONSUMER" -type f` → only `.npmrc` (and empty dir); **no** `package.json` / `node_modules` / `.deft`.
5. Re-run with `-v` once: internals may appear; default without `-v` must stay polished.

**Expected**

- Dry-run changes nothing (AC5.4 / AC14.49).
- Default presentation matches §C9 Examples (titles / ✓ style), not `operation:` / `created=[…]`.

**ACs covered:** AC5.1, AC5.4, AC14.49; UX-PRESENT / §C9

**Cumul. %:** ~40%

<!-- HT-RESULT:HT-04 -->
| Field | Value |
| --- | --- |
| Status | PASS |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb / 0.0.0-yolo.cp-wave2zb.1 |
| Consumer path | ht-04 via ht-prep (operator) |
| Commands exit codes | 0 |
| Sanity summary | n/a |
| Expected met? | yes |
| Notes (symptoms, quotes) | Operator: FULL PASS. Dry-run plan-only; no mutation. |
| Finding keys (`F-…` or none) | none (F-009/F-011 already filed for copy/wrap) |
| Evidence paths | |
<!-- /HT-RESULT:HT-04 -->

---

### HT-05 — Repair idempotent on healthy tree

**Why:** Standard recovery path shops will run; second repair must be a no-op for files that matter.

**Steps**

1. Start from a green HT-01 (or HT-03 accept) consumer `$CONSUMER`.
2. `directive install --root "$CONSUMER" --repair --yes`
3. Confirm pin **unchanged**; doctor still in sync.
4. Run repair **again**; compare meaningful tree (exclude `node_modules` noise / readiness mtime if ephemeral).
5. Sanity again: `npx tsx "$HT_SANITY/src/cli.ts" --root "$CONSUMER"`

**Expected**

- Both repairs exit 0; pin identical; second pass no further managed-file churn (AC6.9).
- Never migrates existing xbrief (AC6.8).

**ACs covered:** AC1.5, AC6.3, AC6.6–6.10, AC9.7 (recovery shape)

**Cumul. %:** ~43%

<!-- HT-RESULT:HT-05 -->
| Field | Value |
| --- | --- |
| Status | PASS |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb / 0.0.0-yolo.cp-wave2zb.1 |
| Consumer path | (operator green consumer) |
| Commands exit codes | 0 |
| Sanity summary | (operator) |
| Expected met? | yes |
| Notes (symptoms, quotes) | Operator: PASSED. |
| Finding keys (`F-…` or none) | none |
| Evidence paths | |
<!-- /HT-RESULT:HT-05 -->

---

### HT-06 — Uninstall preserves xbrief + reinstall

**Why:** Data safety + re-entry. Beta shops must trust uninstall does not eat briefs.

**Steps**

1. On a green consumer, ensure at least one real or seeded path under `xbrief/` exists; record checksum:  
   `find "$CONSUMER/xbrief" -type f | sort | xargs shasum > /tmp/ht06-xbrief.sha`
2. `directive uninstall --root "$CONSUMER" --yes`
3. Confirm xbrief checksums identical; pin/runtime wiring removed; user content in AGENTS preserved if any.
4. Sanity **should fail** (no pin) — that is OK; note it.
5. `directive install --root "$CONSUMER" --yes --target-version "$HT_VER"`
6. Confirm install succeeds; xbrief still byte-identical; sanity green again.

**Expected**

- Uninstall exit 0; `xbrief/` untouched (AC11.7).
- Reinstall succeeds in same project (AC11.8).
- Global launcher still present (uninstall must not remove it).

**ACs covered:** AC11.1, AC11.3, AC11.5, AC11.7, AC11.8, AC8.4 (preserve)

**Cumul. %:** ~45% — **Tier A complete → beta cut credible**

<!-- HT-RESULT:HT-06 -->
| Field | Value |
| --- | --- |
| Status | PASS |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb / 0.0.0-yolo.cp-wave2zb.1 |
| Consumer path | /Users/polfer/yolo-5490/fixtures/ht-05-XLvNNb |
| Commands exit codes | uninstall 0; reinstall 0 |
| Sanity summary | clean after reinstall (0 failed) |
| Expected met? | yes for xbrief preserve + reinstall + sanity |
| Notes (symptoms, quotes) | xbrief SHAs unchanged across uninstall/reinstall. Uninstall cleanup/UX gaps filed separately (empty dirs, husks, plan wall). |
| Finding keys (`F-…` or none) | F-012, F-013, F-014 |
| Evidence paths | consumer ht-05-XLvNNb; INBOX F-012…F-014 |
<!-- /HT-RESULT:HT-06 -->

---

## 7. Tier B — day-2 trust (push toward ~65%)

### HT-07 — Git repo install activates hooksPath

**Why:** F-008 class; shops with git expect hooks to become active, not only files on disk.

**Steps**

1. `CONSUMER=$(mktemp -d "$YOLO_5490/fixtures/ht-07-git-XXXXXX")`
2. Hybrid `.npmrc`; `git -C "$CONSUMER" init`; minimal commit optional.
3. `directive install --root "$CONSUMER" --yes --target-version "$HT_VER"`
4. `git -C "$CONSUMER" config --get core.hooksPath` → `.githooks` (or documented equivalent).
5. Confirm `.githooks/pre-commit` (or product set) exists and invokes package-relative helper / runtime path — not bare `deft` on PATH alone.
6. Sanity on `$CONSUMER`.

**Expected**

- hooksPath set when `.git` exists; hook files executable enough to run.
- Sanity GIT-READY notes/passes appropriately.

**ACs covered:** AC2.1(6), AC8.6 (git activation), AC9.1 / AC9.12 (v261027: committed host `.mjs` outer + entry guards; not shell `.sh`), AC9.9; F-008 regression

**Cumul. %:** ~52%

<!-- HT-RESULT:HT-07 -->
| Field | Value |
| --- | --- |
| Status | PASS |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb / 0.0.0-yolo.cp-wave2zb.1 |
| Consumer path | /Users/polfer/yolo-5490/fixtures/ht-07-iYTBGr |
| Commands exit codes | install 0; doctor in sync (install surfaces) |
| Sanity summary | (operator: other elements passed) |
| Expected met? | yes for hooksPath / git install bar |
| Notes (symptoms, quotes) | hooksPath + install/sanity OK. Doctor deep suite regression filed F-015 (not a hooksPath fail). |
| Finding keys (`F-…` or none) | F-015 |
| Evidence paths | INBOX F-015 |
<!-- /HT-RESULT:HT-07 -->

---

### HT-08 — Fresh clone first activation

**Why:** AC2.5 / AC14.2 — committed wiring + `npm/pnpm install` then first eligible command must finish local readiness (including hooks) without re-running full `directive install`.

**Steps**

1. Take a **committed** green consumer (HT-07 style): pin, lockfile, AGENTS, skills, GENERATION committed; **omit** `node_modules` and readiness markers from the “clone”.
2. Simulate clone: copy tree without `node_modules` / wiring-ready files into new dir, or `git clone` a temp remote.
3. `npm install` (or pnpm) in the clone with hybrid `.npmrc`.
4. Run an eligible ordinary command or trigger a registered hook / `directive doctor` then an ordinary command per product rules — prefer a real first runtime invocation that should complete readiness (AC8.6 / AC14.57).
5. Confirm readiness marker appears; `git config core.hooksPath` active; doctor in sync.
6. Sanity.

**Expected**

- Pointers resolve after PM install; first eligible invocation completes local activation; doctor in sync afterward.
- Doctor alone must **not** be the thing that writes readiness (AC8.8 / AC14.57) — use an ordinary eligible path for the write.

**ACs covered:** AC2.5, AC8.6, AC9.3, AC14.2, AC14.57

**Cumul. %:** ~58%

<!-- HT-RESULT:HT-08 -->
| Field | Value |
| --- | --- |
| Status | PASS |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb / 0.0.0-yolo.cp-wave2zb.1 |
| Consumer path | ht-07-iYTBGr-clone (operator) |
| Commands exit codes | 0 |
| Sanity summary | passed |
| Expected met? | yes |
| Notes (symptoms, quotes) | Clone + npm install + eligible commands wrote wiring-ready; sanity OK. |
| Finding keys (`F-…` or none) | none |
| Evidence paths | |
<!-- /HT-RESULT:HT-08 -->

---

### HT-09 — Equal-version upgrade spot

**Why:** Separates upgrade from install. On current tip with data current → no-op; if you can stage “data behind,” migration-only without forced reinstall.

**Steps**

1. Green consumer at `$HT_VER` with current data.
2. `directive upgrade --root "$CONSUMER" --dry-run` (or without target → resolves equal).
3. `directive upgrade --root "$CONSUMER" --yes` (equal / already current).
4. Confirm “already current” / no-op report; pin unchanged; no spurious PM reinstall.
5. **Optional deeper:** if a prior tip version’s xbrief schema fixture exists, pin/install older data shape then upgrade to `$HT_VER` and confirm migration report — only if fixture is ready; else note SKIP for migration half.

**Expected**

- Equal + data current: exit 0, no writes (AC7.3 / AC14.37).
- Optional migration half: only upgrade migrates data; pin moves only when target differs.

**ACs covered:** AC7.1–7.5, AC7.8, AC14.37, AC14.59 (optional half)

**Cumul. %:** ~62%

<!-- HT-RESULT:HT-09 -->
| Field | Value |
| --- | --- |
| Status | PASS |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb / 0.0.0-yolo.cp-wave2zb.1 |
| Consumer path | equal-version on green zb; V→W ht-09-upgrade za.3→zb.1 |
| Commands exit codes | 0 |
| Sanity summary | (operator; deeper half validated) |
| Expected met? | yes |
| Notes (symptoms, quotes) | Equal-version no-op OK; real upgrade za.3→zb.1 OK; no new oddities beyond prior findings. |
| Finding keys (`F-…` or none) | none new |
| Evidence paths | |
<!-- /HT-RESULT:HT-09 -->

---

### HT-10 — Configured install without `--repair`

**Why:** Example E / AC6.6 / AC14.35 — `--yes` alone on configured project must not silently repair or upgrade.

**Steps**

1. Green configured consumer.
2. `directive install --root "$CONSUMER" --yes`
3. Confirm exit **2** and message naming `directive install --repair --yes` (and cancel/repair menu guidance).
4. Confirm pin/files unchanged.

**Expected**

- Exit 2; no mutation; clear next commands.

**ACs covered:** AC5.3, AC6.4–6.6, AC14.35

**Cumul. %:** ~65%

<!-- HT-RESULT:HT-10 -->
| Field | Value |
| --- | --- |
| Status | PASS |
| Ran | 2026-10-13 |
| Tip tag / version | yolo-cp-wave2zb / 0.0.0-yolo.cp-wave2zb.1 |
| Consumer path | ht-10 via ht-prep (operator) |
| Commands exit codes | install 0; bare install --yes → 2 |
| Sanity summary | n/a |
| Expected met? | yes |
| Notes (symptoms, quotes) | Operator: PASS. |
| Finding keys (`F-…` or none) | none |
| Evidence paths | |
<!-- /HT-RESULT:HT-10 -->

---

## 8. Tier C — refuse / disclosure edges (~75%)

### HT-11 — Refuse `$HOME` / `/` as destination

**Steps**

1. `directive install --root "$HOME" --yes --target-version "$HT_VER"` → refused.
2. `directive install --root / --yes --target-version "$HT_VER"` → refused.
3. Confirm `--yes` does **not** bypass.

**Expected:** Non-zero exit; nothing installed into home or `/`.

**ACs covered:** AC3.8, AC14.43

**Cumul. %:** ~68%

<!-- HT-RESULT:HT-11 -->
| Field | Value |
| --- | --- |
| Status | NOT_RUN |
| Ran | |
| Tip tag / version | |
| Consumer path | $HOME / / |
| Commands exit codes | |
| Sanity summary | n/a |
| Expected met? | |
| Notes (symptoms, quotes) | |
| Finding keys (`F-…` or none) | |
| Evidence paths | |
<!-- /HT-RESULT:HT-11 -->

---

### HT-12 — Non-TTY without `--yes` → exit 2

**Steps**

1. Empty consumer + hybrid `.npmrc`.
2. `directive install --root "$CONSUMER" --target-version "$HT_VER" </dev/null`
3. Confirm exit **2**; message requires `--yes`; no files created.

**Expected:** AC5.5 / AC14.34 behaviour (fresh project variant).

**ACs covered:** AC5.5, AC14.34

**Cumul. %:** ~71%

<!-- HT-RESULT:HT-12 -->
| Field | Value |
| --- | --- |
| Status | NOT_RUN |
| Ran | |
| Tip tag / version | |
| Consumer path | |
| Commands exit codes | |
| Sanity summary | n/a |
| Expected met? | |
| Notes (symptoms, quotes) | |
| Finding keys (`F-…` or none) | |
| Evidence paths | |
<!-- /HT-RESULT:HT-12 -->

---

### HT-13 — Yarn project refused

**Steps**

1. Consumer with `package.json` + `yarn.lock` (minimal) and hybrid `.npmrc`.
2. `directive install --root "$CONSUMER" --yes --target-version "$HT_VER"`
3. Confirm clear not-supported message; no npm lock / pin added.

**Expected:** AC5.7 / AC14.44.

**ACs covered:** AC5.7, AC14.44

**Cumul. %:** ~73%

<!-- HT-RESULT:HT-13 -->
| Field | Value |
| --- | --- |
| Status | NOT_RUN |
| Ran | |
| Tip tag / version | |
| Consumer path | |
| Commands exit codes | |
| Sanity summary | n/a |
| Expected met? | |
| Notes (symptoms, quotes) | |
| Finding keys (`F-…` or none) | |
| Evidence paths | |
<!-- /HT-RESULT:HT-13 -->

---

### HT-14 — No-git install disclosure

**Why:** F-008 — without `.git`, hook files may exist but hooksPath cannot activate; user must see honest disclosure, not a silent “fully ready” claim that implies git hooks are live.

**Steps**

1. Empty **non-git** consumer (like HT-01).
2. Install `--yes --target-version "$HT_VER"`.
3. Confirm plan/completion discloses git-hooks inactive / no-git limitation (product wording).
4. Sanity: GIT-READY warn/fail policy as implemented — record actual; treat unexplained “all green including hooks active” as FAIL.

**Expected**

- Install may succeed for non-git tooling use.
- Disclosure present; no false claim that git hooks are active.

**ACs covered:** AC3.7 (no git init), AC8.6 subset, F-008

**Cumul. %:** ~75%

<!-- HT-RESULT:HT-14 -->
| Field | Value |
| --- | --- |
| Status | NOT_RUN |
| Ran | |
| Tip tag / version | |
| Consumer path | |
| Commands exit codes | |
| Sanity summary | |
| Expected met? | |
| Notes (symptoms, quotes) | |
| Finding keys (`F-…` or none) | |
| Evidence paths | |
<!-- /HT-RESULT:HT-14 -->

---

## 9. Tier D — conversion / multi-project (~80%+)

### HT-15 — Latest legacy convert (if fixture)

**Why:** Beta shops still on exact pre-split `@deftai/directive` + `.deft/core` need one approved upgrade path. **SKIP** if no supported legacy fixture is prepared; do not invent an old tree mid-session.

**Steps** (when fixture ready)

1. Place supported legacy consumer under `~/yolo-5490/fixtures/ht-15-legacy-*` (exact pre-split pin + copied core).
2. `directive install --root …` → must stop naming `directive upgrade`.
3. `directive upgrade --root … --yes` (target tip as required by product).
4. Confirm `.deft/core` gone; runtime pin exact; wiring package-relative; xbrief preserved/migrated; doctor in sync; sanity green.

**Expected:** AC10.2–10.6, AC14.28–14.31.

**ACs covered:** AC10.1–10.7 (latest only), AC14.28–14.31

**Cumul. %:** ~78% (0% add if SKIP)

<!-- HT-RESULT:HT-15 -->
| Field | Value |
| --- | --- |
| Status | NOT_RUN |
| Ran | |
| Tip tag / version | |
| Consumer path | |
| Commands exit codes | |
| Sanity summary | |
| Expected met? | |
| Notes (symptoms, quotes) | |
| Finding keys (`F-…` or none) | |
| Evidence paths | |
<!-- /HT-RESULT:HT-15 -->

---

### HT-16 — Two projects, one launcher

**Steps**

1. Two green consumers A and B, both on `$HT_VER` (or B deliberately left alone).
2. In A only: perform a mutating install-management action that would matter if global (e.g. repair, or upgrade if a second version exists).
3. Confirm B’s pin, `node_modules` version, and doctor status unchanged.
4. `directive --version` in each reports that project’s pin.

**Expected:** AC3.11, AC14.24.

**ACs covered:** AC3.11, AC7.10, AC14.24

**Cumul. %:** ~79%

<!-- HT-RESULT:HT-16 -->
| Field | Value |
| --- | --- |
| Status | NOT_RUN |
| Ran | |
| Tip tag / version | |
| Consumer path | |
| Commands exit codes | |
| Sanity summary | |
| Expected met? | |
| Notes (symptoms, quotes) | |
| Finding keys (`F-…` or none) | |
| Evidence paths | |
<!-- /HT-RESULT:HT-16 -->

---

### HT-17 — Dependabot-style pin bump rewire

**Why:** AC14.10 — pin/lockfile already at W, installed W, GENERATION still V → first eligible hook/command refreshes wiring without plan/`--yes`, without migrating xbrief.

**Steps**

1. Green consumer at tip as V.
2. Simulate Dependabot: edit `package.json` + lockfile to a **second available tip version W** if one exists on Verdaccio (e.g. prior `yolo-cp-wave2za`); `npm install` so `node_modules` is W.
3. Leave `.deft/GENERATION.json` recording V (and/or stale readiness).
4. Fire an eligible runtime command or registered host hook (not doctor).
5. Confirm wiring/GENERATION/readiness catch up to W; pin unchanged by the auto path; xbrief bytes unchanged.
6. Doctor in sync at W; sanity.

**Expected**

- Automatic setup authority only (wiring/generation/readiness); no data migration.
- If no second tip version exists, **SKIP** and note — do not force a fake W.

**ACs covered:** AC8.6, AC14.10, AC1.5 (auto path does not write pin)

**Cumul. %:** ~80%+

<!-- HT-RESULT:HT-17 -->
| Field | Value |
| --- | --- |
| Status | NOT_RUN |
| Ran | |
| Tip tag / version | |
| Consumer path | |
| Commands exit codes | |
| Sanity summary | |
| Expected met? | |
| Notes (symptoms, quotes) | |
| Finding keys (`F-…` or none) | |
| Evidence paths | |
<!-- /HT-RESULT:HT-17 -->

---

## 10. Session log (restart / handoff)

Append one line per attempt. Newest at bottom. Agents: when resuming, read §4 Progress board + last 20 lines here + the open `HT-RESULT` fences.

| When (UTC) | HT | Action | Outcome | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-13 | HT-00 | Operator run | PASS | Tip launcher loaded; proceed to HT-01 |
| 2026-10-13 | HT-01 | Operator run | PASS + F-009 | Mechanical install OK; plan jargon filed; proceed HT-02 |
| 2026-10-13 | tooling | ht-prep added | n/a | `~/yolo-5490/bin/ht-prep` for eval bootstrap |
| 2026-10-13 | HT-02 | Operator run | FAIL + F-010 | no-git → readiness FAIL; wrong Recovery; policy Q filed; find before/after unchanged (doctor no writes) |
| 2026-10-13 | HT-03 | Operator run | PASS + F-011 noted | Live y/N OK; filed wrap finding from plan prose |
| 2026-10-13 | HT-04 | Operator run | PASS | Dry-run plan-only FULL PASS |
| 2026-10-13 | HT-05 | Operator run | PASS | Repair idempotent OK |
| 2026-10-13 | HT-06 | Mid (post-uninstall) | F-012/013/014 filed | Empty skill trees hard fail; husks; UX wall; xbrief OK; reinstall not yet |
| 2026-10-13 | HT-06 | Operator run | PASS + F-012/013/014 | Reinstall clean; sanity OK; xbrief SHAs unchanged; Tier A primary bar met |
| 2026-10-13 | HT-07 | In progress + F-015 | filed | Doctor deep suite shadowed; hooksPath check not closed yet |
| 2026-10-13 | HT-07 | Operator run | PASS + F-015 | hooksPath/sanity OK; doctor suite finding separate |
| 2026-10-13 | HT-08 | Operator run | PASS | Clone activation + eligible cmds + sanity OK |
| 2026-10-13 | HT-09 | Operator run | PASS | Equal-version no-op + za.3→zb.1 upgrade OK |
| 2026-10-13 | HT-10 | Operator run | PASS | Configured install without --repair → exit 2 |

**Resume cue for agent:**  
`grep -n 'HT-RESULT:HT-' HUMAN-TEST-PLAN.md` → find first `Status | NOT_RUN` in §4 order → run that test → update its fence + this table + §4 Status cell.

---

## 11. Beta GO checklist (after Tier A green)

When HT-00…HT-06 are `PASS` (and no open **block-forward** inbox items):

1. Freeze tip aliases if needed (`yolo/cp-final-validated` → tip).
2. Run `/yolo-beta-release` (paired publish → npm dist-tag **`beta`**; leave `@latest` old).
3. Shop opt-in: `npm i -g @deftai/directive@beta`.
4. Continue Tier B–D on **`beta`** packages for soak confidence toward ~80%.
5. Keep Wave 3 / Win matrix / 1e on the process backlog — they do not reopen Tier A.

---

## 12. Explicit non-tests (junk / deferred)

Do **not** expand this plan with:

- Full `{npm,pnpm} × {macOS,Linux,Windows} × {Node 22,24}` live matrix (AC15.1) as human bullets
- Wave 3 historical layouts (AC10.8 / AC14.32)
- Re-validating every closed V1 security finding key unless tip regression appears
- Dogfood install/upgrade against `~/Projects/directive` checkout
- Ganged “install then upgrade then uninstall” single script as the only Tier A proof
- CONTRACT-SO as a product FAIL (process note only)

---

_End of HUMAN-TEST-PLAN.md_
