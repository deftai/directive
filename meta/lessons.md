# Lessons Learned

<!-- When codifying lessons from repeated corrections, use RFC 2119 keywords:
     MUST, MUST NOT, SHOULD, SHOULD NOT, MAY
     This makes learned patterns enforceable as standards.
     Example: "When X occurs, the agent MUST do Y" or "API calls SHOULD include timeouts" -->

## Context Engineering (2026-03)

**Source:** Anthropic, "Effective Context Engineering for AI Agents"

**Key insight:** Context rot is real — more tokens ≠ better performance. Every low-signal token actively degrades output quality. The goal is the smallest set of high-signal tokens.

**What was added:** `context/` directory with five guides (context.md, working-memory.md, long-horizon.md, tool-design.md, examples.md) covering Write/Select/Compress/Isolate strategies, vBRIEF integration for structured scratchpads and checkpoints, and surgical edits to main.md and REFERENCES.md for integration.

## PR Review Process (2026-03)

**Source:** Bootstrap parity PR (#83) — 13-round Greptile review cycle on `fix/45-bootstrap-parity`

**1. Review bots post to two channels — both MUST be checked before declaring clean**

GitHub review bots (e.g. Greptile) post inline diff threads (returned by MCP `get_review_comments`) AND a separate "Comments Outside Diff" section in the rolling summary comment (NOT returned by MCP). A PR MUST NOT be declared review-clean until both sources are verified. The outside-diff check MUST use `do_not_summarize_output: true` to prevent summarizers silently dropping that section.

**2. Wide PRs have non-linear review costs**

A PR touching CLI code, TUI code, prose documents, and tests simultaneously creates combinatorial review exposure — each change can generate parity issues in other areas. A 4-surface PR does not take 4× the review effort; in practice it took 13 rounds. SHOULD split changes into focused PRs: code changes separate from prose/instructional document changes.

**3. Instructional documents SHOULD be read as a consumer before opening a PR**

Prose files (SKILL.md, strategy files, README sections) have flow correctness that diffs do not capture — missing bridging instructions, wrong step ordering, and one-question-rule violations are all invisible in a diff view but immediately apparent when read linearly. Before opening a PR that modifies instructional documents, SHOULD read them from start to finish as the agent or user following them would.

**4. Lint fixes MUST NOT weaken test fault detection without a conscious decision**

When a linter demands an explicit parameter (e.g. `strict=` on `zip()`), the chosen value has semantic meaning. In a content-validation test, `strict=True` is more defensive — a malformed row causes an immediate, obvious failure. `strict=False` silently drops mismatched data. MUST evaluate whether a lint fix weakens fault detection; if it does, prefer the more defensive value. Satisfying a linter at the cost of test quality is not a net improvement.

**5. CHANGELOG promotion is a release step, not a PR step — treat them as distinct**

The PR checklist correctly guards `[Unreleased]` entries during review. But promoting `[Unreleased]` → `[X.Y.Z]` (and updating the comparison links) is a **post-merge release step** that happens at tag time, not PR time. These two steps are easy to conflate and the promotion is easy to forget when the tag and push happen in rapid succession. Until `task release` is implemented (tracked in issue #74), the release sequence MUST be: (1) promote CHANGELOG, (2) commit, (3) tag, (4) push tag. MUST NOT tag before the CHANGELOG promotion commit is on the target branch.

## Toolchain Validation Gate (2026-03)

**Source:** Issue #106 — full DEFT workflow completed on iOS/Swift project without Xcode or task installed

**The agent completed interview → PRD → SPEC → implementation without verifying the toolchain**

An agent ran the full DEFT interview (selecting strict release gate: unit + UI + accessibility + performance tests), scaffolded and implemented an iOS app, ran only `swift test` (4 tests, no coverage), and declared success. Neither `task` nor Xcode were available in the session. The quality gates the user explicitly chose were never enforceable.

Existing directives (`! Run all relevant checks`, `⊗ Claim checks passed without running them`) did not prevent this — they govern *execution*, not *prerequisite verification*. There was no rule requiring the agent to verify that the tools needed to enforce quality gates existed before implementation began.

**Before beginning any implementation phase, MUST verify that the complete toolchain required for that phase is installed and functional. If the build or test toolchain is unavailable, stop and report — do not proceed. Quality gates chosen during the interview are meaningless if the tools to enforce them are absent.**

## Build Script Output Validation (2026-03)

**Source:** Issue #105 — silent `dist/` failure in a Chrome extension build

**AI edits to build scripts can silently drop asset copy steps — builds succeed but `dist/` is stale**

An AI edit to `build.mjs` dropped a `copyFileSync` call for `manifest.json`. The build ran without error, but `dist/manifest.json` was stale — missing `content_scripts`, `storage`, and `host_permissions`. The extension overlay silently failed with no visible error.

Existing directives (`! Run all relevant checks`, `! Call out risk when touching build systems`) did not prevent this — they are process rules (run checks) not output validation rules (verify what was produced). A build exiting 0 is not proof that `dist/` is correct.

**When modifying a build script, MUST verify that expected output artifacts exist and are structurally valid after the build runs. Non-compiled assets that bundlers don't track (manifests, configs, extension metadata) are especially at risk of silent omission.**

## Multi-Agent Orchestration via Oz CLI (2026-04)

**Source:** Two parallel local agents on roadmap items — PR #149 (strategy consolidation) and PR #150 (content fixes)

**1. `oz agent run --mcp` with UUID MUST NOT be used from standalone terminals**

The `--mcp` flag with a Warp-configured MCP server UUID requires Warp app context (OAuth tokens, session state). Spawning `oz agent run` in a standalone PowerShell window via `Start-Process` fails with "Failed to start MCP servers". Agents launched outside Warp MUST use `gh` CLI for GitHub operations instead of MCP.

**2. Agent prompts MUST lead with explicit task directives, not context**

An agent given a prompt starting with "You are working in the deft directive repository..." followed by task instructions treated the entire message as passive context, read the directives, and stopped without doing any work. The same tasks given with a prompt starting "TASK: You must complete 5 documentation fixes..." executed correctly. When prompting autonomous agents via `oz agent run --prompt`, the first line MUST be an imperative action statement. Context and constraints SHOULD follow the task.

**3. Agents SHOULD be isolated in separate git worktrees for parallel work**

Two agents working the same repo on different branches need separate working directories. Git worktrees (`git worktree add`) provide branch isolation without full clones. Each worktree gets its own launch script. MUST ensure no file overlap between agents' assigned tasks to avoid merge conflicts.

**4. Review cycle completion is not guaranteed — monitor agent MUST be prepared to take over**

Agent 1 created its PR and stopped before running the Greptile review cycle (the prompt's Step 9). Agent 2 ran 4 autonomous review rounds successfully. The difference was prompt structure. A monitoring agent MUST check whether each spawned agent completed the full workflow and be prepared to finish incomplete steps.

## Parallel Agent Swarm — First Full Run (2026-04)

**Source:** 4-agent swarm on Phase 1 roadmap items — PRs #154, #155, #156, #157 (14 issues closed)

**1. ~~`oz agent run` launches CLOUD agents~~ — CORRECTION: `oz agent run` is LOCAL; `oz agent run-cloud` is the cloud path**

⚠️ **This lesson was incorrect.** Warp confirmed: `oz agent run` runs agents **locally** on the user's machine (supports `--cwd`, `--profile`, `--mcp`; gets codebase indexing and Warp Drive rules). `oz agent run-cloud` runs agents **remotely** on cloud VMs with no local context.

The original lesson was written after the 4-agent swarm (PRs #154–#157) where agents appeared to lose MCP and local context. The actual cause was not that `oz agent run` routes to cloud. **Corrected rule:** `oz agent run --cwd <path> --prompt "..."` is the PREFERRED automated local launch path. MUST use `oz agent run-cloud` only when cloud execution is explicitly desired. MUST NOT conflate the two commands. (#172)

**2. Warp terminal tabs MUST NOT be assumed openable programmatically**

There is no API or CLI command to open a new Warp terminal tab from an agent or script. When the user said "launch", the monitor agent silently used `Start-Process` to open standalone PowerShell windows instead of asking the user to open Warp tabs manually. The user expected Warp tabs with full context. Agents MUST present the tradeoffs (local vs. cloud vs. standalone) and let the user choose before launching.

**3. Sequential merging of PRs with shared append-only files causes rebase cascades**

CHANGELOG.md and SPECIFICATION.md are "append-only" shared files — each agent adds entries without editing existing content. However, when PRs are merged sequentially, each merge changes the file at the same insertion point, causing merge conflicts for remaining PRs. Merging #154 conflicted #155 and #157; merging #155 conflicted #157 again. Each conflict required rebase → push → wait for checks (~3 min). Four PRs required 3 rebase cycles. SHOULD merge all PRs in rapid succession or rebase all remaining PRs before starting merges.

**4. File-overlap audit MUST check transitive file touches, not just primary scope**

The file-overlap audit assigned `skills/deft-review-cycle/SKILL.md` exclusively to Agent 3. But Agent 2 (enforcement rules, #123) added a `/deft:change` verification step to the same file as part of strengthening the review cycle's Phase 1 audit. This was a transitive touch — the enforcement task's acceptance criteria required changes to a file in another agent's scope. The overlap audit MUST trace each task's acceptance criteria to specific files, not just the task's primary scope.

**5. SPECIFICATION.md task status MUST be verified before assigning work**

The original Agent 2 was scoped to #31 and #50 (strategy consolidation). Both had spec tasks (t1.4.1, t1.4.2) marked `[completed]` in SPECIFICATION.md, but the ROADMAP.md still listed them as open. Verifying the spec caught this before agents wasted time reimplementing done work. The select phase MUST cross-reference ROADMAP.md against SPECIFICATION.md status before assigning.

**6. PR numbers don't match agent numbers — include agent ID in branch/PR naming**

GitHub assigns PR numbers in creation order, which depends on which agent finishes first. Agent 2's PR became #154 while Agent 1's became #156. This caused confusion during monitoring and merging. Branch names SHOULD include the agent number (e.g. `agent1/fix/...`) or PR titles SHOULD include `[Agent N]` for traceability.

**7. ~~Cloud agents~~ Agents stopped after PR creation — likely a prompt completeness issue, not a cloud limitation**

⚠️ **Context correction:** The agents in this lesson were launched via `oz agent run` which (see corrected Lesson #1) is **local**, not cloud. The two-pass behavior was likely due to incomplete prompt instructions, not an inherent limitation of the execution environment.

The core lesson remains valid: when agents stop before completing the full workflow (PR + review cycle), the monitor MUST be prepared to complete the remaining steps. Ensure the prompt's STEP 6 (review cycle) instruction is explicit enough to prevent early termination — regardless of whether agents are local or cloud. (#172)

## Option A (oz agent run) Context Limitations (2026-04)

**Source:** Issue #179 — live testing of `oz agent run` during swarm orchestration

**1. `oz agent run` does NOT receive global Warp Drive rules, MCP UUIDs, or auto-injected context**

Testing revealed that `oz agent run` launched from the terminal does not automatically receive global Warp Drive rules (personal rules stored in Warp Drive > Personal > Rules), MCP servers via UUID, or Warp Drive notebooks/workflows. The only context an Option A agent gets is: `AGENTS.md` in the `--cwd` directory, the agent profile specified with `--profile`, and codebase indexing (non-blocking, background). This makes Option A effectively as context-limited as cloud agents (`oz agent run-cloud`) — the only difference is execution location (local vs remote VM).

**Option B (interactive Warp tab) is the correct choice for full local context** until a future Warp build with experimental orchestration support brings Option A to parity. Option B agents get full MCP, global rules, Warp Drive context, warm codebase indexing, and are interruptible mid-run.

**2. Inline MCP JSON is a partial workaround for Option A but not zero-config**

MCP servers can be passed via inline JSON instead of UUID: `--mcp '{"github": {"url": "https://api.githubcopilot.com/mcp/"}}'`. This works around the UUID proxy issue but requires knowing the MCP endpoint URL and managing auth separately. Not a substitute for Option B's zero-config MCP injection.

## Windows File Editing (2026-03)

**Source:** ROADMAP.md edits during feat/agents-md-onboarding-54 — three sequential failures before clean write

**1. CRLF line endings break multi-line edit_files searches — MUST verify line endings before batch edits**

The edit_files tool matches search strings against file content byte-for-byte. Files with Windows CRLF (\r\n) line endings will silently fail to match search strings that assume LF (\n) only. On any Windows repo, MUST check line endings first ((Get-Content file -Raw) -match '\r\n'). If CRLF is present, fall back to PowerShell Get-Content -Raw / [System.IO.File]::WriteAllText for multi-line edits rather than batching multiple edit_files diffs.

**2. PowerShell 5.1 Set-Content MUST NOT be used on UTF-8 files — not even with -Encoding UTF8**

Get-Content | ... | Set-Content in PowerShell 5.1 defaults to the system ANSI code page (Windows-1252), silently mangling non-ASCII characters. But using `-Encoding UTF8` is also wrong: PowerShell 5.1's UTF8 encoding writes a BOM (byte-order mark, \xEF\xBB\xBF) at byte 0, corrupting every special character across the entire file when re-read by tools that don't expect a BOM. MUST use `[System.IO.File]::WriteAllText(path, content, (New-Object System.Text.UTF8Encoding $false))` — the `$false` argument explicitly disables the BOM. Never use Set-Content for UTF-8 files on Windows PowerShell 5.1.

**3. Markdown table rows in files with CRLF endings MUST be inserted via PowerShell, not edit_files**

The edit_files tool matches byte-for-byte. ROADMAP.md uses CRLF line endings. When inserting new table rows using edit_files, the mismatch between LF in the search/replace strings and CRLF in the file causes row content to be inserted with a doubled leading pipe (`|| #NNN |` instead of `| #NNN |`), shifting all columns right and breaking table alignment. This has surfaced in multiple sessions (PR #130, PR #173). When appending rows to the Open Issues Index or any markdown table in a CRLF file, MUST use PowerShell `[System.IO.File]` methods or a targeted regex replace — never edit_files for table row insertions. After any table edit, MUST verify row prefixes before committing: `Select-String -Path ROADMAP.md -Pattern '\|\| #[0-9]'` should return no matches.

**4. PowerShell 5.1 `Set-Content` corrupts UTF-8 files in TWO ways — BOM removal alone is not a fix**

When PS5.1 `Set-Content` (or `Set-Content -Encoding UTF8`) writes a UTF-8 file, it causes two distinct corruptions: (1) a BOM is prepended at byte 0, and (2) the entire file body is re-encoded from UTF-8 to Windows-1252 (ANSI), converting every multi-byte character to mojibake (for example em-dashes `—` become `—`, arrows `→` become `→`, and other Unicode symbols are mangled similarly). These are independent corruptions — stripping the BOM does NOT restore the body. A file can have no BOM and still be corrupted throughout.

The only correct recovery from `Set-Content` corruption is: (1) restore the original file bytes via `git checkout <ref> -- path/to/file` — MUST NOT use `git show <ref>:path/to/file` piped through PowerShell, as the pipeline silently re-decodes the bytes as Windows-1252 and re-introduces the mojibake; (2) read the restored file with `[System.IO.File]::ReadAllText(path, [System.Text.Encoding]::UTF8)`; (3) apply only the intended edits as string operations; (4) write back with `[System.IO.File]::WriteAllText(path, content, (New-Object System.Text.UTF8Encoding $false))`. MUST NOT attempt to fix `Set-Content` corruption by stripping just the BOM — the body will still be corrupted throughout.

## Review Cycle Monitoring (2026-04)

**Source:** PR #173 review cycle — shell polling loop against static SHA failed to detect Greptile completion

**1. Greptile review completion MUST be polled via MCP `get_check_runs` against the PR head, not `gh api` with a static commit SHA**

When a new commit is pushed while a polling loop is running, Greptile starts a fresh check run on the new head SHA. A shell `while` loop polling `gh api repos/{owner}/{repo}/commits/{old_sha}/check-runs` will never see completion because the completed run is on a different commit. MUST use MCP `pull_request_read` with `method: get_check_runs` — this always targets the current PR head regardless of how many commits have been pushed. Compare the `completed_at` field and `conclusion` to confirm the review is current and passed.

**2. MUST NOT push any commit while Greptile review is in progress — even for unrelated changes**

Every push re-triggers Greptile on the new head. If additional fixes or improvements are identified while waiting for a review, stage them locally but hold the push until the review of the current head is complete and analyzed. "Trivial" or "safe" commits are not exceptions — the rule applies unconditionally. Violating this resets Greptile's clock and can create a loop where the bot never finishes reviewing a stable state. (#175, incident: PR #173)

**3. Poll interval MUST include a genuine delay (≥60 seconds) between `get_check_runs` calls**

Greptile reviews typically take 3–7 minutes. Calling `get_check_runs` in rapid back-to-back succession (seconds apart) adds no information and creates noise in the conversation. MUST use a real sleep between polls — `Start-Sleep -Seconds 60` (PowerShell) or equivalent. Do NOT report "polling again" as if time has passed when it has not. (#175, incident: PR #173 monitoring loop)

**4. After pushing, agent MUST autonomously poll for review updates without stopping to ask the user**

Agents dispatched with a review cycle task (especially cloud/swarm agents) stopped after pushing fix commits and asked the user "should I continue?" or "want me to check the review?" This breaks the autonomous review/fix loop and requires human intervention for every cycle iteration. The review/fix loop in `skills/deft-review-cycle/SKILL.md` is designed to run to the exit condition (no P0/P1 issues, confidence > 3) without human intervention. After pushing, the agent MUST poll for the Greptile review update, analyze findings, and continue fixing — treating the entire loop as a single autonomous operation. (#184)

## Greptile Re-Review on Rebase Force-Push (2026-04)

**Source:** Issue #207 — swarm merge cascade latency during PRs #154–#157

**1. Force-pushing a rebased branch triggers a FULL Greptile re-review, not an incremental diff**

During merge cascades, each remaining PR must be rebased onto updated master and force-pushed. Each force-push triggers Greptile to re-review the entire PR from scratch — not just the rebase diff — because Greptile treats force-push as a new commit history. Expected latency is ~2-5 minutes per PR. For a cascade of N PRs, this adds (N-1) × ~2-5 minutes of Greptile wait time on top of CI. MUST factor Greptile re-review latency into merge cascade planning.

**2. Rebase-only force-pushes MAY be annotated with a PR comment for Greptile context**

When a force-push contains no logic changes (pure rebase onto updated master), the monitor MAY post a brief PR comment noting "rebase-only, no logic changes" before force-pushing. This gives human reviewers (and potentially Greptile) context that the re-review is structural, not functional. This is advisory, not mandatory — Greptile will re-review regardless.

**3. Merge cascade time estimate MUST include Greptile re-review latency**

The original merge cascade lesson (#3 in Parallel Agent Swarm) documented ~3 min CI per rebase cycle. The full cost is ~3 min CI + ~2-5 min Greptile re-review per rebase. For N PRs, plan for (N-1) × (~3 min CI + ~2-5 min Greptile) total additional wait time.

## Mid-Task Instant-Fix Drift (2026-04)

**Source:** Issues #159, #167, #184 — agents derailed active tasks to apply instant fixes for discovered issues

**1. Discovered issues MUST be filed as GitHub issues, not fixed in-place mid-task**

Agents repeatedly interrupted their current task to fix an unrelated issue they discovered along the way (e.g. a typo in another file, a missing test, a stale reference). This caused scope drift, broke the review cycle, and introduced unplanned changes into PRs scoped to specific issues. When a new issue is discovered during an active task, the agent MUST file a GitHub issue and continue the current task — do not apply an instant fix, even if it seems trivial.

**2. Skill execution MUST stop at the skill's explicit instruction boundary**

Agents continued executing past the final step of a skill into adjacent work — for example, after completing a review cycle, an agent started fixing unrelated issues it noticed during the review. A skill's final step is an exit condition. When the skill's steps are complete, the agent MUST stop and return to the calling context. Do not drift into adjacent work, even if it seems related. (#198)

## Skills/ Scan Before Improvising (2026-04)

**Source:** Issue #200 — agents improvised multi-step workflows that already existed as skills

**1. MUST scan skills/ for existing coverage before designing a workflow from scratch**

Agents were asked to run a review cycle and improvised a multi-step process from scratch, missing the existing `skills/deft-review-cycle/SKILL.md` that encodes lessons from dozens of prior review rounds. The skills/ directory contains versioned, tested workflows that encode hard-won operational lessons. Before designing any multi-step workflow, the agent MUST scan skills/ for an existing skill that covers the task. If a matching skill exists, use it — do not reinvent it. (#200)

## PR Merge Hygiene (2026-04)

**Source:** Issue #167 — PRs merged but issues not closed and roadmap not updated

**1. Squash merge + closing keywords can silently fail to close issues — MUST verify after every squash merge**

GitHub processes closing keywords (`Closes #N`, `Fixes #N`) from the PR body when a PR is merged. For regular merge commits, this works reliably. For **squash merges**, GitHub rewrites the commit into a single squash commit and may not always process the closing keywords from the original PR body — the auto-close can silently fail with no error or notification. The PR shows as merged, but the linked issues remain open.

Root cause: GitHub's squash merge constructs a new commit message from the PR title and description. If the closing keyword appears only in the PR body (not the squash commit's final message), or if GitHub's keyword parser does not match the rewritten message format, the issue auto-close is skipped silently. This is a known GitHub behavior difference between regular merges and squash merges.

**After every squash merge, MUST verify that referenced issues actually closed:** `gh issue view <N> --json state --jq .state`. If the issue is still open, close it manually with a comment referencing the merged PR: `gh issue close <N> --comment "Closed by #<PR> (squash merge — auto-close did not trigger)"`. (#167)

## Warp Terminal Multi-Line PowerShell String Splitting (2026-04)

**Source:** Issue #240 -- multi-line PS here-strings pasted into Warp agent input caused syntax errors

**1. Warp splits multi-line PowerShell here-strings across separate command blocks -- MUST use temp files**

When a multi-line PowerShell string literal (here-string `@" ... "@`) is pasted or entered directly into the Warp agent terminal input box, Warp's input handling splits the content across separate command blocks at line boundaries. Each block is sent as a separate command, causing immediate syntax errors (the opening `@"` is sent without its closing `"@`) or silent truncation of the string content.

**Root cause:** Warp's terminal input box treats newlines as command separators. A multi-line here-string that spans N lines becomes N separate commands, none of which is syntactically valid on its own.

**Fix:** Always write multi-line PS content to a temp file first (`[System.IO.File]::WriteAllText($tmpFile, $content, [System.Text.UTF8Encoding]::new($false))`), then reference the temp file path in subsequent commands. This avoids the input splitting entirely. (#240)

**Cross-reference:** `scm/github.md` — Warp Terminal Multi-Line String Handling subsection.

## Duplicate-Tab Failure Mode (2026-04)

**Source:** Issues #261, #263 -- swarm monitor spawned replacement agents while originals were still alive

**1. Original Warp agent tabs MUST be assumed alive until confirmed unresponsive via lifecycle events**

During a swarm run, the monitor agent observed apparent stalls in sub-agent tabs (no recent commits, no messages) and spawned replacement agents on the same worktrees. The original tabs had not actually crashed -- they resumed shortly after, creating two concurrent agents executing on the same branch. Both agents issued `tool_use` calls and received interleaved `tool_result` responses, causing each agent to act on stale or incorrect state. The `tool_use`/`tool_result` corruption seen in #261 (Phase 5 gate bypass, untested code merged to master) and #263 (monitor crash at message ~158) traces directly to this duplicate-agent root cause.

**Before spawning a replacement agent, MUST verify the original is truly unresponsive by checking for an idle/blocked lifecycle event (no active tool calls, no pending shell commands, no recent output in the original tab). MUST NOT spawn a replacement based solely on message timing or absence of recent commits. If an agent appears stalled, go to its original tab and tell it to resume rather than spawning a new agent.** (#261, #263)

## Crash Recovery Pattern (2026-04)

**Source:** Issue #263 -- monitor crash at message ~158 left merge cascade in ambiguous state

**1. Phase 6 merge cascade is safe to recover when steps are idempotent and state is checked before acting**

The monitor agent crashed mid-cascade (likely due to conversation corruption from accumulated context -- ~158 messages of tool_use/tool_result pairs). On recovery, the new session could not determine which PRs had been merged, which were rebased, and which still needed action. The fix is twofold: (1) make every Phase 6 action idempotent (check state before acting -- already merged? already rebased? already closed?) so re-running any step is safe, and (2) record progress checkpoints at each milestone so a recovery session can reconstruct state via `gh pr list --state all` and `gh pr view <number>`.

**The crash risk is proportional to monitor conversation length. MUST offload rebase, review-watch, and merge sub-tasks to ephemeral sub-agents (per the tiered approach in deft-review-cycle/SKILL.md) to keep the monitor conversation shallow. Target <100 tool-call round-trips in any single monitor conversation before considering a fresh session handoff.** (#263)

## RC3 Validation on Windows (2026-04)

**Source:** v0.20.0-rc.3 validation on MScottAdams/slizard-rc3-test — issues #566, #567, #571, #572, #574

**1. Frameworks that vendor-require a task runner MUST have explicit platform-matrix CI on that runner**

Language-level tests (pytest, go test, etc.) do not catch task-runner-specific defects: template-expansion quirks, path normalization on Windows, shell interpretation differences across OSes. A framework that documents "use go-task" (or make, just, etc.) MUST include CI jobs that exercise the runner on every supported OS — at minimum Linux + macOS + Windows if the consumer audience spans those. #566 was a go-task + Windows `GetFullPathNameW` + mixed-separator-normalization interaction; the existing Linux-only CI would never have caught it. Added the `windows-task-dispatch` job in #568 as the regression guard; that pattern MUST be preserved and extended as new render / migration / lifecycle tasks ship.

**2. go-task `vars:` templates re-evaluate at use site in included subfiles — path vars MUST be defined per-subfile with eager `joinPath`**

A `vars:` entry like `DEFT_ROOT: '{{.TASKFILE_DIR}}'` declared in a root Taskfile does NOT hold the root's TASKFILE_DIR value when referenced from an included subfile — go-task re-expands the template in the subfile's scope, where TASKFILE_DIR points at the subfile's own directory. To stabilize a path var across the include hierarchy, define it in each subfile that uses it via the eager form `DEFT_ROOT: '{{joinPath .TASKFILE_DIR ".."}}'`. `joinPath` is evaluated at template-expansion time with Go's `filepath.Clean`, producing a native-separator, `..`-free absolute path.

Corollary: **pytest guard-rails on task file *content* are insufficient** for template-expansion correctness. A test that verifies `{{joinPath .TASKFILE_DIR ".."}}` appears in the file tells you nothing about what it expands to at runtime. MUST pair static content checks with a live subprocess dispatch test that invokes the task through `task --dry-run` or equivalent. This near-miss was caught in #568's pre-push local validation, not by the pytest guard-rail — which passed green on the wrong configuration.

**3. A task that accepts user recovery flags in CLI_ARGS MUST NOT declare `sources:`/`generates:` incremental-build keys**

go-task's `sources:` / `generates:` declarations cause the task runner to skip `cmds:` entirely when inputs haven't changed and outputs exist — printing `Task "X" is up to date` without dispatching anything. CLI_ARGS (`-- --force`, `-- --rebuild`, etc.) are relayed only if `cmds:` actually runs, so any user recovery flag documented in a script's error message (e.g. the `#539` "Re-run with --force" pattern) will silently no-op when the task is cached. Every task whose script emits "Re-run with --force"-style error messages MUST declare neither `sources:` nor `generates:`. See `deft/conventions/task-caching.md` (scaffolded in the #574 fix) for the canonical rule and the regression guard-rail. (#539, #573, #574)

**4. Error messages that prescribe a recovery command are a contract — they MUST be regression-tested**

When a tool emits an error of the shape "to recover, run X", following X literally MUST actually recover. A documented recovery command that doesn't work is worse than no recovery message at all — it sends the operator down a dead-end path believing they've followed the correct fix. MUST add a regression test for every prescriptive error message: reproduce the error, run the command the message suggests literally, assert the expected post-recovery state. Applies equally to operator-facing errors and agent-facing errors. (#539, #574)

**5. Heuristics that detect "machine-generated" by fishing for substrings MUST be part of a canonical marker contract shared with the writers**

When code like `migrate_vbrief.py::_is_user_customized()` decides preservation vs overwrite based on whether a file contains strings such as `"Generated by"` or `"spec_render.py"`, those strings MUST be part of a canonical banner contract that the relevant writers (`spec_render.py`, `prd_render.py`, `roadmap_render.py`, `migrate_vbrief.py` deprecation stubs, and any future render / stub emitters) actually emit. A detector-writer asymmetry — where the detector fishes for text nobody writes — is a latent correctness bug waiting to misclassify operator edits as auto-generated content or vice versa. MUST co-locate the marker specification (as a `deft/conventions/<topic>.md` doc), the writers that emit it, and the detectors that consume it, with a regression test asserting every writer's output matches what every detector expects. (#572)

## GitHub Closing-Keyword False-Positive in Negation Context (2026-04)

**Source:** PR #697 -- issue #642 (a tracking umbrella for PR #401) was auto-closed on squash merge despite the PR body intentionally avoiding closing keywords. Recurrence record extended in PR #735 (#737 deterministic encoding gap-closer); see the third bullet below.

**1. GitHub's closing-keyword parser is substring-based -- the literal token `Closes #N` MUST NOT appear in the PR body even inside a negation, quotation, or example**

The PR body for #697 contained the parenthetical `` (Intentionally not `Closes #642` -- #642 is a tracking umbrella that should remain open until PR #401's full scope is merged or split into linked follow-up issues.) ``. The text was negating the closing keyword in plain English, but GitHub's auto-close parser operates on token presence, not surrounding semantics. The squash merge processed the literal `Closes #642` substring and closed the issue. The same hazard applies to `Fixes #N`, `Resolves #N`, and the past-tense / lowercase variants (`closed`, `fixed`, `resolved`, etc. -- see GitHub's full keyword list).

**Rule:** When a PR body needs to discuss what it intentionally does NOT close (e.g. tracking umbrellas, partial scope, deferred follow-ups), MUST phrase the disclaimer without using any closing keyword token at all. Use phrasings like:

- "Intentionally NOT using a closing keyword for #N" (omits the trigger token entirely)
- "Refs #N (tracking umbrella; remains open)" (use `Refs` only)
- "#N stays open as the umbrella anchor for follow-up work" (no trigger token)

⊗ MUST NOT write `Closes #N`, `Fixes #N`, `Resolves #N`, or any GitHub closing keyword in a PR body even when negating, quoting, or showing as an example -- the parser does not respect surrounding context.

**2. Post-merge issue-state verification MUST run for every squash merge regardless of intent**

The existing post-merge verification rule (Lesson: PR Merge Hygiene #1, #167) was framed around closing-keyword failures (issues that should have closed but didn't). The opposite failure mode -- issues that should have stayed open but were auto-closed -- is just as real and is caught by the same check. After every squash merge, MUST verify the state of every issue mentioned in the PR body matches intent: closed if a closing keyword was used; open if only `Refs` was used. If an issue was closed in error, reopen it with a comment referencing the PR and explaining why it should remain open (e.g. tracking umbrella, partial scope). (#697)

**3. Recurrence (#735): the squash-commit body for that PR contained a negation-context clause referencing #734 in a way that auto-closed it on merge despite intent (the issue was the parent for the in-flight #737 work and had to be reopened manually). #737 closes this gap structurally with a deterministic pre-PR lint (`scripts/pr_check_closing_keywords.py`, surfaced via `task pr:check-closing-keywords`) that scans both the PR body AND every commit message for closing-keyword tokens followed by `#\d+` in negation / quotation / example / code-block contexts and refuses to push when findings surface. The lint is wired into `skills/deft-directive-pre-pr/SKILL.md` Phase 4 (Diff) and cross-referenced from `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 1 as the Layer 0 (prevention) surface alongside the existing Layer 3 (recovery) `task pr:check-protected-issues` (#701).**

**Cross-reference:** existing lesson "PR Merge Hygiene" #1 (#167); `scm/github.md` PR conventions; `skills/deft-directive-review-cycle/SKILL.md` Post-Merge Verification; `skills/deft-directive-pre-pr/SKILL.md` Phase 4 (Layer 0 prevention, #737); `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 1 (Layer 3 recovery, #701).

## GitHub Closing-Keyword False-Positive Layer 3 -- Persistent closingIssuesReferences Link (2026-04)

**Source:** PR #700 squash-merge auto-closed #233; PR #401 squash-merge auto-closed #642 -- both with PR bodies amended to use only `Refs` and no closing keywords in commit messages or the explicit `--subject` / `--body-file` squash payload. Root cause: GitHub's `closingIssuesReferences` link is durable -- it is recorded the moment a closing keyword first appears in a PR body (or an issue is attached via the Development sidebar) and survives every subsequent body / commit-message / squash-payload edit. On squash merge, GitHub iterates the persistent link list and closes every linked issue regardless of the current text.

**Canonical encoding (strongest-applicable layer):** the operative `!` (MUST) rules live in `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 1 -- pre-merge `gh pr view <N> --json closingIssuesReferences` inspection (manually unlink via the PR's Development sidebar before merging if a protected issue is linked) and a post-merge protected-issue reopen sweep. The Anti-Patterns block carries the corresponding `⊗` entries. Optional second-strongest encoding: `task pr:check-protected-issues` (see `tasks/pr.yml`) which wraps the pre-merge inspection deterministically.

**Why this is a short cross-reference, not a full prose rule:** per the Rule Authority [AXIOM] block in `main.md` (added by PR #401), every rule MUST use the strongest applicable layer (deterministic > Taskfile > vBRIEF > RFC2119 > prose). The lessons-consumption umbrella #575 (vBRIEF-backed lessons registry, pre-pr capture, `task lessons:render`, tagged on-demand retrieval) plus the pre-PR deterministic-CI-enforcement umbrella #633 together document why this entry intentionally does not duplicate the rule body in prose -- prose is fallback only.

**Cross-references:** Layer 1 (#167) PR Merge Hygiene; Layer 2 (#698) negation-context substring match; workflow umbrella (#642); incident PRs (#700, #401); lessons-consumption-gap context (#575); pre-PR deterministic-CI umbrella (#633); this lesson (#701). Canonical workflow comment: https://github.com/deftai/directive/issues/642#issuecomment-4330742436.

## Orchestrator Role Separation + Canonical Poller Template (2026-04)

**Source:** #727 -- recurring orchestrator failure across the 2026-04-28 v0.21.0 cut session (#721): three implementation-agent prompts (PR #722, #726, #727) bundled "watch for Greptile" instructions into agents that exit at PR-open via the `succeeded` lifecycle (the watch never starts and only happened to work in #722 by `time.sleep(180)` coincidence); plus two recurring poll-script parsing bugs surfaced post-#721 in Agent D's hand-authored poller (markdown-link `Last reviewed commit:` regex never matched; raw `\b(P0|P1)\b` substring scan false-positived on Greptile's `No P0 or P1 issues found` clean summary); plus the rm-chaining anti-pattern that hit Agent 1 four times in one session (chained `rm` + `git commit` / `git push` poisons Warp's `is_risky` classification on the whole pipeline).

**Canonical encoding (strongest-applicable layer):** the operative `!` MUST rules and `⊗` MUST NOT anti-patterns live in `skills/deft-directive-swarm/SKILL.md` Phase 6 Sub-Agent Role Separation -- post-PR sub-agents embody `skills/deft-directive-review-cycle/SKILL.md` end-to-end as a single coherent role; post-PR monitoring spawns a fresh poller sub-agent via `start_agent`; the canonical poller-prompt template at `templates/swarm-greptile-poller-prompt.md` MUST be used (placeholders `{pr_number}`, `{repo}`, `{poll_interval_seconds}`, `{poll_cap_minutes}`, `{parent_agent_id}`); destructive commands run alone (no rm-chaining); the commit-message temp file is leave-alone. Anti-patterns prohibit parent-turn polling, bundling watch instructions into impl-agent prompts, default pure-pollers, and rm-chaining. Tier 1 deterministic enforcement: `tests/content/test_skills.py` regression-tests that the template exists, all 5 placeholders are present verbatim, both parsing-fix tokens (markdown-link `Last reviewed commit:` regex, badge-based `<img alt="P1"` / negation-aware findings detection) are encoded, the swarm SKILL references the template path, and every `!` rule + `⊗` anti-pattern carries a stable substring marker.

**Why this is a short cross-reference, not a full prose rule:** per the Rule Authority [AXIOM] block in `main.md`, every rule MUST use the strongest applicable layer (deterministic > Taskfile > vBRIEF > RFC2119 > prose). This lessons entry exists for discoverability only -- the rule body lives in the swarm SKILL section above and the template artifact, with the content tests as the deterministic enforcement layer.

**Cross-references:** `skills/deft-directive-swarm/SKILL.md` Phase 6 Sub-Agent Role Separation (primary encoding); `templates/swarm-greptile-poller-prompt.md` (template artifact); `skills/deft-directive-review-cycle/SKILL.md` (the skill the poller embodies end-to-end); precedent encoding pattern Layer 3 (#701); session anchor #721; recurrence PRs #722 / #726 / #727; this lesson (#727).

## vBRIEF Lifecycle Drift on Release (2026-04)

**Source:** v0.21.0 cut session -- post-publish reconciliation surfaced 13 stranded vBRIEFs (8 cycle-relevant + 5 historical residue) whose origin GitHub issues were closed but whose vBRIEF files still lived in `proposed/` / `pending/` / `active/`. Operators consistently forgot the manual `task scope:complete` move step between merge and release, so each cut accreted lifecycle drift the next release inherited.

**Canonical encoding (strongest-applicable layer):** the operative `!` MUST rules and `⊗` MUST NOT anti-patterns live in `skills/deft-directive-release/SKILL.md` Phase 1 (pre-flight) and the deterministic gate at `scripts/release.py::check_vbrief_lifecycle_sync` wired as Step 3 (between branch guard at Step 2 and CI at Step 4) of the 12-step pipeline. The gate refuses the release with `EXIT_VIOLATION` (1) on any Section (c) mismatch (closed-issue vBRIEF in a non-`completed/` folder) unless the operator explicitly passes `--allow-vbrief-drift` (analogous to `--allow-dirty`). The clean recovery path is `task reconcile:issues -- --apply-lifecycle-fixes` (#734) which reads each Section (c) entry, sets `plan.status = "completed"`, stamps `vBRIEFInfo.updated`, and `git mv`'s the file into `completed/` -- idempotent on re-run, and tolerant of both legacy bare `github-issue` and canonical `x-vbrief/github-issue` reference shapes.

**Why this is a short cross-reference, not a full prose rule:** per the Rule Authority [AXIOM] block in `main.md`, every rule MUST use the strongest applicable layer (deterministic > Taskfile > vBRIEF > RFC2119 > prose). The rule body lives in the deterministic gate (`scripts/release.py::check_vbrief_lifecycle_sync` + the apply-mode helpers in `scripts/reconcile_issues.py`); this lessons entry exists for discoverability + recurrence-record citation only.

**Cross-references:** `skills/deft-directive-release/SKILL.md` Phase 1 (primary encoding); `scripts/release.py::check_vbrief_lifecycle_sync` (deterministic gate); `scripts/reconcile_issues.py::apply_lifecycle_fixes` (clean-recovery surface); `scripts/release.py::ReleaseConfig.allow_vbrief_drift` (escape hatch); v0.21.0 cut session anchor; this lesson (#734).

## Inverted-lookup scaling pattern (#754)

**Source:** v0.22.0 cut session 2026-04-30 -- the vBRIEF-lifecycle-sync release gate (#734) false-positively flagged 32 "closed" mismatches on `deftai/directive` once master crossed 200 open issues. Every flagged issue was OPEN on inspection.

**Failure mode:** the gate fetched all open issues and filtered for the vBRIEF-referenced subset. `fetch_open_issues` capped at 200 (`--limit 200`); tail issues silently dropped were treated as CLOSED, producing apparent mismatches that did not exist. Cost scaled by O(repo-open-issue-count).

**Fix:** invert the lookup direction. Extract the issue numbers referenced by vBRIEFs, then query just those issues' states via batched `gh api graphql` with aliased nodes (`i100: issue(number: 100) { state }`). Cost now scales by O(vBRIEF-referenced-issue-count); truncation impossible by construction. The Tier 2 truncation-guard surface from the original two-tier proposal is retired -- it was guarding against a problem the new approach cannot have.

**Generalizable heuristic:** whenever a gate cross-references a small subset against a large enumerable set, query the subset's state directly rather than fetching the full set and filtering. The query cost should scale by the property the gate cares about, not by an enumeration property the gate does not.

**Reference:** `scripts/reconcile_issues.py::fetch_issue_states` (helper); `scripts/release.py::check_vbrief_lifecycle_sync` (consumer); #754 (issue + this fix).

## Greptile Review Stall Detection (2026-04)

**Source:** rc4 swarm cascade on PR #561 -- a Greptile check run sat in IN_PROGRESS for 21 minutes (~3x the upper bound of normal) on a single `commit.oid` while the polling loop continued silently with no escalation surface.

**1. Stalls past 3x the expected window MUST escalate to the user, not auto-retrigger**

Greptile reviews typically complete in 2-5 minutes (7 minutes is the upper bound of normal). When the check run remains IN_PROGRESS past 3x expected (~10 minutes) on the SAME `commit.oid`, the agent MUST stop polling silently and surface the situation to the user. The 21-minute observation on PR #561 was the recurrence record: the polling loop kept running, the user had no visibility, and the cycle effectively wasted the operator's attention budget. The Stall Detection Rubric in `skills/deft-directive-review-cycle/SKILL.md` Step 4 codifies the threshold and the deterministic escalation menu (Wait / Re-trigger / Skip / Cancel / Discuss / Back).

**2. Auto-retrigger without explicit user approval is forbidden**

The naive recovery -- pushing an empty commit, force-pushing, or auto-posting `@greptileai` -- is exactly the wrong move because it resets Greptile's review clock on a NEW SHA and erases the stall evidence. The agent MUST NOT auto-retrigger. The rubric's option-2 (manual `@greptileai` comment) is the only supported re-trigger path AND it requires the user to pick it from the escalation menu. Any user-approved override MUST be documented in a brief PR comment for auditability, so future agents resuming the cycle see why the clock reset.

**3. `startedAt` resets MUST notify the user, not silently re-anchor the clock**

Greptile occasionally drops its prior check run and starts a fresh one without any push from the agent (service-side restart, runner re-roll). The polling loop MUST detect a NEW `startedAt` on the same commit, reset its elapsed-time clock to the new `startedAt`, AND notify the user that an auto-restart was detected. Resetting the clock without notification is forbidden -- the user needs to know the cycle effectively re-started, otherwise a second 10-minute stall can hide behind a silent restart.

**Cross-reference:** `skills/deft-directive-review-cycle/SKILL.md` -- `Stall Detection Rubric (#564)`.

## Greptile CheckRun SUCCESS != Review Approval (2026-05)

**Source:** PR #652 incident 2026-05-01 -- the directive agent attempted to start a merge cascade against `Confidence: 3/5 + 1×P1 + 2×P2` because the GitHub `Greptile Review` CheckRun was SUCCESS. Symmetric blind spot to the NEUTRAL-CheckRun case codified in #526: both are wrong-oracle failures where the agent trusts a CheckRun status as proxy for review approval.

**Generalizable pattern:** ANY reviewer-posted CheckRun is a **completion** signal, not an **approval** signal. The CheckRun goes green when the bot finishes its review pass, irrespective of findings or confidence. For Greptile specifically: SUCCESS can hide unresolved P0/P1 + low confidence in the comment body; NEUTRAL can hide a service-side error in the comment body (#526). Both require parsing the body, not the status.

**Canonical encoding (strongest-applicable layer):** the operative `!` MUST rules and `⊗` MUST NOT anti-patterns live in `skills/deft-directive-swarm/SKILL.md` Phase 5->6 -- programmatic gate (`task pr:merge-ready -- <N>`), atomic-shell-call freshness window (`task pr:merge-ready -- <N> && gh pr merge <N>` chained in the same shell call), SUCCESS-CheckRun-alone prohibition, upstream-batched-readiness-check prohibition. Tier 1 deterministic enforcement: `scripts/pr_merge_readiness.py` parses the Greptile rolling-summary comment body (badge-count P0/P1 detection, structured-section heading fallback, errored-sentinel detection, HEAD-SHA freshness, confidence parse) and exits non-zero on any gate failure; `tests/cli/test_pr_merge_readiness.py` regression-tests the PR #652 incident signature so the same wording cannot pass through the gate again.

**Why this is a short cross-reference, not a full prose rule:** per the Rule Authority [AXIOM] block in `main.md`, every rule MUST use the strongest applicable layer (deterministic > Taskfile > vBRIEF > RFC2119 > prose). The rule body lives in the deterministic gate (`scripts/pr_merge_readiness.py`) wrapped by the `task pr:merge-ready` Taskfile target and surfaced in the swarm SKILL section above; this lessons entry exists for discoverability + recurrence-record citation only.

**Cross-references:** `skills/deft-directive-swarm/SKILL.md` Phase 5->6 (primary encoding); `scripts/pr_merge_readiness.py` (deterministic gate); `tasks/pr.yml::merge-ready` (Taskfile surface); `tests/cli/test_pr_merge_readiness.py` (regression coverage); existing #526 NEUTRAL-CheckRun lesson (symmetric blind spot); #796 (sibling late-arriving-bot-review re-check gap, separate fix); PR #652 incident (recurrence record).

## Implementation-intent inference is a documented anti-pattern (#810).

**Source:** #810 surfacing event -- during the in-flight #801 session the user said "do full pr process to get it into master use poller agents not local loops". Intent was scoping / scheduling guidance about where the work would happen and which lifecycle skill would run it. The orchestrator parsed `full PR process` + `poller agents` + `not local loops` as authorization to invoke `start_agent` for implementation. None of the documented skill-routing keywords (`build`, `implement`, `swarm`, `run agents`) appeared in the user's message; the agent inferred them from workflow-shape vocabulary.

**Failure mode:** lifecycle, branching, and PR-process language are NOT implementation directives. Trigger phrases observed in the wild include "do the full PR process", "poller agents", "start the work", "not local loops", "once the branch is up". Affirmative continuation phrases (`yes`, `go`, `proceed`, `do it`) similarly do NOT authorize implementation unless the prior turn explicitly proposed it. The honor-system anti-pattern was that AGENTS.md skill-routing is a positive grammar -- it lists trigger keywords for skills but does NOT codify that the **absence** of those keywords forbids implementation -- so an agent inferring from workflow-shape vocabulary slipped through every documented gate.

**Canonical encoding (strongest-applicable layer):** the operative `!` MUST rules and `⊗` MUST NOT anti-patterns live in `skills/deft-directive-build/SKILL.md` Step 0 (Implementation Preflight) and `skills/deft-directive-swarm/SKILL.md` Phase 0 Step 1, with the structural fail-closed gate at `scripts/preflight_implementation.py` (asserts `vbrief/active/` AND `plan.status == "running"`, exits 1 otherwise with the actionable `task vbrief:activate <path>` redirect). The companion `scripts/vbrief_activate.py` (surfaced via `task vbrief:activate`) is the ONLY supported way to satisfy the gate -- idempotent, atomic, status-flipping. The prompt-side guardrail block lands inside the `<!-- deft:managed-section v1 -->` markers in `templates/agents-entry.md` so `cmd_agents_refresh` propagates it to consumer projects, and is mirrored verbatim in repo-level `AGENTS.md`. Tier 1 deterministic enforcement: `tests/cli/test_preflight_implementation.py` covers the (folder, status) matrix + edge cases including the recursively-appropriate self-test against the #810 vBRIEF in `vbrief/pending/`; `tests/content/test_skills_preflight_call.py` regex-asserts both build and swarm skills cite the helper as a `!` rule; `tests/content/test_agents_entry_contract.py` asserts the managed-section carries the `Implementation Intent Gate` anchor + 4 bullets with the `!` / `⊗` token mix.

**Generalizable takeaway:** workflow-shape vocabulary is not authorization. When the user's intent is ambiguous, ask one targeted question instead of inferring. The fix converts an honor-system rule into a preflight that fails closed -- a structural gate is strictly stronger than a prose anti-pattern because it cannot be silently skipped by a future agent that hasn't internalized the rule.

**Why this is a short cross-reference, not a full prose rule:** per the Rule Authority [AXIOM] block in `main.md`, every rule MUST use the strongest applicable layer (deterministic > Taskfile > vBRIEF > RFC2119 > prose). The rule body lives in the deterministic gate (`scripts/preflight_implementation.py`) and the build / swarm / templates / AGENTS.md cross-references; this lessons entry exists for discoverability + recurrence-record citation only.

**Cross-references:** `scripts/preflight_implementation.py` (deterministic gate); `scripts/vbrief_activate.py` (recovery surface); `tasks/vbrief.yml::activate` (Taskfile surface); `skills/deft-directive-build/SKILL.md` Step 0 (build skill encoding); `skills/deft-directive-swarm/SKILL.md` Phase 0 Step 1 (swarm skill encoding); `templates/agents-entry.md` Implementation Intent Gate (prompt-side guardrail); `AGENTS.md` Development Process (repo-level mirror); #801 (surfacing-event session); this lesson (#810).
