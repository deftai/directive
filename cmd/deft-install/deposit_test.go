package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newDepositWizard() *Wizard {
	return NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
}

// ---------------------------------------------------------------------------
// EnsureGitattributes (#1430)
// ---------------------------------------------------------------------------

func TestEnsureGitattributes_CreatesNew(t *testing.T) {
	tmp := t.TempDir()
	changed, err := EnsureGitattributes(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true on greenfield consumer")
	}
	data, err := os.ReadFile(filepath.Join(tmp, ".gitattributes"))
	if err != nil {
		t.Fatalf("missing .gitattributes: %v", err)
	}
	for _, want := range coreGitattributesLines {
		if !strings.Contains(string(data), want) {
			t.Errorf(".gitattributes missing marker %q", want)
		}
	}
}

func TestEnsureGitattributes_AppendsPreservesExisting(t *testing.T) {
	tmp := t.TempDir()
	pre := "# consumer attrs\nvbrief/.eval/*.jsonl  merge=union\n"
	if err := os.WriteFile(filepath.Join(tmp, ".gitattributes"), []byte(pre), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureGitattributes(newDepositWizard(), tmp); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(tmp, ".gitattributes"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	// Pre-existing content MUST be preserved byte-for-byte at the start.
	if !strings.HasPrefix(content, pre) {
		t.Errorf(".gitattributes preamble lost; got:\n%s", content)
	}
	for _, want := range append([]string{"merge=union"}, coreGitattributesLines...) {
		if !strings.Contains(content, want) {
			t.Errorf(".gitattributes missing %q after augment", want)
		}
	}
}

func TestEnsureGitattributes_Idempotent(t *testing.T) {
	tmp := t.TempDir()
	w := newDepositWizard()
	if _, err := EnsureGitattributes(w, tmp); err != nil {
		t.Fatal(err)
	}
	changed, err := EnsureGitattributes(w, tmp)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("expected changed=false on second invocation")
	}
	data, _ := os.ReadFile(filepath.Join(tmp, ".gitattributes"))
	if got := strings.Count(string(data), "linguist-generated=true"); got != 1 {
		t.Errorf("expected exactly one linguist-generated line, got %d", got)
	}
	if got := strings.Count(string(data), "linguist-vendored=true"); got != 1 {
		t.Errorf("expected exactly one linguist-vendored line, got %d", got)
	}
}

// ---------------------------------------------------------------------------
// EnsureGreptileIgnore (#1430)
// ---------------------------------------------------------------------------

func TestEnsureGreptileIgnore_CreatesNew(t *testing.T) {
	tmp := t.TempDir()
	changed, err := EnsureGreptileIgnore(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true on greenfield consumer")
	}
	data, err := os.ReadFile(filepath.Join(tmp, "greptile.json"))
	if err != nil {
		t.Fatalf("missing greptile.json: %v", err)
	}
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		t.Fatalf("greptile.json is not valid JSON: %v", err)
	}
	patterns, _ := obj["ignorePatterns"].(string)
	if !strings.Contains(patterns, coreGlob) {
		t.Errorf("greptile.json ignorePatterns missing %q: %q", coreGlob, patterns)
	}
}

func TestEnsureGreptileIgnore_MergesPreservingFields(t *testing.T) {
	tmp := t.TempDir()
	pre := `{
  "strictness": 2,
  "ignorePatterns": "*.md"
}
`
	if err := os.WriteFile(filepath.Join(tmp, "greptile.json"), []byte(pre), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err := EnsureGreptileIgnore(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true when the glob is missing")
	}
	data, _ := os.ReadFile(filepath.Join(tmp, "greptile.json"))
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		t.Fatalf("greptile.json no longer valid JSON: %v", err)
	}
	// Other fields preserved.
	if got, ok := obj["strictness"].(float64); !ok || got != 2 {
		t.Errorf("strictness not preserved: %v", obj["strictness"])
	}
	patterns, _ := obj["ignorePatterns"].(string)
	if !strings.Contains(patterns, "*.md") {
		t.Errorf("pre-existing ignore pattern *.md lost: %q", patterns)
	}
	if !strings.Contains(patterns, coreGlob) {
		t.Errorf("ignorePatterns missing %q after merge: %q", coreGlob, patterns)
	}
}

func TestEnsureGreptileIgnore_Idempotent(t *testing.T) {
	tmp := t.TempDir()
	w := newDepositWizard()
	if _, err := EnsureGreptileIgnore(w, tmp); err != nil {
		t.Fatal(err)
	}
	changed, err := EnsureGreptileIgnore(w, tmp)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("expected changed=false on second invocation")
	}
	data, _ := os.ReadFile(filepath.Join(tmp, "greptile.json"))
	if got := strings.Count(string(data), coreGlob); got != 1 {
		t.Errorf("expected exactly one %q entry, got %d", coreGlob, got)
	}
}

func TestEnsureGreptileIgnore_RefusesNonStringPatterns(t *testing.T) {
	tmp := t.TempDir()
	// ignorePatterns as an array is a shape the installer must not rewrite.
	pre := `{"ignorePatterns": ["*.md"]}`
	if err := os.WriteFile(filepath.Join(tmp, "greptile.json"), []byte(pre), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err := EnsureGreptileIgnore(newDepositWizard(), tmp)
	if err == nil {
		t.Error("expected an error when ignorePatterns is not a string")
	}
	if changed {
		t.Error("expected changed=false when refusing to rewrite")
	}
	// The original file MUST be left untouched.
	data, _ := os.ReadFile(filepath.Join(tmp, "greptile.json"))
	if string(data) != pre {
		t.Errorf("greptile.json was modified despite refusal: %q", string(data))
	}
}

// ---------------------------------------------------------------------------
// EnsureCodeQLPathsIgnore (#1430)
// ---------------------------------------------------------------------------

func TestEnsureCodeQLPathsIgnore_CreatesNew(t *testing.T) {
	tmp := t.TempDir()
	changed, err := EnsureCodeQLPathsIgnore(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true on greenfield consumer")
	}
	data, err := os.ReadFile(filepath.Join(tmp, filepath.FromSlash(codeqlConfigRelPath)))
	if err != nil {
		t.Fatalf("missing CodeQL config: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "paths-ignore:") {
		t.Error("CodeQL config missing paths-ignore key")
	}
	if !strings.Contains(content, coreGlob) {
		t.Errorf("CodeQL config missing %q", coreGlob)
	}
}

func TestEnsureCodeQLPathsIgnore_InsertsIntoExisting(t *testing.T) {
	tmp := t.TempDir()
	dir := filepath.Join(tmp, filepath.FromSlash(".github/codeql"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	pre := "name: \"app codeql\"\npaths-ignore:\n  - 'dist/**'\n"
	path := filepath.Join(tmp, filepath.FromSlash(codeqlConfigRelPath))
	if err := os.WriteFile(path, []byte(pre), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err := EnsureCodeQLPathsIgnore(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true when the glob is missing")
	}
	data, _ := os.ReadFile(path)
	content := string(data)
	if !strings.Contains(content, "dist/**") {
		t.Errorf("pre-existing paths-ignore entry lost: %q", content)
	}
	if !strings.Contains(content, coreGlob) {
		t.Errorf("CodeQL config missing %q after insert: %q", coreGlob, content)
	}
	// Exactly one paths-ignore: key (the entry was inserted into the existing
	// block, not appended as a duplicate top-level key).
	if got := strings.Count(content, "paths-ignore:"); got != 1 {
		t.Errorf("expected a single paths-ignore block, found %d", got)
	}

	// Idempotent second pass.
	changed2, err := EnsureCodeQLPathsIgnore(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if changed2 {
		t.Error("expected changed=false on second invocation")
	}
	data2, _ := os.ReadFile(path)
	if got := strings.Count(string(data2), coreGlob); got != 1 {
		t.Errorf("expected exactly one %q entry, got %d", coreGlob, got)
	}
}

// ---------------------------------------------------------------------------
// EnsureCoreGuardWorkflow (#1430)
// ---------------------------------------------------------------------------

func TestEnsureCoreGuardWorkflow_CreateIfAbsentIdempotent(t *testing.T) {
	tmp := t.TempDir()
	w := newDepositWizard()
	changed, err := EnsureCoreGuardWorkflow(w, tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true on first deposit")
	}
	path := filepath.Join(tmp, filepath.FromSlash(coreGuardWorkflowRelPath))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing guard workflow: %v", err)
	}
	if !strings.Contains(string(data), "deft-core-guard") {
		t.Error("guard workflow missing its name")
	}

	// Customise the file, then re-run: it MUST NOT be overwritten.
	if err := os.WriteFile(path, []byte("# customised\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changed2, err := EnsureCoreGuardWorkflow(w, tmp)
	if err != nil {
		t.Fatal(err)
	}
	if changed2 {
		t.Error("expected changed=false when the workflow already exists")
	}
	data2, _ := os.ReadFile(path)
	if string(data2) != "# customised\n" {
		t.Error("guard workflow was overwritten (must be create-if-absent only)")
	}
}

// ---------------------------------------------------------------------------
// Orphan .deft/VERSION removal (#1427)
// ---------------------------------------------------------------------------

func TestRemoveOrphanDeftVersion_CanonicalRemovesOrphan(t *testing.T) {
	tmp := t.TempDir()
	deftDir := filepath.Join(tmp, ".deft", "core")
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Canonical manifest + orphan one level up.
	manifest := filepath.Join(deftDir, installManifestFilename)
	orphan := filepath.Join(tmp, ".deft", installManifestFilename)
	if err := os.WriteFile(manifest, []byte("ref: 'v1'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orphan, []byte("ref: 'stale'\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := &WizardResult{ProjectDir: tmp, DeftDir: deftDir, Update: true}
	removeOrphanDeftVersion(newDepositWizard(), result)

	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Errorf("orphaned .deft/VERSION should be removed (err=%v)", err)
	}
	if _, err := os.Stat(manifest); err != nil {
		t.Errorf("canonical .deft/core/VERSION must be preserved: %v", err)
	}
}

func TestRemoveOrphanDeftVersion_LegacyLayoutLeavesRootVersion(t *testing.T) {
	tmp := t.TempDir()
	// Legacy layout: deftDir = <project>/deft, so the parent is the project
	// root and <project>/VERSION belongs to the CONSUMER -- it must NOT be
	// removed.
	deftDir := filepath.Join(tmp, "deft")
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rootVersion := filepath.Join(tmp, installManifestFilename)
	if err := os.WriteFile(rootVersion, []byte("consumer's own VERSION\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := &WizardResult{ProjectDir: tmp, DeftDir: deftDir, Update: true, LegacyLayout: true}
	removeOrphanDeftVersion(newDepositWizard(), result)

	if _, err := os.Stat(rootVersion); err != nil {
		t.Errorf("legacy layout MUST NOT remove the consumer's root VERSION: %v", err)
	}
}

func TestRemoveOrphanDeftVersion_NoOpWhenAbsent(t *testing.T) {
	tmp := t.TempDir()
	deftDir := filepath.Join(tmp, ".deft", "core")
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// No orphan present -> a silent no-op (must not panic or error).
	result := &WizardResult{ProjectDir: tmp, DeftDir: deftDir, Update: true}
	removeOrphanDeftVersion(newDepositWizard(), result)
}

// ---------------------------------------------------------------------------
// Review-cycle regression fixes (#1432)
// ---------------------------------------------------------------------------

// TestEnsureGreptileIgnore_PreservesKeyOrder pins the fix for the JSON key-order
// finding: the merge MUST keep the consumer's original top-level key order
// rather than the alphabetical order a Go map emits (which created diff noise).
func TestEnsureGreptileIgnore_PreservesKeyOrder(t *testing.T) {
	tmp := t.TempDir()
	// Keys deliberately NOT in alphabetical order; ignorePatterns absent so it
	// is appended last.
	pre := "{\n  \"strictness\": 2,\n  \"commentTypes\": [\"logic\"]\n}\n"
	if err := os.WriteFile(filepath.Join(tmp, "greptile.json"), []byte(pre), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureGreptileIgnore(newDepositWizard(), tmp); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(tmp, "greptile.json"))
	content := string(data)
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		t.Fatalf("greptile.json no longer valid JSON: %v", err)
	}
	iStrict := strings.Index(content, "\"strictness\"")
	iComment := strings.Index(content, "\"commentTypes\"")
	iIgnore := strings.Index(content, "\"ignorePatterns\"")
	if !(iStrict >= 0 && iComment > iStrict && iIgnore > iComment) {
		t.Errorf("expected key order strictness < commentTypes < ignorePatterns; got positions %d/%d/%d in:\n%s", iStrict, iComment, iIgnore, content)
	}
}

// TestEnsureCodeQLPathsIgnore_InlineListAppends pins the fix for the inline-YAML
// finding: an existing INLINE paths-ignore array is appended to in place (no
// duplicate top-level key that would shadow the consumer's existing exclusions
// under YAML last-key-wins).
func TestEnsureCodeQLPathsIgnore_InlineListAppends(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, filepath.FromSlash(".github/codeql")), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(tmp, filepath.FromSlash(codeqlConfigRelPath))
	pre := "name: \"app\"\npaths-ignore: ['dist/**']\n"
	if err := os.WriteFile(path, []byte(pre), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err := EnsureCodeQLPathsIgnore(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true when the glob is missing from the inline array")
	}
	data, _ := os.ReadFile(path)
	content := string(data)
	if !strings.Contains(content, "dist/**") {
		t.Errorf("pre-existing inline exclusion dropped: %q", content)
	}
	if !strings.Contains(content, coreGlob) {
		t.Errorf("CodeQL config missing %q after inline append: %q", coreGlob, content)
	}
	if got := strings.Count(content, "paths-ignore:"); got != 1 {
		t.Errorf("expected a single paths-ignore key (no duplicate), found %d in:\n%s", got, content)
	}
	// Idempotent second pass (the inline glob is now recognised as present).
	changed2, err := EnsureCodeQLPathsIgnore(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if changed2 {
		t.Error("expected changed=false on second invocation")
	}
}

// TestEnsureCodeQLPathsIgnore_ContextBlindAddsExclusion pins the fix for the
// context-blind presence finding: the glob appearing under an UNRELATED key
// (CodeQL's `paths:` include) must NOT be treated as already-excluded; the
// exclusion is still added under paths-ignore.
func TestEnsureCodeQLPathsIgnore_ContextBlindAddsExclusion(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, filepath.FromSlash(".github/codeql")), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(tmp, filepath.FromSlash(codeqlConfigRelPath))
	// The glob is listed under `paths:` (an INCLUDE), not paths-ignore.
	pre := "name: \"app\"\npaths:\n  - '" + coreGlob + "'\n"
	if err := os.WriteFile(path, []byte(pre), 0o644); err != nil {
		t.Fatal(err)
	}
	if codeqlPathsIgnorePresent(pre, coreGlob) {
		t.Fatal("context-blind: glob under paths: must NOT count as paths-ignore presence")
	}
	changed, err := EnsureCodeQLPathsIgnore(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true: exclusion must be added even though glob appears under paths:")
	}
	data, _ := os.ReadFile(path)
	content := string(data)
	if !strings.Contains(content, "paths-ignore:") {
		t.Errorf("expected a paths-ignore block to be added; got:\n%s", content)
	}
	if !strings.Contains(content, "paths:\n  - '"+coreGlob+"'") {
		t.Errorf("original paths: include was not preserved:\n%s", content)
	}
}
