package main

import (
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
	"strconv"
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

	// The v0.27 v2 marker form (`<!-- deft:managed-section v2 -->`) is still
	// recognised during detection so a fresh canonical install on top of a
	// v0.27 AGENTS.md rewrites the deft entry rather than appending. It is
	// matched (attribute-tolerantly, alongside v3) by agentsMDManagedOpenPattern
	// below rather than via a dedicated constant (#1046 PR-B AC-5, #1437).

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

// agentsMDManagedOpenPattern matches a deft managed-section OPEN marker for
// either the v2 or v3 layout, WITH OR WITHOUT the provenance attributes
// (sha=/refreshed=/session=) that `run agents:refresh` and the relocator stamp
// onto the open marker (#1046 PR-B AC-5). Detection MUST be attribute-tolerant:
// keying on the exact bare marker string made WriteAgentsMD miss an attributed
// marker and APPEND a second managed section instead of rewriting the existing
// one (the v0.39.3 duplicate-managed-section bug, #1437). The installer still
// EMITS the bare canonical marker (agentsMDSentinel); only the MATCHING here is
// attribute-tolerant. The closing marker (agentsMDFenceClose) is unchanged.
var agentsMDManagedOpenPattern = regexp.MustCompile(`<!-- deft:managed-section v[23][^>]*-->`)

// canonicalGitignoreLines is the .gitignore baseline the installer deposits.
// It mirrors scripts/relocate.py::GITIGNORE_LINES (the F2 canonical default
// from #1015): the runtime cache directory, the SELECTIVE .deft runtime
// sentinel files, plus the SELECTIVE per-file vbrief/.eval/* entries.
//
// #1251 / #1464: the eval state is gitignored via the selective per-file
// entries (candidates.jsonl / summary-history.jsonl / scope-lifecycle.jsonl /
// doctor-state.json), NEVER the blanket `vbrief/.eval/` line. The blanket
// hides the team-shared, TRACKED vbrief/.eval/slices.jsonl and README.md
// (#1132 / D13) and contradicts the #1144 hybrid policy. The selective list
// here MUST stay in lockstep with GITIGNORE_EVAL_ENTRIES in
// scripts/_triage_bootstrap_gitignore.py (the single source of truth the
// bootstrap + relocator rails consume); the parity test
// TestCanonicalGitignoreEvalEntriesMatchPythonSource pins the two together,
// and EnsureGitignoreLines HEALS a pre-existing blanket on upgrade.
//
// #1609: session-start writes per-clone runtime sentinels under .deft/. The
// consumer projection tracks .deft/core/ for reproducible installs, so the
// installer MUST ignore only the sentinel files (.deft/ritual-state.json and
// .deft/last-session.json) instead of depositing a blanket .deft/ rule that
// would hide the framework payload.
//
// The three leaked-artefact guards below stop a consumer's `git add -A` from
// trapping installer/render scratch files:
//
//   - vbrief/*.lock          -- the PROJECT-DEFINITION mutation-lock sidecar
//     (vbrief/PROJECT-DEFINITION.vbrief.json.lock) and any sibling vbrief-root
//     lock. The framework now deletes these on a clean exit (#1311), so this
//     is belt-and-suspenders for an interrupted render / an older payload.
//   - .deft/core.bak-*/ + .deft/*.bak-* -- pre-swap payload backups. The
//     installer now writes them OUTSIDE the working tree (#1445), so these
//     only catch backups left by a pre-#1445 installer already in the tree.
//   - *.premigrate.* -- pre-migration safety snapshots written by the vBRIEF
//     migration / spec-render step during install/upgrade (e.g.
//     ROADMAP.premigrate.md, SPECIFICATION.premigrate.md,
//     vbrief/specification.premigrate.vbrief.json). The leading-slash-free
//     glob matches at any depth, so it covers both the repo-root snapshots
//     and the nested vbrief/ one. Same hygiene class as the lock/backup
//     guards above (#1450; the migrator already writes this pattern to the
//     consumer .gitignore on the Python path per #497/#530 -- this closes the
//     installer-deposit gap for the binary install/upgrade rail).
//
// The framework deposit at .deft/core/ is INTENTIONALLY NOT auto-gitignored --
// per #11 .deft/core/ ships read-only packaged framework assets that consumers
// commit for reproducibility; the .bak globs above never match .deft/core
// itself, only the timestamped backup siblings.
var canonicalGitignoreLines = []string{
	".deft-cache/",
	// Selective .deft runtime sentinels -- MUST equal
	// GITIGNORE_DEFT_RUNTIME_SENTINELS in scripts/_triage_bootstrap_gitignore.py.
	".deft/ritual-state.json",
	".deft/last-session.json",
	// Selective vbrief/.eval/* entries -- MUST equal GITIGNORE_EVAL_ENTRIES in
	// scripts/_triage_bootstrap_gitignore.py, in the same order (parity test
	// TestCanonicalGitignoreEvalEntriesMatchPythonSource pins this).
	"vbrief/.eval/candidates.jsonl",
	"vbrief/.eval/summary-history.jsonl",
	"vbrief/.eval/scope-lifecycle.jsonl",
	"vbrief/.eval/decompositions/",
	"vbrief/.eval/doctor-state.json",
	"vbrief/*.lock",
	".deft/core.bak-*/",
	".deft/*.bak-*",
	"*.premigrate.*",
}

// forbiddenBlanketEvalLines mirrors FORBIDDEN_BLANKET_EVAL_LINES in
// scripts/_triage_bootstrap_gitignore.py (#1251 / #1464). A pre-#1251 deposit
// rail appended the blanket `vbrief/.eval/` (or `vbrief/.eval`) line that hides
// the tracked slices.jsonl / README.md from git. EnsureGitignoreLines strips
// any such line on upgrade instead of leaving it, so `task triage:bootstrap`
// no longer warns. The selective per-file entries above are NEVER matched here
// because the forbidden set is the bare directory line only.
var forbiddenBlanketEvalLines = []string{
	"vbrief/.eval/",
	"vbrief/.eval",
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
// 4.1 Framework deposit
// ---------------------------------------------------------------------------
//
// The framework deposit is git-free (#1428): VendorDeft (fresh tarball vendor
// install), UpdateDeft (upgrade dispatch), migrateCloneToVendored,
// refreshVendoredCore, and the payload-layout classification helpers all live
// in upgrade.go (#1425, #1428). The neutralization deposit (.gitattributes,
// Greptile/CodeQL bot-ignore, CI guard) lives in deposit.go (#1430).

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

// agentsMDSpan is a half-open byte range [Start, End) covering one fenced deft
// managed section -- the open marker through the matching closing fence,
// inclusive of the close-fence bytes -- inside an AGENTS.md body.
type agentsMDSpan struct {
	Start int
	End   int
}

// agentsMDManagedSpans returns the byte ranges of EVERY deft managed section in
// body: each v2/v3 open marker (attributed or bare, matched by
// agentsMDManagedOpenPattern) paired with the next closing fence. An open
// marker with no following closing fence terminates the scan (it cannot be
// surgically bounded). Returns nil when no fenced section is present. Used by
// agentsMDManagedSlice (idempotency probe scope) and rewriteAgentsMDBlock
// (self-heal collapse to a single section, #1437).
func agentsMDManagedSpans(body string) []agentsMDSpan {
	var spans []agentsMDSpan
	from := 0
	for from <= len(body) {
		loc := agentsMDManagedOpenPattern.FindStringIndex(body[from:])
		if loc == nil {
			break
		}
		openStart := from + loc[0]
		closeOff := strings.Index(body[openStart:], agentsMDFenceClose)
		if closeOff < 0 {
			break
		}
		closeEnd := openStart + closeOff + len(agentsMDFenceClose)
		spans = append(spans, agentsMDSpan{Start: openStart, End: closeEnd})
		from = closeEnd
	}
	return spans
}

// agentsMDManagedSlice returns the substring of body covering the FIRST fenced
// managed section (inclusive of the close-fence bytes). Returns (slice, true)
// when a fenced managed section is found, or ("", false) when no fenced block
// is detected (pre-v0.27 unfenced legacy body, or no deft sentinel at all).
// The open marker is matched attribute-tolerantly (#1437). Used by
// WriteAgentsMD to scope the idempotency probe to the managed slice ONLY
// (Greptile P1 #1066: a file-wide claim check could produce a false skip when
// operator-authored prose outside the fence contains the layout claim while
// the managed block stays stale).
func agentsMDManagedSlice(body string) (string, bool) {
	spans := agentsMDManagedSpans(body)
	if len(spans) == 0 {
		return "", false
	}
	return body[spans[0].Start:spans[0].End], true
}

// rewriteAgentsMDBlock replaces the deft-managed section(s) inside body with a
// SINGLE rendered replacement and returns (newBody, surgical). When at least
// one fenced section (v2/v3, attributed or bare) is present the rewrite is
// surgical (`surgical=true`): the FIRST section is replaced in place with
// replacement and EVERY subsequent managed section is removed, so any number of
// existing managed sections converges to exactly one (the #1437 self-heal --
// installs already broken with duplicate sections are cleaned up on the next
// upgrade). Operator prose before, between, and after the fences is preserved
// verbatim. The pre-v0.27 layout has no closing fence, so when no fenced
// section is present the entire file is replaced with the replacement
// (`surgical=false`); the legacy body has no reliable terminator the installer
// can detect, and leaving stale legacy prose alongside the new canonical body
// would itself produce the kind of cross-layout drift #1060 closes.
//
// When the replacement already ends in a newline AND the byte immediately
// after the first section's closing fence is also a newline, one trailing
// newline is consumed from body so repeated surgical rewrites don't accumulate
// blank lines at the boundary (Greptile P1 #1066: cosmetic drift across
// upgrades).
func rewriteAgentsMDBlock(body, replacement string) (string, bool) {
	spans := agentsMDManagedSpans(body)
	if len(spans) == 0 {
		return replacement, false
	}
	var b strings.Builder
	// Operator prose before the first managed section is preserved verbatim.
	b.WriteString(body[:spans[0].Start])
	// Exactly one canonical managed section replaces the first one.
	b.WriteString(replacement)
	prevEnd := spans[0].End
	if strings.HasSuffix(replacement, "\n") && prevEnd < len(body) && body[prevEnd] == '\n' {
		prevEnd++
	}
	// Drop every SUBSEQUENT managed section (converge N -> 1) while preserving
	// any operator prose BETWEEN the fences.
	for _, sp := range spans[1:] {
		b.WriteString(body[prevEnd:sp.Start])
		prevEnd = sp.End
	}
	b.WriteString(body[prevEnd:])
	return b.String(), true
}

// WriteAgentsMD creates, rewrites, or appends the deft managed section in
// AGENTS.md so the file always advertises the install root the installer is
// depositing at. Layout-aware sentinel logic (#1060, #1437):
//
//   - AGENTS.md absent                  -> write the layout-correct v3 body.
//   - exactly ONE bare-marker section
//     AND matching claim                -> skip (file is up-to-date).
//   - any managed section(s), attributed
//     or bare (v2/v3), stale / foreign
//     layout / duplicated               -> rewrite to a SINGLE layout-correct
//     v3 body, collapsing duplicates and preserving operator prose outside
//     the fences (the #1437 self-heal: converges 0/1/N sections to one).
//   - pre-v0.27 legacy sentinel only    -> rewrite the entire file to the
//     layout-correct v3 body (the legacy body is unfenced so a surgical
//     replacement is not safe -- see rewriteAgentsMDBlock).
//   - no deft sentinel at all           -> append the layout-correct v3 body
//     to the existing file (preserves the operator's pre-existing AGENTS.md).
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

	// Locate EVERY deft managed section (v2/v3, attributed or bare). The open
	// marker is matched attribute-tolerantly so a marker carrying provenance
	// attributes (sha=/refreshed=/session=, emitted by `run agents:refresh` /
	// the relocator) is recognised -- keying on the bare marker string made
	// WriteAgentsMD fall through and APPEND a second managed section instead of
	// rewriting the existing one (#1437).
	managedSpans := agentsMDManagedSpans(s)
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

	// Up-to-date happy path: EXACTLY ONE managed section, emitted in the BARE
	// canonical marker form the installer itself writes (agentsMDSentinel), and
	// already advertising the install root we are depositing at. Gating the
	// skip on the bare marker -- rather than the attribute-tolerant match used
	// for detection above -- means an ATTRIBUTED marker is rewritten in place
	// to the canonical body (#1437) while a re-run on the installer's own
	// output stays a byte-for-byte no-op. A file carrying MULTIPLE managed
	// sections (the duplicate bug) also falls through so it self-heals to one.
	if strings.Contains(s, agentsMDSentinel) && hasClaim && len(managedSpans) == 1 {
		w.printf("AGENTS.md already advertises install root %s — skipping.\n", installRoot)
		return nil
	}

	// Any deft managed section (v2/v3, attributed or bare) OR a pre-v0.27
	// legacy sentinel: rewrite to a SINGLE layout-correct v3 body, collapsing
	// any duplicates and preserving operator prose outside the fences, so the
	// installer never leaves the consumer in the cross-layout drift or the
	// duplicate-section state the doctor would flag (#1060, #1437 self-heal).
	if len(managedSpans) > 0 || hasLegacy {
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
		// #1671: a re-run that rewrites the managed section is the upgrade /
		// refresh path. Disclose the framework files this refresh (plus the
		// upgrade payload swap) left uncommitted instead of a single silent
		// success line, so the operator sees the AGENTS.md / .deft/core
		// stragglers that belong in the framework deposit commit. Best-effort:
		// a no-op outside a git work tree.
		printRefreshSideEffects(w, frameworkRefreshSideEffects(projectDir))
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
	// #1671: appending the managed section into an existing operator AGENTS.md
	// also dirties the file (and, on an upgrade, the .deft/core payload swap).
	// Disclose the framework stragglers so they are not silently left out of
	// the framework deposit commit. Best-effort: a no-op outside a git work tree.
	printRefreshSideEffects(w, frameworkRefreshSideEffects(projectDir))
	return nil
}

// ---------------------------------------------------------------------------
// 4.2b .gitignore upkeep -- canonical F2 default (#1015, #1020)
// ---------------------------------------------------------------------------

// EnsureGitignoreLines ensures the canonical baseline (the runtime cache dir +
// the SELECTIVE .deft runtime sentinels + the SELECTIVE vbrief/.eval/* entries
// + the leaked-artefact guards) is present in the consumer's .gitignore,
// creating the file when absent. It also HEALS a
// pre-existing forbidden blanket `vbrief/.eval/` (or `vbrief/.eval`) line on
// upgrade (#1464): pre-#1251 rails deposited that blanket, which hides the
// tracked vbrief/.eval/slices.jsonl + README.md from git; an upgrade now
// STRIPS it rather than leaving it (so `task triage:bootstrap` no longer
// warns). Every other line is preserved verbatim. Mirrors
// scripts/relocate.py::_ensure_gitignore_lines for cross-rail parity (#1015 F2
// canonical default). Returns true if the file was modified -- a heal with no
// additions still counts as a modification.
func EnsureGitignoreLines(w *Wizard, projectDir string) (bool, error) {
	path := filepath.Join(projectDir, ".gitignore")
	existing := ""
	if data, err := os.ReadFile(path); err == nil {
		existing = string(data)
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("could not read .gitignore: %w", err)
	}

	// Heal (#1464): drop any forbidden blanket vbrief/.eval/ line (tolerating a
	// trailing inline comment) so the upgrade removes it. Reconstruct from the
	// surviving lines; track the original trailing newline so a clean file stays
	// clean. The selective per-file entries are never matched -- the forbidden
	// set is the bare directory line only.
	lines := strings.Split(existing, "\n")
	trailingNewline := false
	if strings.HasSuffix(existing, "\n") && len(lines) > 0 && lines[len(lines)-1] == "" {
		trailingNewline = true
		lines = lines[:len(lines)-1]
	}
	var kept []string
	blanketRemoved := false
	present := map[string]bool{}
	for _, raw := range lines {
		stripped := stripGitignoreInlineComment(raw)
		if isForbiddenBlanketEvalLine(stripped) {
			blanketRemoved = true
			continue
		}
		kept = append(kept, raw)
		if stripped != "" {
			present[stripped] = true
		}
	}

	var additions []string
	for _, line := range canonicalGitignoreLines {
		if !present[line] {
			additions = append(additions, line)
		}
	}
	if !blanketRemoved && len(additions) == 0 {
		w.printf(".gitignore already covers the canonical deft entries — skipping.\n")
		return false, nil
	}

	healed := strings.Join(kept, "\n")
	if len(kept) > 0 && trailingNewline {
		healed += "\n"
	}

	var body strings.Builder
	body.WriteString(healed)
	if len(additions) > 0 {
		if healed != "" && !strings.HasSuffix(healed, "\n") {
			body.WriteString("\n")
		}
		if healed != "" && !strings.HasSuffix(healed, "\n\n") {
			body.WriteString("\n")
		}
		body.WriteString("# Deft framework: ignore local-only caches and scratch directories\n")
		for _, add := range additions {
			body.WriteString(add)
			body.WriteString("\n")
		}
	}

	if err := os.WriteFile(path, []byte(body.String()), 0o644); err != nil {
		return false, fmt.Errorf("could not write .gitignore: %w", err)
	}
	if len(additions) > 0 {
		w.printf(".gitignore updated with canonical entries: %s\n", strings.Join(additions, ", "))
	}
	if blanketRemoved {
		w.printf(".gitignore healed: removed forbidden blanket vbrief/.eval/ line (#1464).\n")
	}
	return true, nil
}

// isForbiddenBlanketEvalLine reports whether s (an already inline-comment-
// stripped gitignore line) is one of the forbidden blanket eval lines mirrored
// from the Python rails (#1464).
func isForbiddenBlanketEvalLine(s string) bool {
	for _, f := range forbiddenBlanketEvalLines {
		if s == f {
			return true
		}
	}
	return false
}

// stripGitignoreInlineComment mirrors strip_gitignore_inline_comment in
// scripts/_triage_bootstrap_gitignore.py: trim surrounding whitespace and drop
// a trailing `# ...` comment so a blanket entry like `vbrief/.eval/  # legacy`
// is still recognised by the heal. A whole-line comment (or blank line)
// returns "".
func stripGitignoreInlineComment(line string) string {
	stripped := strings.TrimSpace(line)
	if stripped == "" || strings.HasPrefix(stripped, "#") {
		return ""
	}
	if idx := strings.Index(stripped, "#"); idx != -1 {
		return strings.TrimRight(stripped[:idx], " \t")
	}
	return stripped
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

// coreToolCandidates maps canonical tool names to PATH probe aliases.
var coreToolCandidates = map[string][]string{
	"task":   {"task"},
	"uv":     {"uv"},
	"python": {"python", "python3"},
	"gh":     {"gh"},
}

// linuxBootstrapRequiredTools are the doctor-critical tools the Linux --yes
// path MUST bootstrap or fail loud on before claiming install success (#1538).
var linuxBootstrapRequiredTools = []string{"uv", "task", "gh"}

// coreToolsBootstrapBlockCode is the machine-readable error_code emitted on
// stdout in --json mode when Linux non-interactive bootstrap cannot satisfy
// required tools (#1538).
const coreToolsBootstrapBlockCode = "core_tools_bootstrap_unavailable"

// coreToolsBootstrapBlockMessage is the short human-facing error headline for
// unsupported / incomplete Linux bootstrap (#1538).
const coreToolsBootstrapBlockMessage = "required core tools could not be bootstrapped automatically"

// goosForCoreTools is the platform gate for the Linux bootstrap path. Tests
// override it to exercise Linux behaviour on any host.
var goosForCoreTools = func() string { return runtime.GOOS }

// bootstrapLinuxCoreToolsFunc installs portable Linux user-local copies of
// missing required tools. Tests replace it to avoid real network/package work.
var bootstrapLinuxCoreToolsFunc = bootstrapLinuxCoreTools

// ErrCoreToolsBootstrap is returned when Linux --yes bootstrap cannot satisfy
// doctor-required tools (uv, task, gh) without claiming install success.
type ErrCoreToolsBootstrap struct {
	Missing []string
	Detail  string
}

func (e *ErrCoreToolsBootstrap) Error() string {
	if e == nil {
		return coreToolsBootstrapBlockMessage
	}
	missing := strings.Join(e.Missing, ", ")
	if missing == "" {
		return e.Detail
	}
	return fmt.Sprintf("%s (still missing: %s)", e.Detail, missing)
}

// coreToolsBootstrapBlockResult builds the single machine-readable JSON object
// emitted on stdout when Linux core-tool bootstrap refuses install success in
// --json mode (#1538). Mirrors dirtyTreeBlockResult: stdout stays one JSON
// object with actionable structured fields.
func coreToolsBootstrapBlockResult(missing []string, err error) map[string]any {
	missingOut := missing
	if missingOut == nil {
		missingOut = []string{}
	}
	why := coreToolsBootstrapBlockMessage
	if err != nil {
		why = err.Error()
	}
	return map[string]any{
		"success":       false,
		"error":         coreToolsBootstrapBlockMessage,
		"error_code":    coreToolsBootstrapBlockCode,
		"missing_tools": missingOut,
		"why":           why,
		"remediation": []string{
			"Install uv, task, and gh on your PATH before re-running deft-install --yes",
			"uv: https://docs.astral.sh/uv/getting-started/installation/",
			"task: https://taskfile.dev/installation/",
			"gh: https://cli.github.com/",
		},
		"warnings": []string{},
	}
}

// probeCoreToolsMissing returns the sorted list of canonical tools absent from
// PATH. Uses lookPathFunc so tests can inject discovery outcomes.
func probeCoreToolsMissing() []string {
	var missing []string
	for name, alts := range coreToolCandidates {
		found := false
		for _, a := range alts {
			if _, err := lookPathFunc(a); err == nil {
				found = true
				break
			} else if !errors.Is(err, exec.ErrNotFound) {
				log.Printf("warning: LookPath %q: %v", a, err)
			}
		}
		if !found {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	return missing
}

// missingLinuxBootstrapRequired filters missing to the doctor-required subset
// in canonical sorted order.
func missingLinuxBootstrapRequired(missing []string) []string {
	required := map[string]bool{}
	for _, t := range linuxBootstrapRequiredTools {
		required[t] = true
	}
	var out []string
	for _, t := range missing {
		if required[t] {
			out = append(out, t)
		}
	}
	return out
}

func printCoreToolsFallbacks(w *Wizard, missing []string) {
	w.printf("Missing core tools: %s\n", strings.Join(missing, ", "))
	w.printf("  Fallbacks (run manually or via platform package manager):\n")
	w.printf("    Windows: winget install --id <ID> or scripts/setup_windows.ps1\n")
	w.printf("    macOS:   brew install go-task uv python gh\n")
	w.printf("    Linux:   apt/brew equivalent for task uv python3 gh\n")
	w.printf("  See docs/getting-started.md and QUICK-START.md for details.\n")
}

// EnsureCoreTools probes for the four canonical toolchain binaries required
// for full Deft operation (uv, go-task as "task", Python, gh). In Linux
// non-interactive/--yes mode it bootstraps doctor-required tools (uv, task,
// gh) via portable user-local installers or fails loud with structured output
// instead of claiming success with fallback prose only (#1538). Other
// platforms keep the Epic-4 manual-fallback guidance. Returns the list of
// missing tools (for JSON result) as a non-nil slice (empty when none
// missing) for stable JSON emission.
func EnsureCoreTools(w *Wizard, nonInteractive bool) ([]string, error) {
	// #1668: validate the Python interpreter (version + resolution) up front so
	// a too-old / Windows-`python3`-missing environment is surfaced loudly at
	// install time instead of as a raw traceback on the first commit. This is
	// reporting only -- it never changes the missing-tool list or aborts.
	reportPythonPreflight(w)

	missing := probeCoreToolsMissing()
	if len(missing) == 0 {
		w.printf("Core tools present: task, uv, python, gh.\n")
		return []string{}, nil
	}

	requiredMissing := missingLinuxBootstrapRequired(missing)
	if nonInteractive && goosForCoreTools() == "linux" && len(requiredMissing) > 0 {
		w.printf("Bootstrapping required core tools for Linux --yes: %s\n", strings.Join(requiredMissing, ", "))
		if err := bootstrapLinuxCoreToolsFunc(w, requiredMissing); err != nil {
			return requiredMissing, err
		}
		if err := prependLinuxLocalBin(); err != nil {
			return requiredMissing, &ErrCoreToolsBootstrap{
				Missing: requiredMissing,
				Detail:  fmt.Sprintf("could not wire ~/.local/bin onto PATH: %v", err),
			}
		}
		missing = probeCoreToolsMissing()
		requiredMissing = missingLinuxBootstrapRequired(missing)
		if len(requiredMissing) > 0 {
			return requiredMissing, &ErrCoreToolsBootstrap{
				Missing: requiredMissing,
				Detail:  "bootstrap completed but required tools are still missing from PATH",
			}
		}
		if len(missing) == 0 {
			w.printf("Core tools present after Linux bootstrap: task, uv, python, gh.\n")
		} else {
			w.printf("Required core tools bootstrapped; optional still missing: %s\n", strings.Join(missing, ", "))
		}
		return missing, nil
	}

	printCoreToolsFallbacks(w, missing)
	if nonInteractive {
		w.printf("  (--yes on non-Linux hosts does not auto-install; use platform setup scripts.)\n")
	}
	return missing, nil
}

// prependLinuxLocalBin prepends $HOME/.local/bin to the process PATH so
// post-bootstrap LookPath probes see user-local installs (#1538).
func prependLinuxLocalBin() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	localBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(localBin, 0o755); err != nil {
		return err
	}
	sep := string(os.PathListSeparator)
	current := os.Getenv("PATH")
	if current == "" {
		return os.Setenv("PATH", localBin)
	}
	if pathListEntryPresent(current, localBin, sep) {
		return nil
	}
	return os.Setenv("PATH", localBin+sep+current)
}

func pathListEntryPresent(pathEnv, entry, sep string) bool {
	for _, p := range strings.Split(pathEnv, sep) {
		if p == entry {
			return true
		}
	}
	return false
}

// linuxBootstrapFetcherAvailable reports whether curl or wget is on PATH for
// the portable install scripts (#1538).
func linuxBootstrapFetcherAvailable() bool {
	for _, bin := range []string{"curl", "wget"} {
		if _, err := lookPathFunc(bin); err == nil {
			return true
		}
	}
	return false
}

// linuxBootstrapArch maps runtime.GOARCH to the architecture token used by
// upstream gh/task release asset names.
func linuxBootstrapArch(goarch string) (string, bool) {
	switch goarch {
	case "amd64":
		return "amd64", true
	case "arm64":
		return "arm64", true
	case "arm":
		return "armv6", true
	default:
		return "", false
	}
}

// bootstrapLinuxCoreTools installs missing doctor-required tools into
// ~/.local/bin using portable, non-root scripts/downloads (#1538).
func bootstrapLinuxCoreTools(w *Wizard, missing []string) error {
	if !linuxBootstrapFetcherAvailable() {
		return &ErrCoreToolsBootstrap{
			Missing: missing,
			Detail:  "no supported fetcher on PATH (need curl or wget for portable Linux bootstrap)",
		}
	}
	if _, err := os.UserHomeDir(); err != nil {
		return &ErrCoreToolsBootstrap{
			Missing: missing,
			Detail:  fmt.Sprintf("cannot resolve home directory for user-local bootstrap: %v", err),
		}
	}
	if err := prependLinuxLocalBin(); err != nil {
		return &ErrCoreToolsBootstrap{
			Missing: missing,
			Detail:  fmt.Sprintf("cannot prepare ~/.local/bin: %v", err),
		}
	}
	arch, ok := linuxBootstrapArch(runtime.GOARCH)
	if !ok {
		return &ErrCoreToolsBootstrap{
			Missing: missing,
			Detail:  fmt.Sprintf("unsupported Linux architecture %q for portable bootstrap", runtime.GOARCH),
		}
	}
	for _, tool := range missing {
		var err error
		switch tool {
		case "uv":
			err = installUVLinux(w)
		case "task":
			err = installTaskLinux(w)
		case "gh":
			err = installGhLinux(w, arch)
		default:
			continue
		}
		if err != nil {
			return &ErrCoreToolsBootstrap{
				Missing: missing,
				Detail:  fmt.Sprintf("failed to bootstrap %s: %v", tool, err),
			}
		}
	}
	return nil
}

func installUVLinux(w *Wizard) error {
	w.printf("  Installing uv via Astral install script...\n")
	// Download to a temp file first so a curl failure propagates to runCmdFunc.
	// A bare `curl | sh` pipeline masks curl's exit status (POSIX uses the last
	// command's status), which would report bootstrap success on network errors.
	return runCmdFunc(w.out, "sh", "-c", `set -e
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
curl -fsSL https://astral.sh/uv/install.sh -o "$tmpdir/install.sh"
sh "$tmpdir/install.sh"`)
}

func installTaskLinux(w *Wizard) error {
	w.printf("  Installing task via taskfile.dev install script...\n")
	return runCmdFunc(w.out, "sh", "-c", `set -e
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
curl -fsSL https://taskfile.dev/install.sh -o "$tmpdir/install.sh"
sh "$tmpdir/install.sh" -d -b "${HOME}/.local/bin"`)
}

func installGhLinux(w *Wizard, arch string) error {
	w.printf("  Installing gh via GitHub CLI release tarball...\n")
	script := fmt.Sprintf(`
set -e
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
tag="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
if [ -z "$tag" ]; then
  echo "could not resolve latest gh release tag" >&2
  exit 1
fi
ver="${tag#v}"
asset="gh_${ver}_linux_%s.tar.gz"
url="https://github.com/cli/cli/releases/download/${tag}/${asset}"
curl -fsSL "$url" -o "$tmpdir/gh.tgz"
tar -xzf "$tmpdir/gh.tgz" -C "$tmpdir"
install -m 0755 "$tmpdir"/gh_*/bin/gh "${HOME}/.local/bin/gh"
`, arch)
	return runCmdFunc(w.out, "sh", "-c", script)
}

type maintainerToolStatus struct {
	Name     string `json:"name"`
	Binary   string `json:"binary"`
	Present  bool   `json:"present"`
	Required bool   `json:"required"`
	Purpose  string `json:"purpose"`
}

var maintainerToolDefinitions = []maintainerToolStatus{
	{Name: "go", Binary: "go", Required: true, Purpose: "build and test cmd/deft-install"},
	{Name: "node", Binary: "node", Required: true, Purpose: "maintainer-side documentation and release tooling"},
	{Name: "ghx", Binary: "ghx", Required: false, Purpose: "optional cached GitHub CLI proxy for maintainer and swarm read-only calls"},
}

func EnsureMaintainerTools(w *Wizard) []maintainerToolStatus {
	statuses := make([]maintainerToolStatus, 0, len(maintainerToolDefinitions))
	var missing []string
	for _, def := range maintainerToolDefinitions {
		status := def
		_, err := lookPathFunc(def.Binary)
		status.Present = err == nil
		if err != nil && !errors.Is(err, exec.ErrNotFound) {
			log.Printf("warning: LookPath %q: %v", def.Binary, err)
		}
		if !status.Present {
			missing = append(missing, def.Name)
		}
		statuses = append(statuses, status)
	}
	if len(missing) == 0 {
		w.printf("Maintainer tools present: go, node, ghx.\n")
		return statuses
	}
	w.printf("Maintainer tools missing or optional: %s\n", strings.Join(missing, ", "))
	w.printf("  Required for framework development: go, node.\n")
	w.printf("  Optional acceleration: ghx (install with `task setup:ghx`; consumers only need gh).\n")
	return statuses
}

func skippedConsumerProjectionNames() []string {
	return []string{
		"framework_payload",
		"AGENTS.md",
		".agents/skills",
		".gitignore",
		".gitattributes",
		"greptile.json",
		"codeql_config",
		"core_guard_workflow",
		"vbrief_scaffold",
		"consumer_git_hooks",
		"Taskfile.yml",
		"scoped_staging",
	}
}

func validateMaintainerCheckout(projectDir string) error {
	if !isDirectiveFrameworkCheckout(projectDir) {
		return fmt.Errorf("--maintainer requires --repo-root to point at a directive framework checkout; missing maintainer source markers under %s", projectDir)
	}
	return nil
}

func isDirectiveFrameworkCheckout(projectDir string) bool {
	for _, rel := range []string{
		"main.md",
		"cmd/deft-install/main.go",
		"templates/agent-prompt-preamble.md",
		"scripts/setup_ghx.py",
	} {
		info, err := os.Stat(filepath.Join(projectDir, filepath.FromSlash(rel)))
		if err != nil || info.IsDir() {
			return false
		}
	}
	return true
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
//
// The source file's permission bits are preserved (#1477): the git-free payload
// swap (upgrade.go copyTree -> copyFile) and the vbrief schema seed (copyDir ->
// copyFile) must not strip the executable bit from vendored executables -- the
// .githooks/ hooks, the `run` launcher, and shebang scripts ship mode 100755 in
// the framework tarball and were silently flattened to 0o644 before this. Fall
// back to 0o644 when the source mode cannot be stat'd.
func copyFile(src, dst string) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	mode := os.FileMode(0o644)
	if info, serr := in.Stat(); serr != nil {
		// Stat failure is non-fatal -- fall back to 0o644 -- but log it so a
		// transient error leaves a trace rather than silently dropping the
		// source mode (mirrors copyTree's stat-for-mode handling in upgrade.go).
		log.Printf("warning: stat %q for mode (using 0o644): %v", src, serr)
	} else {
		mode = info.Mode().Perm()
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if err := copyStream(in, out); err != nil {
		return err
	}
	// O_CREATE applies the perm only when the file did not already exist and is
	// subject to umask; chmod guarantees dst ends with the source's mode
	// regardless (e.g. a pre-existing 0o644 dst being refreshed). (#1477)
	return os.Chmod(dst, mode)
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

func PrintMaintainerNextSteps(w *Wizard, result *WizardResult, configDir string) {
	w.printf("\n✓ Deft maintainer setup checked.\n\n")
	w.printf("  Checkout     : %s%c\n", result.ProjectDir, os.PathSeparator)
	w.printf("  User config  : %s%c\n", configDir, os.PathSeparator)
	w.printf("  Projections  : skipped consumer AGENTS.md / .gitignore / vbrief / workflow deposits\n")
	w.printf("\nNext steps:\n")
	w.printf("  1. Run `task setup` from the framework checkout for maintainer hooks and ghx detection.\n")
	w.printf("  2. Run `task check` before committing framework changes.\n\n")
}

// ---------------------------------------------------------------------------
// 4.5b Python interpreter preflight (#1668)
// ---------------------------------------------------------------------------
//
// The framework scripts (doctor.py, policy.py, preflight_branch.py, ...) use
// `from datetime import UTC`, which only exists on Python 3.11+. On Windows
// `python3` is usually absent (only `python.exe` / the `py` launcher exist),
// so a successful-looking install can leave a broken commit workflow and the
// post-install doctor handoff dumps a raw ImportError traceback. The preflight
// below resolves a usable interpreter across DEFT_PYTHON / python / python3 /
// the `py` launcher, verifies it is >= 3.11, and lets the doctor handoff
// degrade gracefully with an actionable message instead of a raw traceback.

const (
	// minPythonMajor / minPythonMinor are the minimum interpreter version the
	// framework scripts require (the `from datetime import UTC` floor).
	minPythonMajor = 3
	minPythonMinor = 11
)

// pythonVersion is a parsed `Python X.Y[.Z]` interpreter version.
type pythonVersion struct {
	major int
	minor int
	patch int
	raw   string
}

// meetsMinimum reports whether the version satisfies the 3.11+ requirement.
func (v pythonVersion) meetsMinimum() bool {
	if v.major != minPythonMajor {
		return v.major > minPythonMajor
	}
	return v.minor >= minPythonMinor
}

// String renders a human-friendly `X.Y.Z` version.
func (v pythonVersion) String() string {
	return fmt.Sprintf("%d.%d.%d", v.major, v.minor, v.patch)
}

// pythonInterpreterCandidate is one interpreter the preflight probes. bin is the
// executable; prefixArgs are inserted before any forwarded args (the Windows
// `py` launcher needs `-3` to select Python 3). source is a short label used in
// operator-facing messages. probeDirect skips the PATH LookPath gate -- used
// for DEFT_PYTHON, which is an explicit (possibly absolute) operator override.
type pythonInterpreterCandidate struct {
	source      string
	bin         string
	prefixArgs  []string
	probeDirect bool
}

// pythonInterpreterCandidates returns the ordered interpreter candidates the
// preflight probes: DEFT_PYTHON (when set) -> python3 -> python -> the Windows
// `py -3` launcher. This order MUST match the installed git hooks
// (.githooks/pre-commit and .githooks/pre-push, which probe
// python3 -> python -> py -3 after DEFT_PYTHON) so the installer validates the
// same interpreter the hooks will later resolve and use (Greptile #1676).
func pythonInterpreterCandidates() []pythonInterpreterCandidate {
	var cands []pythonInterpreterCandidate
	if override := strings.TrimSpace(os.Getenv("DEFT_PYTHON")); override != "" {
		cands = append(cands, pythonInterpreterCandidate{source: "DEFT_PYTHON", bin: override, probeDirect: true})
	}
	cands = append(cands,
		pythonInterpreterCandidate{source: "python3", bin: "python3"},
		pythonInterpreterCandidate{source: "python", bin: "python"},
		pythonInterpreterCandidate{source: "py launcher", bin: "py", prefixArgs: []string{"-3"}},
	)
	return cands
}

// pythonVersionProbeFunc runs the candidate interpreter's `--version` and
// returns the trimmed combined stdout+stderr. Replaceable in tests so the
// preflight logic can be exercised without a real interpreter. CPython prints
// the version to stdout on 3.4+, but older builds used stderr -- combining both
// keeps the parse robust.
var pythonVersionProbeFunc = defaultPythonVersionProbe

func defaultPythonVersionProbe(bin string, prefixArgs ...string) (string, error) {
	args := append(append([]string{}, prefixArgs...), "--version")
	out, err := exec.Command(bin, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// pythonVersionPattern extracts the first `X.Y[.Z]` triple from `--version`
// output such as `Python 3.13.1`.
var pythonVersionPattern = regexp.MustCompile(`(\d+)\.(\d+)(?:\.(\d+))?`)

// parsePythonVersion parses interpreter `--version` output into a pythonVersion.
// Returns ok=false when no version triple is present.
func parsePythonVersion(output string) (pythonVersion, bool) {
	m := pythonVersionPattern.FindStringSubmatch(output)
	if m == nil {
		return pythonVersion{}, false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	patch := 0
	if m[3] != "" {
		patch, _ = strconv.Atoi(m[3])
	}
	return pythonVersion{major: major, minor: minor, patch: patch, raw: strings.TrimSpace(output)}, true
}

// isAppExecutionAliasStub reports whether `--version` output is the Windows
// App-Execution-Alias `python3` stub rather than a real interpreter. The stub
// prints "Python was not found; run without arguments to install from the
// Microsoft Store, or disable this shortcut from Settings > ... > App execution
// aliases." and must never be treated as a usable interpreter (#1668).
func isAppExecutionAliasStub(output string) bool {
	lo := strings.ToLower(output)
	return strings.Contains(lo, "microsoft store") ||
		strings.Contains(lo, "execution alias") ||
		strings.Contains(lo, "was not found")
}

// pythonPreflight is the resolved outcome of probing the interpreter candidates.
type pythonPreflight struct {
	// resolved + version describe the candidate that satisfied the 3.11+
	// requirement (the interpreter the installer/hooks should use). Valid only
	// when ok is true.
	resolved pythonInterpreterCandidate
	version  pythonVersion
	ok       bool

	// bestFound + bestVersion describe the first interpreter that reported ANY
	// version, used to craft the "too old" message. foundAny reports whether a
	// real interpreter was found at all (vs none/only the alias stub).
	bestFound   pythonInterpreterCandidate
	bestVersion pythonVersion
	foundAny    bool
}

// runPythonPreflight probes the interpreter candidates in order and returns the
// first one that reports a version >= 3.11. When none satisfies the floor it
// records the first interpreter that reported any version (for the "too old"
// message) and returns ok=false.
func runPythonPreflight() pythonPreflight {
	var pf pythonPreflight
	for _, c := range pythonInterpreterCandidates() {
		if !c.probeDirect && !filepath.IsAbs(c.bin) {
			if _, err := lookPathFunc(c.bin); err != nil {
				continue
			}
		}
		out, err := pythonVersionProbeFunc(c.bin, c.prefixArgs...)
		if isAppExecutionAliasStub(out) {
			continue
		}
		if err != nil && out == "" {
			continue
		}
		v, ok := parsePythonVersion(out)
		if !ok {
			continue
		}
		if !pf.foundAny {
			pf.foundAny = true
			pf.bestFound = c
			pf.bestVersion = v
		}
		if v.meetsMinimum() {
			pf.resolved = c
			pf.version = v
			pf.ok = true
			return pf
		}
	}
	return pf
}

// pythonPreflightMessage renders the actionable, operator-facing message for a
// failed preflight. It names the 3.11+ requirement and documents the
// DEFT_PYTHON override (the supported Windows escape hatch).
func pythonPreflightMessage(pf pythonPreflight) string {
	var b strings.Builder
	b.WriteString("Deft requires Python 3.11+ (framework scripts import `from datetime import UTC`, added in 3.11).\n")
	if pf.foundAny {
		fmt.Fprintf(&b, "  Found Python %s via %s, which is too old.\n", pf.bestVersion.String(), pf.bestFound.source)
	} else {
		b.WriteString("  No usable Python interpreter was found (probed DEFT_PYTHON, python3, python, and the `py` launcher).\n")
	}
	b.WriteString("  Install Python 3.11 or newer, then put it on PATH or set DEFT_PYTHON to its full path:\n")
	b.WriteString("    Windows:     set DEFT_PYTHON=C:\\Users\\<you>\\AppData\\Local\\Programs\\Python\\Python313\\python.exe\n")
	b.WriteString("    macOS/Linux: export DEFT_PYTHON=/usr/local/bin/python3.11\n")
	b.WriteString("  The installed git hooks and the post-install doctor handoff use this interpreter.\n")
	return b.String()
}

// pythonPreflightReported caches the preflight outcome once reportPythonPreflight
// has surfaced it on the --yes / CI path (via EnsureCoreTools) so the later
// doHandoffToDoctor call reuses the SAME result instead of re-probing the
// interpreter and re-printing the actionable message a second time (the #1676
// duplicate-message review finding). nil means "not yet reported" -- e.g. the
// interactive install path never calls EnsureCoreTools, so doHandoffToDoctor
// computes and prints the message itself. It is consume-once: reading it clears
// the cache so a subsequent install in the same process starts fresh.
var pythonPreflightReported *pythonPreflight

// consumeReportedPythonPreflight returns the preflight previously surfaced by
// reportPythonPreflight (and whether one was cached), clearing the cache so the
// result is reused at most once.
func consumeReportedPythonPreflight() (pythonPreflight, bool) {
	if pythonPreflightReported == nil {
		return pythonPreflight{}, false
	}
	pf := *pythonPreflightReported
	pythonPreflightReported = nil
	return pf, true
}

// reportPythonPreflight runs the interpreter preflight and prints either a
// concise confirmation (documenting the DEFT_PYTHON override) or a loud,
// actionable error block when no compatible 3.11+ interpreter resolves. The
// outcome is cached for the later doctor handoff (see pythonPreflightReported)
// so the actionable message is not printed twice on the --yes/CI path. It never
// returns an error / aborts on its own -- aborting the whole install requires
// the caller's flow control -- but the prominent message is the install-time
// "fail loud" the #1668 issue asks for.
func reportPythonPreflight(w *Wizard) pythonPreflight {
	pf := runPythonPreflight()
	cached := pf
	pythonPreflightReported = &cached
	if pf.ok {
		w.printf("Python preflight: %s satisfies the 3.11+ requirement (resolved via %s).\n", pf.version.String(), pf.resolved.source)
		w.printf("  Override the interpreter with DEFT_PYTHON=<full path> if needed.\n")
		return pf
	}
	w.printf("\n[deft-install] Python preflight FAILED -- the install will not be usable until this is fixed:\n")
	w.printf("%s", pythonPreflightMessage(pf))
	return pf
}

// doctorHandoffCommand builds the interpreter binary and argv for the
// post-install doctor handoff from a successful preflight. Extracted as a pure
// helper so the interpreter-resolution wiring (incl. the `py -3` prefix) is
// testable without shelling out.
func doctorHandoffCommand(pf pythonPreflight, scriptsDoctor, projectDir string, jsonOut bool) (string, []string) {
	args := append([]string{}, pf.resolved.prefixArgs...)
	// --full bypasses the 24h/4h throttle gate in scripts/doctor.py so the
	// installer-doctor handoff always runs the staleness check (Greptile P1
	// on #1384: throttle could otherwise short-circuit the post-install
	// report whenever doctor was recently run from another entry point).
	args = append(args, scriptsDoctor, "--session", "--full")
	if jsonOut {
		args = append(args, "--json")
	}
	args = append(args, "--project-root", projectDir)
	return pf.resolved.bin, args
}

// doHandoffToDoctor implements the #1339 (Epic-5) deterministic installer-to-doctor
// handoff. It is invoked unconditionally at the end of every successful
// install/update so that both human operators and agents receive the
// --session report (which now includes payload staleness detection against
// the manifest sha). The --json flag is forwarded only when the installer
// itself is in --json mode so interactive humans see prose output rather
// than a raw JSON blob (Greptile P1 on #1384). The call is best-effort and
// never fails the overall install.
//
// #1668: the interpreter is resolved via the preflight (DEFT_PYTHON / python /
// python3 / the `py` launcher) rather than hardcoded to python/python3, which
// is usually absent on Windows. When no compatible 3.11+ interpreter resolves
// the handoff degrades to a concise actionable message instead of streaming a
// raw ImportError traceback from doctor.py to the operator.
func doHandoffToDoctor(w *Wizard, result *WizardResult, jsonOut bool) {
	scriptsDoctor := filepath.Join(result.DeftDir, "scripts", "doctor.py")
	if _, err := os.Stat(scriptsDoctor); err != nil {
		w.printf("(doctor handoff skipped: canonical doctor not present at %s)\n", scriptsDoctor)
		return
	}

	// Reuse the preflight already surfaced by reportPythonPreflight on the
	// --yes/CI path (EnsureCoreTools) so we neither re-probe the interpreter
	// nor re-print the actionable message a second time (#1676). On the
	// interactive path nothing was reported yet, so compute + print here.
	pf, alreadyReported := consumeReportedPythonPreflight()
	if !alreadyReported {
		pf = runPythonPreflight()
	}
	if !pf.ok {
		w.printf("\n--- Doctor handoff skipped: no compatible Python interpreter (3.11+) ---\n")
		if alreadyReported {
			w.printf("(See the Python preflight message above for the fix.)\n")
		} else {
			w.printf("%s", pythonPreflightMessage(pf))
		}
		w.printf("(Re-run the doctor with `task doctor` once a 3.11+ interpreter is available.)\n")
		return
	}

	bin, doctorArgs := doctorHandoffCommand(pf, scriptsDoctor, result.ProjectDir, jsonOut)
	cmd := exec.Command(bin, doctorArgs...)
	cmd.Stdout = w.out
	cmd.Stderr = w.out

	modeLabel := "prose"
	if jsonOut {
		modeLabel = "JSON"
	}
	w.printf("\n--- Doctor handoff (post-install state via --session --full %s; interpreter resolved via %s) ---\n", modeLabel, pf.resolved.source)
	if err := cmd.Run(); err != nil {
		// Non-fatal: the report (or any error detail) has already been
		// emitted above; we simply note that the doctor surfaced issues.
		w.printf("(doctor handoff completed; see report above for any warnings/recommendations)\n")
	}
}
