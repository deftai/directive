package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// semverTagPattern matches semver-shaped release refs (with or without the
// leading `v`). Used by resolveInstallManifestFields to distinguish a release
// tag (which the manifest should record as `tag: 'vX.Y.Z'`) from a branch
// name like `master` / `main` / `feat/...` (which must NOT be propagated into
// the manifest's `tag` field -- doing so produces nonsensical values such as
// `vmaster` after BuildInstallManifestText's v-prefix normalisation, breaking
// downstream consumers that parse `tag` as semver). The regex intentionally
// allows pre-release / build-metadata suffixes (e.g. `v0.28.0-rc.1`,
// `v0.28.0+build`) so legitimate release-candidate refs still round-trip.
var semverTagPattern = regexp.MustCompile(`^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$`)

// version is set at build time via ldflags:
//
//	go build -ldflags "-X main.version=v1.0.0" ./cmd/deft-install/
var version = "1.0.0"

// defaultBranch is set at build time via ldflags to pair the installer
// binary with the framework ref it was built from. Empty means "origin
// default branch" (usually master). Typical values:
//
//	-X main.defaultBranch=v0.20.0            (tagged release)
//	-X main.defaultBranch=v0.20.0-rc.1       (pre-release)
//	-X main.defaultBranch=phase2/vbrief-cutover  (dispatch/branch build)
//
// User-provided --branch / /branch flag takes precedence.
var defaultBranch = ""

// resolveBranch returns the effective branch to use for clone/update.
// A user-provided --branch value takes precedence over the build-time
// defaultBranch. An empty result means "origin default branch".
func resolveBranch(flagValue, defaultValue string) string {
	if flagValue != "" {
		return flagValue
	}
	return defaultValue
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `deft-install %s — Deft project installer

Usage:
  deft-install [options]

Options:
  --branch <name>           Clone from a specific branch (default: repo default)
  --legacy-layout           Deposit at legacy 'deft/' instead of canonical '.deft/core/'
                            (back-compat path; pre-v0.27 in-flight migrations only)
  --yes, --non-interactive  Non-interactive/agent mode: skip all prompts; requires
                            --repo-root for target dir (or uses CWD); auto-confirms
                            updates and installs; ideal for CI/agents
  --upgrade                 Force update/upgrade path even if framework dir exists.
                            Refuses by default when the working tree is dirty
                            (use --force / --allow-dirty to upgrade a dirty tree)
  --require-clean           Deprecated no-op: a dirty tree is now refused by
                            default on --upgrade (accepted as an alias)
  --force, --allow-dirty    Upgrade even when the working tree is dirty (bypass
                            the default clean-tree requirement)
  --maintainer              Maintainer checkout mode: bootstrap/report tooling
                            without consumer file projections
  --repo-root <path>        Target project directory (enables fully non-interactive
                            installs when combined with --yes)
  --json                    Emit structured JSON result to stdout (success, paths,
                            actions taken, warnings); suppresses some prose
  --no-update-check         Skip the startup version-currency check (offline/CI)
  --debug                   Print build target and diagnostic info
  --version                 Print version and exit
  --help                    Show this help message

Windows-style aliases:
  /branch <name>            Same as --branch
  /legacy-layout            Same as --legacy-layout
  /yes, /non-interactive    Same as --yes
  /upgrade                  Same as --upgrade
  /require-clean            Same as --require-clean
  /force, /allow-dirty      Same as --force
  /maintainer               Same as --maintainer
  /repo-root <path>         Same as --repo-root
  /json                     Same as --json
  /no-update-check          Same as --no-update-check
  /debug                    Same as --debug
  /v, /version              Same as --version
  /?, /h, /help             Same as --help

User configuration:
  Config directory : %s
  Override via     : DEFT_USER_PATH environment variable

Examples:
  deft-install                              Interactive install (canonical layout)
  deft-install --branch beta                Install from beta branch
  deft-install --yes --repo-root C:\proj    Non-interactive agent install
  deft-install --yes --repo-root . --json   Machine-readable result for scripting
  deft-install --yes --upgrade --repo-root .  Force refresh of existing install
  deft-install --yes --upgrade --maintainer --repo-root . --json
                                            Maintainer setup for a directive checkout
  deft-install /yes /repo-root .            Windows-style non-interactive
`, version, UserConfigDir())
}

// normalizeArgs rewrites Windows-style /flag arguments into --flag form
// so the standard flag package can parse them.
func normalizeArgs(args []string) []string {
	slashFlags := map[string]string{
		"/?":               "--help",
		"/h":               "--help",
		"/help":            "--help",
		"/v":               "--version",
		"/version":         "--version",
		"/debug":           "--debug",
		"/branch":          "--branch",
		"/legacy-layout":   "--legacy-layout",
		"/yes":             "--yes",
		"/non-interactive": "--non-interactive",
		"/upgrade":         "--upgrade",
		"/require-clean":   "--require-clean",
		"/force":           "--force",
		"/allow-dirty":     "--allow-dirty",
		"/maintainer":      "--maintainer",
		"/repo-root":       "--repo-root",
		"/json":            "--json",
		"/no-update-check": "--no-update-check",
	}
	out := make([]string, 0, len(args))
	for _, a := range args {
		if repl, ok := slashFlags[a]; ok {
			out = append(out, repl)
		} else {
			out = append(out, a)
		}
	}
	return out
}

func main() {
	// Rewrite Windows-style /flags to --flags so the flag package handles them.
	os.Args = append(os.Args[:1], normalizeArgs(os.Args[1:])...)

	showVersion := flag.Bool("version", false, "print version and exit")
	debug := flag.Bool("debug", false, "print build target and diagnostic info")
	branch := flag.String("branch", "", "clone from a specific branch")
	legacyLayout := flag.Bool("legacy-layout", false, "deposit at legacy 'deft/' instead of canonical '.deft/core/' (back-compat only)")
	yes := flag.Bool("yes", false, "non-interactive mode (no prompts; combine with --repo-root)")
	nonInteractive := flag.Bool("non-interactive", false, "alias for --yes")
	upgrade := flag.Bool("upgrade", false, "force update/upgrade of existing install")
	requireClean := flag.Bool("require-clean", false, "deprecated no-op: a dirty tree is refused by default on --upgrade (#1458)")
	force := flag.Bool("force", false, "upgrade even when the working tree is dirty (bypass the default clean-tree requirement)")
	allowDirty := flag.Bool("allow-dirty", false, "alias for --force")
	maintainer := flag.Bool("maintainer", false, "maintainer checkout mode: bootstrap/report tools without consumer file projections")
	repoRoot := flag.String("repo-root", "", "target project dir for non-interactive installs")
	jsonOut := flag.Bool("json", false, "emit JSON result instead of (or with) prose for agents")
	noUpdateCheck := flag.Bool("no-update-check", false, "skip startup version-currency check")
	flag.Usage = printUsage
	flag.Parse()

	if *showVersion {
		fmt.Printf("deft-install %s\n", version)
		return
	}

	// If the user did not explicitly pass --branch, fall back to the
	// build-time default (if any).
	effectiveBranch := resolveBranch(*branch, defaultBranch)

	nonInt := *yes || *nonInteractive
	// --force and --allow-dirty are synonyms: either bypasses the #1458
	// default dirty-tree refusal of a dirty working tree on --upgrade.
	forceDirty := *force || *allowDirty
	code := install(*debug, effectiveBranch, *legacyLayout, nonInt, *upgrade, *repoRoot, *jsonOut, *requireClean, forceDirty, *maintainer, *noUpdateCheck)
	if runtime.GOOS == "windows" && !nonInt {
		pressEnterToExit()
	}
	if code != 0 {
		os.Exit(code)
	}
}

// install runs the full install/update workflow and returns an exit code.
// force carries the #1458 dirty-tree bypass (--force / --allow-dirty); a dirty
// working tree refuses an --upgrade by default and only force bypasses it.
// requireClean is a deprecated no-op alias kept for back-compat (#1458).
// maintainer selects the #1554 framework-checkout setup path: it validates that
// --repo-root points at this repository's source tree, reports maintainer tools,
// and skips every consumer projection so AGENTS.md / .gitignore / workflows stay
// maintainer-owned.
func install(debug bool, branch string, legacyLayout bool, nonInteractive, upgrade bool, repoRoot string, jsonOut, requireClean, force, maintainer, noUpdateCheck bool) int {
	if debug {
		fmt.Printf("[debug] OS=%s ARCH=%s\n", runtime.GOOS, runtime.GOARCH)
		fmt.Printf("[debug] defaultBranch=%s branch=%s legacyLayout=%v nonInteractive=%v upgrade=%v repoRoot=%s json=%v maintainer=%v\n", defaultBranch, branch, legacyLayout, nonInteractive, upgrade, repoRoot, jsonOut, maintainer)
	}

	var result *WizardResult
	var err error
	if nonInteractive && repoRoot != "" {
		if !updateCheckBypassed(noUpdateCheck) {
			w := NewWizardWithLayout(strings.NewReader(""), os.Stdout, debug, legacyLayout)
			if code := runInstallerUpdateCheck(w, false); code != 0 {
				return code
			}
		}
		// Fast path for agents/CI: construct result directly from --repo-root
		// without any interactive prompts. Derive project name from basename.
		absRoot, absErr := filepath.Abs(repoRoot)
		if absErr != nil {
			fmt.Fprintf(os.Stderr, "Error: resolving --repo-root %q: %v\n", repoRoot, absErr)
			return 1
		}
		result = buildNonInteractiveResult(absRoot, legacyLayout, upgrade)
		if debug {
			fmt.Printf("[debug] non-interactive fast-path: project=%s deft=%s update=%v\n", result.ProjectDir, result.DeftDir, result.Update)
		}
	} else if nonInteractive {
		if !updateCheckBypassed(noUpdateCheck) {
			w := NewWizardWithLayout(strings.NewReader(""), os.Stdout, debug, legacyLayout)
			if code := runInstallerUpdateCheck(w, false); code != 0 {
				return code
			}
		}
		// --yes without --repo-root: fall back to CWD as repo root (common for
		// agents running inside an existing project dir).
		cwd, getErr := os.Getwd()
		if getErr != nil {
			fmt.Fprintf(os.Stderr, "Error: cannot determine working directory: %v\n", getErr)
			return 1
		}
		absRoot, absErr := filepath.Abs(cwd)
		if absErr != nil {
			fmt.Fprintf(os.Stderr, "Error: resolving CWD %q: %v\n", cwd, absErr)
			return 1
		}
		result = buildNonInteractiveResult(absRoot, legacyLayout, upgrade)
		if debug {
			fmt.Printf("[debug] non-interactive cwd-fallback: project=%s deft=%s update=%v\n", result.ProjectDir, result.DeftDir, result.Update)
		}
	} else {
		w := NewWizardWithLayout(os.Stdin, os.Stdout, debug, legacyLayout)
		w.printBanner()
		if !updateCheckBypassed(noUpdateCheck) {
			if code := runInstallerUpdateCheck(w, stdinAllowsUpdateCheckPrompt()); code != 0 {
				return code
			}
		}
		result, err = w.runAfterBanner()
		if err != nil {
			if err == errUserExit {
				fmt.Println("\nGoodbye!")
				return 0
			}
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
	}

	// For non-interactive paths we never created w; create a stdout-backed
	// dummy (no scanner input expected) so downstream helpers (EnsureGit,
	// Write* ) that take *Wizard for debug printf / user feedback continue
	// to work. In full non-int + json mode we may later suppress some output.
	w := NewWizardWithLayout(strings.NewReader(""), os.Stdout, debug, legacyLayout)
	if result == nil {
		// defensive (should not happen)
		fmt.Fprintf(os.Stderr, "Error: no install result\n")
		return 1
	}

	if debug {
		fmt.Printf("[debug] project=%s deft=%s legacy=%v update=%v\n", result.ProjectDir, result.DeftDir, result.LegacyLayout, result.Update)
	}

	// Phase 3: ensure git is available.
	if err := EnsureGit(w); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}

	if maintainer {
		return installMaintainerMode(w, result, nonInteractive, upgrade, jsonOut, debug)
	}

	// #1453 Layer 1 / #1458: dirty-working-tree GATE BEFORE an --upgrade payload
	// swap. Gated on result.Update so an INITIAL install is never probed or
	// blocked. As of #1458 the DEFAULT is FAIL-LOUD: a dirty tree refuses the
	// upgrade (non-zero exit, NO payload swap) on BOTH the interactive and the
	// --yes/non-interactive paths; --force / --allow-dirty is the only bypass and
	// --require-clean is an accepted no-op alias. The probe never prompts, so the
	// --yes / CI path can never hang. In --json mode the prose advisory is routed
	// to stderr (stdout stays single-JSON-clean, #1385) and the refusal emits one
	// structured error object on stdout (error_code + dirty_files + why +
	// remediation + force_hint + warnings).
	dirtyAdv := dirtyTreeGate(result.Update, result.ProjectDir, commitHygieneOptions{requireClean: requireClean, force: force})
	advWriter := w
	if jsonOut {
		advWriter = NewWizardWithLayout(strings.NewReader(""), os.Stderr, debug, legacyLayout)
	}
	printDirtyTreeAdvisory(advWriter, dirtyAdv)
	if dirtyAdv.blocked {
		if jsonOut {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			if encErr := enc.Encode(dirtyTreeBlockResult(dirtyAdv)); encErr != nil {
				fmt.Fprintf(os.Stderr, "Warning: JSON encode failed: %v\n", encErr)
			}
		}
		return 1
	}

	// #1458: capture the pre-upgrade payload version from the existing
	// <deftDir>/VERSION manifest BEFORE the swap replaces it, so the --json
	// success result can report previous_version. Best-effort: "" when there is
	// no readable manifest (fresh install, unreadable file, no tag line).
	previousVersion := ""
	if result.Update {
		previousVersion = readInstallManifestTag(result.DeftDir)
	}

	// Phase 4: vendor or update deft. Every deposit is git-free (#1428): a fresh
	// install vendors the release tarball (VendorDeft); an --upgrade dispatches
	// via UpdateDeft, which migrates a git-clone payload to vendored, refreshes
	// an existing vendored payload via file swap, or vendors a fresh copy when
	// the payload is absent.
	var updateOutcome *UpdateOutcome
	if result.Update {
		o, err := UpdateDeft(w, result, branch)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		updateOutcome = o
	} else {
		o, err := VendorDeft(w, result, branch)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		updateOutcome = o
	}

	// #1062: stamp the canonical YAML install manifest at <deftDir>/VERSION
	// alongside VendorDeft / UpdateDeft so the framework records the
	// install_root field as the single source of truth for the install-
	// layout contract. Best-effort: a failure to resolve git provenance
	// (vendored payload, git unavailable) falls back to the resolved
	// values from the installer binary (defaultBranch + empty SHA) so the
	// manifest still carries install_root.
	installFields := resolveInstallManifestFields(result, branch)
	// #1425: on a vendored refresh, resolveInstallManifestFields() resolved the
	// SHA via `git -C <core> rev-parse HEAD`, which on a no-.git payload climbs
	// to the PARENT consumer repo's HEAD (the #1323/#1324 wrong-sha class).
	// Override with the framework source SHA/tag recovered from the release
	// tarball wrapper so the manifest records true framework provenance.
	if updateOutcome != nil && updateOutcome.Layout == payloadLayoutVendored {
		if updateOutcome.SHA != "" {
			installFields.SHA = updateOutcome.SHA
		}
		if updateOutcome.Tag != "" {
			installFields.Tag = updateOutcome.Tag
			if installFields.Ref == "" {
				installFields.Ref = updateOutcome.Tag
			}
		}
	}
	if _, err := WriteInstallManifest(result.ProjectDir, result.DeftDir, installFields); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not write install manifest: %v\n", err)
		// Non-fatal: the install proceeds, but downstream consumers (doctor,
		// sync skill) will fall back to the AGENTS.md parse for install_root.
	}

	// #1427: on an upgrade, remove an orphaned .deft/VERSION left by older
	// installer rails that wrote the manifest one level ABOVE .deft/core/. The
	// canonical manifest now lives at .deft/core/VERSION (written above), so a
	// stale .deft/VERSION would shadow it for consumers that read the parent.
	if result.Update {
		removeOrphanDeftVersion(w, result)
	}

	if err := WriteAgentsMD(w, result.ProjectDir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}

	skillsCreated, err := WriteAgentsSkills(w, result.ProjectDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}

	// Phase 4b: .gitignore upkeep (#1015 F2 canonical default mirrored from
	// scripts/relocate.py). Runs on every layout because the cache + audit
	// log are written regardless of where the framework deposit lives.
	if _, err := EnsureGitignoreLines(w, result.ProjectDir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}

	// Phase 4b2 (#1430): deposit the neutralization so the vendored framework
	// payload at .deft/core/** is treated as packaged framework assets -- not
	// consumer source -- by linguist (language stats), bot reviewers
	// (Greptile/CodeQL), and an optional CI guard. Best-effort: a deposit
	// failure (e.g. a malformed pre-existing config) warns but never aborts the
	// install, mirroring the WriteInstallManifest contract above.
	depositNeutralization(w, result.ProjectDir)

	// Phase 4c: consumer-root vbrief/ deposit (canonical contract: scope
	// vBRIEFs live at the consumer root, not inside the framework copy).
	if _, err := WriteConsumerVbrief(w, result.ProjectDir, result.DeftDir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}

	// Phase 4d (#1463): wire consumer-root git hooks. The installer copies the
	// layout-aware .githooks/ from the framework payload to the consumer root
	// and sets core.hooksPath so the #747 branch gate, #798 encoding gate, and
	// #1019 destructive-gh-verb gate actually fire in a vendored consumer
	// project. Best-effort: a wiring failure warns but never aborts the install,
	// mirroring depositNeutralization above.
	if _, err := WriteConsumerGitHooks(w, result.ProjectDir, result.DeftDir); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not wire git hooks: %v\n", err)
	}

	// Epic-4 (1338): Automatic Taskfile wiring + core tool bootstrap.
	// Only in non-interactive mode (per ACs: "in --yes mode"). Consent is
	// implied by the --yes flag; interactive consent is future (or via doctor).
	var taskfileChanged bool
	missingTools := []string{} // non-nil for consistent JSON (never null when --json even without --yes; Greptile P2)
	maintainerTools := []maintainerToolStatus{}
	if nonInteractive {
		var tfErr error
		taskfileChanged, tfErr = EnsureTaskfile(w, result.ProjectDir)
		if tfErr != nil {
			fmt.Fprintf(os.Stderr, "Warning: Taskfile wiring incomplete: %v\n", tfErr)
		}
		var toolsErr error
		missingTools, toolsErr = EnsureCoreTools(w, nonInteractive)
		if toolsErr != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", toolsErr)
			if jsonOut {
				enc := json.NewEncoder(os.Stdout)
				enc.SetIndent("", "  ")
				if encErr := enc.Encode(coreToolsBootstrapBlockResult(missingTools, toolsErr)); encErr != nil {
					fmt.Fprintf(os.Stderr, "Warning: JSON encode failed: %v\n", encErr)
				}
			}
			return 1
		}
	}

	configDir, err := CreateUserConfigDir(w)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}

	// #1453 Layer 2: scoped staging + commit guidance. After every deposit,
	// best-effort stage ONLY the framework + installer-managed paths (never
	// `git add -A`, never consumer app files) and (below) print the exact scoped
	// commit command. A staging failure is best-effort and never fails install.
	stagePaths := frameworkStagePaths(result.ProjectDir, result.DeftDir)
	staged, stageErr := stageFrameworkPaths(result.ProjectDir, stagePaths)
	if stageErr != nil && debug {
		fmt.Fprintf(os.Stderr, "[debug] scoped staging best-effort error: %v\n", stageErr)
	}

	if jsonOut {
		// Machine readable result for agents / CI (Epic-3 AC). Includes
		// actions taken for 1337/1338 so callers can react (e.g. re-invoke
		// doctor after wiring).
		//
		// #1425: payload_layout (clone|vendored|absent) and strategy
		// (git-checkout|file-swap|clone) let agents/CI see how the upgrade was
		// performed -- and confirm a vendored install used the git-free swap
		// rather than a git command against the consumer repo.
		payloadLayout := payloadLayoutAbsent
		strategy := strategyVendor
		// #1458: backup_path is the out-of-tree backup swapInCore stages before a
		// vendored file-swap / migration upgrade ("" when no swap ran, e.g. a
		// greenfield vendor) so a scripted caller can discover the rollback
		// location.
		backupPath := ""
		if updateOutcome != nil {
			payloadLayout = updateOutcome.Layout
			strategy = updateOutcome.Strategy
			backupPath = updateOutcome.Backup
		}
		// #1453: surface the commit-hygiene advisory + scoped staging so agents /
		// CI can react. Slices are non-nil for a stable JSON schema (never null).
		dirtyFiles := dirtyAdv.files
		if dirtyFiles == nil {
			dirtyFiles = []string{}
		}
		stagedOut := []string{}
		if staged {
			stagedOut = stagePaths
		}
		out := installSummary{
			result:          result,
			nonInteractive:  nonInteractive,
			upgrade:         upgrade,
			taskfileWired:   taskfileChanged,
			missingTools:    missingTools,
			maintainerTools: maintainerTools,
			configDir:       configDir,
			skillsCreated:   skillsCreated,
			payloadLayout:   payloadLayout,
			strategy:        strategy,
			dirty:           dirtyAdv.dirty,
			dirtyFiles:      dirtyFiles,
			stagedPaths:     stagedOut,
			backupPath:      backupPath,
			previousVersion: previousVersion,
		}.jsonObject()
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(out); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: JSON encode failed: %v\n", err)
		}
		// Greptile P1: PrintNextSteps prose was being written to stdout
		// immediately after the JSON object, poisoning the stream so any
		// jq / json.loads / json.Unmarshal consumer failed on trailing
		// non-JSON text. In --json mode the prose AND the doctor handoff
		// JSON are rerouted to stderr instead -- humans / log scrapers
		// still see it, stdout stays a single parseable JSON object for
		// the documented agent / CI use.
		//
		// Greptile P1 on fa03152: the doctor handoff (Epic-5 staleness
		// detection -- the central deliverable of this PR) was previously
		// skipped in --json mode because the early return below ran before
		// the doHandoffToDoctor call. Agents using `deft-install --yes
		// --json` never saw staleness verdicts. Routing the handoff to
		// stderr in --json mode keeps stdout single-JSON-clean for jq /
		// json.loads consumers while still surfacing the doctor report on
		// stderr (which agents commonly capture alongside stdout).
		wErr := NewWizardWithLayout(strings.NewReader(""), os.Stderr, debug, legacyLayout)
		PrintNextSteps(wErr, result, configDir, skillsCreated)
		printCommitGuidance(wErr, stagePaths, staged)
		doHandoffToDoctor(wErr, result, jsonOut)
		return 0
	}

	PrintNextSteps(w, result, configDir, skillsCreated)
	printCommitGuidance(w, stagePaths, staged)

	// #1339 (Epic-5): Installer → Doctor handoff + payload staleness detection.
	// The installer invokes the canonical doctor (scripts/doctor.py) with
	// --session [--json] --full at the end of every successful run. This
	// makes the handoff deterministic for agents, surfaces manifest-based
	// staleness recommendations ("run the installer again"), and keeps
	// humans/agents on the unified post-install guidance path. The --json
	// flag is forwarded only when the installer itself is in --json mode so
	// interactive humans see the doctor's prose output rather than a raw
	// JSON blob (Greptile P1 on #1384 head a7266239). The --json branch
	// above also calls doHandoffToDoctor (routed to stderr) so the Epic-5
	// staleness verdict reaches agents on every path.
	doHandoffToDoctor(w, result, jsonOut)
	return 0
}

func installMaintainerMode(w *Wizard, result *WizardResult, nonInteractive, upgrade, jsonOut, debug bool) int {
	msgWriter := w
	if jsonOut {
		msgWriter = NewWizardWithLayout(strings.NewReader(""), os.Stderr, debug, result.LegacyLayout)
	}

	if err := validateMaintainerCheckout(result.ProjectDir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		if jsonOut {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			if encErr := enc.Encode(map[string]any{
				"success":     false,
				"error_code":  "maintainer_mode_requires_framework_checkout",
				"error":       err.Error(),
				"project_dir": result.ProjectDir,
			}); encErr != nil {
				fmt.Fprintf(os.Stderr, "Warning: JSON encode failed: %v\n", encErr)
			}
		}
		return 1
	}

	missingTools := []string{}
	var toolsErr error
	if nonInteractive {
		missingTools, toolsErr = EnsureCoreTools(msgWriter, nonInteractive)
		if toolsErr != nil {
			fmt.Fprintf(os.Stderr, "Warning: tool probe: %v\n", toolsErr)
		}
	}
	maintainerTools := EnsureMaintainerTools(msgWriter)

	configDir, err := CreateUserConfigDir(msgWriter)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}

	summary := installSummary{
		result:                     result,
		nonInteractive:             nonInteractive,
		upgrade:                    upgrade,
		missingTools:               missingTools,
		maintainerMode:             true,
		maintainerTools:            maintainerTools,
		skippedConsumerProjections: skippedConsumerProjectionNames(),
		configDir:                  configDir,
		payloadLayout:              payloadLayoutAbsent,
		strategy:                   "maintainer-mode",
	}

	if jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(summary.jsonObject()); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: JSON encode failed: %v\n", err)
		}
		PrintMaintainerNextSteps(msgWriter, result, configDir)
		return 0
	}

	PrintMaintainerNextSteps(msgWriter, result, configDir)
	return 0
}

// installSummary carries the fields install() reports in the --json success
// object. Extracted from the inline map so the success-result shape -- notably
// the #1458 backup_path / previous_version additions -- is unit-testable
// without driving the full install() pipeline (network, git, doctor handoff).
type installSummary struct {
	result          *WizardResult
	nonInteractive  bool
	upgrade         bool
	taskfileWired   bool
	missingTools    []string
	maintainerTools []maintainerToolStatus
	configDir       string
	skillsCreated   bool
	payloadLayout   string // clone | vendored | absent (#1425)
	strategy        string // file-swap | vendor | clone-to-vendored (#1425)
	dirty           bool   // working tree was dirty (#1453)
	dirtyFiles      []string
	stagedPaths     []string
	backupPath      string // out-of-tree swap backup, "" when no swap ran (#1458)
	previousVersion string // pre-upgrade manifest tag, "" when unknown (#1458)

	maintainerMode             bool
	skippedConsumerProjections []string
}

// jsonObject renders the --json success result. Slice fields are normalised to
// non-nil so the JSON schema is stable (arrays never serialise as null), and
// backup_path / previous_version are always present (empty string when not
// applicable) so a scripted caller can branch on them deterministically.
func (s installSummary) jsonObject() map[string]any {
	missingTools := s.missingTools
	if missingTools == nil {
		missingTools = []string{}
	}
	dirtyFiles := s.dirtyFiles
	if dirtyFiles == nil {
		dirtyFiles = []string{}
	}
	stagedPaths := s.stagedPaths
	if stagedPaths == nil {
		stagedPaths = []string{}
	}
	maintainerTools := s.maintainerTools
	if maintainerTools == nil {
		maintainerTools = []maintainerToolStatus{}
	}
	skippedConsumerProjections := s.skippedConsumerProjections
	if skippedConsumerProjections == nil {
		skippedConsumerProjections = []string{}
	}
	return map[string]any{
		"success":                      true,
		"version":                      version,
		"project_dir":                  s.result.ProjectDir,
		"deft_dir":                     s.result.DeftDir,
		"legacy_layout":                s.result.LegacyLayout,
		"update":                       s.result.Update,
		"non_interactive":              s.nonInteractive,
		"upgrade":                      s.upgrade,
		"taskfile_wired":               s.taskfileWired,
		"missing_tools":                missingTools,
		"maintainer_mode":              s.maintainerMode,
		"maintainer_tools":             maintainerTools,
		"skipped_consumer_projections": skippedConsumerProjections,
		"user_config_dir":              s.configDir,
		"skills_created":               s.skillsCreated,
		"payload_layout":               s.payloadLayout,
		"strategy":                     s.strategy,
		"dirty_tree":                   s.dirty,
		"dirty_files":                  dirtyFiles,
		"staged_paths":                 stagedPaths,
		"backup_path":                  s.backupPath,
		"previous_version":             s.previousVersion,
	}
}

// buildNonInteractiveResult centralises the duplicated non-interactive
// fast-path / CWD-fallback logic (Greptile P2). Also centralises the
// update-detection Stat so error handling stays in one place.
func buildNonInteractiveResult(absRoot string, legacyLayout, upgrade bool) *WizardResult {
	projectName := SanitizeProjectName(filepath.Base(absRoot))
	if projectName == "" {
		projectName = "project"
	}
	deftSub := CanonicalFrameworkSubdir
	if legacyLayout {
		deftSub = LegacyFrameworkSubdir
	}
	deftDir := filepath.Join(absRoot, deftSub)
	update := upgrade
	if !update {
		if info, statErr := os.Stat(deftDir); statErr == nil && info.IsDir() {
			update = true
		} else {
			// Transient / unexpected Stat failure (permission denied, I/O
			// error, filesystem unavailable). The expected fresh-install
			// case (os.ErrNotExist) stays silent so --yes / --json runs are
			// not noisy; everything else surfaces via log.Printf so the
			// failure is visible in agent logs (SLizard P1
			// go-silent-error-branch). Experiments A+B (PR #1385): bare-else
			// + nested-if shape AND log.Printf (the literal call form SLizard's
			// recommendation text names) so the detector unambiguously sees
			// the canonical error-branch logger. log uses stderr by default
			// so the user-visible behaviour is unchanged.
			if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
				log.Printf("warning: stat %q for update detection: %v", deftDir, statErr)
			}
		}
	}
	return &WizardResult{
		ProjectName:  projectName,
		ProjectDir:   absRoot,
		DeftDir:      deftDir,
		Update:       update,
		LegacyLayout: legacyLayout,
	}
}

// resolveInstallManifestFields builds the InstallManifestFields struct the
// installer writes into <deftDir>/VERSION (#1062). The SHA is resolved via
// `git rev-parse HEAD` rooted at deftDir; failure (fresh shallow clone, git
// unavailable) falls back to an empty string so the manifest still carries
// the other fields. Ref / tag fall back to the build-time defaultBranch
// when no explicit --branch was passed.
//
// Tag is populated ONLY when the resolved ref looks like a semver release
// tag (per semverTagPattern). Branch refs (`master`, `main`, `feat/...`)
// leave Tag empty -- BuildInstallManifestText then renders `tag: ”` rather
// than nonsensical values like `vmaster` that would corrupt downstream
// consumers parsing the field as semver. Ref is still recorded verbatim so
// the manifest preserves the full provenance trail (Greptile P1 review on
// PR #1063 closing PR for #1062).
func resolveInstallManifestFields(result *WizardResult, branch string) InstallManifestFields {
	effectiveRef := branch
	if effectiveRef == "" {
		effectiveRef = defaultBranch
	}
	effectiveTag := ""
	if semverTagPattern.MatchString(effectiveRef) {
		effectiveTag = effectiveRef
	}
	sha := resolveDeftHeadSHA(result.DeftDir)
	return InstallManifestFields{
		Ref:         effectiveRef,
		SHA:         sha,
		Tag:         effectiveTag,
		InstallRoot: deriveInstallRootString(result.ProjectDir, result.DeftDir),
		FetchedAt:   time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		FetchedBy:   "deft-install",
	}
}

// resolveDeftHeadSHA runs `git -C <deftDir> rev-parse HEAD` and returns the
// trimmed output. Best-effort: returns "" on any failure (git missing,
// shallow clone with no refs, permission denied) so the install pipeline
// never crashes because of provenance resolution.
func resolveDeftHeadSHA(deftDir string) string {
	cmd := exec.Command("git", "-C", deftDir, "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// readInstallManifestTag best-effort reads the `tag:` value from the existing
// <deftDir>/VERSION manifest BEFORE an upgrade swaps the payload, so install()
// can report previous_version in the --json success result (#1458). It mirrors
// the single-quoted YAML shape BuildInstallManifestText emits and the doctor's
// manifest tag parse (TrimSpace + strip surrounding quotes). Returns "" on any
// miss -- no manifest, unreadable file, or no tag line -- since previous_version
// is advisory only and must never fail the install.
func readInstallManifestTag(deftDir string) string {
	data, err := os.ReadFile(filepath.Join(deftDir, installManifestFilename))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "tag:") {
			val := strings.TrimSpace(strings.TrimPrefix(line, "tag:"))
			return strings.TrimSpace(strings.Trim(val, "'\""))
		}
	}
	return ""
}

// removeOrphanDeftVersion deletes an orphaned <project>/.deft/VERSION left by
// older installer rails that stamped the manifest one level ABOVE the canonical
// .deft/core/VERSION (#1427). It runs ONLY for the canonical layout -- i.e.
// when the framework parent dir is named ".deft" -- so the legacy `deft/`
// layout (whose parent is the project root) can never cause the consumer's own
// root VERSION file to be removed. Best-effort: a stat miss or non-regular
// entry is a silent no-op; a removal error is surfaced as a warning only.
func removeOrphanDeftVersion(w *Wizard, result *WizardResult) {
	parent := filepath.Dir(result.DeftDir)
	if filepath.Base(parent) != ".deft" {
		return
	}
	orphan := filepath.Join(parent, installManifestFilename)
	// Never touch the manifest the installer just wrote at .deft/core/VERSION.
	if samePath(orphan, filepath.Join(result.DeftDir, installManifestFilename)) {
		return
	}
	info, err := os.Stat(orphan)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	if err := os.Remove(orphan); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not remove orphaned %s: %v\n", orphan, err)
		return
	}
	w.printf("Removed orphaned %s (the install manifest now lives at %s).\n", orphan, filepath.Join(result.DeftDir, installManifestFilename))
}

// pressEnterToExit waits for the user to press Enter before the process exits.
// This keeps the console window visible when the installer is launched by
// double-clicking the .exe, which opens a transient cmd window.
func pressEnterToExit() {
	fmt.Print("Press Enter to exit...")
	fmt.Scanln()
}
