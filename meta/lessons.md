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

GitHub assigns PR numbers in creation order, which depends on which cloud agent finishes first. Agent 2's PR became #154 while Agent 1's became #156. This caused confusion during monitoring and merging. Branch names SHOULD include the agent number (e.g. `agent1/fix/...`) or PR titles SHOULD include `[Agent N]` for traceability.

**7. ~~Cloud agents~~ Agents stopped after PR creation — likely a prompt completeness issue, not a cloud limitation**

⚠️ **Context correction:** The agents in this lesson were launched via `oz agent run` which (see corrected Lesson #1) is **local**, not cloud. The two-pass behavior was likely due to incomplete prompt instructions, not an inherent limitation of the execution environment.

The core lesson remains valid: when agents stop before completing the full workflow (PR + review cycle), the monitor MUST be prepared to complete the remaining steps. Ensure the prompt's STEP 6 (review cycle) instruction is explicit enough to prevent early termination — regardless of whether agents are local or cloud. (#172)

## Windows File Editing (2026-03)

**Source:** ROADMAP.md edits during feat/agents-md-onboarding-54 — three sequential failures before clean write

**1. CRLF line endings break multi-line edit_files searches — MUST verify line endings before batch edits**

The edit_files tool matches search strings against file content byte-for-byte. Files with Windows CRLF (\r\n) line endings will silently fail to match search strings that assume LF (\n) only. On any Windows repo, MUST check line endings first ((Get-Content file -Raw) -match '\r\n'). If CRLF is present, fall back to PowerShell Get-Content -Raw / [System.IO.File]::WriteAllText for multi-line edits rather than batching multiple edit_files diffs.

**2. PowerShell 5.1 Set-Content MUST NOT be used on UTF-8 files — not even with -Encoding UTF8**

Get-Content | ... | Set-Content in PowerShell 5.1 defaults to the system ANSI code page (Windows-1252), silently mangling non-ASCII characters. But using `-Encoding UTF8` is also wrong: PowerShell 5.1's UTF8 encoding writes a BOM (byte-order mark, \xEF\xBB\xBF) at byte 0, corrupting every special character across the entire file when re-read by tools that don't expect a BOM. MUST use `[System.IO.File]::WriteAllText(path, content, (New-Object System.Text.UTF8Encoding $false))` — the `$false` argument explicitly disables the BOM. Never use Set-Content for UTF-8 files on Windows PowerShell 5.1.

**3. Markdown table rows in files with CRLF endings MUST be inserted via PowerShell, not edit_files**

The edit_files tool matches byte-for-byte. ROADMAP.md uses CRLF line endings. When inserting new table rows using edit_files, the mismatch between LF in the search/replace strings and CRLF in the file causes row content to be inserted with a doubled leading pipe (`|| #NNN |` instead of `| #NNN |`), shifting all columns right and breaking table alignment. This has surfaced in multiple sessions (PR #130, PR #173). When appending rows to the Open Issues Index or any markdown table in a CRLF file, MUST use PowerShell `[System.IO.File]` methods or a targeted regex replace — never edit_files for table row insertions. After any table edit, MUST verify row prefixes before committing: `Select-String -Path ROADMAP.md -Pattern '\|\| #[0-9]'` should return no matches.

**4. PowerShell 5.1 `Set-Content` corrupts UTF-8 files in TWO ways — BOM removal alone is not a fix**

When PS5.1 `Set-Content` (or `Set-Content -Encoding UTF8`) writes a UTF-8 file, it causes two distinct corruptions: (1) a BOM is prepended at byte 0, and (2) the entire file body is re-encoded from UTF-8 to Windows-1252 (ANSI), converting every multi-byte character to mojibake (for example em-dashes `—` become `â€”`, arrows `→` become `â†’`, and other Unicode symbols are mangled similarly). These are independent corruptions — stripping the BOM does NOT restore the body. A file can have no BOM and still be corrupted throughout.

The only correct recovery from `Set-Content` corruption is: (1) restore the original file bytes via `git checkout <ref> -- path/to/file` — MUST NOT use `git show <ref>:path/to/file` piped through PowerShell, as the pipeline silently re-decodes the bytes as Windows-1252 and re-introduces the mojibake; (2) read the restored file with `[System.IO.File]::ReadAllText(path, [System.Text.Encoding]::UTF8)`; (3) apply only the intended edits as string operations; (4) write back with `[System.IO.File]::WriteAllText(path, content, (New-Object System.Text.UTF8Encoding $false))`. MUST NOT attempt to fix `Set-Content` corruption by stripping just the BOM — the body will still be corrupted throughout.

## Review Cycle Monitoring (2026-04)

**Source:** PR #173 review cycle — shell polling loop against static SHA failed to detect Greptile completion

**1. Greptile review completion MUST be polled via MCP `get_check_runs` against the PR head, not `gh api` with a static commit SHA**

When a new commit is pushed while a polling loop is running, Greptile starts a fresh check run on the new head SHA. A shell `while` loop polling `gh api repos/{owner}/{repo}/commits/{old_sha}/check-runs` will never see completion because the completed run is on a different commit. MUST use MCP `pull_request_read` with `method: get_check_runs` — this always targets the current PR head regardless of how many commits have been pushed. Compare the `completed_at` field and `conclusion` to confirm the review is current and passed.
