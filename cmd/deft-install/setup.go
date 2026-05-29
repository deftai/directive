package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
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

	// agentsMDFenceClose is the closing marker for the deft-managed section.
	// The v0.28 v3 template (templates/agents-entry.md) fences its body with
	// agentsMDSentinel ... agentsMDFenceClose so WriteAgentsMD can surgically
	// replace the managed slice without disturbing operator-authored prose
	// elsewhere in AGENTS.md (#1060 cross-layout rewrite).
	agentsMDFenceClose = "<!-- /deft:managed-section -->"

	// agentsMDV2Sentinel is the v0.27 marker form retained for one release
	// cycle (v0.28 only; v0.29 deprecates v2). #1046 PR-B AC-5 bumps the
	// canonical marker to v3 with refresh provenance attributes; the v2 form
	// is still recognised here so a fresh canonical install on top of a
	// v0.27 AGENTS.md still recognises the deft entry.
	agentsMDV2Sentinel = "<!-- deft:managed-section v2 -->"

	// agentsMDLegacySentinel is the pre-v0.27 idempotency marker. It still
	// participates in detection so a fresh canonical install on top of a
	// pre-v0.27 AGENTS.md recognises the deft entry, but per #1060 it no
	// longer triggers a skip when the install layout disagrees with the body --
	// the legacy body advertises `deft/main.md` while a canonical install is
	// depositing at `.deft/core/`, and silently skipping leaves the consumer
	// in cross-layout drift the framework:doctor probe (#1046 PR-B AC-3)
	// then flags. WriteAgentsMD now rewrites the managed block in that case.
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

// minimalTaskfileContent is the canonical starter Taskfile.yml written (or
// used as the include-append source) by the installer in --yes /
// non-interactive mode (Epic-4). It provides the supported consumer include
// pattern so `task` from project root immediately resolves all deft:* tasks.
// The `optional: true` prevents load failure before the framework is present.
// This is intentionally a small, stable string (no new embed file) so the
// Go installer binary stays self-contained.
const minimalTaskfileContent = `version: '3'

# Taskfile for this project.
# Installed by deft-install --yes (Epic-4). Add your own tasks below or in
# additional included files. The deft include makes all framework tasks
# (task check, task vbrief:*, task doctor, etc.) available from the project root.

includes:
  deft:
    taskfile: ./.deft/core/Taskfile.yml
    optional: true
`

// canonicalTaskfileIncludeFragment is the exact string we search for to
// decide whether a consumer Taskfile already wires the deft include. Used
// by EnsureTaskfile for idempotent "add if missing" in --yes mode.
const canonicalTaskfileIncludeFragment = "taskfile: ./.deft/core/Taskfile.yml"

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

// canonicalInstallRootPOSIX is the POSIX-style canonical install root the
// embedded templates.AgentsEntry body is keyed to. Used by renderAgentsEntry
// to detect when a path substitution is needed for legacy installs and by
// agentsMDLayoutClaim to build the layout-specific body claim.
const canonicalInstallRootPOSIX = ".deft/core"

// renderAgentsEntry returns the v3 AGENTS.md managed-section body with paths
// rewritten to match the install layout the installer is depositing at. The
// embedded templates.AgentsEntry body is authored against `.deft/core/`
// (the v0.27+ canonical layout); for the legacy `deft/` layout (`--legacy-layout`),
// every `.deft/core/` prefix in the body is rewritten to `<installRoot>/` so the
// written AGENTS.md matches the on-disk deposit.
//
// installRoot is expected to be the POSIX-style relative install path the
// installer chose for the current run (e.g. ".deft/core" or "deft"). An empty
// string falls back to the canonical body unchanged.
func renderAgentsEntry(installRoot string) string {
	posix := filepath.ToSlash(installRoot)
	if posix == "" || posix == canonicalInstallRootPOSIX {
		return agentsMDEntry
	}
	return strings.ReplaceAll(agentsMDEntry, canonicalInstallRootPOSIX+"/", posix+"/")
}

// agentsMDLayoutClaim returns the layout-specific body claim used by the
// idempotency probe in WriteAgentsMD. The v3 template's lead sentence is
// `Deft is installed in <installRoot>/.` -- when an existing AGENTS.md
// carries the v3 marker AND this claim, the body's install root matches the
// one the installer is depositing into and the file is up-to-date.
func agentsMDLayoutClaim(installRoot string) string {
	posix := filepath.ToSlash(installRoot)
	return "Deft is installed in " + posix + "/."
}

// detectAgentsMDLayoutLabel inspects the existing AGENTS.md body for a
// recognisable install-root claim and returns a short label suitable for the
// installer log when a rewrite fires. The order matches the supported
// layouts: canonical `.deft/core` -> legacy `deft` -> unknown (the file
// carries a deft sentinel but no body claim we can pin to a layout).
func detectAgentsMDLayoutLabel(body string) string {
	for _, candidate := range []string{canonicalInstallRootPOSIX, LegacyFrameworkSubdir} {
		if strings.Contains(body, agentsMDLayoutClaim(candidate)) {
			return candidate
		}
	}
	if strings.Contains(body, agentsMDLegacySentinel) {
		return "deft (pre-v0.27)"
	}
	return "unknown"
}

// agentsMDManagedSlice returns the substring of body between the first v3 or
// v2 open marker and the matching closing fence (inclusive of the close fence
// bytes). Returns (slice, true) when a fenced managed section is found, or
// ("", false) when no fenced block is detected (pre-v0.27 unfenced legacy
// body, or no deft sentinel at all). Used by WriteAgentsMD to scope the
// idempotency probe to the managed slice ONLY (Greptile P1 #1066: file-wide
// claim check could produce a false skip when operator-authored prose
// outside the fence contains the layout claim while the managed block stays
// stale).
func agentsMDManagedSlice(body string) (string, bool) {
	for _, openMarker := range []string{agentsMDSentinel, agentsMDV2Sentinel} {
		idx := strings.Index(body, openMarker)
		if idx < 0 {
			continue
		}
		closeOff := strings.Index(body[idx:], agentsMDFenceClose)
		if closeOff < 0 {
			continue
		}
		closeIdx := idx + closeOff + len(agentsMDFenceClose)
		return body[idx:closeIdx], true
	}
	return "", false
}

// rewriteAgentsMDBlock replaces the deft-managed section inside body with the
// rendered replacement and returns (newBody, surgical). When the section is
// fenced by a v2/v3 open marker AND the closing marker, only the fenced range
// is rewritten (`surgical=true`) so any operator prose outside the managed
// section is preserved verbatim. The pre-v0.27 layout has no closing fence,
// so when only the unfenced legacy sentinel is present the entire file is
// replaced with the replacement (`surgical=false`); the legacy body has no
// reliable terminator the installer can detect, and leaving stale legacy
// prose alongside the new canonical body would itself produce the kind of
// cross-layout drift #1060 closes.
//
// When the replacement already ends in a newline AND the byte immediately
// after the closing fence is also a newline, one trailing newline is
// consumed from body so repeated surgical rewrites don't accumulate blank
// lines at the boundary (Greptile P1 #1066: cosmetic drift across upgrades).
func rewriteAgentsMDBlock(body, replacement string) (string, bool) {
	for _, openMarker := range []string{agentsMDSentinel, agentsMDV2Sentinel} {
		idx := strings.Index(body, openMarker)
		if idx < 0 {
			continue
		}
		closeOff := strings.Index(body[idx:], agentsMDFenceClose)
		if closeOff < 0 {
			continue
		}
		closeIdx := idx + closeOff + len(agentsMDFenceClose)
		if strings.HasSuffix(replacement, "\n") && closeIdx < len(body) && body[closeIdx] == '\n' {
			closeIdx++
		}
		return body[:idx] + replacement + body[closeIdx:], true
	}
	return replacement, false
}

// WriteAgentsMD creates, rewrites, or appends the deft managed section in
// AGENTS.md so the file always advertises the install root the installer is
// depositing at. Layout-aware sentinel logic (#1060):
//
//   - AGENTS.md absent              -> write the layout-correct v3 body.
//   - v3 marker AND matching claim  -> skip (file is up-to-date).
//   - v3 marker but foreign layout  -> surgically rewrite the managed block
//     to the layout-correct v3 body (preserving operator prose outside the
//     fence).
//   - v2 marker (pre-v0.28)         -> surgically rewrite to v3.
//   - pre-v0.27 legacy sentinel     -> rewrite the entire file to the
//     layout-correct v3 body (the legacy body is unfenced so a surgical
//     replacement is not safe -- see rewriteAgentsMDBlock).
//   - no deft sentinel at all       -> append the layout-correct v3 body to
//     the existing file (preserves the operator's pre-existing AGENTS.md).
//
// The install root is derived from the Wizard's selected framework subdir
// (the same value the deposit path uses) and normalised to POSIX form so the
// AGENTS.md body never carries Windows backslashes regardless of host OS.
func WriteAgentsMD(w *Wizard, projectDir string) error {
	installRoot := filepath.ToSlash(w.frameworkSubdir())
	path := filepath.Join(projectDir, "AGENTS.md")
	body := renderAgentsEntry(installRoot)

	existing, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("could not read AGENTS.md: %w", err)
		}
		// File does not exist — create it.
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			return fmt.Errorf("could not create AGENTS.md: %w", err)
		}
		w.printf("AGENTS.md created.\n")
		return nil
	}

	s := string(existing)
	expectedClaim := agentsMDLayoutClaim(installRoot)
	hasV3 := strings.Contains(s, agentsMDSentinel)
	hasV2 := strings.Contains(s, agentsMDV2Sentinel)
	hasLegacy := strings.Contains(s, agentsMDLegacySentinel)

	// Scope the layout-claim probe to the fenced managed slice when one
	// exists -- operator-authored prose OUTSIDE the fence that happens to
	// contain the claim string (e.g. a documentation callout copy-quoting
	// the rendered template) MUST NOT mask a stale claim inside the managed
	// block (Greptile P1 #1066: file-wide claim check could produce a false
	// skip). When no fence exists (pre-v0.27 unfenced legacy body), the
	// full-file probe is the correct surface -- there is no narrower slice
	// the installer can isolate, and the unfenced legacy body always
	// triggers a whole-file rewrite below regardless of hasClaim.
	probe := s
	if slice, ok := agentsMDManagedSlice(s); ok {
		probe = slice
	}
	hasClaim := strings.Contains(probe, expectedClaim)

	// Up-to-date: v3 marker AND body advertises the install root we are
	// depositing at. This is the only happy-path that may legitimately skip
	// the rewrite per the #1060 layout-aware contract.
	if hasV3 && hasClaim {
		w.printf("AGENTS.md already advertises install root %s — skipping.\n", installRoot)
		return nil
	}

	// Any deft sentinel present but body is stale (older marker) or pointing
	// at a foreign layout: rewrite to the layout-correct v3 body so the
	// installer never leaves the consumer in the cross-layout drift the
	// framework:doctor probe would flag (#1060).
	if hasV3 || hasV2 || hasLegacy {
		newBody, surgical := rewriteAgentsMDBlock(s, body)
		if err := os.WriteFile(path, []byte(newBody), 0o644); err != nil {
			return fmt.Errorf("could not rewrite AGENTS.md: %w", err)
		}
		oldLabel := detectAgentsMDLayoutLabel(s)
		scope := "managed section"
		if !surgical {
			scope = "file (legacy pre-v0.27 layout had no closing fence)"
		}
		w.printf("[deft-install] rewriting AGENTS.md %s from layout %s -> %s\n", scope, oldLabel, installRoot)
		return nil
	}

	// No deft sentinel — append to existing operator prose.
	content := s
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += "\n" + body
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fmt.Errorf("could not update AGENTS.md: %w", err)
	}
	w.printf("AGENTS.md updated with deft entries.\n")
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

// hasTopLevelIncludes reports whether the provided Taskfile content declares
// a top-level "includes:" key. Used by EnsureTaskfile to decide whether to
// extend an existing block or emit a fresh one (P1 fix for silent data loss
// of user includes under duplicate top-level keys).
func hasTopLevelIncludes(content string) bool {
	if content == "" {
		return false
	}
	norm := "\n" + strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	if strings.Contains(norm, "\nincludes:") {
		return true
	}
	// Also handle file that starts with the key (no leading newline)
	trimmed := strings.TrimLeft(content, " \t\r\n")
	return strings.HasPrefix(trimmed, "includes:")
}

// deftIncludeChildBlock is the canonical 2-space-indented YAML fragment for
// the deft include entry, formatted as a CHILD of an existing top-level
// `includes:` mapping (no leading `includes:` line). The leading `# Added by
// deft-install --yes (Epic-4)` comment is rendered at indent 2 so it lives
// inside the includes block instead of accidentally landing at top level
// (top-level YAML comments are fine, but co-locating with the entry keeps
// the audit trail next to the inserted block when operators read the file).
const deftIncludeChildBlock = "  # Added by deft-install --yes (Epic-4)\n" +
	"  deft:\n" +
	"    taskfile: ./.deft/core/Taskfile.yml\n" +
	"    optional: true\n"

// insertDeftIncludeAfterIncludesLine scans `content` for the first top-level
// `includes:` line (indent 0, end-of-line or comment-only trailing content)
// and inserts the canonical deft entry as the FIRST CHILD of that block --
// immediately after the `includes:` line, before any pre-existing children.
//
// This closes the Greptile P0 (PR #1385 review): the previous EnsureTaskfile
// implementation appended the deft entry at EOF, so a Taskfile shaped like
//
//	includes:
//	  myapp: ./myapp/Taskfile.yml
//	tasks:
//	  hello:
//	    cmds: [echo hi]
//
// would have the appended `  deft:` block land under `tasks:` (YAML indent-
// scope rule: a 2-space-indented key under the last opened mapping), wiring
// deft into the wrong block. The installer would still report
// `taskfile_wired:true` but go-task would silently ignore the entry.
//
// Inserting as the FIRST CHILD of `includes:` is always structurally correct
// regardless of what other top-level keys (`tasks:` / `vars:` / `env:`) come
// after the `includes:` block, and regardless of whether the block was
// previously empty or already had children.
//
// Returns (newContent, true) on a successful insertion, (content, false) when
// no top-level `includes:` line could be located -- callers fall back to
// emitting a fresh `includes:` block at EOF in that case.
//
// Line-ending preservation: the helper normalises CR-LF to LF for the scan,
// inserts LF-terminated bytes, and Go's `os.WriteFile` keeps the result LF-
// only. The legacy code path already wrote LF unconditionally; this helper
// preserves that behaviour byte-for-byte on LF-native files and converts a
// CR-LF input to LF on disk (a deliberate normalisation, not a regression --
// the prior code's `body.WriteString(existing)` also propagated whatever the
// reader returned, which on Windows with `os.ReadFile` is the on-disk bytes).
func insertDeftIncludeAfterIncludesLine(content string) (string, bool) {
	if content == "" {
		return content, false
	}
	norm := strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	lines := strings.Split(norm, "\n")
	for i, line := range lines {
		// Top-level `includes:` line:
		//  - indent 0 (no leading whitespace),
		//  - the literal token `includes:`,
		//  - optional whitespace / inline comment after the colon.
		// Anything else (commented-out `# includes:`, indented `  includes:`
		// inside another mapping, an `includes:`-prefixed key like
		// `includes_v2:`) is ignored.
		if len(line) == 0 || line[0] == ' ' || line[0] == '\t' {
			continue
		}
		trimmed := strings.TrimRight(line, " \t")
		if trimmed == "includes:" {
			// Found the top-level includes: line. Insert the deft block
			// immediately after it (becomes the first child of includes).
			out := make([]string, 0, len(lines)+4)
			out = append(out, lines[:i+1]...)
			out = append(out, strings.Split(strings.TrimRight(deftIncludeChildBlock, "\n"), "\n")...)
			out = append(out, lines[i+1:]...)
			return strings.Join(out, "\n"), true
		}
		// Tolerate inline comment forms like `includes:  # main app includes`.
		if strings.HasPrefix(trimmed, "includes:") && len(trimmed) > len("includes:") {
			rest := strings.TrimLeft(trimmed[len("includes:"):], " \t")
			if strings.HasPrefix(rest, "#") {
				out := make([]string, 0, len(lines)+4)
				out = append(out, lines[:i+1]...)
				out = append(out, strings.Split(strings.TrimRight(deftIncludeChildBlock, "\n"), "\n")...)
				out = append(out, lines[i+1:]...)
				return strings.Join(out, "\n"), true
			}
		}
	}
	return content, false
}

// EnsureTaskfile ensures a usable root Taskfile.yml exists and (in --yes /
// non-interactive mode) wires the canonical deft include so `task`
// subcommands from the project root resolve into the framework.
//   - If no Taskfile.yml: writes the minimal one (version + deft include).
//   - If exists and lacks the deft include fragment: structurally inserts
//     the deft entry as the FIRST CHILD of the top-level `includes:` block
//     when one exists, OR appends a fresh `includes:` block at EOF when it
//     does not. Pre-existing content is preserved.
//   - Idempotent: no-op if already wired.
//
// Called only for nonInteractive flows per Epic-4 ACs. Returns true if
// the file was created or modified.
//
// Greptile P0 (PR #1385 review): the previous EnsureTaskfile appended the
// deft entry at EOF on the "has top-level includes:" path, which caused
// silent mis-wiring on Taskfiles shaped like `includes:\n  ...\ntasks:\n`
// (the appended `  deft:` block landed under `tasks:`, not `includes:`).
// insertDeftIncludeAfterIncludesLine now performs a structural insertion
// that is correct regardless of what other top-level keys come after
// `includes:`.
func EnsureTaskfile(w *Wizard, projectDir string) (bool, error) {
	path := filepath.Join(projectDir, "Taskfile.yml")
	existing := ""
	if data, err := os.ReadFile(path); err == nil {
		existing = string(data)
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("could not read Taskfile.yml: %w", err)
	}

	if strings.Contains(existing, canonicalTaskfileIncludeFragment) {
		w.printf("Taskfile.yml already includes deft — skipping wiring.\n")
		return false, nil
	}

	var resultText string
	modified := false
	if existing == "" {
		// No Taskfile: create minimal from const.
		resultText = minimalTaskfileContent
		modified = true
		w.printf("Created minimal Taskfile.yml with deft include (Epic-4).\n")
	} else if hasTopLevelIncludes(existing) {
		// Existing top-level includes: structurally insert deft as the first
		// child so it cannot land under a sibling top-level key like tasks:
		// or vars: when other top-level keys follow includes:.
		inserted, ok := insertDeftIncludeAfterIncludesLine(existing)
		if !ok {
			// hasTopLevelIncludes returned true but the scanner could not
			// locate the line shape we recognise (e.g. CR-LF round-trip
			// artefact or an unanticipated comment form). Fall back to the
			// safe append-fresh-includes-block path -- this still produces a
			// valid Taskfile (go-task tolerates two top-level mappings only
			// when they are unique keys; duplicate `includes:` is undefined,
			// so we annotate the appended block with a manual-merge hint).
			inserted = existing
			if !strings.HasSuffix(inserted, "\n") {
				inserted += "\n"
			}
			inserted += "\n# deft-install --yes (Epic-4): could not locate " +
				"the existing top-level `includes:` line for structural " +
				"insertion; appended a fresh block. Manual merge recommended.\n" +
				"includes:\n" +
				"  deft:\n" +
				"    taskfile: ./.deft/core/Taskfile.yml\n" +
				"    optional: true\n"
			w.printf("Appended fresh `includes:` block to Taskfile.yml -- " +
				"top-level includes: detected but structural insertion fell " +
				"through; manual merge recommended.\n")
		} else {
			w.printf("Inserted deft entry inside existing `includes:` block in Taskfile.yml (Epic-4).\n")
		}
		resultText = inserted
		modified = true
	} else {
		// No top-level includes: in the existing file. Safe to append a
		// fresh block at EOF.
		var body strings.Builder
		body.WriteString(existing)
		if !strings.HasSuffix(existing, "\n") {
			body.WriteString("\n")
		}
		body.WriteString("\n# Added by deft-install --yes (Epic-4)\n")
		body.WriteString("includes:\n")
		body.WriteString("  deft:\n")
		body.WriteString("    taskfile: ./.deft/core/Taskfile.yml\n")
		body.WriteString("    optional: true\n")
		resultText = body.String()
		modified = true
		w.printf("Appended new `includes:` block with deft entry to Taskfile.yml (Epic-4).\n")
	}

	if modified {
		if err := os.WriteFile(path, []byte(resultText), 0o644); err != nil {
			return false, fmt.Errorf("could not write Taskfile.yml: %w", err)
		}
	}
	return modified, nil
}

// EnsureCoreTools probes for the four canonical toolchain binaries required
// for full Deft operation (uv, go-task as "task", Python, gh). In
// non-interactive/--yes mode it reports missing ones with clear manual
// fallbacks (Epic-4) without attempting privileged installs (UAC/sudo
// concerns addressed by documentation + delegation to setup_*.ps1 / winget).
// Returns the list of missing tools (for JSON result) as a non-nil slice
// (empty when none missing) for stable JSON emission.
func EnsureCoreTools(w *Wizard, nonInteractive bool) ([]string, error) {
	candidates := map[string][]string{
		"task":   {"task"},
		"uv":     {"uv"},
		"python": {"python", "python3"},
		"gh":     {"gh"},
	}
	var missing []string
	for name, alts := range candidates {
		found := false
		for _, a := range alts {
			if _, err := exec.LookPath(a); err == nil {
				found = true
				break
			} else {
				// Surface non-ENOENT LookPath failures (permission denied,
				// stat error on an entry in PATH, etc.) so agent logs carry
				// the trace instead of silently treating the alt as missing.
				// ErrNotFound is the expected "not on PATH" case and stays
				// silent (SLizard P1 go-silent-error-branch). Experiments A+B
				// (PR #1385): bare-else + nested-if shape AND log.Printf (the
				// literal call form SLizard's recommendation text names) so
				// the detector unambiguously sees the canonical error-branch
				// logger. log uses stderr by default so the user-visible
				// behaviour is unchanged.
				if !errors.Is(err, exec.ErrNotFound) {
					log.Printf("warning: LookPath %q: %v", a, err)
				}
			}
		}
		if !found {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		w.printf("Core tools present: task, uv, python, gh.\n")
		return []string{}, nil
	}
	sort.Strings(missing) // deterministic JSON output regardless of map iteration (Greptile P2)
	w.printf("Missing core tools (consent implied by --yes): %s\n", strings.Join(missing, ", "))
	w.printf("  Fallbacks (run manually or via platform package manager):\n")
	w.printf("    Windows: winget install --id <ID> or scripts/setup_windows.ps1\n")
	w.printf("    macOS:   brew install go-task uv python gh\n")
	w.printf("    Linux:   apt/brew equivalent for task uv python3 gh\n")
	w.printf("  See docs/getting-started.md and QUICK-START.md for details.\n")
	return missing, nil
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

// vbriefLifecycleDirs is the canonical v0.20 layout of scope-vBRIEF lifecycle
// subdirectories the consumer's `vbrief/` workspace must carry on a fresh
// install. The deft-directive-setup skill's pre-cutover condition 3 -- see
// `skills/deft-directive-setup/SKILL.md:32` and `main.md:159` for the
// canonical text -- fires when `./vbrief/` exists but any of the five
// lifecycle subfolders is missing. AGENTS.md does NOT enumerate this
// condition; the canonical source lives in the skill body and main.md.
// #1179 reverses the #1020 4g "do not pre-create" contract and has the Go
// installer create all five on first deposit so the guard stays silent on a
// fresh install.
//
// Order matches the canonical narrative (proposed -> pending -> active ->
// completed -> cancelled) and is intentionally stable so doctor / conformance
// surfaces can iterate it deterministically.
var vbriefLifecycleDirs = []string{
	"proposed",
	"pending",
	"active",
	"completed",
	"cancelled",
}

// vbriefLifecycleGitkeepBody is the placeholder content written into each
// empty lifecycle directory's `.gitkeep` so the empty directories survive
// `git add` / `tar` / installer packaging. Mirrors the `.gitkeep` convention
// used elsewhere in the framework deposit. Body is documented for grepability
// (#1179) and small enough to round-trip cleanly through any packaging tool.
const vbriefLifecycleGitkeepBody = `# This file keeps the lifecycle directory present in version control and
# survives installer packaging so the deft-directive-setup pre-cutover guard
# (condition 3, see skills/deft-directive-setup/SKILL.md:32 and main.md:159)
# does not fire on a fresh install. See #1179.
`

// ensureVbriefLifecycleDirs creates the canonical v0.20 lifecycle
// subdirectories under `vbrief/` and drops a `.gitkeep` placeholder into each
// empty one so the directory is durable across `git add` / installer packaging.
// Idempotent -- MkdirAll on an existing dir is a no-op, and an existing
// `.gitkeep` is left in place so operator edits (or directory contents added
// later) are preserved. When a lifecycle directory already contains files
// (e.g. the operator has filed scope vBRIEFs there) the `.gitkeep` is skipped
// because the directory is no longer empty.
func ensureVbriefLifecycleDirs(consumerVbrief string) error {
	for _, sub := range vbriefLifecycleDirs {
		dir := filepath.Join(consumerVbrief, sub)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("could not create vbrief/%s/: %w", sub, err)
		}
		gitkeep := filepath.Join(dir, ".gitkeep")
		if _, err := os.Stat(gitkeep); err == nil {
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("could not stat vbrief/%s/.gitkeep: %w", sub, err)
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return fmt.Errorf("could not list vbrief/%s/: %w", sub, err)
		}
		if len(entries) > 0 {
			// Directory already carries content (e.g. operator-filed scope
			// vBRIEFs); the placeholder is unnecessary.
			continue
		}
		if err := os.WriteFile(gitkeep, []byte(vbriefLifecycleGitkeepBody), 0o644); err != nil {
			return fmt.Errorf("could not write vbrief/%s/.gitkeep: %w", sub, err)
		}
	}
	return nil
}

// vbriefLifecycleDirsPresent reports whether all canonical lifecycle
// subdirectories under `consumerVbrief` already exist. Used by the
// idempotency probe in WriteConsumerVbrief so a half-state install (schemas/
// + vbrief.md present, lifecycle dirs missing -- i.e. the pre-#1179 shape)
// still triggers the lifecycle-dir creation pass on a re-run.
func vbriefLifecycleDirsPresent(consumerVbrief string) bool {
	for _, sub := range vbriefLifecycleDirs {
		info, err := os.Stat(filepath.Join(consumerVbrief, sub))
		if err != nil || !info.IsDir() {
			return false
		}
	}
	return true
}

// WriteConsumerVbrief deposits a consumer-side `vbrief/` workspace at the
// project root containing `vbrief/schemas/`, a `vbrief/vbrief.md` template,
// and the five canonical lifecycle subdirectories (proposed, pending, active,
// completed, cancelled) each carrying a `.gitkeep` placeholder so empty
// directories survive `git add` / installer packaging.
//
// Schemas are copied from the freshly-deposited framework copy at
// `<deftDir>/vbrief/schemas/` so the consumer's schema files stay in lockstep
// with the framework version they installed. If the framework copy is missing
// for any reason the function falls back to creating the directories with a
// placeholder README so the deposit is observable to downstream tooling and
// to the conformance audit (#1020).
//
// #1179 reverses the original #1020 4g "do not pre-create lifecycle dirs"
// contract: a fresh install that ships only schemas/ + vbrief.md trips the
// deft-directive-setup pre-cutover condition 3 ("vbrief/ exists but any of
// the five lifecycle subfolders is missing" -- see
// `skills/deft-directive-setup/SKILL.md:32` and `main.md:159` for the
// canonical text) and routes the operator into a `task migrate:vbrief`
// dead-end on a project that has nothing to migrate. Materialising the
// lifecycle dirs at install time keeps the guard quiet and the install
// greenfield-ready.
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
	lifecyclePresent := vbriefLifecycleDirsPresent(consumerVbrief)
	if schemasPresent && vbriefMDPresent && lifecyclePresent {
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

	// Materialise the canonical lifecycle directories (#1179). Done
	// unconditionally on every call so a half-state install left behind by
	// an older installer rail is repaired on the next re-run.
	if err := ensureVbriefLifecycleDirs(consumerVbrief); err != nil {
		return false, err
	}

	w.printf("vbrief/ deposited at project root (schemas + vbrief.md + lifecycle dirs).\n")
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
