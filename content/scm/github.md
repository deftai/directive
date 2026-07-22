# GitHub Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [main.md](../../main.md) | [git.md](./git.md) | [changelog.md](./changelog.md)

**Stack**: gh CLI 2.0+, GitHub Actions, Conventional Commits, issue/PR workflows

## Standing gh CLI Rules

Rules that apply to every `gh` invocation, regardless of context.

- ! Use `--body-file` for PR and issue bodies longer than one line -- inline `--body` strings break on special characters, newlines, and shell escaping across platforms
- ! For Markdown-rich issue bodies, PR bodies, and issue/PR comments, prefer the canonical safe wrapper: `task scm:body:* -- --repo OWNER/NAME ... --body-file <path>`. It reads UTF-8 body text from a file or stdin, sends JSON to `gh api` without shell interpolation, and immediately performs live `gh` read-back.
- ! Never place Markdown containing backticks inside a double-quoted shell command. In Bash and zsh, a body fragment like ``"include `ghx`"`` runs command substitution before `gh` receives the text, corrupting the posted body.
- ! Write `--body-file` temp files to the OS temp directory, not the worktree -- writing temp files inside the worktree triggers `rm` denylist collisions that block autonomous swarm agents in Warp (the agent cannot delete files via `rm` in autonomous mode)
  - **PowerShell:**
    ```powershell
    $bodyFile = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($bodyFile, $content, [System.Text.UTF8Encoding]::new($false))
    gh pr create --title "feat: example" --body-file $bodyFile
    ```
  - **Unix (bash/zsh):**
    ```bash
    bodyFile=$(mktemp)
    echo "$content" > "$bodyFile"
    gh pr create --title "feat: example" --body-file "$bodyFile"
    ```
  - No explicit `rm` is needed after `gh pr create` -- the file lives outside the worktree, which is the key advantage: it eliminates the `rm` step that collides with the Warp autonomous agent `rm` denylist. (OS temp directories are eventually cleaned by the OS on Unix/macOS; on Windows they persist until manually purged, but agent cleanup is not required.)
- ! Immediately verify after every create or edit operation:
  - After `gh pr create`: run `gh pr view <number>` to confirm title, body, and labels rendered correctly
  - After `gh issue create`: run `gh issue view <number>` to confirm body content
  - After `gh pr edit`: re-fetch and verify the edited field
- ! Use live `gh` for immediate read-back after a mutation. Do not use `ghx` for the first verification GET because it may serve a cached stale response.
- ~ Prefer `gh api` for structured/programmatic queries (filtering, bulk reads, JSON output) and `gh pr`/`gh issue` for quick ad-hoc commands
- ⊗ Construct multi-line `--body` strings inline in shell commands -- always write to a temp file and use `--body-file`
- ⊗ Construct Markdown-rich `gh api -f body="..."` or `gh issue comment --body "..."` commands when the body contains backticks, dollar signs, quotes, or fenced code blocks -- use a body file and the `scm:body:*` wrapper instead
- ⊗ Write `--body-file` temp files inside the worktree or repository directory -- always use the OS temp directory (`$env:TEMP` on PowerShell, `$TMPDIR` or `/tmp` on Unix)

## Safe Markdown Body Posting (#1555)

Use `scripts/github_body.py` through the task surface whenever an agent needs to post or edit Markdown-rich GitHub text. The helper accepts `--body-file <path>` or `--body-file -`, wraps the body as JSON inside Python, calls `gh api --input -` through the UTF-8-safe subprocess helper, and prints the live read-back object returned by `gh`.

Safe issue creation:

```bash
task scm:body:issue:create -- \
  --repo deftai/directive \
  --title "tooling: safe body example" \
  --body-file "$bodyFile"
```

Safe issue or PR comment creation:

```bash
task scm:body:comment:create -- \
  --repo deftai/directive \
  --issue 1555 \
  --body-file "$bodyFile"
```

Safe issue comment edit with live read-back:

```bash
task scm:body:comment:edit -- \
  --repo deftai/directive \
  --comment 123456789 \
  --body-file "$bodyFile"
```

The helper's stdout is the live post-mutation GitHub object, so inspect the `body` field from that output first. If you need a second manual verification, use live REST through `gh api repos/OWNER/REPO/issues/comments/<id>` or `gh api repos/OWNER/REPO/issues/<number>`; do not use `ghx` for immediate read-back after the mutation because it may return a cached GET.

### Win32 issue-body read-modify-write footgun (#2744 / #2607)

#2646 covers safe **write** delivery (`--body-file`). A distinct failure mode persists on **read-modify-write** (amending an existing issue body): capturing `gh api repos/OWNER/REPO/issues/<N> --jq .body` into a PowerShell variable, concatenating amended text, writing a temp file, and PATCHing.

When `--jq` emits JSON with embedded newlines, PowerShell 5.x/7+ often stores the result as a **string array** (`string[]`). String interpolation or `$body + $append` coerces via `$OFS` (Output Field Separator, default single space), collapsing paragraph breaks into one line. The PATCH then persists a flattened body; agents may treat a zero exit code as success unless postcondition verify catches the damage (#2607).

**Canonical RMW recipe (all platforms; mandatory on win32):**

1. Fetch the live body to a UTF-8 file — no shell capture:

```bash
task scm:body:issue:fetch -- \
  --repo OWNER/REPO \
  --issue <N> \
  --out-file "$bodyFile"
```

2. Edit `$bodyFile` with the editor/Write tool or Python `pathlib` — not PowerShell string concat on captured `gh` output.

3. PATCH via verified edit:

```bash
task scm:body:issue:edit -- \
  --repo OWNER/REPO \
  --issue <N> \
  --body-file "$bodyFile"
```

`scm:body:issue:edit` re-fetches after PATCH and fails closed when the live body is flattened, mojibaked, or otherwise mismatched vs the intended payload (#2607).

- ! For issue-body RMW on win32, MUST use `task scm:body:issue:fetch --out-file` then file edit then `task scm:body:issue:edit --body-file` — never rebuild the body from PowerShell-captured `gh api --jq .body` output
- ⊗ Capture-concat of `gh api repos/.../issues/<N> --jq .body` (or `$body = (gh api ... | ConvertFrom-Json).body`) into PowerShell variables for amendment — the string[]/$OFS join destroys multi-line Markdown bodies silently
- ⊗ Treat a successful `gh api -X PATCH` exit code as proof the body survived intact without read-back — use `scm:body:issue:edit` postcondition verify instead

**Incident record:** #2087 (automation-declaration body corruption), #2741 (win32 RMW flattening during issue amend), #1492 (issue-body integrity class). Parent helper: #2607 / PR #2750.

## PR Workflow Conventions

### Merge Strategy

- ! Use squash-merge as the default merge method: `gh pr merge --squash --delete-branch`
- ~ Squash-merge keeps the mainline history linear and readable -- one commit per PR
- ? Use merge commits only when preserving individual commit history is explicitly required (e.g., vendor imports)
- ⊗ Use rebase-merge on PRs with multiple commits unless the author explicitly requests it

### Branch Lifecycle

- ! Create feature branches from `master` (or the project's default branch)
- ! Each branch serves a single purpose -- one issue or one cohesive change
- ! Include closing keywords in the PR body (`Closes #N`, `Fixes #N`) so GitHub auto-closes issues on merge
- ! Delete the branch after merge (`--delete-branch` flag on `gh pr merge`)
- ⊗ Reuse a branch for a second PR after the first has merged
- ~ Name branches descriptively: `docs/add-github-guide`, `fix/bootstrap-loop`, `feat/swarm-phase0`

### PR Standards

- ! Use Conventional Commits format for PR titles
- ~ Keep PRs small (< 400 lines changed ideal)
- ! Ensure all CI checks pass before requesting review
- ~ Link to related issues using closing keywords
- ~ Explain "why" not just "what" in the PR description
- ! Run `task check` before opening a PR

### Review Guidelines

**Approval criteria (MUST be met)**:

- Code follows language standards (python.md, go.md, cpp.md)
- Tests pass with required coverage threshold
- Conventional Commits format
- No security vulnerabilities
- Documentation updated
- No breaking changes (or properly documented)

**Review tone (SHOULD follow)**:

- Be constructive and specific
- Explain "why" not just "what"
- Suggest alternatives when requesting changes
- Focus on correctness, maintainability, performance (in that order)

## Post-Merge Issue Verification

! After a PR is squash-merged, verify that all referenced issues were actually closed. Squash merges can silently fail to process closing keywords (`Closes #N`, `Fixes #N`) from the PR body (#167).

1. ! For each issue referenced with a closing keyword in the PR body, run:
   ```
   gh issue view <N> --json state --jq .state
   ```
2. ! If the issue state is not `CLOSED`, close it manually with a comment referencing the merged PR:
   ```
   gh issue close <N> --comment "Closed by #<PR> (squash merge -- auto-close did not trigger)"
   ```
3. ~ This applies to ALL PR merges, not just swarm runs. See also: `skills/deft-review-cycle/SKILL.md` Post-Merge Verification, `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 2.

## Windows / PowerShell Encoding Guidance

PowerShell 5.x (Windows default) uses UTF-16LE internally and may inject a BOM or transcode `gh` CLI output unexpectedly. These issues are silent -- files look correct in the editor but fail on `edit_files` or `git diff`.

- ! Use UTF-8 without BOM for all `--body-file` content written from scripts or agents
- ! On PowerShell 5.x, set encoding before writing temp files:
  ```powershell
  [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
  ```
- ~ Avoid piping `gh` output through PowerShell 5.x redirection (`>`, `Out-File`) -- these default to UTF-16LE; use .NET `WriteAllText` with the BOM-free constructor instead (see rule below)
- ~ Prefer PowerShell 7+ (`pwsh`) which defaults to UTF-8 without BOM
- ! Use `Get-Content -Raw` to read a file as a single string -- reading without `-Raw` processes line-by-line and can inject BOM characters or silently mangle Unicode characters (em-dashes, curly quotes) when the file is re-written
- ! For BOM-safe file writes after agent reads, use `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))` -- never use `Set-Content` (even with `-Encoding UTF8`) or `Out-File` in PS 5.1, as both inject a BOM regardless of the `-Encoding` flag (`Out-File -Encoding utf8NoBOM` requires PS 7+ and is unavailable in PS 5.1)

**Rationale**: PS 5.1 defaults to UTF-16LE for `Set-Content` and UTF-8-with-BOM for some paths, causing silent mojibake on round-trip. The combination of `Get-Content -Raw` for reads and `[System.IO.File]::WriteAllText` for writes is the only reliable BOM-safe round-trip pattern.

### Warp Terminal Multi-Line String Handling

- ! Never paste multi-line PowerShell string literals (here-strings `@" ... "@`) directly into the Warp agent input box -- Warp splits multi-line input across separate command blocks, causing syntax errors or silent truncation. Always write multi-line PS content to a temp file first (e.g. `[System.IO.File]::WriteAllText($tmpFile, $content, [System.Text.UTF8Encoding]::new($false))`), then use the temp file path in subsequent commands

### Windows PowerShell: safe multi-line git/gh bodies (#2646 / #1417)

On Windows PowerShell (5.1 and often `pwsh` when commands are not routed through bash), multi-line git and gh payloads MUST NOT be authored inline in agent shell commands. Bash-style heredocs, POSIX here-document redirection (including `<<<`), inline multi-line `--body` flags, and multi-line PS here-strings pasted into the agent command box all fail or corrupt the payload before git/gh receives it. Related but distinct failure modes: #240 (Warp splits PS here-strings across command blocks) and #798 (PS 5.1 encoding corruption on read/write round-trips -- use the safe write path when creating temp files).

**Canonical pattern (Windows PowerShell agents):**

1. Write the multi-line payload to a UTF-8 (no BOM) temp file in the OS temp directory (`$env:TEMP` / `[System.IO.Path]::GetTempFileName()`), not the worktree.
2. Prefer creating that file **outside the shell** (editor/Write tool, Node script on disk) so host/agent shell wrappers cannot rewrite strings that look like git commit or gh body invocations.
3. Pass the file to git/gh: `git commit -F <file>`, `gh pr create --body-file <file>`, `gh issue create --body-file <file>`, `gh issue comment --body-file <file>`, or `gh api ... --input <file>` (JSON bodies for PATCH/POST).

**PowerShell example (commit message + PR body):**

```powershell
$bodyFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($bodyFile, $prBody, [System.Text.UTF8Encoding]::new($false))
git commit -F $bodyFile
gh pr create --title "feat: example" --body-file $bodyFile
```

**Recovery pattern for issue/PR PATCH (when wrappers corrupt inline payloads):** write a Node (or other) script to disk with the editor/Write tool, have it emit JSON to a temp file, then `gh api -X PATCH ... --input <file>` via `execFileSync` / equivalent. Verify the posted body afterward for injected Co-authored-by or Made-with markers.

**Dogfood failure modes (Cursor on win32, 2026-07-19, #2646):**

1. Bash `<<<` in a PowerShell script -- parse abort (`Missing file specification after redirection operator`); the whole script never runs.
2. Host wrapper rewrote `git commit ...` prose inside an issue-body PATCH -- injected angle brackets made PowerShell treat `<...>` as operators (`The '<' operator is reserved for future use`).
3. Host wrapper rewrote inline `--body "..."` prose -- corrupted failure-mode examples mid-PATCH.
4. File-staged `gh api --input <file>` (payload written outside the shell) succeeded.

- ! Under Windows PowerShell, MUST use temp-file delivery for all multi-line git commit messages (`git commit -F`) and gh bodies (`--body-file` / `gh api --input`) -- never bash heredocs, `<<<`, or inline multi-line `--body` flags
- ! For `gh issue create`, `gh issue comment`, and `gh pr create`, long bodies MUST use `--body-file` (temp file), not an inline `--body` flag (#1417)
- ! Create temp payload files via a safe UTF-8 write path (#798) -- prefer editor/Write/Node on disk over PS here-strings in the agent command box (#240)
- ⊗ Use bash-style heredocs or `<<<` redirection under Windows PowerShell -- not valid; payloads never reach git/gh intact
- ⊗ Embed multi-line markdown inside a PowerShell agent shell string for git/gh -- quoting splits arguments, angle brackets parse as operators, and host wrappers may rewrite the text
- ⊗ Build multi-line gh/git PATCH JSON inside an instrumented agent shell one-liner -- stage the file first, then `gh api --input`

Refs #240, #798, #1417, #2646.

## PowerShell platform-conditional rules for agents (#798 / #1353)

These runtime-specific rules are lazy-loaded here rather than shipped in the always-loaded AGENTS.md, so they don't crowd context for sessions that can't trigger them (#2157 / #1882). Load this section **before** the risky operation when your session matches one of the triggers below.

### PS 5.1 non-ASCII file edits (#798) -- gate-enforced by `verify:encoding`

The corruption happens on the **read** side: `Get-Content -Raw` decodes via the active Windows codepage (cp1252 / cp437) BEFORE any safe write can preserve the bytes, so a correct UTF-8 write of already-corrupted text just persists the mojibake. PowerShell 7+ (`pwsh`), bash, and zsh handle UTF-8 correctly and are exempt.

- ! On PS 5.1, use Python `pathlib` (`Path.read_text(encoding="utf-8")` / `write_text(text, encoding="utf-8")`) for ALL file edits touching non-ASCII glyphs (em dashes, arrows, ⊗, ✓, …, smart quotes) -- never `Get-Content -Raw` / `Set-Content` / inline `-replace` / backtick-n interpolation.
- ! When writing files from PS 7+ where unavoidable, use `New-Object System.Text.UTF8Encoding $false` -- never `[System.Text.Encoding]::UTF8` (writes a BOM).
- ⊗ Round-trip a file containing non-ASCII content through PS 5.1 commands (`Get-Content` → `-replace` → `Set-Content`, string-concat → `WriteAllText`, here-strings interpolating non-ASCII) -- the read-side decode corrupts the bytes regardless of the write encoding.

The deterministic `verify:encoding` gate (wired into `task check` and the pre-commit hook) enforces this at commit time by scanning for U+FFFD, the CP1252 / CP437-as-UTF-8 mojibake bigram set, and unexpected BOMs. Because the gate travels with the repo and fires only on the corrupting op, it is the authoritative form of the rule (#798).

### Grok Build Windows + pwsh 7+ shell capture (#1353) -- runtime-detect

When running under the Grok Build runtime on Windows + pwsh 7+, `run_terminal_command` leaks internal wrapper text (Get-Content and redirection fragments) whenever the command string contains `|`, `2>&1`, `| cat`, `>`, or similar metacharacters. Non-piped commands execute cleanly.

- ! Never emit commands containing pipes or redirections through the agent shell tool on this runtime. For anything needing a pipe, use one of: Python one-liners with `pathlib` / `subprocess.run(capture_output=True)` (preferred -- bypasses the wrapper at the OS level), run the operation in the user's native terminal and paste the result back, or isolate the work in a dedicated worktree and mark the step "user shell required".
- ! Applies to the Grok Build runtime (pwsh 7+) only; Warp + Claude (PTY-based) is not affected by this wrapper leakage.

Refs #798, #1353 (root-cause audit), #2157.

## Safe subprocess capture (#1366)

Rationale + recurrence record: `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § Safe subprocess capture (#1366).

- ! The `scripts/` Python directory was removed in #2022 (TS-native migration). All subprocess capture rules from this section now apply to TS tooling only -- the `scripts/_safe_subprocess.py` helper no longer exists; TS equivalents use the Node.js `child_process` / `execa` patterns and are not subject to Python locale-codepage decode issues.
- ! TS scripts that shell out for parsable output (gh, git, task) MUST use `execa` or `child_process.spawn` with `encoding: "utf8"` -- never `execSync` with default encoding when the output may carry non-ASCII glyphs (Greptile bodies, gh REST bodies, user-authored commit messages).
- ⊗ Use `execSync` / `spawnSync` without explicit `encoding: "utf8"` when capturing `gh api` output that may contain non-ASCII glyphs -- the default `Buffer` return is the TS analogue of the Python locale-codepage bug.
- ⊗ Reference `scripts/_safe_subprocess.py`, `scripts/pr_merge_readiness.py`, or any deleted Python script as a live implementation path -- the entire `scripts/` directory was removed in #2022.

## Cascade automation surface (#1369)

Rationale + recurrence record + cross-references: `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § Cascade automation surface (#1369). Canonical surface: `task pr:wait-mergeable-and-merge`.

- ! Cascade automation on the Grok Build hybrid path MUST go through `task pr:wait-mergeable-and-merge -- <N> --repo <owner>/<repo>`. Do NOT hand-roll a `while ...; do task pr:merge-ready ...; done` shell loop or a per-cascade ad-hoc Python monitor. The helper composes the resilient wait-until-ready loop (#1368) with the Layer-3 protected-issue check (#701) and the `gh pr merge --squash --delete-branch --admin` invocation behind a single three-state exit (0 merged / 1 timeout-or-escalation / 2 config error).
- ! Multi-PR merge cascades MUST pass `--cascade` on each `task pr:wait-mergeable-and-merge` invocation so merge-tree-clean PRs whose base SHA is behind the current target branch HEAD are refused (semantically stale pre-spine CI, #2385). After the first merge in a cascade, also pass `--require-master-ci-green` before merging the next PR. Rebase/update-branch onto the post-spine target and wait for fresh green CI before re-invoking.
- ! The per-PR atomic gate (`task pr:merge-ready -- <N> && gh pr merge <N> --squash --delete-branch --admin`) documented in `content/skills/deft-directive-swarm/SKILL.md` Phase 5 -> 6 STILL applies for any in-cascade merge an operator runs by hand. The Wave-3 cascade surface is the automated wrapper; the per-PR atomic gate is the manual freshness-window-atomic check. The two co-exist -- one does not retire the other.
- ! When `--protected <issue-numbers>` is supplied, the helper runs the protected-issue check (#701) BEFORE the wait loop. A persistent `closingIssuesReferences` link short-circuits the cascade with exit 1 (escalation) AHEAD of any `gh pr merge` call. New cascade scripts MUST preserve this ordering -- the protected-issue check is structurally a pre-condition that cannot be resolved by waiting.
- ⊗ Hand-roll a cascade `while ... task pr:merge-ready` shell loop (or equivalent ad-hoc Python monitor) when `task pr:wait-mergeable-and-merge` is available. The Wave-1+2 hardening is in the helpers the new task composes; hand-rolled loops re-introduce the `head: None` / babysit-each-PR failure mode #1369 closes.
- ⊗ Run `gh pr merge <N>` from inside a cascade automation script without first chaining the Layer-3 protected-issue check (#701) when the PR is known to reference any umbrella / staying-OPEN issue. The cascade surface (`task pr:wait-mergeable-and-merge` with `--protected`) is the canonical compose-point; hand-rolled merges that skip the chain re-surface the PR #700 / PR #401 persistent-link recurrence.

## SCM tooling (#884 / #1145)

Rationale: `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § SCM tooling — prefer ghx (#884).

- ! When you need to invoke the GitHub CLI (`gh issue view`, `gh pr list`, `gh api`, ...) and `ghx` is on PATH, prefer `ghx` over `gh` -- the surface is identical and the cached responses are 10x faster on repeated calls
- ! Fall back to `gh` transparently when `ghx` is not on PATH; do NOT fail or warn -- this keeps the rule additive for consumers who have not yet opted in
- ~ Maintainers SHOULD run `task setup` to install `ghx`; the install is consent-gated and never auto-runs by default. Pass `--yes` for non-interactive (CI / scripted) approval
- ⊗ Auto-install `ghx` without explicit operator consent -- `task setup` MUST prompt before invoking the upstream installer; the only non-interactive paths are `--yes` (explicit approval) or `DEFT_SETUP_GHX_SKIP=1` (explicit opt-out)
- ! Raw `gh` calls outside the TS SCM shim layer are forbidden by `task verify:scm-boundary` (#1145 / N5 -- partial down-payment on #445 / #935 Workstream 6). The TS verb layer MUST route `gh` calls through the canonical SCM shim; the deterministic gate scans the canonical scope globs and fails `task check` when any of them route around the shim. Non-`github-issue` sources raise `NotImplementedError` so a consumer on GitLab / Gitea / local sees the deferred abstraction immediately.
- ? Power users MAY install `ghx` manually via the upstream `install.ps1` (Windows) or `install.sh` (macOS / Linux); the `task setup` prompt is a convenience, not a gate

See also § ghx cache proxy (#884) for install surfaces and read-only vs mutation rules.

## Windows / ASCII Conventions for Machine-Editable Sections

Agent `edit_files` operations can fail when structured file sections contain Unicode characters that do not round-trip cleanly through Windows toolchains (xref warpdotdev/warp#9022). The following rules apply to **machine-editable structured sections**: ROADMAP.md phase bodies, CHANGELOG.md entries, and Open Issues Index rows.

- ~ In machine-editable structured sections, prefer ASCII punctuation:
  - Use `--` instead of em-dash
  - Use `->` instead of arrow characters
  - Avoid emoji in body text (emoji in headings or decorative positions are acceptable)
- ! Never use Unicode em-dashes, curly quotes, or non-ASCII arrow characters in CHANGELOG.md entries or ROADMAP.md index rows -- these cause `edit_files` search/replace mismatches when the tool's internal encoding differs from the file's byte representation
- ~ Use straight quotes (`"`, `'`) rather than curly/smart quotes in all machine-edited files
- ? Prose-only sections (README narrative, philosophy docs) may use Unicode freely since they are rarely machine-edited

**Rationale**: The `edit_files` tool performs exact byte-string matching. When Windows agents write files through encoding layers that silently substitute characters (e.g., em-dash `\u2014` vs. `--`), subsequent search/replace operations fail because the stored bytes no longer match the search string. Sticking to ASCII in structured sections eliminates this class of failure.

## Issue Workflow

**Best practices**:
- ~ Search for duplicates before creating
- ! Include reproduction steps, expected/actual behavior, environment details
- ~ Apply appropriate labels and assign when taking ownership
- ~ Link related issues and PRs

### Issue Labels

**Priority**: `priority:critical` (production down), `priority:high` (major broken), `priority:medium` (important, not blocking), `priority:low` (nice to have)

**Type**: `bug`, `feat`, `docs`, `refactor`, `test`, `chore`

**Status**: `status:blocked`, `status:in-progress`, `status:needs-info`, `status:wontfix`

### Post-1.0.0 Issue Linking

Following a v1.0.0 release, commits:

- ! link to existing or new issues for: Features, bugs, breaking changes, architecture decisions
- ≉ create issues for: Typos, formatting, dependency bumps, refactoring same code
- ~ create issues for: Anything someone might search for later, or that needs discussion

**Format**: Reference issues in commit messages using `Closes #123`, `Fixes #456`, or `Relates to #789`

## GitHub Actions Best Practices

**CI Workflows**:
- ~ Provide fast feedback (fail fast, cache dependencies)
- ~ Use matrix testing for multiple versions
- ! Run `task check` for quality gates
- ~ Upload coverage reports

**Framework CI runners (#2672)**:
- ! `deftai/directive` required CI prefers Blacksmith (`blacksmith-4vcpu-ubuntu-2404`) for TypeScript and Go cost
- ! Capacity watchdog (~20 minute budget): if a Blacksmith primary job stays `queued` with `runner_name` null and no `started_at`, cancel that queued attempt (concurrency cancel-in-progress) and run the same suite on `ubuntu-latest`
- ! Branch-protection required check names (`TypeScript (build + lint + test)`, `Go (test + build)`) live **only** on the aggregator jobs — never on primary/failover lane names
- ⊗ Fail over `in_progress` jobs (execution hangs) — those stay timeout + fix (#2652); capacity failover is queue-stall only
- ! Consumer scaffolds and `npm-publish.yml` stay on GitHub-hosted `ubuntu-latest` (Blacksmith is opt-in for consumer orgs; npm `--provenance` requires GH-hosted)
- ! Agents seeing `runner_capacity_stall` / `RUNNER_CAPACITY_STALL` MUST wait for auto-failover — ⊗ `--skip-ci` as a capacity remedy

**Security**:
- ! Use GitHub Secrets for CI/CD credentials
- ⊗ Commit secrets to repo
- ~ Keep secrets in `secrets/` dir locally (gitignored)
- ~ Rotate secrets regularly

## Branch Protection

**Recommended settings** for `main`:
- ! Require PR reviews (1+ approvals)
- ! Require status checks to pass
- ! Require branches to be up to date
- ~ Require conversation resolution
- ~ Require linear history
- ⊗ Allow force pushes
- ⊗ Allow deletions

## ghx cache proxy (#884)

[ghx](https://github.com/brunoborges/ghx) is a **supported, recommended** read-only cache proxy for the GitHub CLI. Deft's SCM layer (`resolveBinary` in `@deftai/directive-core/scm`) prefers `ghx` over `gh` when both are on PATH, so consumers benefit automatically once ghx is installed. ghx is optional for consumer projects — only `gh` is required — but strongly recommended for maintainers and multi-agent swarms that issue many read-only `gh api` / `gh issue view` calls.

**Install (consent-gated, default deny):**

```bash
directive setup:ghx          # interactive y/N prompt (default: no)
task setup:ghx               # same via Taskfile
task setup:ghx -- --yes      # non-interactive CI / scripted approval
```

`task setup` runs a detection-only `--check` pass and nudges when `gh` is present but `ghx` is missing. Set `DEFT_SETUP_GHX_SKIP=1` to suppress the interactive install path in non-interactive shells.

**Surface rules:**

- ! Prefer `ghx` over `gh` for read-only GET operations when ghx is on PATH
- ! Use live `gh` for mutations (POST/PATCH/PUT/DELETE) and for immediate read-back after a mutation — ghx is a cached GET proxy only
- ⊗ Use `ghx api` for multi-arg write invocations — ghx accepts a single positional path arg; writes fall through to `gh`

## Branch policy (#746 / #747)

Three consumer-facing surfaces enforce the branch-policy contract:

- `deft check` — consumer pre-commit quality gate. In vendored `.deft/core` installs it runs consumer-safe Deft install/lifecycle gates and does NOT run framework source-repo self-tests. Run `deft check:framework-source` only when explicitly validating the vendored framework payload itself (#1519).
- `deft verify:branch` — refuses default-branch commit unless `plan.policy.allowDirectCommitsToMaster = true` (typed) or `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1`.
- `.githooks/pre-commit` / `pre-push` — installed via `deft setup`; verify via `deft verify:hooks-installed`. After a framework upgrade, run `deft update` to refresh hook templates (#2049).
- `deft policy:show --field=allowDirectCommitsToMaster` — inspect policy; `deft policy:allow-direct-commits -- --confirm` writes typed override with audit row.
- `deft verify:forward-coverage` — forward-coverage gate (#1310), wired into `deft check` + pre-commit (`--staged`); document exceptions via `--allow-list <path>`.

When `plan.policy.allowDirectCommitsToMaster = true`, the agent MUST surface at session start (after alignment confirmation):

> "[deft policy] Direct commits to the default branch are ENABLED (source: typed). Branch-protection policy is OFF."

Phrasing from `deft policy:show --field=allowDirectCommitsToMaster`. When OFF (default), absence of the disclosure signals enforcing state. Override paths: `deft policy:show` / `deft policy:enforce-branches` / `deft policy:allow-direct-commits -- --confirm` / `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1`.

⊗ Begin a session that will commit/push without surfacing policy when `allowDirectCommitsToMaster=true`.

## Local git hooks (#747 / #2049)

Project-root `.githooks/` enforce branch policy and encoding gates through the **`deft` CLI only** — no Python `scripts/*.py` dispatch (#2049). `deft init` and `deft update` deposit hook files; `deft setup` / `task setup` wires `core.hooksPath=.githooks` and refuses when the directory is missing (#2530).

| Hook | Dispatches | Purpose |
|------|------------|---------|
| `pre-commit` | `deft verify:branch`, `deft verify:encoding`, `deft verify:vbrief-conformance` (when `vbrief/` exists) | Default-branch commit refusal (#747), encoding gate (#798), staged vBRIEF conformance (#1620) |
| `pre-push` | `deft preflight-gh --pre-push-stdin` | Refspec-aware default-branch push refusal + destructive gh verb gate (#1019) |

- ! Verify wiring after install or framework upgrade: `deft verify:hooks-installed` (also wired into `deft check`).
- ! After upgrading the framework payload, run `deft update` from the project root to refresh `.githooks/` to the current TS-native templates (#2049). Stale hooks that still invoke `python scripts/preflight_branch.py` or other legacy paths fail `deft verify:hooks-installed`.
- ~ Recovery when hooks are stale or broken: `deft update` (deposits/refreshes hook files from the framework payload, including on an already-current deposit) then `deft setup` / `task setup` (wires `core.hooksPath` when files are present).

## Destructive gh verbs (#1019)

A detection-bound gate (`deft preflight-gh`) refuses three classes of destructive surface before they execute, complementing the #747 branch-protection gate which already refuses commits to the default branch:

- `delete_repo` -- `gh repo delete <owner/repo>` and `gh api -X DELETE repos/<owner>/<repo>[/...]`. Irreversible.
- `force_push_default` -- `git push --force` / `--force-with-lease` / `+refspec` targeting `master` or `main`.
- `admin_merge` -- `gh pr merge --admin` (bypasses branch-protection required reviews).

Three enforcement surfaces back the gate:

1. `.githooks/pre-push` invokes `deft preflight-gh --pre-push-stdin` after the #747 branch gate (on pre-commit), refusing any push that touches the default branch (force-push or otherwise). Install via `deft setup` (idempotent `git config core.hooksPath .githooks`); verify via `deft verify:hooks-installed`.
2. `deft verify:destructive-gh-verbs` (or `task verify:destructive-gh-verbs` in framework source repos) is wired into the `deft check` aggregate. It runs `deft preflight-gh --self-test`, which drives a built-in fixture table through the classifier so a future edit that introduces a false negative / false positive fails CI immediately.
3. Agent pre-execution callers can invoke `deft preflight-gh --command "<full command>"` to classify a candidate verb before it executes. Three-state exit (0 allowed / 1 destructive refused / 2 config error) mirrors `deft verify:branch`.

**Override paths:**

- `DEFT_ALLOW_DESTRUCTIVE_GH_VERBS=1` -- per-shell emergency env-var bypass. Mirrors `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT` (#747). The gate prints an explicit `policy bypassed for this session` line so the bypass is auditable after the fact.
- For repo deletion specifically: prefer the GitHub web UI's archive-or-delete prompt -- archiving is reversible, the gate is not opining on it.
- For an admin merge: the canonical recovery is to request review through the normal flow. The `--admin` flag is gated because the most-common legitimate use case (release hot-fix) is rare enough that documenting an explicit bypass is cheaper than letting the verb pass by default.

## Release Workflow (UCCPR)

**UCCPR** = Update Changelog, Commit, Push, Release

Standard workflow for releasing new versions:

1. Update `CHANGELOG.md` -- move `[Unreleased]` entries to new version section with date
2. Update `VERSION` constant in main script/package file
3. Commit: `git commit -m "chore: release v<X.Y.Z>"`
4. Push to default branch
5. Tag: `git tag v<X.Y.Z> && git push origin v<X.Y.Z>`
6. Release: `gh release create v<X.Y.Z> --title "Deft v<X.Y.Z>" --notes-file release-notes.md`

## Compliance

- ! Use Conventional Commits for all PR titles
- ! Maintain CHANGELOG.md following [Keep a Changelog](./changelog.md) format
- ! Use [Semantic Versioning](../meta/versioning.md) for releases
- ! Include CHANGELOG.md content in release notes
- ! Maintain test coverage at or above PROJECT.md threshold
- ! Pass all CI checks before merge
- ~ Request reviews from appropriate team members
- ~ Link PRs to related issues
- ~ Use gh CLI for automation where possible
- ⊗ Force-push to protected branches
- ! Keep PR scope focused and size reasonable
- ! Update documentation with code changes
