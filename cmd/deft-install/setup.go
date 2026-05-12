package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/deftai/directive/templates"
)

// bareSemverPattern matches a bare `X.Y.Z[-pre][+build]` semver triple (no
// leading `v`). Used by BuildInstallManifestText to gate the v-prefix
// normalisation: only bare semver strings get the `v` prepended; branch refs
// or already-`v`-prefixed values pass through verbatim. Defence-in-depth
// alongside the resolver-side guard in resolveInstallManifestFields
// (Greptile P1 on PR #1063).
var bareSemverPattern = regexp.MustCompile(`^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$`)

// agentsMDEntry is the AGENTS.md body the installer writes into consumer
// projects. It is sourced from templates/agents-entry.md via //go:embed (see
// templates/embed.go) so that editing the template alone is sufficient to
// change what the installer writes -- no Go file edit required (closes #636).
// It must contain agentsMDSentinel (the v0.28 deft:managed-section v3 marker)
// for idempotency -- WriteAgentsMD checks for that string (or the v2 / pre-v0.27
// `deft/main.md` legacy sentinels) before appending (#1020, #1046 PR-B AC-5).
var agentsMDEntry = templates.AgentsEntry

const (
	deftRepoURL = "https://github.com/deftai/directive"

	// agentsMDSentinel detects an existing deft entry in AGENTS.md for the
	// idempotency probe in WriteAgentsMD. We use the v0.28 marker open token
	// (the same marker the relocator and `run agents:refresh` use) because it
	// is stable across both the canonical (`.deft/core/`) and legacy (`deft/`)
	// install layouts -- a re-run after a layout flip MUST NOT re-append.
	agentsMDSentinel = "<!-- deft:managed-section v3 -->"

	// agentsMDV2Sentinel is the v0.27 marker form retained for one release
	// cycle (v0.28 only; v0.29 deprecates v2). #1046 PR-B AC-5 bumps the
	// canonical marker to v3 with refresh provenance attributes; the v2 form
	// is still recognised here so a fresh canonical install on top of a
	// v0.27 AGENTS.md still recognises the deft entry and skips re-appending.
	agentsMDV2Sentinel = "<!-- deft:managed-section v2 -->"

	// agentsMDLegacySentinel is the pre-v0.27 idempotency marker. It is
	// retained so a fresh canonical install on top of a legacy AGENTS.md still
	// recognises the deft entry and skips re-appending (#1020).
	agentsMDLegacySentinel = "deft/main.md"

	// agentsSkillDeft is the thin pointer content for .agents/skills/deft/SKILL.md.
	agentsSkillDeft = `---
name: deft
description: Apply deft framework standards for AI-assisted development. Use when starting projects, writing code, running tests, making commits, or when the user references deft, project standards, or coding guidelines.
---

Read and follow: .deft/core/SKILL.md
`
	// agentsSkillDeftDirectiveSetup is the thin pointer for .agents/skills/deft-directive-setup/SKILL.md.
	agentsSkillDeftDirectiveSetup = `---
name: deft-directive-setup
description: >-
  Set up a new project with Deft framework standards. Use when the user wants
  to bootstrap user preferences, configure a project, or generate a project
  specification. Walks through setup conversationally — no separate CLI needed.
---

Read and follow: .deft/core/skills/deft-directive-setup/SKILL.md
`
	// agentsSkillDeftDirectiveBuild is the thin pointer for .agents/skills/deft-directive-build/SKILL.md.
	agentsSkillDeftDirectiveBuild = `---
name: deft-directive-build
description: >-
  Build a project from scope vBRIEFs following Deft framework standards.
  Use after deft-directive-setup has generated the project definition, or when
  the user has scope vBRIEFs ready to implement. Handles scaffolding,
  implementation, testing, and quality checks phase by phase.
---

Read and follow: .deft/core/skills/deft-directive-build/SKILL.md
`
	// agentsSkillDeftDirectiveReviewCycle is the thin pointer for .agents/skills/deft-directive-review-cycle/SKILL.md.
	agentsSkillDeftDirectiveReviewCycle = `---
name: deft-directive-review-cycle
description: >-
  Greptile bot reviewer response workflow. Use when running a review cycle
  on a PR — to audit process prerequisites, fetch bot findings, fix all
  issues in a single batch commit, and exit cleanly when no P0/P1 issues
  remain. Enables cloud agents to run autonomous PR review cycles.
---

Read and follow: .deft/core/skills/deft-directive-review-cycle/SKILL.md
`
	// agentsSkillDeftDirectiveRefinement is the thin pointer for .agents/skills/deft-directive-refinement/SKILL.md.
	agentsSkillDeftDirectiveRefinement = `---
name: deft-directive-refinement
description: >-
  Structured refinement workflow. Compares open GitHub issues against
  the roadmap, triages new issues one-at-a-time with human review, and updates
  the roadmap with phase placement, analysis comments, and index entries.
---

Read and follow: .deft/core/skills/deft-directive-refinement/SKILL.md
`
	// agentsSkillDeftDirectiveSwarm is the thin pointer for .agents/skills/deft-directive-swarm/SKILL.md.
	agentsSkillDeftDirectiveSwarm = `---
name: deft-directive-swarm
description: >-
  Parallel local agent orchestration. Use when running multiple agents
  on roadmap items simultaneously — to select non-overlapping tasks, set up
  isolated worktrees, launch agents with proven prompts, monitor progress,
  handle stalled review cycles, and close out PRs cleanly.
---

Read and follow: .deft/core/skills/deft-directive-swarm/SKILL.md
`
	// agentsSkillDeftDirectiveInterview is the thin pointer for .agents/skills/deft-directive-interview/SKILL.md.
	agentsSkillDeftDirectiveInterview = `---
name: deft-directive-interview
description: >-
  Deterministic structured Q&A interview skill. Use when a skill or workflow
  needs to collect structured answers from the user — one question per turn,
  numbered options, default acceptance, and a confirmation gate.
---

Read and follow: .deft/core/skills/deft-directive-interview/SKILL.md
`
	// agentsSkillDeftDirectivePrePr is the thin pointer for .agents/skills/deft-directive-pre-pr/SKILL.md.
	agentsSkillDeftDirectivePrePr = `---
name: deft-directive-pre-pr
description: >-
  Iterative pre-PR quality loop (Read-Write-Lint-Diff-Loop). Use before
  pushing a branch for PR creation — structured self-review that agents run
  to catch issues before they reach the bot reviewer.
---

Read and follow: .deft/core/skills/deft-directive-pre-pr/SKILL.md
`
	// agentsSkillDeftDirectiveSync is the thin pointer for .agents/skills/deft-directive-sync/SKILL.md.
	agentsSkillDeftDirectiveSync = `---
name: deft-directive-sync
description: >-
  Session-start framework sync skill. Use at the beginning of a session to
  pull latest framework updates, validate project files, and confirm alignment
  before starting work.
---

Read and follow: .deft/core/skills/deft-directive-sync/SKILL.md
`
)

// canonicalGitignoreLines mirrors scripts/relocate.py::GITIGNORE_LINES (the F2
// canonical default from #1015): the runtime cache directory and the audit-log
// private state. The framework deposit at .deft/core/ is INTENTIONALLY NOT
// auto-gitignored -- per #11 .deft/core/ ships read-only packaged framework
// assets that consumers commit for reproducibility.
var canonicalGitignoreLines = []string{
	".deft-cache/",
	"vbrief/.eval/",
}

// ---------------------------------------------------------------------------
// 4.0 Install manifest writer (#1062)
// ---------------------------------------------------------------------------

// installManifestFilename is the canonical filename for the install manifest
// at <install>/VERSION. Mirrors run::_INSTALL_MANIFEST_FILENAME.
const installManifestFilename = "VERSION"

// InstallManifestFields holds the provenance fields the Go installer emits
// into the canonical <install>/VERSION manifest (#1046 PR-B AC-4, #1062).
//
// All fields are strings so the YAML shape matches what oz-agent-upgrade /
// run install / run upgrade write -- the doctor and downstream consumers do
// not need to special-case the producer rail.
//
// InstallRoot is the relative POSIX-style path from the consumer project
// root to the framework deposit (e.g. ".deft/core" for canonical installs,
// "deft" for legacy state-A). It is the #1062 single-source-of-truth field
// the doctor reads instead of parsing AGENTS.md prose.
type InstallManifestFields struct {
	Ref         string // upstream ref the framework was fetched from (e.g. "v0.28.0" or "master")
	SHA         string // 40-char commit SHA of framework HEAD at fetch time
	Tag         string // tag-reference version (e.g. "v0.28.0"); leading "v" stripped for the bare derivative
	InstallRoot string // relative POSIX-style install root path (#1062)
	FetchedAt   string // ISO-8601 UTC timestamp of the install
	FetchedBy   string // rail identifier (e.g. "deft-install", "run-install", "oz-agent-upgrade")
}

// BuildInstallManifestText renders the canonical YAML provenance manifest
// text emitted by the Go installer (#1046 PR-B AC-4, #1062). Pure -- no I/O.
//
// Mirrors run::_build_install_manifest_text so consumers reading the file
// see one consistent shape regardless of which rail produced it: single-
// quoted values, ordered ref/sha/tag/install_root/fetched_at/fetched_by, and
// the v-prefixed tag-reference form for both ref and tag. Tag is normalised
// to the v-prefix when the caller passes a bare "0.X.Y"; ref defaults to
// the normalised tag when empty.
func BuildInstallManifestText(fields InstallManifestFields) string {
	effectiveTag := fields.Tag
	// Only v-prefix tags that look like a bare semver number (e.g. `0.28.0`).
	// Any other shape (branch refs the resolver missed, pre-formatted
	// `vX.Y.Z`, empty strings) is rendered verbatim so we never produce
	// `vmaster` or similar nonsense (Greptile P1 on PR #1063).
	if effectiveTag != "" && !strings.HasPrefix(effectiveTag, "v") && bareSemverPattern.MatchString(effectiveTag) {
		effectiveTag = "v" + effectiveTag
	}
	effectiveRef := fields.Ref
	if effectiveRef == "" {
		effectiveRef = effectiveTag
	}
	var b strings.Builder
	fmt.Fprintf(&b, "ref: '%s'\n", effectiveRef)
	fmt.Fprintf(&b, "sha: '%s'\n", fields.SHA)
	fmt.Fprintf(&b, "tag: '%s'\n", effectiveTag)
	fmt.Fprintf(&b, "install_root: '%s'\n", fields.InstallRoot)
	fmt.Fprintf(&b, "fetched_at: '%s'\n", fields.FetchedAt)
	fmt.Fprintf(&b, "fetched_by: '%s'\n", fields.FetchedBy)
	return b.String()
}

// deriveInstallRootString returns the POSIX-style relative install-root
// string used in the manifest's install_root field (#1062). When deftDir is
// not under projectDir (defensive case -- callers should never construct
// this) the absolute POSIX path is returned so the field is still populated.
func deriveInstallRootString(projectDir, deftDir string) string {
	rel, err := filepath.Rel(projectDir, deftDir)
	if err != nil {
		return filepath.ToSlash(deftDir)
	}
	return filepath.ToSlash(rel)
}

// WriteInstallManifest writes the canonical YAML provenance manifest at
// <deftDir>/VERSION (#1046 PR-B AC-4, #1062). Best-effort -- silently
// degrades to a no-op when fields.SHA / fields.FetchedAt are empty so the
// installer pipeline does not crash on a fresh checkout where git rev-parse
// failed; callers SHOULD pre-populate every field so the manifest carries
// full provenance.
//
// The install_root field is derived from filepath.Rel(projectDir, deftDir)
// and rendered POSIX-style so the manifest shape stays consistent on
// Windows (`.deft/core` not `.deft\\core`). Callers MUST pass the same
// projectDir / deftDir the wizard chose so the recorded path matches the
// on-disk deposit.
//
// Returns the absolute path to the written manifest file, or an empty
// string if the field set is missing required values. An OSError-class
// failure (read-only filesystem, permission denied) is returned to the
// caller so the installer can surface it; mirrors run::_write_install_manifest's
// best-effort contract while still propagating concrete filesystem errors.
func WriteInstallManifest(projectDir, deftDir string, fields InstallManifestFields) (string, error) {
	if deftDir == "" {
		return "", fmt.Errorf("WriteInstallManifest: deftDir must not be empty")
	}
	if fields.InstallRoot == "" {
		fields.InstallRoot = deriveInstallRootString(projectDir, deftDir)
	}
	body := BuildInstallManifestText(fields)
	path := filepath.Join(deftDir, installManifestFilename)
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		return "", fmt.Errorf("could not create install dir for manifest: %w", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return "", fmt.Errorf("could not write install manifest: %w", err)
	}
	return path, nil
}

// ---------------------------------------------------------------------------
// 4.1 Clone deft
// ---------------------------------------------------------------------------

// CloneDeft clones the deft repository into deftDir.
// The parent directory (projectDir) is created if it does not exist.
// If branch is non-empty the clone checks out that branch.
func CloneDeft(w *Wizard, result *WizardResult, branch string) error {
	// Ensure the project directory exists.
	if err := os.MkdirAll(result.ProjectDir, 0o755); err != nil {
		return fmt.Errorf("could not create project directory: %w", err)
	}

	args := []string{"clone"}
	if branch != "" {
		args = append(args, "--branch", branch)
		w.printf("Cloning deft (branch %s) into %s ...\n", branch, result.DeftDir)
	} else {
		w.printf("Cloning deft into %s ...\n", result.DeftDir)
	}
	args = append(args, deftRepoURL, result.DeftDir)

	if err := runCmdFunc(w.out, "git", args...); err != nil {
		w.printf("\nClone failed. Please check your internet connection and try again.\n")
		return fmt.Errorf("git clone failed: %w", err)
	}
	return nil
}

// UpdateDeft fetches the latest changes and optionally switches branch.
// Used when deft/ already exists and the user chose to update.
func UpdateDeft(w *Wizard, result *WizardResult, branch string) error {
	w.printf("Updating deft at %s ...\n", result.DeftDir)

	// Fetch latest from origin.
	if err := runCmdFunc(w.out, "git", "-C", result.DeftDir, "fetch", "origin"); err != nil {
		return fmt.Errorf("git fetch failed: %w", err)
	}

	// Switch branch if requested.
	if branch != "" {
		w.printf("Switching to branch %s ...\n", branch)
		if err := runCmdFunc(w.out, "git", "-C", result.DeftDir, "checkout", branch); err != nil {
			return fmt.Errorf("git checkout %s failed: %w", branch, err)
		}
	}

	// Pull latest changes.
	if err := runCmdFunc(w.out, "git", "-C", result.DeftDir, "pull"); err != nil {
		return fmt.Errorf("git pull failed: %w", err)
	}

	w.printf("Deft updated successfully.\n")
	return nil
}

// ---------------------------------------------------------------------------
// 4.2 Write AGENTS.md
// ---------------------------------------------------------------------------

// WriteAgentsMD creates or appends deft entries to AGENTS.md in the project
// folder. If the entries already exist the file is left unchanged (idempotent).
// Both the canonical v2 marker and the pre-v0.27 "deft/main.md" sentinel
// count as "already present" so a canonical re-install over a legacy
// AGENTS.md does NOT duplicate the entry (#1020).
func WriteAgentsMD(w *Wizard, projectDir string) error {
	path := filepath.Join(projectDir, "AGENTS.md")

	existing, err := os.ReadFile(path)
	if err == nil {
		s := string(existing)
		if strings.Contains(s, agentsMDSentinel) ||
			strings.Contains(s, agentsMDV2Sentinel) ||
			strings.Contains(s, agentsMDLegacySentinel) {
			w.printf("AGENTS.md already contains deft entries — skipping.\n")
			return nil
		}
		// Append to existing file.
		content := s
		if !strings.HasSuffix(content, "\n") {
			content += "\n"
		}
		content += "\n" + agentsMDEntry
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return fmt.Errorf("could not update AGENTS.md: %w", err)
		}
		w.printf("AGENTS.md updated with deft entries.\n")
		return nil
	}

	// File does not exist — create it.
	if err := os.WriteFile(path, []byte(agentsMDEntry), 0o644); err != nil {
		return fmt.Errorf("could not create AGENTS.md: %w", err)
	}
	w.printf("AGENTS.md created.\n")
	return nil
}

// ---------------------------------------------------------------------------
// 4.2b .gitignore upkeep -- canonical F2 default (#1015, #1020)
// ---------------------------------------------------------------------------

// EnsureGitignoreLines appends the canonical baseline (`.deft-cache/`,
// `vbrief/.eval/`) to the consumer's .gitignore if any line is missing. The
// file is created when absent. Pre-existing lines are preserved byte-for-byte.
// Mirrors scripts/relocate.py::_ensure_gitignore_lines for parity with the
// relocator (#1015 F2 canonical default). Returns true if the file was
// modified, false when no additions were needed.
func EnsureGitignoreLines(w *Wizard, projectDir string) (bool, error) {
	path := filepath.Join(projectDir, ".gitignore")
	existing := ""
	if data, err := os.ReadFile(path); err == nil {
		existing = string(data)
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("could not read .gitignore: %w", err)
	}

	present := map[string]bool{}
	scanner := bufio.NewScanner(strings.NewReader(existing))
	for scanner.Scan() {
		present[strings.TrimSpace(scanner.Text())] = true
	}

	var additions []string
	for _, line := range canonicalGitignoreLines {
		if !present[line] {
			additions = append(additions, line)
		}
	}
	if len(additions) == 0 {
		w.printf(".gitignore already covers deft-cache + vbrief eval lines — skipping.\n")
		return false, nil
	}

	var body strings.Builder
	body.WriteString(existing)
	if existing != "" && !strings.HasSuffix(existing, "\n") {
		body.WriteString("\n")
	}
	if existing != "" && !strings.HasSuffix(existing, "\n\n") {
		body.WriteString("\n")
	}
	body.WriteString("# Deft framework: ignore local-only caches and scratch directories\n")
	for _, add := range additions {
		body.WriteString(add)
		body.WriteString("\n")
	}

	if err := os.WriteFile(path, []byte(body.String()), 0o644); err != nil {
		return false, fmt.Errorf("could not write .gitignore: %w", err)
	}
	w.printf(".gitignore updated with canonical entries: %s\n", strings.Join(additions, ", "))
	return true, nil
}

// ---------------------------------------------------------------------------
// 4.2c Consumer-root vbrief/ deposit (#1020)
// ---------------------------------------------------------------------------

// vbriefReadmeBody is the placeholder vbrief.md text written at the consumer
// root when the framework copy is absent or unreadable. The framework's full
// canonical vbrief.md lives in the deposited framework tree under
// .deft/core/vbrief/vbrief.md; this stub points operators at it.
const vbriefReadmeBody = `# vbrief/ -- scope vBRIEF lifecycle workspace

This directory is your project's scope vBRIEF lifecycle workspace.

- vbrief/proposed/  -- newly proposed scope vBRIEFs
- vbrief/pending/   -- accepted, awaiting activation
- vbrief/active/    -- in-flight implementation work
- vbrief/completed/ -- merged / shipped
- vbrief/cancelled/ -- closed without merge

Schemas: vbrief/schemas/ (mirrored from the framework copy at install time).
Reference template: .deft/core/vbrief/vbrief.md

Do not commit vbrief/.eval/ -- it is the local audit-log private state and
is covered by the canonical .gitignore baseline deposited by deft-install.
`

// WriteConsumerVbrief deposits a consumer-side `vbrief/` workspace at the
// project root containing `vbrief/schemas/` and a `vbrief/vbrief.md` template.
// Schemas are copied from the freshly-deposited framework copy at
// `<deftDir>/vbrief/schemas/` so the consumer's schema files stay in lockstep
// with the framework version they installed. If the framework copy is missing
// for any reason the function falls back to creating the directories with a
// placeholder README so the deposit is observable to downstream tooling and
// to the conformance audit (#1020).
func WriteConsumerVbrief(w *Wizard, projectDir, deftDir string) (bool, error) {
	consumerVbrief := filepath.Join(projectDir, "vbrief")
	schemasDst := filepath.Join(consumerVbrief, "schemas")
	vbriefMDDst := filepath.Join(consumerVbrief, "vbrief.md")

	schemasPresent := false
	if info, err := os.Stat(schemasDst); err == nil && info.IsDir() {
		schemasPresent = true
	}
	vbriefMDPresent := false
	if info, err := os.Stat(vbriefMDDst); err == nil && info.Mode().IsRegular() {
		vbriefMDPresent = true
	}
	if schemasPresent && vbriefMDPresent {
		w.printf("vbrief/ already present at project root — skipping.\n")
		return false, nil
	}

	if err := os.MkdirAll(consumerVbrief, 0o755); err != nil {
		return false, fmt.Errorf("could not create vbrief/: %w", err)
	}

	// Copy schemas from the framework deposit when available.
	if !schemasPresent {
		fwSchemas := filepath.Join(deftDir, "vbrief", "schemas")
		if info, err := os.Stat(fwSchemas); err == nil && info.IsDir() {
			if err := copyDir(fwSchemas, schemasDst); err != nil {
				return false, fmt.Errorf("could not seed vbrief/schemas/: %w", err)
			}
		} else {
			// Fallback: at least create the directory so downstream tooling
			// (and the conformance audit) observes the deposit shape.
			if err := os.MkdirAll(schemasDst, 0o755); err != nil {
				return false, fmt.Errorf("could not create vbrief/schemas/: %w", err)
			}
		}
	}

	if !vbriefMDPresent {
		fwVbriefMD := filepath.Join(deftDir, "vbrief", "vbrief.md")
		if data, err := os.ReadFile(fwVbriefMD); err == nil {
			if err := os.WriteFile(vbriefMDDst, data, 0o644); err != nil {
				return false, fmt.Errorf("could not write vbrief/vbrief.md: %w", err)
			}
		} else {
			if err := os.WriteFile(vbriefMDDst, []byte(vbriefReadmeBody), 0o644); err != nil {
				return false, fmt.Errorf("could not write vbrief/vbrief.md: %w", err)
			}
		}
	}

	w.printf("vbrief/ deposited at project root (schemas + vbrief.md).\n")
	return true, nil
}

// copyDir recursively copies src into dst. Intermediate directories are
// created with mode 0o755; files keep their source bytes. Used by
// WriteConsumerVbrief to seed schemas from the framework deposit.
func copyDir(src, dst string) error {
	return filepathWalk(src, func(srcPath string, isDir bool) error {
		rel, err := filepath.Rel(src, srcPath)
		if err != nil {
			return err
		}
		dstPath := filepath.Join(dst, rel)
		if isDir {
			return os.MkdirAll(dstPath, 0o755)
		}
		if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
			return err
		}
		return copyFile(srcPath, dstPath)
	})
}

// filepathWalk is a thin wrapper over filepath.WalkDir restricted to the
// (path, isDir) callback shape copyDir needs. Keeping it tiny avoids pulling
// fs.DirEntry into copyDir's body.
func filepathWalk(root string, fn func(string, bool) error) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return fn(path, d.IsDir())
	})
}

// copyFile copies src into dst, capturing close errors so a silent-truncation
// scenario (e.g. full-disk where io.Copy completes via the OS page cache but
// the underlying flush at Close() fails) surfaces to the caller rather than
// being swallowed by a bare `defer out.Close()`. The named return `err` lets
// the deferred close-error override a nil return when io.Copy succeeded.
func copyFile(src, dst string) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	return copyStream(in, out)
}

// copyStream is the I/O orchestration half of copyFile, split out so the
// close-error propagation path is testable without filesystem trickery
// (a fake io.WriteCloser whose Close returns an error suffices). The named
// return `err` lets the deferred Close error override a nil io.Copy return.
func copyStream(in io.Reader, out io.WriteCloser) (err error) {
	defer func() {
		if cerr := out.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}()
	_, err = io.Copy(out, in)
	return err
}

// ---------------------------------------------------------------------------
// 4.3 Write .agents/skills/ thin pointer files
// ---------------------------------------------------------------------------

// WriteAgentsSkills creates the .agents/skills/ discovery structure in the
// project root so AI agents auto-discover deft skills without user prompting.
// Each skill gets its own subdirectory with a thin SKILL.md pointer that
// redirects agents to the canonical skill files inside deft/.
// Idempotent — skips only when all skill files are present.
// Returns true if files were created, false if skipped.
func WriteAgentsSkills(w *Wizard, projectDir string) (bool, error) {
	// All skills that the installer creates thin pointers for.
	allSkillNames := []string{
		"deft", "deft-directive-setup", "deft-directive-build",
		"deft-directive-review-cycle", "deft-directive-refinement", "deft-directive-swarm",
		"deft-directive-interview", "deft-directive-pre-pr", "deft-directive-sync",
	}

	// Check all skill files before deciding to skip.
	allExist := true
	for _, skill := range allSkillNames {
		p := filepath.Join(projectDir, ".agents", "skills", skill, "SKILL.md")
		if _, err := os.Stat(p); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return false, fmt.Errorf("could not check %s: %w", p, err)
			}
			allExist = false
			break
		}
	}
	if allExist {
		w.printf(".agents/skills/ already present — skipping.\n")
		return false, nil
	}

	skills := []struct {
		dir     string
		content string
	}{
		{"deft", agentsSkillDeft},
		{"deft-directive-setup", agentsSkillDeftDirectiveSetup},
		{"deft-directive-build", agentsSkillDeftDirectiveBuild},
		{"deft-directive-review-cycle", agentsSkillDeftDirectiveReviewCycle},
		{"deft-directive-refinement", agentsSkillDeftDirectiveRefinement},
		{"deft-directive-swarm", agentsSkillDeftDirectiveSwarm},
		{"deft-directive-interview", agentsSkillDeftDirectiveInterview},
		{"deft-directive-pre-pr", agentsSkillDeftDirectivePrePr},
		{"deft-directive-sync", agentsSkillDeftDirectiveSync},
	}

	for _, skill := range skills {
		dir := filepath.Join(projectDir, ".agents", "skills", skill.dir)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return false, fmt.Errorf("could not create %s: %w", dir, err)
		}
		path := filepath.Join(dir, "SKILL.md")
		if _, err := os.Stat(path); err == nil {
			continue // already present — leave as-is
		}
		if err := os.WriteFile(path, []byte(skill.content), 0o644); err != nil {
			return false, fmt.Errorf("could not write %s: %w", path, err)
		}
	}

	w.printf(".agents/skills/ created — deft skills will be auto-discovered.\n")
	return true, nil
}

// ---------------------------------------------------------------------------
// 4.4 Create USER.md config directory
// ---------------------------------------------------------------------------

// UserConfigDir returns the platform-appropriate deft config directory.
//
// Windows:    %APPDATA%\deft\
// macOS/Linux: ~/.config/deft/
// Override:    DEFT_USER_PATH env var
func UserConfigDir() string {
	if p := os.Getenv("DEFT_USER_PATH"); p != "" {
		return p
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("APPDATA"), "deft")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "deft")
}

// CreateUserConfigDir ensures the user config directory exists.
// If USER.md already exists inside it, a note is printed but no error is returned.
func CreateUserConfigDir(w *Wizard) (string, error) {
	dir := UserConfigDir()

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("could not create config directory %s: %w", dir, err)
	}

	userMD := filepath.Join(dir, "USER.md")
	if _, err := os.Stat(userMD); err == nil {
		w.printf("USER.md already exists at %s — keeping existing file.\n", userMD)
	}

	return dir, nil
}

// ---------------------------------------------------------------------------
// 4.5 Print next steps
// ---------------------------------------------------------------------------

// PrintNextSteps displays the success banner and post-install instructions.
func PrintNextSteps(w *Wizard, result *WizardResult, configDir string, skillsCreated bool) {
	skillsStatus := "already present"
	if skillsCreated {
		skillsStatus = "created"
	}
	w.printf("\n✓ Deft installed successfully!\n\n")
	w.printf("  Location     : %s%c\n", result.DeftDir, os.PathSeparator)
	w.printf("  AGENTS.md    : updated\n")
	w.printf("  Skills       : .agents/skills/ %s (auto-discovered by AI agents)\n", skillsStatus)
	w.printf("  User config  : %s%c\n", configDir, os.PathSeparator)
	w.printf("\nNext steps:\n")
	w.printf("  1. Open your AI coding assistant in %s%c\n", result.ProjectDir, os.PathSeparator)
	w.printf("  2. Deft skill auto-discovery is partially implemented — if your agent doesn't\n")
	w.printf("     start setup automatically, tell it: \"Use AGENTS.md\"\n")
	w.printf("  3. On first session, the agent will guide you through creating USER.md and PROJECT-DEFINITION.vbrief.json\n")
	w.printf("\n")
}
