package main

import (
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// commit-hygiene (#1453, #1458) gives the installer a PROACTIVE counterpart to
// the deposited deft-core-guard CI check (#1430/#1440). The guard is a late,
// PR-time, GitHub-only, consumer-deletable backstop that rejects a PR mixing
// the vendored framework payload (.deft/core/**) with the consumer's own files.
// Before this change the installer gave no advance warning, so a consumer would
// only discover the rule after pushing. The two layers below close that gap:
//
//   - Layer 1: a dirty-working-tree GATE BEFORE an --upgrade payload swap. As
//     of #1458 the default is FAIL-LOUD: a dirty tree refuses the upgrade
//     (non-zero exit, no payload swap) on BOTH the interactive and the
//     --yes/non-interactive paths. --force / --allow-dirty bypasses it.
//   - Layer 2: scoped staging + an exact, copy-pasteable scoped commit command
//     AFTER the deposit (reusing installerManagedMatchers so the installer only
//     ever stages framework-owned paths, never consumer app files).

// dirtyTreeBlockCode is the stable machine-readable error code surfaced in
// --json mode when a dirty tree refuses an upgrade, so agents / CI can branch
// on it deterministically (no interactive hang, no silent abort). The name is
// kept verbatim from #1453 for back-compat with any consumer already matching
// it, even though #1458 made the refusal the default (no --require-clean
// needed).
const dirtyTreeBlockCode = "dirty_tree_require_clean"

// dirtyTreeBlockMessage is the human-readable top-line counterpart to
// dirtyTreeBlockCode (the --json `error` field).
const dirtyTreeBlockMessage = "refusing to upgrade: the working tree has uncommitted changes; commit/stash first (recommended) or re-run with --force / --allow-dirty to upgrade a dirty tree"

// dirtyTreeWhy is the short rationale (the --json `why` field) explaining why a
// clean tree is wanted before an upgrade.
const dirtyTreeWhy = "an upgrade rewrites the framework payload (.deft/core/**) and installer-managed files; committing those mixed with your own work trips the deft-core-guard CI check, which rejects a PR that mixes the framework payload with your app files"

// dirtyTreeRemediation is the clean-up-first guidance (the --json `remediation`
// field): the recommended path plus its pros/cons.
const dirtyTreeRemediation = "clean up first (recommended): commit or stash your own work (git stash / git commit), then re-run the upgrade and commit the framework deposit on its OWN branch/PR. Pros: the framework bump lands as its own reviewable commit, the guard passes, clean history. Cons: you must commit or stash your in-progress work first."

// dirtyTreeForceHint is the exact bypass command + its tradeoff (the --json
// `force_hint` field).
const dirtyTreeForceHint = "re-run with --force (or --allow-dirty) to upgrade a dirty tree, e.g. `deft-install --upgrade --force`. Pros: no interruption to your current work. Cons: the framework deposit and your uncommitted changes coexist -- keep them in separate commits yourself or the guard rejects a mixed commit."

// dirtyTreePreviewLimit bounds how many porcelain status lines the prose
// advisory prints so a large dirty tree does not flood the terminal.
const dirtyTreePreviewLimit = 20

// commitHygieneOptions carries the #1453 / #1458 flag state into the dirty-tree
// gate. As of #1458 a dirty tree refuses the upgrade by DEFAULT, so force
// (--force / --allow-dirty) is the only flag that changes the gate decision.
// requireClean (--require-clean) is retained as an accepted no-op alias for the
// now-default behavior so passing it neither errors nor changes anything.
type commitHygieneOptions struct {
	requireClean bool // accepted no-op alias since #1458 (refusal is the default)
	force        bool // --force / --allow-dirty: bypass the refusal and upgrade a dirty tree
}

// dirtyTreeAdvisory is the result of the pre-swap working-tree probe (#1453,
// #1458).
type dirtyTreeAdvisory struct {
	checked bool     // the probe actually ran (an upgrade inside a git work tree)
	dirty   bool     // the working tree had uncommitted changes
	files   []string // `git status --porcelain` lines (verbatim)
	blocked bool     // the dirty tree refused the upgrade (dirty && !force, the #1458 default)
}

// gitPorcelainStatusFunc returns the `git status --porcelain` lines for the
// repo containing dir, whether dir is inside a git work tree at all, and any
// hard error. Indirected through a var so tests can drive the advisory without
// a real repo. Best-effort by contract: a non-git project (or a missing git
// binary) yields (nil, false, nil) so callers simply skip the advisory.
var gitPorcelainStatusFunc = defaultGitPorcelainStatus

// defaultGitPorcelainStatus is the production gitPorcelainStatusFunc. It is the
// installer's only working-tree READ against the consumer repo; it runs no
// mutating git command. It first confirms dir is inside a work tree, then reads
// the porcelain status. Output is split on newlines with the trailing newline
// trimmed but the per-line XY status prefix preserved (so the advisory can show
// the verbatim status), and blank lines dropped.
func defaultGitPorcelainStatus(dir string) ([]string, bool, error) {
	inside, err := exec.Command("git", "-C", dir, "rev-parse", "--is-inside-work-tree").Output()
	if err != nil || strings.TrimSpace(string(inside)) != "true" {
		return nil, false, nil
	}
	out, err := exec.Command("git", "-C", dir, "status", "--porcelain").Output()
	if err != nil {
		return nil, true, err
	}
	var lines []string
	for _, ln := range strings.Split(strings.TrimRight(string(out), "\r\n"), "\n") {
		ln = strings.TrimRight(ln, "\r")
		if strings.TrimSpace(ln) == "" {
			continue
		}
		lines = append(lines, ln)
	}
	return lines, true, nil
}

// runGitStageFunc runs `git -C dir add -- <paths...>`. This is the ONLY
// mutating git command the installer ever issues against the consumer repo, and
// it is strictly scoped (#1453): callers pass only framework + installer-managed
// paths, never `git add -A` and never consumer app files. Indirected for tests.
var runGitStageFunc = func(dir string, paths ...string) error {
	if len(paths) == 0 {
		return nil
	}
	args := append([]string{"-C", dir, "add", "--"}, paths...)
	return exec.Command("git", args...).Run()
}

// dirtyTreeGate is the Layer-1 entry point. It enforces the CRITICAL #1453
// invariant that the dirty-tree advisory is an UPGRADE-only concern: an initial
// install never probes the tree and can never be blocked. For an upgrade it
// delegates to checkDirtyTree.
func dirtyTreeGate(isUpgrade bool, projectDir string, opts commitHygieneOptions) dirtyTreeAdvisory {
	if !isUpgrade {
		return dirtyTreeAdvisory{}
	}
	return checkDirtyTree(projectDir, opts)
}

// checkDirtyTree probes the consumer working tree before an --upgrade payload
// swap (#1453, #1458). It is a silent no-op for a clean tree, a non-git
// project, or when git is unavailable. As of #1458 the DEFAULT is FAIL-LOUD: a
// dirty tree is blocked (the upgrade refuses, non-zero exit, no payload swap)
// unless --force / --allow-dirty is set. --require-clean is an accepted no-op
// alias for this now-default behavior. It NEVER prompts, so the refusal is
// identical on the interactive and the --yes / non-interactive agent/CI paths
// (the latter can never hang).
func checkDirtyTree(projectDir string, opts commitHygieneOptions) dirtyTreeAdvisory {
	lines, isRepo, err := gitPorcelainStatusFunc(projectDir)
	if err != nil || !isRepo {
		// Best-effort: a git error or non-repo simply skips the advisory.
		return dirtyTreeAdvisory{}
	}
	if len(lines) == 0 {
		return dirtyTreeAdvisory{checked: true}
	}
	adv := dirtyTreeAdvisory{checked: true, dirty: true, files: lines}
	// #1458: a dirty tree refuses the upgrade by default; --force / --allow-dirty
	// is the only escape. --require-clean (opts.requireClean) is now redundant
	// and intentionally not consulted.
	if !opts.force {
		adv.blocked = true
	}
	return adv
}

// printDirtyTreeAdvisory writes the human-readable commit-hygiene advisory for
// a dirty working tree (#1453, #1458). For the default fail-loud refusal
// (blocked) it prints a LOUD error that explains WHY a clean tree is wanted and
// spells out the clean-up-vs-force tradeoff with pros/cons. For the --force /
// --allow-dirty bypass (dirty but not blocked) it prints a short warning that
// the framework deposit and the consumer's uncommitted changes will coexist.
func printDirtyTreeAdvisory(w *Wizard, adv dirtyTreeAdvisory) {
	if !adv.dirty {
		return
	}
	w.printf("\n")
	if !adv.blocked {
		// --force / --allow-dirty: proceeding against a dirty tree.
		w.printf("Warning: upgrading against a dirty working tree (--force / --allow-dirty).\n")
		w.printf("The framework deposit and your uncommitted changes will coexist; keep them in\n")
		w.printf("separate commits or the deft-core-guard CI check rejects a mixed commit.\n\n")
		w.printf("Uncommitted changes:\n")
		printDirtyFiles(w, adv.files)
		w.printf("\n")
		return
	}
	// Default fail-loud refusal: explain WHY and the clean-up-vs-force pros/cons.
	w.printf("Refusing to upgrade: your working tree has uncommitted changes.\n\n")
	w.printf("Why a clean tree is wanted:\n")
	w.printf("  An upgrade rewrites the framework payload (.deft/core/**) and installer-managed\n")
	w.printf("  files. Committing those mixed with your own work trips the deft-core-guard CI\n")
	w.printf("  check, which rejects a PR that mixes the framework payload with your app files.\n\n")
	w.printf("Option 1 -- clean up first (recommended):\n")
	w.printf("  - Commit or stash your own work first (git stash  /  git commit).\n")
	w.printf("  - Re-run the upgrade, then commit the framework deposit on its OWN branch/PR.\n")
	w.printf("  Pros: the framework bump lands as its own reviewable commit; the guard passes;\n")
	w.printf("        clean history.\n")
	w.printf("  Cons: you must commit or stash your in-progress work first.\n\n")
	w.printf("Option 2 -- upgrade a dirty tree with --force:\n")
	w.printf("  - Re-run with --force (or --allow-dirty) to upgrade anyway.\n")
	w.printf("  Pros: no interruption to your current work.\n")
	w.printf("  Cons: the framework deposit and your uncommitted changes coexist; you must keep\n")
	w.printf("        them in separate commits yourself, or risk a mixed commit the guard rejects.\n\n")
	w.printf("Uncommitted changes:\n")
	printDirtyFiles(w, adv.files)
	w.printf("\n")
}

// printDirtyFiles prints up to dirtyTreePreviewLimit porcelain status lines,
// summarising any overflow so a large dirty tree does not flood the terminal.
func printDirtyFiles(w *Wizard, files []string) {
	for i, ln := range files {
		if i >= dirtyTreePreviewLimit {
			w.printf("  ... and %d more\n", len(files)-dirtyTreePreviewLimit)
			break
		}
		w.printf("  %s\n", ln)
	}
}

// dirtyTreeBlockResult builds the single machine-readable JSON object emitted on
// stdout when a dirty tree refuses an upgrade in --json mode (#1453, #1458).
// stdout stays a single clean JSON object (#1385), so EVERY actionable signal
// is a structured field rather than stderr-only prose: alongside the existing
// error / error_code / dirty_tree / dirty_files it carries `why` (short
// rationale), `remediation` (clean-up-first guidance), `force_hint` (the exact
// bypass command), and a `warnings: []` array for non-fatal notices. dirty_files
// and warnings are always non-nil slices for a stable JSON schema.
func dirtyTreeBlockResult(adv dirtyTreeAdvisory) map[string]any {
	files := adv.files
	if files == nil {
		files = []string{}
	}
	return map[string]any{
		"success":     false,
		"error":       dirtyTreeBlockMessage,
		"error_code":  dirtyTreeBlockCode,
		"dirty_tree":  true,
		"dirty_files": files,
		"why":         dirtyTreeWhy,
		"remediation": dirtyTreeRemediation,
		"force_hint":  dirtyTreeForceHint,
		"warnings":    []string{},
	}
}

// frameworkStagePaths returns the ordered, repo-relative (POSIX) set of paths
// the installer may stage after a deposit (#1453 Layer 2): the framework
// payload dir (result.DeftDir, relative to the project root) followed by the
// installer-managed deposit surface (installerManagedMatchers -- the SAME
// allowlist the deft-core-guard exempts). Only paths that EXIST under
// projectDir are returned, so the set names what is actually on disk and
// `git add` never errors on an absent pathspec. Crucially this NEVER includes
// consumer app code or consumer vBRIEF data: those are not in the allowlist, so
// they fall through to the guard's "app" bucket and must stay out of the
// framework commit.
func frameworkStagePaths(projectDir, deftDir string) []string {
	var paths []string
	seen := map[string]bool{}
	add := func(rel string) {
		rel = filepath.ToSlash(rel)
		if rel == "" || rel == "." || seen[rel] {
			return
		}
		if !pathExists(filepath.Join(projectDir, filepath.FromSlash(rel))) {
			return
		}
		seen[rel] = true
		paths = append(paths, rel)
	}

	// Framework payload dir first (relative to the project root). Skip it if it
	// resolves outside the project tree (defensive; should not happen).
	if rel, err := filepath.Rel(projectDir, deftDir); err == nil && !strings.HasPrefix(rel, "..") {
		add(rel)
	}

	// Installer-managed deposit surface: exact paths verbatim, directory
	// prefixes as their (trailing-slash-trimmed) dir so `git add <dir>` stages
	// everything beneath it.
	for _, m := range installerManagedMatchers() {
		if m.exact != "" {
			add(m.exact)
		} else if m.prefix != "" {
			add(strings.TrimSuffix(m.prefix, "/"))
		}
	}
	return paths
}

// stageFrameworkPaths best-effort stages ONLY the supplied framework +
// installer-managed paths (#1453 Layer 2b). It NEVER runs `git add -A`. Best-
// effort means: a non-git project (or missing git) is a silent no-op, and a
// `git add` error is returned for optional debug logging but must NEVER fail
// the install. Returns whether anything was staged.
func stageFrameworkPaths(projectDir string, paths []string) (bool, error) {
	if len(paths) == 0 {
		return false, nil
	}
	if _, isRepo, _ := gitPorcelainStatusFunc(projectDir); !isRepo {
		return false, nil
	}
	if err := runGitStageFunc(projectDir, paths...); err != nil {
		return false, err
	}
	return true, nil
}

// commitHygieneBranchName is the suggested branch name the full-lifecycle
// guidance uses for the framework-only deposit PR (#1671). It is a single
// constant so the printed `git switch`, `git push`, and `gh pr` commands stay
// consistent with each other (and so the tests can pin the exact lifecycle).
const commitHygieneBranchName = "chore/deft-framework-upgrade"

// printCommitGuidance prints the scoped next-steps commit guidance after a
// deposit (#1453 Layer 2a): the exact scoped command naming only the framework
// + installer-managed paths, and an explicit warning against `git add -A`
// (which would sweep consumer app files into the framework commit and trip the
// deft-core-guard). staged reports whether the installer already staged those
// paths so the guidance reads correctly either way.
//
// #1671: the guidance now walks the FULL PR lifecycle (branch -> commit -> push
// -> `gh pr create` -> merge) instead of stopping at `git commit`. The
// deft-core-guard CI check only runs on a PR, so a user (or agent) told only to
// `git commit` had no signal that a standalone branch + push + PR is what the
// guard actually requires. Spelling out every step keeps the framework deposit
// on the clean, standalone-PR path the guard intends.
func printCommitGuidance(w *Wizard, paths []string, staged bool) {
	if len(paths) == 0 {
		return
	}
	addCmd := "git add " + strings.Join(paths, " ")
	w.printf("\nCommit hygiene (#1453, #1671): keep the framework deposit in its OWN branch/PR.\n")
	w.printf("Do NOT use `git add -A` -- mixing the payload with your own files trips the\n")
	w.printf("deft-core-guard CI check.\n")
	if staged {
		w.printf("The installer already staged ONLY these framework + installer-managed paths:\n")
		w.printf("  %s\n", addCmd)
	} else {
		w.printf("Stage ONLY these framework + installer-managed paths:\n")
		w.printf("  %s\n", addCmd)
	}
	w.printf("Then take the framework deposit through the full PR lifecycle so deft-core-guard\n")
	w.printf("evaluates a clean, standalone PR:\n")
	w.printf("  1. Branch: git switch -c %s\n", commitHygieneBranchName)
	w.printf("  2. Commit: git commit -m \"chore(deft): update framework payload\"\n")
	w.printf("  3. Push:   git push -u origin %s\n", commitHygieneBranchName)
	w.printf("  4. PR:     gh pr create --fill --title \"chore(deft): update framework payload\"\n")
	w.printf("  5. Merge:  gh pr merge --squash --delete-branch   # after deft-core-guard passes\n")
}

// porcelainStatusPaths extracts the repo-relative (POSIX) paths from the
// `git status --porcelain` v1 lines returned by gitPorcelainStatusFunc (which
// preserve the leading two-column XY status prefix). For a rename/copy entry
// (`XY ORIG -> NEW`) the NEW path is returned. Git-quoted paths (core.quotePath
// default-on, used for paths with special bytes) are unquoted. Blank / malformed
// lines are skipped. Used by frameworkRefreshSideEffects to map the working-tree
// status onto the framework-managed classification.
func porcelainStatusPaths(lines []string) []string {
	var paths []string
	for _, ln := range lines {
		// Porcelain v1 entry: X at [0], Y at [1], a space at [2], path at [3:].
		if len(ln) < 4 {
			continue
		}
		rest := ln[3:]
		if idx := strings.Index(rest, " -> "); idx != -1 {
			rest = rest[idx+len(" -> "):]
		}
		p := unquoteGitPath(strings.TrimSpace(rest))
		if p == "" {
			continue
		}
		paths = append(paths, filepath.ToSlash(p))
	}
	return paths
}

// unquoteGitPath strips git's C-style double-quoting from a porcelain path. Git
// quotes paths containing special bytes when core.quotePath is on (the default);
// an unquoted path is returned verbatim. A best-effort strconv.Unquote handles
// the C escapes; on failure the surrounding quotes are trimmed so the caller
// still gets a usable path.
func unquoteGitPath(s string) string {
	if len(s) >= 2 && strings.HasPrefix(s, "\"") && strings.HasSuffix(s, "\"") {
		if uq, err := strconv.Unquote(s); err == nil {
			return uq
		}
		return s[1 : len(s)-1]
	}
	return s
}

// frameworkRefreshSideEffects returns the sorted, repo-relative (POSIX) set of
// framework-managed files (the vendored payload under .deft/core/** plus the
// installer-managed deposit surface) that currently have UNCOMMITTED changes in
// projectDir (#1671). It is the data behind the self-aware refresh disclosure:
// after the AGENTS.md refresh rewrites the managed section -- and after the
// upgrade payload swap has touched .deft/core files such as uv.lock -- these are
// the files that must land in the framework deposit commit. Consumer app files
// are excluded (classifyChangedPaths' "app" bucket) so the disclosure never
// nudges the user to commit their own work into the framework PR.
//
// Best-effort by contract: a non-git project (or a missing git binary) yields
// nil so callers simply skip the disclosure, mirroring the dirty-tree advisory.
func frameworkRefreshSideEffects(projectDir string) []string {
	lines, isRepo, err := gitPorcelainStatusFunc(projectDir)
	if err != nil || !isRepo {
		return nil
	}
	core, installerManaged, _ := classifyChangedPaths(porcelainStatusPaths(lines))
	files := append(append([]string{}, core...), installerManaged...)
	if len(files) == 0 {
		return nil
	}
	sort.Strings(files)
	return files
}

// printRefreshSideEffects discloses the framework files the AGENTS.md refresh /
// upgrade payload swap left with uncommitted changes (#1671). It replaces the
// old single, silent success line ("Refreshed AGENTS.md managed section ...")
// that left an operator -- who may have already committed an earlier snapshot --
// unaware that new stragglers (e.g. AGENTS.md, .deft/core/uv.lock) exist and
// belong in the framework deposit commit. No-op when files is empty.
func printRefreshSideEffects(w *Wizard, files []string) {
	if len(files) == 0 {
		return
	}
	w.printf("\nAGENTS.md refresh side effects (#1671): the refresh and framework payload swap\n")
	w.printf("left these framework files with uncommitted changes -- they belong in the\n")
	w.printf("framework deposit commit (the installer stages them before printing the\n")
	w.printf("`git add` list below, so there are no post-stage stragglers):\n")
	for _, f := range files {
		w.printf("  %s\n", f)
	}
}
