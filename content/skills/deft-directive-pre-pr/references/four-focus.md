# Four-focus pre-PR pass

Specialist review of `merge-base..HEAD` **after** the RWLDL loop and **before** push / PR open. Invoked from `deft-directive-pre-pr` Phase 6.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `≉`=SHOULD NOT, `⊗`=MUST NOT, `?`=MAY.

## When it runs

- ! Once per push / PR-open, covering every commit that would leave the machine (`git merge-base` with `origin/main` or `origin/master`, then `git diff <merge-base>..HEAD`).
- ⊗ Per-commit (too expensive; trains skip).
- ⊗ Empty `merge-base..HEAD` — report "nothing to push" and skip the specialists.
- ~ Docs-only diffs still run **C** and **D**; A and B MAY return empty after reading.

## Passes

Each pass is a **read-only specialist**. It may only report findings in its lens. Empty findings are valid only after the agent has read the diff **and** the surrounding source (not from memory).

| Pass | Looks for |
|---|---|
| **A** | Acceptance + tests |
| **B** | Bug hunt |
| **C** | Stealth / secrets / log leaks |
| **D** | Regression + extra scope |

Severity: `P0` (must-fix before push), `P1` (must-fix or file-and-justify), `P2` (advisory, does not block).

### Pass A — Acceptance + tests

- ! Every acceptance criterion on the active xBRIEF / spec item is met by the diff, or is explicitly out of this PR with a recorded follow-up.
- ! New behavior has tests that would fail without the change (not tautological assertions).
- ! Both sides of new branches are exercised (happy path, error, empty, default).
- ! Coverage on changed modules has headroom above the project floor (`#2683`), not barely-at-floor.
- ⊗ Report secrets, extra-scope files, or latent bugs that are not acceptance/test gaps (those are C / D / B).

### Pass B — Bug hunt

- ! Adversarial correctness only: off-by-one, null/undefined, races, swallowed errors, wrong defaults, broken types, unhandled rejection, inverted conditions, missing await, stale closures.
- ! Read call sites around the diff, not only the hunk.
- ⊗ Report missing tests, secrets, or scope creep (those are A / C / D).

### Pass C — Stealth / secrets / log leaks

- ! Secrets, tokens, PATs, cookies, private keys, connection strings in the diff, fixtures, screenshots, committed `.env`, or example files that are not `.example`.
- ! Log / error / telemetry / agent-transcript leaks: PII, full request bodies, stack traces with env, prompt dumps, internal URLs.
- ! Debug leftovers that disclose unreleased or internal process (verbose payload dumps, committed session transcripts).
- ~ Align with `coding/security.md` secrets + no-log-credentials; this pass is the pre-push enforcement, not a restatement of the security corpus.
- ⊗ Report missing tests or extra-scope files (those are A / D).

### Pass D — Regression + extra scope

- ! Files / behavior outside the active xBRIEF changed without being required by the story.
- ! Adjacent tests deleted, skipped, or weakened solely to go green (`#3156` gate integrity).
- ! Missing or mismatched `CHANGELOG.md` `[Unreleased]` entry (when the repo has that file).
- ! Unintended whitespace-only or formatting drift that hides the real change.
- ~ Closing-keyword hazards in commit messages (`#737`) MAY be flagged here; the mechanical `task pr:check-closing-keywords` remains the fail-closed lint.
- ⊗ Silently expand the PR to absorb extra-scope findings — file them as issues / ideas instead.

## Output schema

Each specialist returns JSON:

```json
{
  "pass": "A",
  "findings": [
    {
      "severity": "P0",
      "file": "path/to/file.ext",
      "line": 42,
      "issue": "what is wrong",
      "evidence": "what was read (diff hunk, call site, test name)"
    }
  ]
}
```

- ! `pass` is `A` | `B` | `C` | `D`. `severity` is `P0` | `P1` | `P2`.
- ! Drop any finding whose `evidence` is missing or empty — it is unverified.
- ! An empty `findings` array is valid only after the specialist used git/read/grep on the actual diff.

## Host fallback

1. **Grok workflow:** if `.grok/workflows/pre-pr-four-focus.rhai` (or `~/.grok/workflows/pre-pr-four-focus.rhai`) exists, run it (`/pre-pr-four-focus`). Pass `args.base` = merge-base SHA when known.
2. **Parallel subagents:** `spawn_subagent` × 4, `background: true` then wait, each with this file + one pass letter + the merge-base. Specialists never edit source.
3. **Sequential fallback:** same agent runs A→B→C→D, re-reading this file and `git diff <merge-base>..HEAD` at the start of each pass so the previous lens does not bleed.
- ⊗ One agent "doing all four passes in one thought" when (1) or (2) is available.

## Dual-stop (#2442)

- **Success:** zero P0/P1 after synthesis (P2 does not block).
- **Failure / budget:** 2 re-runs after in-scope fixes, then halt with an operator-visible leftover list.
- ! Parent applies in-scope P0/P1 only, re-runs `task check`, re-runs four-focus.
- ⊗ Drive-by fixes for out-of-scope Pass D findings.

## Operator-visible report

After synthesis the parent prints:

1. Counts by pass and severity.
2. The P0/P1 list as `pass severity file:line — issue`.
3. Whether the gate is clean, looping, or halted at the iteration cap.

## Anti-patterns

- ⊗ Push because RWLDL / `task check` was green if four-focus did not run.
- ⊗ Claim four-focus passed without launching the specialists or reading the diff.
- ⊗ Pass B reporting missing tests, or Pass A reporting secrets (lens bleed).
- ⊗ Fixing Pass D extra-scope by silently expanding the PR.
