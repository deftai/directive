package main

import (
	"os/exec"
	"path/filepath"
	"strings"
)

// commit-hygiene (#1453) gives the installer a PROACTIVE counterpart to the
// deposited deft-core-guard CI check (#1430/#1440). The guard is a late,
// PR-time, GitHub-only, consumer-deletable backstop that rejects a PR mixing
// the vendored framework payload (.deft/core/**) with the consumer's own files.
// Before this change the installer gave no advance warning, so a consumer would
// only discover the rule after pushing. The two layers below close that gap:
//
//   - Layer 1: a dirty-working-tree advisory BEFORE an --upgrade payload swap.
//   - Layer 2: scoped staging + an exact, copy-pasteable scoped commit command
//     AFTER the deposit (reusing installerManagedMatchers so the installer only
//     ever stages framework-owned paths, never consumer app files).

// dirtyTreeBlockCode is the stable machine-readable error code surfaced in
// --json mode when --require-clean refuses an upgrade against a dirty tree, so
// agents / CI can branch on it deterministically (no interactive hang, no
// silent abort).
const dirtyTreeBlockCode = "dirty_tree_require_clean"

// dirtyTreeBlockMessage is the human-readable counterpart to dirtyTreeBlockCode.
const dirtyTreeBlockMessage = "working tree has uncommitted changes and --require-clean was set; commit/stash first or re-run with --force / --allow-dirty"

// dirtyTreePreviewLimit bounds how many porcelain status lines the prose
// advisory prints so a large dirty tree does not flood the terminal.
const dirtyTreePreviewLimit = 20

// commitHygieneOptions carries the #1453 flag state into the dirty-tree
// advisory. requireClean (--require-clean) turns the default warn-and-proceed
// advisory into a hard refusal; force (--force / --allow-dirty) escapes that
// refusal.
type commitHygieneOptions struct {
	requireClean bool
	force        bool
}

// dirtyTreeAdvisory is the result of the pre-swap working-tree probe (#1453).
type dirtyTreeAdvisory struct {
	checked bool     // the probe actually ran (an upgrade inside a git work tree)
	dirty   bool     // the working tree had uncommitted changes
	files   []string // `git status --porcelain` lines (verbatim)
	blocked bool     // --require-clean refused the upgrade (dirty && requireClean && !force)
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
// swap (#1453). It is a silent no-op for a clean tree, a non-git project, or
// when git is unavailable. The DEFAULT is warn-and-proceed (dirty reported,
// never blocked); --require-clean turns a dirty tree into a hard refusal, which
// --force / --allow-dirty escapes. It NEVER prompts, so the --yes /
// non-interactive agent/CI path can never hang.
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
	if opts.requireClean && !opts.force {
		adv.blocked = true
	}
	return adv
}

// printDirtyTreeAdvisory writes the human-readable commit-hygiene advisory for
// a dirty working tree (#1453). It frames the message as either a hard refusal
// (blocked, via --require-clean) or a warn-and-proceed notice, and always
// explains WHY (the deft-core-guard rejects a mixed PR) and WHAT to do
// (commit/stash first; land the framework deposit on its own branch/PR).
func printDirtyTreeAdvisory(w *Wizard, adv dirtyTreeAdvisory) {
	if !adv.dirty {
		return
	}
	w.printf("\n")
	if adv.blocked {
		w.printf("Refusing to upgrade: your working tree has uncommitted changes (--require-clean).\n")
	} else {
		w.printf("Warning: your working tree has uncommitted changes before this upgrade.\n")
	}
	w.printf("This upgrade rewrites the framework payload (.deft/core/**) and installer-managed\n")
	w.printf("files. Committing those together with your own work trips the deft-core-guard CI\n")
	w.printf("check, which rejects a PR that mixes .deft/core/** with your project files.\n\n")
	w.printf("Recommended before upgrading:\n")
	w.printf("  1. Commit or stash your own work first (git stash  /  git commit).\n")
	w.printf("  2. Run the upgrade, then commit the framework deposit on its OWN branch.\n")
	w.printf("  3. Open the framework bump as a separate PR from your app changes.\n\n")
	w.printf("Uncommitted changes:\n")
	for i, ln := range adv.files {
		if i >= dirtyTreePreviewLimit {
			w.printf("  ... and %d more\n", len(adv.files)-dirtyTreePreviewLimit)
			break
		}
		w.printf("  %s\n", ln)
	}
	if adv.blocked {
		w.printf("\nRe-run with --force (or --allow-dirty) to upgrade anyway, or drop --require-clean.\n")
	}
	w.printf("\n")
}

// dirtyTreeBlockResult builds the single machine-readable JSON object emitted on
// stdout when --require-clean refuses an upgrade in --json mode (#1453). The
// shape mirrors the success object's dirty_* fields so a consumer parses one
// schema either way. dirty_files is always a non-nil slice for stable JSON.
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

// printCommitGuidance prints the scoped next-steps commit guidance after a
// deposit (#1453 Layer 2a): the exact scoped command naming only the framework
// + installer-managed paths, and an explicit warning against `git add -A`
// (which would sweep consumer app files into the framework commit and trip the
// deft-core-guard). staged reports whether the installer already staged those
// paths so the guidance reads correctly either way.
func printCommitGuidance(w *Wizard, paths []string, staged bool) {
	if len(paths) == 0 {
		return
	}
	addCmd := "git add " + strings.Join(paths, " ")
	w.printf("\nCommit hygiene (#1453): keep the framework deposit in its OWN commit/PR.\n")
	w.printf("Do NOT use `git add -A` -- mixing the payload with your own files trips the\n")
	w.printf("deft-core-guard CI check.\n")
	if staged {
		w.printf("The installer already staged ONLY these framework + installer-managed paths:\n")
		w.printf("  %s\n", addCmd)
		w.printf("Review them, then commit on a framework-only branch:\n")
		w.printf("  git commit -m \"chore(deft): update framework payload\"\n")
	} else {
		w.printf("Stage ONLY these framework + installer-managed paths, then commit:\n")
		w.printf("  %s\n", addCmd)
		w.printf("  git commit -m \"chore(deft): update framework payload\"\n")
	}
}
