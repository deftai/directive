package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
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

// ---------------------------------------------------------------------------
// deft-core-guard installer-managed allowlist (#1440)
// ---------------------------------------------------------------------------

// upgradeOnlyChangeSet is a representative `deft-install --upgrade` diff: the
// vendored payload plus every installer-managed root deposit. None of these are
// consumer app code, so the guard must let the PR through.
func upgradeOnlyChangeSet() []string {
	changed := []string{
		".deft/core/VERSION",
		".deft/core/skills/deft-directive-setup/SKILL.md",
		"AGENTS.md",
		".agents/deft.md",
		".gitattributes",
		".gitignore",
		"greptile.json",
		codeqlConfigRelPath,
		coreGuardWorkflowRelPath,
		"vbrief/.deft-version",
		"vbrief/vbrief.md",
		"vbrief/schemas/scope.schema.json",
		"vbrief/migration/0001-init.md",
	}
	for _, sub := range vbriefLifecycleDirs {
		changed = append(changed, "vbrief/"+sub+"/.gitkeep")
	}
	return changed
}

// TestCoreGuard_UpgradeOnlyChangeSetAllowed pins acceptance criterion (a): an
// upgrade-only diff (.deft/core/** + the installer-managed allowlist) passes the
// guard. Without the #1440 allowlist subtraction the installer-managed root
// files land in "app" and this set is rejected (RED); with it the set is GREEN.
func TestCoreGuard_UpgradeOnlyChangeSetAllowed(t *testing.T) {
	changed := upgradeOnlyChangeSet()
	core, managed, app := classifyChangedPaths(changed)
	if len(core) == 0 {
		t.Fatal("expected the change set to include .deft/core/** paths")
	}
	if len(app) != 0 {
		t.Errorf("upgrade-only diff must leave the app set empty; got app=%v", app)
	}
	// Every non-core path must be recognised as installer-managed.
	if want := len(changed) - len(core); len(managed) != want {
		t.Errorf("expected %d installer-managed paths, got %d (%v)", want, len(managed), managed)
	}
	if guardWouldFail(changed) {
		t.Error("guard must PASS an upgrade-only diff (.deft/core/** + installer-managed root files)")
	}
}

// TestCoreGuard_MixedWithAppFails pins acceptance criterion (b): mixing
// .deft/core/** with a genuine app file still trips the guard.
func TestCoreGuard_MixedWithAppFails(t *testing.T) {
	changed := []string{".deft/core/VERSION", "AGENTS.md", "src/main.py"}
	core, _, app := classifyChangedPaths(changed)
	if len(core) == 0 || len(app) == 0 {
		t.Fatalf("expected both core and app non-empty; core=%v app=%v", core, app)
	}
	if app[0] != "src/main.py" {
		t.Errorf("expected src/main.py to classify as app; got app=%v", app)
	}
	if !guardWouldFail(changed) {
		t.Error("guard must FAIL a diff mixing .deft/core/** with a genuine app file")
	}
}

// TestCoreGuard_MixedWithConsumerVbriefFails pins acceptance criterion (c):
// consumer-authored vBRIEF data is NOT allowlisted, so mixing it with a core
// change still fails. Covers both the project definition and a lifecycle scope
// vBRIEF that lives right next to an allowlisted .gitkeep.
func TestCoreGuard_MixedWithConsumerVbriefFails(t *testing.T) {
	cases := [][]string{
		{".deft/core/VERSION", "vbrief/PROJECT-DEFINITION.vbrief.json"},
		{".deft/core/VERSION", "vbrief/active/2026-06-03-1440-fix.vbrief.json"},
	}
	for _, changed := range cases {
		_, managed, app := classifyChangedPaths(changed)
		if len(managed) != 0 {
			t.Errorf("consumer vBRIEF data must NOT be installer-managed; got managed=%v for %v", managed, changed)
		}
		if len(app) == 0 {
			t.Errorf("consumer vBRIEF data must classify as app; got empty app for %v", changed)
		}
		if !guardWouldFail(changed) {
			t.Errorf("guard must FAIL when .deft/core/** is mixed with consumer vBRIEF data: %v", changed)
		}
	}
}

// TestCoreGuard_AllowlistAuthoritative pins acceptance criterion (d): the
// deposited guard template renders its matcher from the SAME allowlist source
// the Go classifier uses, and the rendered ERE accepts exactly the
// installer-managed paths the classifier accepts. This is what prevents the
// guard and the installer from drifting apart.
func TestCoreGuard_AllowlistAuthoritative(t *testing.T) {
	ere := installerManagedGuardERE()

	// The deposited workflow must embed the allowlist ERE verbatim in its
	// app-subtraction step -- proving the template is rendered from the source.
	content := coreGuardWorkflowContent()
	wantLine := "grep -vE '" + ere + "'"
	if !strings.Contains(content, wantLine) {
		t.Errorf("deposited guard does not embed the allowlist ERE; expected to find:\n%s\nin:\n%s", wantLine, content)
	}

	// The rendered ERE (what grep -E runs) and the Go classifier
	// (matchesAnyInstallerManaged) must agree on every probe path, so the bash
	// guard and the Go logic can never diverge.
	re := regexp.MustCompile(ere)
	matchers := installerManagedMatchers()

	managed := []string{
		"AGENTS.md",
		".agents/deft.md",
		".agents/nested/dir/file.md",
		".gitattributes",
		".gitignore",
		"greptile.json",
		codeqlConfigRelPath,
		coreGuardWorkflowRelPath,
		"vbrief/.deft-version",
		"vbrief/vbrief.md",
		"vbrief/schemas/scope.schema.json",
		"vbrief/migration/0001-init.md",
	}
	for _, sub := range vbriefLifecycleDirs {
		managed = append(managed, "vbrief/"+sub+"/.gitkeep")
	}
	notManaged := []string{
		"src/main.py",
		"README.md",
		".deft/core/VERSION",
		"vbrief/PROJECT-DEFINITION.vbrief.json",
		"vbrief/active/2026-06-03-1440-fix.vbrief.json",
		"agents.md",       // case-sensitive: must NOT match AGENTS.md
		"vbrief/schemas",  // the prefix entry requires a trailing slash + child
		"vbrief/active/x", // a lifecycle file that is not .gitkeep
	}

	for _, p := range managed {
		if !matchesAnyInstallerManaged(matchers, p) {
			t.Errorf("classifier should treat %q as installer-managed", p)
		}
		if !re.MatchString(p) {
			t.Errorf("rendered guard ERE should match installer-managed path %q", p)
		}
	}
	for _, p := range notManaged {
		if matchesAnyInstallerManaged(matchers, p) {
			t.Errorf("classifier must NOT treat %q as installer-managed", p)
		}
		if re.MatchString(p) {
			t.Errorf("rendered guard ERE must NOT match %q", p)
		}
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

// ---------------------------------------------------------------------------
// Framework self-test pruning (#1474)
// ---------------------------------------------------------------------------

// TestPruneFrameworkSelfTests_RemovesVendoredSuite pins #1474 acceptance (a2):
// the consumer deposit excludes the framework's own .deft/core/tests/ suite so
// the always-red framework-repo-only self-tests are never vendored/executed.
func TestPruneFrameworkSelfTests_RemovesVendoredSuite(t *testing.T) {
	tmp := t.TempDir()
	testsDir := filepath.Join(tmp, filepath.FromSlash(frameworkSelfTestRelPath))
	if err := os.MkdirAll(filepath.Join(testsDir, "unit"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(testsDir, "test_x.py"), []byte("def test_x():\n    assert True\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A non-test framework file MUST survive -- only tests/ is pruned.
	scriptsDir := filepath.Join(tmp, filepath.FromSlash(".deft/core/scripts"))
	if err := os.MkdirAll(scriptsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scriptsDir, "doctor.py"), []byte("# keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	removed, err := pruneFrameworkSelfTests(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !removed {
		t.Error("expected removed=true when the vendored tests/ suite is present")
	}
	if pathExists(testsDir) {
		t.Errorf("%s must be removed from the consumer deposit", frameworkSelfTestRelPath)
	}
	if !pathExists(filepath.Join(scriptsDir, "doctor.py")) {
		t.Error("non-test framework files (.deft/core/scripts/) must be preserved")
	}
}

// TestPruneFrameworkSelfTests_NoOpWhenAbsent: a consumer with no vendored tests/
// is a clean no-op (no error, removed=false).
func TestPruneFrameworkSelfTests_NoOpWhenAbsent(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, filepath.FromSlash(".deft/core")), 0o755); err != nil {
		t.Fatal(err)
	}
	removed, err := pruneFrameworkSelfTests(newDepositWizard(), tmp)
	if err != nil {
		t.Fatalf("absent suite must not error: %v", err)
	}
	if removed {
		t.Error("expected removed=false when there is no vendored tests/ suite")
	}
}

// TestPruneFrameworkSelfTests_LeavesRegularFile: a regular file at the tests/
// path (not a directory) is not the framework suite and must be left intact.
func TestPruneFrameworkSelfTests_LeavesRegularFile(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, filepath.FromSlash(frameworkSelfTestRelPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("not a dir\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	removed, err := pruneFrameworkSelfTests(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if removed {
		t.Error("a regular file at the tests/ path must NOT be treated as the suite")
	}
	if !pathExists(path) {
		t.Error("the regular file must be left intact")
	}
}

// TestDepositNeutralization_PrunesFrameworkTests pins #1474 acceptance (a1/a2)
// at the integration boundary: the full neutralization deposit removes the
// vendored framework self-tests while leaving the rest of the payload intact.
func TestDepositNeutralization_PrunesFrameworkTests(t *testing.T) {
	tmp := t.TempDir()
	testsDir := filepath.Join(tmp, filepath.FromSlash(frameworkSelfTestRelPath))
	if err := os.MkdirAll(testsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(testsDir, "test_self.py"), []byte("def test():\n    assert False\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	coreFile := filepath.Join(tmp, filepath.FromSlash(".deft/core/main.md"))
	if err := os.MkdirAll(filepath.Dir(coreFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(coreFile, []byte("# framework\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	depositNeutralization(newDepositWizard(), tmp)

	if pathExists(testsDir) {
		t.Errorf("depositNeutralization must prune %s", frameworkSelfTestRelPath)
	}
	if !pathExists(coreFile) {
		t.Error("depositNeutralization must NOT remove non-test framework files")
	}
}

// ---------------------------------------------------------------------------
// deft-core-guard refresh-on-upgrade + .githooks/ classification (#1478)
// ---------------------------------------------------------------------------

// TestEnsureCoreGuardWorkflow_RefreshesStaleDeftGuard pins #1478 acceptance
// (a2): an existing consumer whose deposited guard predates the .githooks/
// allowlist entry gets the guard REFRESHED on the next install/upgrade rather
// than skipped, so the framework-only upgrade PR stops being rejected.
func TestEnsureCoreGuardWorkflow_RefreshesStaleDeftGuard(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, filepath.FromSlash(coreGuardWorkflowRelPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	// A recognisably deft-managed guard (carries the marker) but STALE: its
	// allowlist omits the .githooks/ atom the current renderer emits.
	stale := "name: deft-core-guard\n# old guard rendered before the .githooks/ allowlist entry (#1463)\n"
	if err := os.WriteFile(path, []byte(stale), 0o644); err != nil {
		t.Fatal(err)
	}

	changed, err := EnsureCoreGuardWorkflow(newDepositWizard(), tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true: a stale deft-managed guard must be refreshed on upgrade")
	}
	data, _ := os.ReadFile(path)
	if string(data) != coreGuardWorkflowContent() {
		t.Errorf("stale guard was not refreshed to the current content:\n%s", string(data))
	}
	// The refreshed guard now exempts .githooks/ (the rendered ERE atom).
	if !strings.Contains(string(data), "^\\.githooks/") {
		t.Errorf("refreshed guard missing the .githooks/ allowlist atom:\n%s", string(data))
	}
}

// TestEnsureCoreGuardWorkflow_CleanReRunIsNoOp: re-running over an already-current
// guard is a no-op (content already matches the renderer).
func TestEnsureCoreGuardWorkflow_CleanReRunIsNoOp(t *testing.T) {
	tmp := t.TempDir()
	w := newDepositWizard()
	if _, err := EnsureCoreGuardWorkflow(w, tmp); err != nil {
		t.Fatal(err)
	}
	changed, err := EnsureCoreGuardWorkflow(w, tmp)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("expected changed=false when the deposited guard already matches the current content")
	}
}

// TestCoreGuard_GithooksClassifyInstallerManaged pins #1478 acceptance (a3): the
// wired .githooks/pre-commit and .githooks/pre-push classify as installer-managed
// (not app), so a framework-deposit PR carrying them alongside .deft/core/**
// passes the guard instead of being rejected.
func TestCoreGuard_GithooksClassifyInstallerManaged(t *testing.T) {
	changed := []string{".deft/core/VERSION", ".githooks/pre-commit", ".githooks/pre-push"}
	_, managed, app := classifyChangedPaths(changed)
	if len(app) != 0 {
		t.Errorf(".githooks/ hooks must NOT classify as app; got app=%v", app)
	}
	if len(managed) != 2 {
		t.Errorf("expected both .githooks/ hooks installer-managed; got managed=%v", managed)
	}
	if guardWouldFail(changed) {
		t.Error("guard must PASS a framework-deposit PR mixing .deft/core/** with .githooks/* (#1478)")
	}
}
