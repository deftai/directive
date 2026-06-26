package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/deftai/directive/content/templates"
)

// gate.go -- read-only, node-independent health-gate subcommand for the frozen
// deft-install binary (#1933 Option 3 / #2001 §1).
//
// This is the npm-era replacement for `python3 .deft/core/run gate`. The gate
// MUST run when the Node engine (and the Python `run` shim) is missing or
// broken -- the bootstrap paradox -- so it cannot be a Node CLI verb. It is a
// faithful Go port of the read-only logic in the Python `run` script's
// `cmd_gate` / `_build_gate_state` / `_gate_state_is_ok` / `_format_gate_line`
// helpers (and the detectors they reuse: `_read_version_marker`,
// `_detect_pre_cutover_legacy`, `_classify_agents_md`,
// `_running_inside_deft_repo`).
//
// The gate is a PROBE: it NEVER writes, NEVER touches AGENTS.md, NEVER migrates
// or reshapes the install layout. It prints a one-line state vector and exits:
//
//	healthy:        OK v<current>                                       (exit 0)
//	needs upgrade:  NEEDS-UPGRADE recorded=<recorded|unknown> \
//	                  current=<current> precutover=<csv|empty> \
//	                  agents-md=<current|stale|missing|absent>          (exit 1)
//
// An optional --json flag emits the same state vector as a JSON object on
// stdout (mirrors the Python `cmd_gate --json` surface).

// --- Managed-section marker contract (mirrors scripts/_agents_md.py) --------

// gateManagedOpenRE accepts the v1, v2 and v3 managed-section open markers,
// with or without the v3 provenance attributes (sha=/refreshed=/session=).
// Group 1 is the version digit. Mirrors `_AGENTS_MANAGED_OPEN_RE` so a legacy
// v1/v2 consumer marker classifies as stale (force-upgrade to v3).
var gateManagedOpenRE = regexp.MustCompile(`<!--\s*deft:managed-section\s+v(1|2|3)(?:\s+([^>]*?))?\s*-->`)

const (
	gateManagedClose      = "<!-- /deft:managed-section -->"
	gateManagedOpenBareV3 = "<!-- deft:managed-section v3 -->"
)

// --- Pre-cutover legacy detection (mirrors scripts/_precutover.py) ----------

const (
	gateDeprecatedRedirectSentinel = "<!-- deft:deprecated-redirect -->"
	gateDeprecationRedirectPurpose = "<!-- Purpose: deprecation redirect -->"
	gateGeneratedSpecPurpose       = "<!-- Purpose: rendered specification -->"
	gateGeneratedSpecSource        = "<!-- Source of truth: vbrief/specification.vbrief.json -->"
)

// gateState is the read-only state vector computed by buildGateState. It is the
// Go analogue of the dict returned by the Python `_build_gate_state`.
type gateState struct {
	current        string // the frozen binary's build-time version (main.version)
	recorded       string // contents of the version marker, when present
	recordedSet    bool   // whether a version marker was found at all
	precutover     []string
	agentsMD       string // current | stale | missing | absent
	insideDeftRepo bool
}

// gateIsRegularFile reports whether path exists and is a regular file.
func gateIsRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// gateIsDir reports whether path exists and is a directory.
func gateIsDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// gateReadVersionMarker returns the recorded framework version, mirroring the
// Python `_read_version_marker`: it prefers vbrief/.deft-version then falls
// back to .deft-version at the project root. The second return value reports
// whether any marker was found (distinct from an empty marker file).
func gateReadVersionMarker(projectRoot string) (string, bool) {
	candidates := []string{
		filepath.Join(projectRoot, "vbrief", ".deft-version"),
		filepath.Join(projectRoot, ".deft-version"),
	}
	for _, candidate := range candidates {
		if !gateIsRegularFile(candidate) {
			continue
		}
		data, err := os.ReadFile(candidate)
		if err != nil {
			// Mirrors the Python fall-through on an unreadable preferred
			// path: try the next candidate rather than suppressing drift.
			continue
		}
		return strings.TrimSpace(string(data)), true
	}
	return "", false
}

// gateIsDeprecationRedirect mirrors `_precutover.is_deprecation_redirect`.
func gateIsDeprecationRedirect(content string) bool {
	return strings.Contains(content, gateDeprecatedRedirectSentinel) ||
		strings.Contains(content, gateDeprecationRedirectPurpose)
}

// gateIsGeneratedSpecExport mirrors
// `_precutover.is_generated_specification_export`: the banner alone is not
// enough -- the declared vBRIEF source must also exist on disk.
func gateIsGeneratedSpecExport(projectRoot, content string) bool {
	if !strings.Contains(content, gateGeneratedSpecPurpose) {
		return false
	}
	if !strings.Contains(content, gateGeneratedSpecSource) {
		return false
	}
	return gateIsRegularFile(filepath.Join(projectRoot, "vbrief", "specification.vbrief.json"))
}

// gateRootMarkdownIsLegacy mirrors `_precutover.root_markdown_is_legacy`.
func gateRootMarkdownIsLegacy(projectRoot, filename, content string) bool {
	if gateIsDeprecationRedirect(content) {
		return false
	}
	if filename == "SPECIFICATION.md" && gateIsGeneratedSpecExport(projectRoot, content) {
		return false
	}
	return filename == "SPECIFICATION.md" || filename == "PROJECT.md"
}

// gateDetectPreCutoverLegacy mirrors `_precutover.detect_pre_cutover_legacy`:
// it returns the root markdown filenames that are legacy pre-v0.20 inputs.
func gateDetectPreCutoverLegacy(projectRoot string) []string {
	legacy := []string{}
	for _, filename := range []string{"SPECIFICATION.md", "PROJECT.md"} {
		candidate := filepath.Join(projectRoot, filename)
		if !gateIsRegularFile(candidate) {
			continue
		}
		data, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		if gateRootMarkdownIsLegacy(projectRoot, filename, string(data)) {
			legacy = append(legacy, filename)
		}
	}
	return legacy
}

// gateIterManagedSections returns every well-formed managed-section block
// (open marker through close marker, inclusive) in text. Mirrors the Python
// `_iter_managed_sections`.
func gateIterManagedSections(text string) []string {
	var results []string
	pos := 0
	for pos <= len(text) {
		loc := gateManagedOpenRE.FindStringIndex(text[pos:])
		if loc == nil {
			break
		}
		openStart := pos + loc[0]
		openEnd := pos + loc[1]
		closeOff := strings.Index(text[openEnd:], gateManagedClose)
		if closeOff < 0 {
			break
		}
		end := openEnd + closeOff + len(gateManagedClose)
		results = append(results, text[openStart:end])
		pos = end
	}
	return results
}

// gateManagedSectionVersion returns the marker version (1, 2 or 3) for the
// first open marker in block, or 0 when no marker matches.
func gateManagedSectionVersion(block string) int {
	m := gateManagedOpenRE.FindStringSubmatch(block)
	if m == nil {
		return 0
	}
	switch m[1] {
	case "1":
		return 1
	case "2":
		return 2
	case "3":
		return 3
	}
	return 0
}

// gateStripManagedSectionAttrs normalises the FIRST open marker in section to
// the bare v3 form so per-refresh attributes (sha=/refreshed=/session=) do not
// poison byte-equality comparisons. Mirrors `_strip_managed_section_attrs`.
func gateStripManagedSectionAttrs(section string) string {
	loc := gateManagedOpenRE.FindStringIndex(section)
	if loc == nil {
		return section
	}
	return section[:loc[0]] + gateManagedOpenBareV3 + section[loc[1]:]
}

// gateRenderTemplateManagedSection extracts the managed-section block from the
// embedded canonical template (templates.AgentsEntry == content/templates/
// agents-entry.md), with the open marker normalised to bare v3. Mirrors the
// Python `_render_managed_section(_read_agents_template())`. The boolean is
// false when the embedded template is missing the markers (treated by the
// caller as "do not fire", matching the Python fall-through to "current").
func gateRenderTemplateManagedSection() (string, bool) {
	normalised := strings.ReplaceAll(templates.AgentsEntry, "\r\n", "\n")
	loc := gateManagedOpenRE.FindStringIndex(normalised)
	if loc == nil {
		return "", false
	}
	closeOff := strings.Index(normalised[loc[1]:], gateManagedClose)
	if closeOff < 0 {
		return "", false
	}
	end := loc[1] + closeOff + len(gateManagedClose)
	return gateStripManagedSectionAttrs(normalised[loc[0]:end]), true
}

// gateClassifyAgentsMD returns one of current | stale | missing | absent for
// the consumer's ./AGENTS.md. Faithful port of the Python `_classify_agents_md`:
//
//   - absent  -> ./AGENTS.md does not exist (or is unreadable)
//   - missing -> exists but has no managed-section markers
//   - stale   -> markers present but bytes != current template render, OR a
//     legacy v1/v2 marker (force upgrade to v3), OR more than one managed block
//   - current -> exactly one managed block byte-identical to the template
//     render after normalising the open marker to bare v3
//
// A missing/malformed embedded template falls through to "current" so the gate
// never fires solely because the framework payload is incomplete.
func gateClassifyAgentsMD(projectRoot string) string {
	path := filepath.Join(projectRoot, "AGENTS.md")
	if !gateIsRegularFile(path) {
		return "absent"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "absent"
	}
	normalised := strings.ReplaceAll(string(data), "\r\n", "\n")
	blocks := gateIterManagedSections(normalised)
	if len(blocks) == 0 {
		return "missing"
	}
	if len(blocks) > 1 {
		return "stale"
	}
	extracted := blocks[0]
	if v := gateManagedSectionVersion(extracted); v == 1 || v == 2 {
		return "stale"
	}
	rendered, ok := gateRenderTemplateManagedSection()
	if !ok {
		return "current"
	}
	if gateStripManagedSectionAttrs(extracted) == rendered {
		return "current"
	}
	return "stale"
}

// gateRunningInsideDeftRepo is the Go analogue of `_running_inside_deft_repo`:
// it reports True only when run from inside the deft framework source checkout
// itself, so the maintainer is never nagged by the consumer-facing upgrade
// flow. It fires only when main.md is present at the root, NEITHER install
// location (deft/ nor .deft/core/) exists, AND all framework-internal positive
// markers resolve.
func gateRunningInsideDeftRepo(projectRoot string) bool {
	if !gateIsRegularFile(filepath.Join(projectRoot, "main.md")) {
		return false
	}
	if gateIsDir(filepath.Join(projectRoot, "deft")) {
		return false
	}
	if gateIsDir(filepath.Join(projectRoot, ".deft", "core")) {
		return false
	}
	markers := []string{
		filepath.Join(projectRoot, "templates", "agents-entry.md"),
		filepath.Join(projectRoot, "skills", "deft-directive-build", "SKILL.md"),
	}
	for _, marker := range markers {
		if !gateIsRegularFile(marker) {
			return false
		}
	}
	return true
}

// buildGateState computes the full read-only state vector. Pure with respect to
// the filesystem: it only reads under projectRoot and the embedded template.
func buildGateState(projectRoot string) gateState {
	recorded, recordedSet := gateReadVersionMarker(projectRoot)
	return gateState{
		current:        version,
		recorded:       recorded,
		recordedSet:    recordedSet,
		precutover:     gateDetectPreCutoverLegacy(projectRoot),
		agentsMD:       gateClassifyAgentsMD(projectRoot),
		insideDeftRepo: gateRunningInsideDeftRepo(projectRoot),
	}
}

// gateStateIsOK reports whether the state vector indicates no upgrade work is
// needed. Faithful port of the Python `_gate_state_is_ok` precedence.
func gateStateIsOK(s gateState) bool {
	if s.insideDeftRepo {
		// Maintainer working inside the deft repo itself -- never blocked by
		// the consumer-facing upgrade flow.
		return true
	}
	if len(s.precutover) > 0 {
		return false
	}
	if s.recordedSet && s.recorded != s.current {
		return false
	}
	if s.agentsMD == "stale" || s.agentsMD == "missing" {
		return false
	}
	return true
}

// formatGateLine renders the one-line text surface consumed by the AGENTS.md
// preamble. Faithful port of the Python `_format_gate_line`.
func formatGateLine(s gateState) string {
	if gateStateIsOK(s) {
		return fmt.Sprintf("OK v%s", s.current)
	}
	recorded := s.recorded
	if !s.recordedSet || recorded == "" {
		recorded = "unknown"
	}
	precutover := strings.Join(s.precutover, ",")
	agentsMD := s.agentsMD
	if agentsMD == "" {
		agentsMD = "absent"
	}
	return fmt.Sprintf(
		"NEEDS-UPGRADE recorded=%s current=%s precutover=%s agents-md=%s",
		recorded, s.current, precutover, agentsMD,
	)
}

// gateJSONPayload builds the --json object, mirroring the Python cmd_gate JSON
// shape (recorded is null when no marker was found; precutover is always an
// array).
func gateJSONPayload(s gateState) map[string]any {
	status := "needs-upgrade"
	if gateStateIsOK(s) {
		status = "ok"
	}
	var recorded any
	if s.recordedSet {
		recorded = s.recorded
	}
	precutover := s.precutover
	if precutover == nil {
		precutover = []string{}
	}
	return map[string]any{
		"status":           status,
		"current":          s.current,
		"recorded":         recorded,
		"precutover":       precutover,
		"agents-md":        s.agentsMD,
		"inside_deft_repo": s.insideDeftRepo,
	}
}

// runGate is the gate subcommand entry point. It reads the current working
// directory as the project root and returns the process exit code.
func runGate(args []string) int {
	jsonMode := false
	for _, arg := range args {
		if arg == "--json" {
			jsonMode = true
		}
	}
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot determine working directory: %v\n", err)
		return 2
	}
	return runGateInDir(cwd, jsonMode, os.Stdout)
}

// runGateInDir is the testable core of the gate: it computes the state vector
// for projectRoot, writes the chosen surface to out, and returns the exit code
// (0 healthy, 1 needs-upgrade). Split out from runGate so tests drive it with a
// temp project root and a buffer rather than chdir + stdout capture.
func runGateInDir(projectRoot string, jsonMode bool, out io.Writer) int {
	state := buildGateState(projectRoot)
	if jsonMode {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		if err := enc.Encode(gateJSONPayload(state)); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: JSON encode failed: %v\n", err)
		}
	} else {
		fmt.Fprintln(out, formatGateLine(state))
	}
	if gateStateIsOK(state) {
		return 0
	}
	return 1
}
