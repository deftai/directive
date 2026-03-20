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

## Windows File Editing (2026-03)

**Source:** ROADMAP.md edits during feat/agents-md-onboarding-54 — three sequential failures before clean write

**1. CRLF line endings break multi-line edit_files searches — MUST verify line endings before batch edits**

The edit_files tool matches search strings against file content byte-for-byte. Files with Windows CRLF (\r\n) line endings will silently fail to match search strings that assume LF (\n) only. On any Windows repo, MUST check line endings first ((Get-Content file -Raw) -match '\r\n'). If CRLF is present, fall back to PowerShell Get-Content -Raw / [System.IO.File]::WriteAllText for multi-line edits rather than batching multiple edit_files diffs.

**2. PowerShell 5.1 Set-Content MUST NOT be used on UTF-8 files without explicit encoding**

Get-Content | ... | Set-Content in PowerShell 5.1 defaults to the system ANSI code page (Windows-1252), not UTF-8. This silently mangles any non-ASCII characters (em-dashes, curly quotes, etc.) to mojibake (— → â€"). MUST use [System.IO.File]::WriteAllText(path, content, [System.Text.Encoding]::UTF8) when writing back UTF-8 files. Never pipe through Set-Content without -Encoding UTF8.
