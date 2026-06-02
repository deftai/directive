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

// coreGuardWorkflowContent is the optional CI guard deposited at
// coreGuardWorkflowRelPath (#1430). It fails a PR that mixes changes to the
// vendored framework payload (.deft/core/**) with changes to the consumer's own
// files, so a framework update from deft-install/upgrade lands in its own PR and
// reviewers can treat it as a packaged, machine-managed bump. It is deposited
// create-if-absent and is safe for consumers to delete.
const coreGuardWorkflowContent = `name: deft-core-guard

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
          app=$(printf '%s\n' "$changed" | grep -vE '^\.deft/core/' | grep -v '^$' || true)
          if [ -n "$core" ] && [ -n "$app" ]; then
            echo "::error title=deft-core guard (#1430)::This PR changes the vendored framework payload (.deft/core/**) AND non-framework files. Split the framework update into its own PR."
            echo "--- framework (.deft/core/**) changes ---"; printf '%s\n' "$core"
            echo "--- non-framework changes ---"; printf '%s\n' "$app"
            exit 1
          fi
          echo "OK: no mixed framework + app changes."
`

// depositNeutralization performs the #1430 deposit so the vendored framework
// payload at .deft/core/** is treated as packaged framework assets rather than
// consumer source by linguist, the Greptile/CodeQL bot reviewers, and an
// optional CI guard. Every step is best-effort: a deposit failure (e.g. a
// malformed pre-existing config the installer refuses to rewrite) is logged as a
// warning and never aborts the install, mirroring WriteInstallManifest.
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

// EnsureCoreGuardWorkflow deposits the optional CI guard workflow at
// coreGuardWorkflowRelPath create-if-absent (#1430). It is never overwritten so
// a consumer who customised or deleted it keeps their choice. Returns true if
// the file was created.
func EnsureCoreGuardWorkflow(w *Wizard, projectDir string) (bool, error) {
	path := filepath.Join(projectDir, filepath.FromSlash(coreGuardWorkflowRelPath))
	if pathExists(path) {
		w.printf("%s already present — skipping.\n", coreGuardWorkflowRelPath)
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, fmt.Errorf("could not create workflows dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(coreGuardWorkflowContent), 0o644); err != nil {
		return false, fmt.Errorf("could not write %s: %w", coreGuardWorkflowRelPath, err)
	}
	w.printf("%s created: CI refuses PRs mixing %s with app files.\n", coreGuardWorkflowRelPath, coreGlob)
	return true, nil
}
