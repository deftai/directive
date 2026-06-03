package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// coreGlob is the gitignore/linguist/CodeQL-style glob that matches every file
// under the vendored framework payload. The payload at .deft/core/ is packaged,
// machine-managed framework code (#1428) -- not consumer source -- so the
// neutralization deposit (#1430) tells linguist, bot reviewers, and CI to treat
// it as such.
const coreGlob = ".deft/core/**"

// coreGitattributesLines mark the vendored payload as generated AND vendored so
// GitHub's linguist excludes it from language statistics and collapses it in
// diffs. Mirrors the line-based, idempotent contract of EnsureGitignoreLines.
var coreGitattributesLines = []string{
	coreGlob + " linguist-generated=true",
	coreGlob + " linguist-vendored=true",
}

// codeqlConfigRelPath / coreGuardWorkflowRelPath are the POSIX-relative deposit
// locations (converted to OS-native separators at use sites).
const (
	codeqlConfigRelPath      = ".github/codeql/codeql-config.yml"
	coreGuardWorkflowRelPath = ".github/workflows/deft-core-guard.yml"
)

// frameworkSelfTestRelPath is the framework's own pytest suite as vendored into
// a consumer install at .deft/core/tests/. Those tests validate the framework
// inside its OWN repo (deftai/directive) and depend on framework-repo-only
// fixtures (the framework CI workflows, the framework's vbrief/.eval/README.md,
// the dev version string), so they fail by construction in any consumer
// checkout -- the always-red `task deft:check` reported 14 failed + 6 errors
// (#1474). pruneFrameworkSelfTests excludes the suite from the consumer deposit
// so the framework-repo-only self-tests are never vendored (and therefore never
// executed) in a consumer project. The canonical .deft/core/ layout is assumed,
// mirroring coreGlob.
const frameworkSelfTestRelPath = ".deft/core/tests"

// installerManagedMatcher classifies a single repo-relative (POSIX-separated)
// changed path as installer-managed -- i.e. deposited and maintained by
// deft-install / upgrade outside .deft/core/, not consumer app code. A matcher
// is either an exact path or a directory prefix (any path beneath it).
type installerManagedMatcher struct {
	exact  string // full repo-relative path matched verbatim
	prefix string // directory prefix (trailing slash) matching any path beneath it
}

// matches reports whether a repo-relative POSIX path is covered by the matcher.
func (m installerManagedMatcher) matches(path string) bool {
	if m.exact != "" {
		return path == m.exact
	}
	return m.prefix != "" && strings.HasPrefix(path, m.prefix)
}

// ere renders the matcher as one anchored POSIX ERE atom equivalent to
// matches(): an exact path becomes ^path$ and a prefix becomes ^prefix.
func (m installerManagedMatcher) ere() string {
	if m.exact != "" {
		return "^" + escapeERE(m.exact) + "$"
	}
	return "^" + escapeERE(m.prefix)
}

// escapeERE backslash-escapes the POSIX ERE metacharacters in s so a literal
// path fragment is matched verbatim by both grep -E and Go's regexp.
func escapeERE(s string) string {
	const meta = `.^$*+?()[]{}|\`
	var b strings.Builder
	for _, r := range s {
		if r < 128 && strings.ContainsRune(meta, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// installerManagedMatchers is the single source of truth for the installer's own
// non-core deposit surface (#1440). It feeds BOTH the deposited deft-core-guard
// regex (via installerManagedGuardERE) and the Go classifier
// (classifyChangedPaths), so the guard the installer writes can never drift from
// what the installer actually manages.
//
// CRITICAL: this allowlist MUST NOT cover consumer-authored vBRIEF data
// (vbrief/PROJECT-DEFINITION.vbrief.json, vbrief/**/*.vbrief.json). Mixing that
// with a .deft/core/** change MUST still trip the guard -- that separation is
// the whole point of #1430. The vbrief entries below are scaffolding only
// (.deft-version, vbrief.md, schemas/, migration/, and the per-lifecycle
// .gitkeep placeholders), derived from vbriefLifecycleDirs so they stay in
// lockstep with what WriteConsumerVbrief deposits.
func installerManagedMatchers() []installerManagedMatcher {
	matchers := []installerManagedMatcher{
		{exact: "AGENTS.md"},
		{prefix: ".agents/"},
		// .githooks/ is deposited by WriteConsumerGitHooks (#1463): the
		// layout-aware pre-commit / pre-push copied to the consumer root. It
		// is framework-managed, not consumer app code, so the guard exempts it
		// and frameworkStagePaths stages it with the framework deposit.
		{prefix: ".githooks/"},
		{exact: ".gitattributes"},
		{exact: ".gitignore"},
		{exact: "greptile.json"},
		{exact: codeqlConfigRelPath},
		{exact: coreGuardWorkflowRelPath},
		{exact: "vbrief/.deft-version"},
		{exact: "vbrief/vbrief.md"},
		{prefix: "vbrief/schemas/"},
		{prefix: "vbrief/migration/"},
	}
	for _, sub := range vbriefLifecycleDirs {
		matchers = append(matchers, installerManagedMatcher{exact: "vbrief/" + sub + "/.gitkeep"})
	}
	return matchers
}

// installerManagedGuardERE renders the installer-managed allowlist as one POSIX
// ERE alternation (atoms joined by "|") suitable for `grep -E`. It is the exact
// pattern embedded in the deposited guard AND the pattern classifyChangedPaths
// mirrors, so the two cannot diverge. The atoms contain no single quotes, so the
// result is safe to embed inside a single-quoted shell string.
func installerManagedGuardERE() string {
	matchers := installerManagedMatchers()
	atoms := make([]string, len(matchers))
	for i, m := range matchers {
		atoms[i] = m.ere()
	}
	return strings.Join(atoms, "|")
}

// classifyChangedPaths splits a PR's changed (repo-relative, POSIX) paths into
// the three buckets the deft-core-guard reasons about: framework payload
// (.deft/core/**), installer-managed deposits (the #1440 allowlist), and app
// (everything else -- consumer source AND consumer vBRIEF data). The guard fails
// iff both core and app are non-empty. Empty strings are ignored. This mirrors
// the shell logic rendered by coreGuardWorkflowContent so the Go tests can pin
// the guard's semantics without executing bash.
func classifyChangedPaths(changed []string) (core, installerManaged, app []string) {
	matchers := installerManagedMatchers()
	for _, p := range changed {
		if p == "" {
			continue
		}
		switch {
		case strings.HasPrefix(p, ".deft/core/"):
			core = append(core, p)
		case matchesAnyInstallerManaged(matchers, p):
			installerManaged = append(installerManaged, p)
		default:
			app = append(app, p)
		}
	}
	return core, installerManaged, app
}

// matchesAnyInstallerManaged reports whether path is covered by any matcher.
func matchesAnyInstallerManaged(matchers []installerManagedMatcher, path string) bool {
	for _, m := range matchers {
		if m.matches(path) {
			return true
		}
	}
	return false
}

// guardWouldFail reports the deposited guard's decision for a set of changed
// paths: it fails a PR iff the diff mixes the framework payload (.deft/core/**)
// with genuine app paths (after subtracting the installer-managed allowlist).
func guardWouldFail(changed []string) bool {
	core, _, app := classifyChangedPaths(changed)
	return len(core) > 0 && len(app) > 0
}

// coreGuardWorkflowContent renders the optional CI guard deposited at
// coreGuardWorkflowRelPath (#1430, #1440). It fails a PR that mixes changes to
// the vendored framework payload (.deft/core/**) with changes to the consumer's
// own files, so a framework update from deft-install/upgrade lands in its own PR
// and reviewers can treat it as a packaged, machine-managed bump. It is
// deposited create-if-absent and is safe for consumers to delete.
//
// The "app" set subtracts the installer-managed allowlist (#1440) so a
// `deft-install --upgrade` PR -- which legitimately rewrites root files like
// AGENTS.md and vbrief scaffolding alongside .deft/core/** -- is no longer
// rejected by construction. The allowlist regex is rendered from
// installerManagedGuardERE so the deposited guard and the installer never drift.
func coreGuardWorkflowContent() string {
	return `name: deft-core-guard

# Deft framework guard (#1430): a single PR should not mix changes to the
# vendored framework payload (.deft/core/**) with changes to your own project
# files. Framework updates come from ` + "`deft-install`" + ` / upgrade and should
# land in their own PR so reviewers (and bot reviewers) can treat them as
# packaged, machine-managed assets. Delete this file if you do not want the guard.
on:
  pull_request:

permissions:
  contents: read

jobs:
  no-mixed-core-and-app:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Refuse PRs that mix .deft/core/** with non-framework paths
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          set -eu
          changed=$(git diff --name-only "$BASE_SHA" "$HEAD_SHA")
          echo "Changed files:"
          echo "$changed"
          core=$(printf '%s\n' "$changed" | grep -E '^\.deft/core/' || true)
          # Installer-managed deposits (deft-install / upgrade writes these
          # outside .deft/core/, e.g. AGENTS.md, .agents/, vbrief scaffolding)
          # are part of the framework deposit, not consumer app code, so they are
          # subtracted from the "app" set (#1440). Consumer vBRIEF data
          # (vbrief/**/*.vbrief.json) is intentionally NOT exempt and still trips
          # the guard when mixed with a .deft/core/** change.
          app=$(printf '%s\n' "$changed" | grep -vE '^\.deft/core/' | grep -vE '` + installerManagedGuardERE() + `' | grep -v '^$' || true)
          if [ -n "$core" ] && [ -n "$app" ]; then
            echo "::error title=deft-core guard (#1430)::This PR changes the vendored framework payload (.deft/core/**) AND non-framework files. Split the framework update into its own PR."
            echo "--- framework (.deft/core/**) changes ---"; printf '%s\n' "$core"
            echo "--- non-framework changes ---"; printf '%s\n' "$app"
            exit 1
          fi
          echo "OK: no mixed framework + app changes."
`
}

// depositNeutralization performs the #1430 deposit so the vendored framework
// payload at .deft/core/** is treated as packaged framework assets rather than
// consumer source by linguist, the Greptile/CodeQL bot reviewers, and an
// optional CI guard. It also prunes the framework's own self-test suite from the
// consumer deposit (#1474) so `task deft:check` never runs framework-repo-only
// tests. Every step is best-effort: a deposit failure (e.g. a malformed
// pre-existing config the installer refuses to rewrite) is logged as a warning
// and never aborts the install, mirroring WriteInstallManifest.
func depositNeutralization(w *Wizard, projectDir string) {
	if _, err := EnsureGitattributes(w, projectDir); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not deposit .gitattributes: %v\n", err)
	}
	if _, err := EnsureGreptileIgnore(w, projectDir); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not deposit Greptile ignore: %v\n", err)
	}
	if _, err := EnsureCodeQLPathsIgnore(w, projectDir); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not deposit CodeQL paths-ignore: %v\n", err)
	}
	if _, err := EnsureCoreGuardWorkflow(w, projectDir); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not deposit CI guard workflow: %v\n", err)
	}
	if _, err := pruneFrameworkSelfTests(w, projectDir); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not prune framework self-tests: %v\n", err)
	}
}

// pruneFrameworkSelfTests removes the vendored framework self-test suite
// (.deft/core/tests/) from a consumer install so the framework-repo-only tests
// are never shipped -- and therefore never executed by the consumer-facing
// `task deft:check` (#1474). It runs on every install (fresh + upgrade), after
// the payload deposit, so a re-vendored tree is re-pruned. Returns true when the
// suite was present and removed; an absent suite is a clean no-op (false, nil).
// The canonical .deft/core/ layout is assumed, matching the rest of this
// neutralization deposit (coreGlob). Best-effort by contract: the caller treats
// a removal failure as non-fatal, mirroring depositNeutralization.
func pruneFrameworkSelfTests(w *Wizard, projectDir string) (bool, error) {
	path := filepath.Join(projectDir, filepath.FromSlash(frameworkSelfTestRelPath))
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("could not stat %s: %w", frameworkSelfTestRelPath, err)
	}
	if !info.IsDir() {
		// A regular file at that path is not the framework test suite; leave it.
		return false, nil
	}
	if err := os.RemoveAll(path); err != nil {
		return false, fmt.Errorf("could not remove %s: %w", frameworkSelfTestRelPath, err)
	}
	w.printf("Removed vendored framework self-tests (%s) from the consumer deposit (#1474).\n", frameworkSelfTestRelPath)
	return true, nil
}

// EnsureGitattributes appends the linguist generated/vendored markers for
// .deft/core/** to the consumer's .gitattributes if any line is missing. The
// file is created when absent; pre-existing lines are preserved byte-for-byte.
// Mirrors EnsureGitignoreLines (#1430). Returns true if the file was modified.
func EnsureGitattributes(w *Wizard, projectDir string) (bool, error) {
	path := filepath.Join(projectDir, ".gitattributes")
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("could not read .gitattributes: %w", err)
	}
	existing := ""
	if err == nil {
		existing = string(data)
	}

	// Build the set of existing lines via strings.Split (not bufio.Scanner) so
	// an over-long line can never silently truncate the idempotency probe.
	present := map[string]bool{}
	for _, line := range strings.Split(existing, "\n") {
		present[strings.TrimSpace(line)] = true
	}

	var additions []string
	for _, line := range coreGitattributesLines {
		if !present[line] {
			additions = append(additions, line)
		}
	}
	if len(additions) == 0 {
		w.printf(".gitattributes already marks %s as generated/vendored — skipping.\n", coreGlob)
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
	body.WriteString("# Deft framework: the vendored payload is packaged framework code, not\n")
	body.WriteString("# consumer source. Mark it generated + vendored so language stats and\n")
	body.WriteString("# diffs treat .deft/core/** as machine-managed (#1430).\n")
	for _, add := range additions {
		body.WriteString(add)
		body.WriteString("\n")
	}

	if err := os.WriteFile(path, []byte(body.String()), 0o644); err != nil {
		return false, fmt.Errorf("could not write .gitattributes: %w", err)
	}
	w.printf(".gitattributes updated with linguist markers: %s\n", strings.Join(additions, ", "))
	return true, nil
}

// EnsureGreptileIgnore ensures the consumer's greptile.json ignores
// .deft/core/** during bot review (#1430). The file is created when absent. When
// present, only the newline-separated `ignorePatterns` string is touched --
// every other field is preserved verbatim via json.RawMessage. If
// `ignorePatterns` exists but is not a string (a shape the documented Greptile
// schema does not use), the file is left unchanged and an error is returned so
// the installer never corrupts a config it does not understand. Returns true if
// the file was created or modified.
func EnsureGreptileIgnore(w *Wizard, projectDir string) (bool, error) {
	path := filepath.Join(projectDir, "greptile.json")
	data, readErr := os.ReadFile(path)
	exists := true
	if readErr != nil {
		if !errors.Is(readErr, os.ErrNotExist) {
			return false, fmt.Errorf("could not read greptile.json: %w", readErr)
		}
		exists = false
	}
	// Treat an empty (or whitespace-only) existing file as an empty object so
	// json.Unmarshal does not fail on a 0-byte greptile.json.
	if !exists || strings.TrimSpace(string(data)) == "" {
		data = []byte("{}")
	}

	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return false, fmt.Errorf("could not parse greptile.json (leaving it unchanged): %w", err)
	}
	if obj == nil {
		obj = map[string]json.RawMessage{}
	}

	patterns := ""
	if raw, ok := obj["ignorePatterns"]; ok {
		if err := json.Unmarshal(raw, &patterns); err != nil {
			return false, fmt.Errorf("greptile.json ignorePatterns is not a newline-separated string (%w); leaving it unchanged", err)
		}
	}
	if exists && greptilePatternPresent(patterns, coreGlob) {
		w.printf("greptile.json already ignores %s — skipping.\n", coreGlob)
		return false, nil
	}

	patterns = appendGreptilePattern(patterns, coreGlob)
	encoded, err := json.Marshal(patterns)
	if err != nil {
		return false, fmt.Errorf("could not encode ignorePatterns: %w", err)
	}

	// Preserve the consumer's original top-level key order. A Go map emits keys
	// sorted, which would shuffle the file on first deposit and create diff
	// noise in consumer repos.
	orderedKeys, err := orderedTopLevelKeys(data)
	if err != nil {
		return false, fmt.Errorf("could not parse greptile.json key order (leaving it unchanged): %w", err)
	}
	if _, existed := obj["ignorePatterns"]; !existed {
		orderedKeys = append(orderedKeys, "ignorePatterns")
	}
	obj["ignorePatterns"] = encoded

	out, err := marshalObjectOrdered(obj, orderedKeys)
	if err != nil {
		return false, fmt.Errorf("could not encode greptile.json: %w", err)
	}
	if err := os.WriteFile(path, out, 0o644); err != nil {
		return false, fmt.Errorf("could not write greptile.json: %w", err)
	}
	if exists {
		w.printf("greptile.json updated: bot review now ignores %s.\n", coreGlob)
	} else {
		w.printf("greptile.json created: bot review ignores %s.\n", coreGlob)
	}
	return true, nil
}

// greptilePatternPresent reports whether the newline-separated patterns string
// already contains the glob as a standalone line.
func greptilePatternPresent(patterns, glob string) bool {
	for _, line := range strings.Split(patterns, "\n") {
		if strings.TrimSpace(line) == glob {
			return true
		}
	}
	return false
}

// appendGreptilePattern appends glob to the newline-separated patterns string,
// inserting a separating newline only when the existing value is non-empty.
func appendGreptilePattern(patterns, glob string) string {
	if strings.TrimSpace(patterns) == "" {
		return glob
	}
	if strings.HasSuffix(patterns, "\n") {
		return patterns + glob
	}
	return patterns + "\n" + glob
}

// orderedTopLevelKeys returns the top-level object keys of a JSON document in
// document order (encoding/json maps lose order). Used so EnsureGreptileIgnore
// rewrites greptile.json without reshuffling the consumer's existing fields.
func orderedTopLevelKeys(data []byte) ([]string, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("expected a JSON object")
	}
	var keys []string
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := kt.(string)
		if !ok {
			return nil, fmt.Errorf("expected a string object key")
		}
		keys = append(keys, key)
		if err := skipJSONValue(dec); err != nil {
			return nil, err
		}
	}
	return keys, nil
}

// skipJSONValue consumes exactly one JSON value (scalar, object, or array) from
// dec, tracking nesting depth so nested structures are skipped whole.
func skipJSONValue(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); ok && (d == '{' || d == '[') {
		depth := 1
		for depth > 0 {
			t, err := dec.Token()
			if err != nil {
				return err
			}
			if dd, ok := t.(json.Delim); ok {
				if dd == '{' || dd == '[' {
					depth++
				} else {
					depth--
				}
			}
		}
	}
	return nil
}

// marshalObjectOrdered serialises obj as indented JSON with keys emitted in the
// given order (keys absent from obj are skipped). Values are written verbatim
// from their json.RawMessage, then the whole document is normalised via
// json.Indent so indentation is consistent.
func marshalObjectOrdered(obj map[string]json.RawMessage, keys []string) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	first := true
	for _, k := range keys {
		v, ok := obj[k]
		if !ok {
			continue
		}
		if !first {
			buf.WriteByte(',')
		}
		first = false
		kb, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		buf.Write(kb)
		buf.WriteByte(':')
		buf.Write(v)
	}
	buf.WriteByte('}')
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, buf.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	pretty.WriteByte('\n')
	return pretty.Bytes(), nil
}

// EnsureCodeQLPathsIgnore ensures a CodeQL config at
// .github/codeql/codeql-config.yml excludes .deft/core/** from analysis (#1430).
// The file (and its parent dir) is created when absent. When present and the
// glob is already excluded it is a no-op; otherwise the entry is inserted as the
// first child of an existing top-level `paths-ignore:` block, or a fresh
// `paths-ignore:` block is appended when none exists. Returns true if the file
// was created or modified.
func EnsureCodeQLPathsIgnore(w *Wizard, projectDir string) (bool, error) {
	path := filepath.Join(projectDir, filepath.FromSlash(codeqlConfigRelPath))
	data, readErr := os.ReadFile(path)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return false, fmt.Errorf("could not read %s: %w", codeqlConfigRelPath, readErr)
	}
	if errors.Is(readErr, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return false, fmt.Errorf("could not create CodeQL config dir: %w", err)
		}
		if err := os.WriteFile(path, []byte(codeqlConfigDefault()), 0o644); err != nil {
			return false, fmt.Errorf("could not write %s: %w", codeqlConfigRelPath, err)
		}
		w.printf("%s created: CodeQL ignores %s.\n", codeqlConfigRelPath, coreGlob)
		return true, nil
	}

	existing := string(data)
	if codeqlPathsIgnorePresent(existing, coreGlob) {
		w.printf("%s already ignores %s — skipping.\n", codeqlConfigRelPath, coreGlob)
		return false, nil
	}
	updated, inserted := insertCodeQLPathsIgnore(existing, coreGlob)
	if !inserted {
		// No top-level `paths-ignore:` key -> append a fresh block.
		if existing != "" && !strings.HasSuffix(existing, "\n") {
			existing += "\n"
		}
		updated = existing + "paths-ignore:\n  - '" + coreGlob + "'\n"
	}
	if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
		return false, fmt.Errorf("could not write %s: %w", codeqlConfigRelPath, err)
	}
	w.printf("%s updated: CodeQL now ignores %s.\n", codeqlConfigRelPath, coreGlob)
	return true, nil
}

// codeqlConfigDefault is the standalone CodeQL config deposited when none
// exists. It carries a name (so the file is self-describing in the Actions UI)
// and a single paths-ignore entry for the vendored payload.
func codeqlConfigDefault() string {
	return "# Deft framework: exclude the vendored payload from CodeQL analysis (#1430).\n" +
		"# .deft/core/** is packaged framework code, not consumer source.\n" +
		"name: \"CodeQL config (deft)\"\n" +
		"paths-ignore:\n" +
		"  - '" + coreGlob + "'\n"
}

// codeqlPathsIgnorePresent reports whether glob is already excluded under a
// top-level `paths-ignore:` key -- either as a YAML list item in a block or as
// an element of an inline array (`paths-ignore: ['x', 'y']`). A match under any
// OTHER key (e.g. CodeQL's `paths:` include list) does NOT count, so the
// idempotency probe never skips adding the exclusion just because the glob
// happens to appear in an unrelated section of the config.
func codeqlPathsIgnorePresent(content, glob string) bool {
	norm := strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	candidates := []string{
		"- '" + glob + "'",
		"- \"" + glob + "\"",
		"- " + glob,
	}
	inBlock := false
	for _, line := range strings.Split(norm, "\n") {
		// A top-level key (indent 0) opens or closes the paths-ignore context.
		if len(line) > 0 && line[0] != ' ' && line[0] != '\t' {
			trimmed := strings.TrimRight(line, " \t")
			if trimmed == "paths-ignore:" {
				inBlock = true
				continue
			}
			if strings.HasPrefix(trimmed, "paths-ignore:") {
				// Inline form: paths-ignore: [ ... ] on the same line.
				rest := strings.TrimSpace(trimmed[len("paths-ignore:"):])
				if inlineArrayHasGlob(rest, glob) {
					return true
				}
				inBlock = false
				continue
			}
			// Any other top-level key ends the paths-ignore block.
			inBlock = false
			continue
		}
		if inBlock {
			t := strings.TrimSpace(line)
			for _, c := range candidates {
				if t == c {
					return true
				}
			}
		}
	}
	return false
}

// inlineArrayHasGlob reports whether a YAML inline array literal (e.g.
// `['dist/**', '.deft/core/**']`) contains glob as one of its elements.
func inlineArrayHasGlob(literal, glob string) bool {
	literal = strings.TrimSpace(literal)
	if !strings.HasPrefix(literal, "[") || !strings.HasSuffix(literal, "]") {
		return false
	}
	inner := literal[1 : len(literal)-1]
	for _, part := range strings.Split(inner, ",") {
		item := strings.Trim(strings.TrimSpace(part), "'\"")
		if item == glob {
			return true
		}
	}
	return false
}

// insertCodeQLPathsIgnore adds glob to an existing top-level `paths-ignore:` key
// without creating a duplicate key, returning (newContent, true) on success.
// Two existing shapes are handled:
//
//   - Block form (`paths-ignore:` on its own line) -> insert `  - '<glob>'` as
//     the first child.
//   - Inline form (`paths-ignore: ['a', 'b']`) -> append `'<glob>'` to the
//     inline array, preserving the existing entries. (A second top-level
//     `paths-ignore:` key would shadow them under YAML last-key-wins, silently
//     dropping the consumer's existing exclusions.)
//
// When no top-level `paths-ignore:` key exists it returns (content, false) so
// the caller appends a fresh block. Mirrors insertDeftIncludeAfterIncludesLine
// (setup.go): CR-LF is normalised to LF for the scan and LF is written back.
func insertCodeQLPathsIgnore(content, glob string) (string, bool) {
	norm := strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	lines := strings.Split(norm, "\n")
	entry := "  - '" + glob + "'"
	for i, line := range lines {
		if len(line) == 0 || line[0] == ' ' || line[0] == '\t' {
			continue
		}
		trimmed := strings.TrimRight(line, " \t")
		if trimmed == "paths-ignore:" {
			// Block form -> insert as the first child of the block.
			out := make([]string, 0, len(lines)+1)
			out = append(out, lines[:i+1]...)
			out = append(out, entry)
			out = append(out, lines[i+1:]...)
			return strings.Join(out, "\n"), true
		}
		if strings.HasPrefix(trimmed, "paths-ignore:") {
			rest := strings.TrimSpace(trimmed[len("paths-ignore:"):])
			if strings.HasPrefix(rest, "[") && strings.HasSuffix(rest, "]") {
				// Inline array form -> append the glob into the existing array.
				inner := strings.TrimSpace(rest[1 : len(rest)-1])
				item := "'" + glob + "'"
				if inner == "" {
					lines[i] = "paths-ignore: [" + item + "]"
				} else {
					lines[i] = "paths-ignore: [" + inner + ", " + item + "]"
				}
				return strings.Join(lines, "\n"), true
			}
			// Unrecognised inline shape (e.g. trailing comment) -> let the
			// caller fall back rather than risk corrupting the file.
		}
	}
	return content, false
}

// coreGuardWorkflowMarker is the distinctive header every deft-rendered guard
// carries (coreGuardWorkflowContent always begins `name: deft-core-guard`). It
// is the recognition token EnsureCoreGuardWorkflow uses to decide whether a
// pre-existing file at coreGuardWorkflowRelPath is a deft-managed guard (safe to
// refresh) versus an unrelated consumer file that merely shares the path (#1478).
const coreGuardWorkflowMarker = "name: deft-core-guard"

// EnsureCoreGuardWorkflow deposits the optional CI guard workflow at
// coreGuardWorkflowRelPath (#1430). It is create-if-absent AND refresh-on-stale:
//
//   - absent              -> the current guard is written (fresh install).
//   - present + current   -> no-op (content already matches).
//   - present + STALE deft guard -> rewritten to the current content so an
//     allowlist change (e.g. the #1463 .githooks/ exemption added after the
//     consumer first installed) reaches the consumer on the next --upgrade
//     (#1478). Before this, the create-if-absent contract left v0.40.0 consumers
//     pinned to a guard whose allowlist omitted .githooks/, so every framework
//     upgrade PR was rejected by construction.
//   - present + NOT a deft guard -> left untouched, so a consumer file that
//     happens to share the path is never clobbered (the guard remains safe to
//     delete or replace).
//
// Returns true if the file was created or refreshed.
func EnsureCoreGuardWorkflow(w *Wizard, projectDir string) (bool, error) {
	path := filepath.Join(projectDir, filepath.FromSlash(coreGuardWorkflowRelPath))
	desired := coreGuardWorkflowContent()

	data, err := os.ReadFile(path)
	if err == nil {
		existing := string(data)
		if existing == desired {
			w.printf("%s already current — skipping.\n", coreGuardWorkflowRelPath)
			return false, nil
		}
		if !strings.Contains(existing, coreGuardWorkflowMarker) {
			// Not a deft-managed guard -- never clobber a consumer file that
			// merely shares the deposit path.
			w.printf("%s present but not deft-managed — leaving unchanged.\n", coreGuardWorkflowRelPath)
			return false, nil
		}
		if err := os.WriteFile(path, []byte(desired), 0o644); err != nil {
			return false, fmt.Errorf("could not refresh %s: %w", coreGuardWorkflowRelPath, err)
		}
		w.printf("%s refreshed: deft-core-guard allowlist updated (#1478).\n", coreGuardWorkflowRelPath)
		return true, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("could not read %s: %w", coreGuardWorkflowRelPath, err)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, fmt.Errorf("could not create workflows dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(desired), 0o644); err != nil {
		return false, fmt.Errorf("could not write %s: %w", coreGuardWorkflowRelPath, err)
	}
	w.printf("%s created: CI refuses PRs mixing %s with app files.\n", coreGuardWorkflowRelPath, coreGlob)
	return true, nil
}
