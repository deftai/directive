# SLizard code facts (for investigators)

Use to falsify popular fantasies. Cite file paths in EV descriptions; still verify production env separately.

---

## LLM_AGENTIC_CONTEXT

- Loaded in `src/config.ts`: `llmAgenticContext = env('LLM_AGENTIC_CONTEXT') === 'true'`.
- Default **off** unless env is literally `true`.
- When off, `gatherReviewContext` in `src/reviewer/review-session-context.ts` uses **single-pass** vector search — not `gatherAgenticContext` multi-hop.
- ⊗ Infer agentic from code comments, probes, or old vbrief Problem text.

**Verify in prod:** `fly secrets list -a slizard` and/or process env on machine. Secret absent = off.

---

## Repo gates (#1264)

Module: `src/reviewer/review-repo-gates.ts`

| Gate | Scope | Blocks |
|------|-------|--------|
| `index-write` | repoId + clonePath | exclusive writer |
| `clone` | clonePath | exclusive |
| `working-tree` | clonePath | shared readers; blocked by clone/index-write |
| `graph-read` | repoId | blocked by index-write |
| `index-read` | repoId | blocked by index-write |

Gates acquired inside `withRepoGate(..., async () => { ... })` only for the duration of that callback.

**Context phase** (`review-session.ts`): `index-read` during `gatherReviewContext` only — released when callback returns.

**Static phase:** `working-tree` during deterministic/static work — released when callback returns.

**LLM extract/verify waits:** HTTP in flight — **not** inside repo gate callbacks unless explicitly nested (they are not for typical extract).

Log signals of actual contention:

- `event: review.gate.degrade` (gate name, crId)
- metrics `review.gate.timeout.<gate>.<repoId>`

⊗ Claim lock contention from overlapping session wall clocks without gate events on anchor crId.

---

## Timeout / salvage / zombie (#1196)

- `review.timeout` — session wall hit; handler may await salvage.
- Salvage may continue LLM/format work (`review-session-timeout-salvage.ts`).
- `review.timeout.zombie_prevented` — duplicate submit blocked after timeout.
- Prior timed-out session chewing Gemini tokens ≠ holding index-write for a new session unless logs show gate degrade during overlap window.

---

## Phase attribution (#1265)

Use `review.completed` / `review.timeout` phase breakdown for **each** attempt (crId + timestamp). Do not blend six attempts into one slow-context story without per-attempt dominant phase.

**Footgun — missing `review.completed`:** A session may log all `review.phase.complete` through `review-dedup` then never emit `review.completed`. For lifecycle counting, treat as terminal if no later `review.*` for that crId within 30m. See domain pack § Log footguns.

---

## Context search scope

- `gatherReviewContext` searches the indexed repo — **not** one embedding round-trip per changed file in the PR diff.
- PR file count from GitHub (`gh api pulls/N/files`) ≠ number of vector queries.
- Wide PR trap uses admission/skip events — not raw file count alone as slowness proof.