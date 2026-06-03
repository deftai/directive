package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// resolveBranch — build-time default vs user flag precedence (#424)
// ---------------------------------------------------------------------------

func TestResolveBranch(t *testing.T) {
	tests := []struct {
		name         string
		flagValue    string
		defaultValue string
		want         string
	}{
		{"both empty falls through to origin default", "", "", ""},
		{"defaultBranch used when flag empty", "", "v0.20.0-rc.1", "v0.20.0-rc.1"},
		{"flag takes precedence over default", "beta", "v0.20.0-rc.1", "beta"},
		{"flag wins even with empty default", "beta", "", "beta"},
		{"branch-style default (phase2 dispatch build)", "", "phase2/vbrief-cutover", "phase2/vbrief-cutover"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveBranch(tc.flagValue, tc.defaultValue)
			if got != tc.want {
				t.Errorf("resolveBranch(%q, %q) = %q, want %q",
					tc.flagValue, tc.defaultValue, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Phase 1 — smoke test
// ---------------------------------------------------------------------------

func TestMain_Compiles(t *testing.T) {
	tmp := t.TempDir()
	out := filepath.Join(tmp, "deft-install-test")
	if runtime.GOOS == "windows" {
		out += ".exe"
	}

	cmd := exec.Command("go", "build", "-o", out, ".")
	cmd.Dir = "."
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("build failed: %v\n%s", err, output)
	}
}

// ---------------------------------------------------------------------------
// Phase 2 — project name sanitisation
// ---------------------------------------------------------------------------

func TestSanitizeProjectName(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"my-project", "my-project"},
		{"My Project", "My Project"},
		{"hello<world>", "helloworld"},
		{"a:b/c\\d|e?f*g", "abcdefg"},
		{"...leading-dots", "leading-dots"},
		{"trailing-dots...", "trailing-dots"},
		{"  spaces  ", "spaces"},
		{"múltiple  ünïcödé", "múltiple ünïcödé"},
		{"", ""},
		{"***", ""},
		{`<>:"/\|?*`, ""},
		{"normal123", "normal123"},
		{"hello\x00world", "helloworld"},
	}

	for _, tc := range tests {
		got := SanitizeProjectName(tc.input)
		if got != tc.want {
			t.Errorf("SanitizeProjectName(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Phase 2 — folder listing
// ---------------------------------------------------------------------------

func TestListSubdirs_ExcludesHiddenAndSystem(t *testing.T) {
	tmp := t.TempDir()

	// Visible dirs.
	os.Mkdir(filepath.Join(tmp, "Repos"), 0o755)
	os.Mkdir(filepath.Join(tmp, "Projects"), 0o755)

	// Hidden dir.
	os.Mkdir(filepath.Join(tmp, ".hidden"), 0o755)

	// System-like dirs.
	os.Mkdir(filepath.Join(tmp, "$Recycle.Bin"), 0o755)
	os.Mkdir(filepath.Join(tmp, "Windows"), 0o755)

	// Regular file (must be excluded).
	os.WriteFile(filepath.Join(tmp, "file.txt"), []byte("hi"), 0o644)

	dirs, err := ListSubdirs(tmp)
	if err != nil {
		t.Fatal(err)
	}

	want := map[string]bool{"Repos": true, "Projects": true}
	got := map[string]bool{}
	for _, d := range dirs {
		got[d] = true
	}

	for name := range want {
		if !got[name] {
			t.Errorf("expected dir %q in result, got %v", name, dirs)
		}
	}
	for name := range got {
		if !want[name] {
			t.Errorf("unexpected dir %q in result", name)
		}
	}
}

// ---------------------------------------------------------------------------
// Phase 2 — guards
// ---------------------------------------------------------------------------

func TestCheckGuards_WritableDir(t *testing.T) {
	tmp := t.TempDir()
	deftDir := filepath.Join(tmp, "project", ".deft", "core")
	os.MkdirAll(filepath.Dir(deftDir), 0o755)

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	err := w.checkGuards(deftDir)
	if err != nil {
		t.Errorf("expected no error for writable parent dir, got: %v", err)
	}
}

func TestAskUpdate_Accept(t *testing.T) {
	var buf bytes.Buffer
	w := NewWizard(strings.NewReader("y\n"), &buf, false)

	ok, err := w.askUpdate(`C:\Projects\myproj\deft`)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("expected askUpdate to return true for 'y'")
	}
	if !strings.Contains(buf.String(), "already exists") {
		t.Error("prompt should mention existing folder")
	}
}

func TestAskUpdate_AcceptDefault(t *testing.T) {
	w := NewWizard(strings.NewReader("\n"), &bytes.Buffer{}, false)

	ok, err := w.askUpdate(`C:\Projects\myproj\deft`)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("expected askUpdate to return true for empty input (default Y)")
	}
}

func TestAskUpdate_Decline(t *testing.T) {
	w := NewWizard(strings.NewReader("n\n"), &bytes.Buffer{}, false)

	ok, err := w.askUpdate(`C:\Projects\myproj\deft`)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("expected askUpdate to return false for 'n'")
	}
}

func TestCheckWritePermission_WritableDir(t *testing.T) {
	tmp := t.TempDir()
	if err := CheckWritePermission(tmp); err != nil {
		t.Errorf("expected no error for writable dir, got: %v", err)
	}
}

func TestCheckWritePermission_NonExistentParent(t *testing.T) {
	tmp := t.TempDir()
	deep := filepath.Join(tmp, "does", "not", "exist")
	if err := CheckWritePermission(deep); err != nil {
		t.Errorf("expected no error (ancestor is writable), got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Phase 2 — drive enumeration (Windows only)
// ---------------------------------------------------------------------------

func TestEnumerateDrives_NonEmpty(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("drive enumeration only applies on Windows")
	}
	drives, err := EnumerateDrives()
	if err != nil {
		t.Fatal(err)
	}
	if len(drives) == 0 {
		t.Fatal("expected at least one fixed drive")
	}
}

// ---------------------------------------------------------------------------
// Phase 3 — git detection
// ---------------------------------------------------------------------------

func TestGitAvailable_Found(t *testing.T) {
	orig := lookPathFunc
	defer func() { lookPathFunc = orig }()

	lookPathFunc = func(file string) (string, error) {
		return `C:\Program Files\Git\cmd\git.exe`, nil
	}

	if !gitAvailable() {
		t.Error("expected gitAvailable to return true when LookPath succeeds")
	}
}

func TestGitAvailable_NotFound(t *testing.T) {
	orig := lookPathFunc
	defer func() { lookPathFunc = orig }()

	lookPathFunc = func(file string) (string, error) {
		return "", fmt.Errorf("not found")
	}

	if gitAvailable() {
		t.Error("expected gitAvailable to return false when LookPath fails")
	}
}

func TestInstallGitWindows_WingetFirst(t *testing.T) {
	origRun := runCmdFunc
	origDl := downloadGitInstallerFunc
	defer func() {
		runCmdFunc = origRun
		downloadGitInstallerFunc = origDl
	}()

	var calls []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		call := name
		if len(args) > 0 {
			call += " " + args[0]
		}
		calls = append(calls, call)
		return fmt.Errorf("not available")
	}
	downloadGitInstallerFunc = func(w *Wizard) error {
		calls = append(calls, "download-fallback")
		return fmt.Errorf("download disabled in test")
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	_ = installGitWindows(w)

	if len(calls) < 2 {
		t.Fatalf("expected at least 2 calls, got %d: %v", len(calls), calls)
	}
	if !strings.Contains(calls[0], "winget") {
		t.Errorf("expected winget attempted first, got: %s", calls[0])
	}
	if calls[1] != "download-fallback" {
		t.Errorf("expected download fallback second, got: %s", calls[1])
	}
}

func TestInstallGitLinux_PackageManagerOrder(t *testing.T) {
	origLook := lookPathFunc
	origRun := runCmdFunc
	defer func() {
		lookPathFunc = origLook
		runCmdFunc = origRun
	}()

	var lookCalls []string
	lookPathFunc = func(file string) (string, error) {
		lookCalls = append(lookCalls, file)
		if file == "dnf" {
			return "/usr/bin/dnf", nil
		}
		return "", fmt.Errorf("not found")
	}

	var ranCmd string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		ranCmd = name + " " + strings.Join(args, " ")
		return nil
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := installGitLinux(w); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// apt-get must be checked before dnf.
	if len(lookCalls) < 2 || lookCalls[0] != "apt-get" || lookCalls[1] != "dnf" {
		t.Errorf("expected apt-get checked before dnf, got: %v", lookCalls)
	}
	// dnf should have been used to install.
	if !strings.Contains(ranCmd, "dnf") {
		t.Errorf("expected dnf install command, got: %s", ranCmd)
	}
}

func TestEnsureGit_PostInstallReCheck(t *testing.T) {
	origLook := lookPathFunc
	origRun := runCmdFunc
	origDl := downloadGitInstallerFunc
	defer func() {
		lookPathFunc = origLook
		runCmdFunc = origRun
		downloadGitInstallerFunc = origDl
	}()

	// First call: git not found. After install: git found.
	calls := 0
	lookPathFunc = func(file string) (string, error) {
		calls++
		if calls <= 1 {
			return "", fmt.Errorf("not found")
		}
		return `C:\Program Files\Git\cmd\git.exe`, nil
	}
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		return nil // winget "succeeds"
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	err := EnsureGit(w)
	if err != nil {
		t.Fatalf("EnsureGit should succeed after re-check, got: %v", err)
	}
	if calls < 2 {
		t.Errorf("expected at least 2 lookPath calls (initial + re-check), got %d", calls)
	}
}

// ---------------------------------------------------------------------------
// Phase 4 — vendor and update
// ---------------------------------------------------------------------------

// forceCloneLayoutGit stubs runGitCaptureFunc so classifyPayloadLayout sees a
// genuine clone (git toplevel == deftDir) and a deterministic HEAD sha. It
// returns the original so callers can restore it.
func forceCloneLayoutGit(deftDir string) func(string, ...string) (string, error) {
	orig := runGitCaptureFunc
	runGitCaptureFunc = func(dir string, args ...string) (string, error) {
		if len(args) >= 2 && args[0] == "rev-parse" && args[1] == "--show-toplevel" {
			return deftDir, nil
		}
		return "deadbeefcafe1234", nil
	}
	return orig
}

// TestUpdateDeft_CloneMigratesToVendored proves the #1428 behavior change: an
// --upgrade against a genuine git-clone payload MIGRATES it to a vendored
// (git-free) payload via file swap. NO mutating git command runs, the result
// carries no .git, the old payload is gone, and the outcome reports the
// post-migration vendored layout + clone-to-vendored strategy.
func TestUpdateDeft_CloneMigratesToVendored(t *testing.T) {
	origRun := runCmdFunc
	origFetch := fetchCoreTarballFunc
	defer func() {
		runCmdFunc = origRun
		fetchCoreTarballFunc = origFetch
	}()

	tmp := t.TempDir()
	deftDir := filepath.Join(tmp, "myproj", ".deft", "core")
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Seed an old payload + a nested .git so we can assert both are gone after.
	if err := os.WriteFile(filepath.Join(deftDir, "OLD.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(deftDir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	origGit := forceCloneLayoutGit(deftDir)
	defer func() { runGitCaptureFunc = origGit }()

	tarball := makeCoreTarball(t, "deftai-directive-abc1234", map[string]string{"marker.txt": "new"})
	fetchCoreTarballFunc = func(string) (string, error) { return tarball, nil }

	// Guardrail: record any git command. There MUST be none on the migration.
	var gitCalls []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		if name == "git" {
			gitCalls = append(gitCalls, strings.Join(args, " "))
		}
		return nil
	}

	result := &WizardResult{
		ProjectName: "myproj",
		ProjectDir:  filepath.Join(tmp, "myproj"),
		DeftDir:     deftDir,
		Update:      true,
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	outcome, err := UpdateDeft(w, result, "v9.9.9")
	if err != nil {
		t.Fatalf("UpdateDeft (clone->vendored): %v", err)
	}

	if len(gitCalls) != 0 {
		t.Errorf("migration ran git commands (safety bug): %v", gitCalls)
	}
	if outcome.Layout != payloadLayoutVendored {
		t.Errorf("layout = %q, want vendored (post-migration)", outcome.Layout)
	}
	if outcome.Strategy != strategyMigrate {
		t.Errorf("strategy = %q, want %q", outcome.Strategy, strategyMigrate)
	}
	if outcome.Tag != "v9.9.9" {
		t.Errorf("tag = %q, want v9.9.9", outcome.Tag)
	}
	if outcome.SHA != "abc1234" {
		t.Errorf("SHA = %q, want abc1234 (from tarball wrapper)", outcome.SHA)
	}
	if outcome.Backup == "" {
		t.Error("expected a backup path on a successful migration")
	}
	if data, err := os.ReadFile(filepath.Join(deftDir, "marker.txt")); err != nil || string(data) != "new" {
		t.Errorf("migrated core missing marker.txt: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(deftDir, "OLD.txt")); !os.IsNotExist(err) {
		t.Errorf("old payload file should be gone after migration (err=%v)", err)
	}
	if _, err := os.Stat(filepath.Join(deftDir, ".git")); !os.IsNotExist(err) {
		t.Errorf("migrated core MUST NOT contain .git (err=%v)", err)
	}
}

func TestWriteAgentsMD_CreateNew(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), agentsMDSentinel) {
		t.Errorf("AGENTS.md missing deft entry, got:\n%s", data)
	}
	for _, section := range []string{"## First Session", "## Returning Sessions", "## Commands"} {
		if !strings.Contains(string(data), section) {
			t.Errorf("AGENTS.md missing section %q", section)
		}
	}
	if strings.Contains(string(data), "Skills: deft/SKILL.md") {
		t.Error("AGENTS.md should not contain Skills line — .agents/skills/ handles discovery")
	}
	// Verify deft-directive-setup references (not legacy deft-setup).
	content := string(data)
	if !strings.Contains(content, "deft-directive-setup") {
		t.Error("AGENTS.md should reference deft-directive-setup")
	}
	if strings.Contains(content, "deft/skills/deft-setup/") {
		t.Error("AGENTS.md should not reference legacy deft-setup path")
	}
	// Verify vBRIEF-centric references.
	if !strings.Contains(content, "PROJECT-DEFINITION.vbrief.json") {
		t.Error("AGENTS.md should reference PROJECT-DEFINITION.vbrief.json")
	}
}

func TestWriteAgentsMD_AppendExisting(t *testing.T) {
	tmp := t.TempDir()
	existing := "# AGENTS\nSome existing content.\n"
	os.WriteFile(filepath.Join(tmp, "AGENTS.md"), []byte(existing), 0o644)

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if !strings.Contains(content, "Some existing content") {
		t.Error("original content was lost")
	}
	if !strings.Contains(content, agentsMDSentinel) {
		t.Error("deft entry was not appended")
	}
}

func TestWriteAgentsMD_Idempotent(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	// Write twice. Surface any write error so a regression in WriteAgentsMD
	// fails the test loudly rather than masquerading as a sentinel-count
	// mismatch (#1281).
	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatalf("first WriteAgentsMD failed: %v", err)
	}
	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatalf("second WriteAgentsMD failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	if err != nil {
		t.Fatalf("could not read AGENTS.md: %v", err)
	}
	count := strings.Count(string(data), agentsMDSentinel)
	if count != 1 {
		t.Errorf("expected exactly 1 deft entry, found %d", count)
	}
}

// repoRootFromDeftInstall walks up from the cmd/deft-install test working
// directory to find the repo root (identified by the go.mod file). Keeps the
// template fixture tests independent of how `go test` was invoked.
func repoRootFromDeftInstall(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("could not get working directory: %v", err)
	}
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("could not locate repo root (go.mod) from %s", dir)
	return ""
}

// TestWriteAgentsMD_MatchesTemplateFixture asserts that the AGENTS.md the
// installer writes is byte-identical to templates/agents-entry.md at the repo
// root. This ties cmd/deft-install to the canonical template so the installer,
// task agents:init, and QUICK-START.md all produce byte-identical output for
// the same template revision (closes #636).
func TestWriteAgentsMD_MatchesTemplateFixture(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatal(err)
	}

	written, err := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}

	templatePath := filepath.Join(repoRootFromDeftInstall(t), "templates", "agents-entry.md")
	template, err := os.ReadFile(templatePath)
	if err != nil {
		t.Fatalf("could not read %s: %v", templatePath, err)
	}

	if string(written) != string(template) {
		t.Errorf("installer-written AGENTS.md drifted from %s: wrote %d bytes, template has %d bytes",
			templatePath, len(written), len(template))
	}
}

// TestAgentsMDEntrySourcedFromTemplate asserts the installer's agentsMDEntry
// is fed by the embedded templates.AgentsEntry (i.e. no stray hardcoded copy
// was re-introduced alongside it). This is the cmd-level mirror of the drift
// test in templates/embed_test.go (closes #636).
func TestAgentsMDEntrySourcedFromTemplate(t *testing.T) {
	templatePath := filepath.Join(repoRootFromDeftInstall(t), "templates", "agents-entry.md")
	template, err := os.ReadFile(templatePath)
	if err != nil {
		t.Fatalf("could not read %s: %v", templatePath, err)
	}
	if agentsMDEntry != string(template) {
		t.Errorf("agentsMDEntry drifted from %s: installer has %d bytes, template has %d bytes",
			templatePath, len(agentsMDEntry), len(template))
	}
	if !strings.Contains(agentsMDEntry, agentsMDSentinel) {
		t.Errorf("agentsMDEntry must contain the %q sentinel for idempotency", agentsMDSentinel)
	}
}

func TestUserConfigDir_EnvOverride(t *testing.T) {
	t.Setenv("DEFT_USER_PATH", "/custom/path")
	if got := UserConfigDir(); got != "/custom/path" {
		t.Errorf("expected /custom/path, got %s", got)
	}
}

func TestUserConfigDir_Default(t *testing.T) {
	// Clear override to test platform default.
	t.Setenv("DEFT_USER_PATH", "")
	dir := UserConfigDir()
	if dir == "" {
		t.Fatal("UserConfigDir returned empty string")
	}
	if runtime.GOOS == "windows" {
		if !strings.HasSuffix(dir, `\deft`) {
			t.Errorf("expected path ending in \\deft, got %s", dir)
		}
	} else {
		if !strings.HasSuffix(dir, "/deft") {
			t.Errorf("expected path ending in /deft, got %s", dir)
		}
	}
}

func TestWriteAgentsSkills_CreateNew(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	if _, err := WriteAgentsSkills(w, tmp); err != nil {
		t.Fatal(err)
	}

	allSkills := []string{
		"deft", "deft-directive-setup", "deft-directive-build",
		"deft-directive-review-cycle", "deft-directive-refinement", "deft-directive-swarm",
		"deft-directive-interview", "deft-directive-pre-pr", "deft-directive-sync",
	}
	for _, skill := range allSkills {
		path := filepath.Join(tmp, ".agents", "skills", skill, "SKILL.md")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("missing skill file for %s: %v", skill, err)
		}
		if !strings.Contains(string(data), "deft/") {
			t.Errorf("%s/SKILL.md missing deft/-prefixed path, got:\n%s", skill, data)
		}
		if !strings.Contains(string(data), "name: "+skill) {
			t.Errorf("%s/SKILL.md missing name frontmatter", skill)
		}
	}
}

func TestWriteAgentsSkills_Idempotent(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	// Write once (setup).
	if _, err := WriteAgentsSkills(w, tmp); err != nil {
		t.Fatal("setup WriteAgentsSkills failed:", err)
	}

	// Overwrite the deft SKILL.md with sentinel content.
	sentinel := []byte("sentinel content")
	deftPath := filepath.Join(tmp, ".agents", "skills", "deft", "SKILL.md")
	os.WriteFile(deftPath, sentinel, 0o644)

	// Second call should skip (all nine files exist).
	if _, err := WriteAgentsSkills(w, tmp); err != nil {
		t.Fatalf("second WriteAgentsSkills call failed unexpectedly: %v", err)
	}

	data, err := os.ReadFile(deftPath)
	if err != nil {
		t.Fatalf("could not read sentinel file: %v", err)
	}
	if string(data) != string(sentinel) {
		t.Error("expected second WriteAgentsSkills call to be idempotent (no overwrite)")
	}
}

// ---------------------------------------------------------------------------
// Path consistency — framework deposit at .deft/core/ (#1020)
// ---------------------------------------------------------------------------

// TestInstallPathConsistency_SkillPointersUseCanonicalPrefix verifies every
// thin-pointer SKILL.md references the canonical .deft/core/ path (NOT the
// legacy deft/ path). Regression guard for #1020.
func TestInstallPathConsistency_SkillPointersUseCanonicalPrefix(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	if _, err := WriteAgentsSkills(w, tmp); err != nil {
		t.Fatal(err)
	}

	allSkills := []string{
		"deft", "deft-directive-setup", "deft-directive-build",
		"deft-directive-review-cycle", "deft-directive-refinement", "deft-directive-swarm",
		"deft-directive-interview", "deft-directive-pre-pr", "deft-directive-sync",
	}
	for _, skill := range allSkills {
		path := filepath.Join(tmp, ".agents", "skills", skill, "SKILL.md")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("missing skill pointer for %s: %v", skill, err)
		}
		content := string(data)
		if !strings.Contains(content, ".deft/core/") {
			t.Errorf("%s thin pointer does not use .deft/core/ prefix:\n%s", skill, content)
		}
		// Legacy deft/<skill>/SKILL.md or deft/skills/ paths must be absent.
		if strings.Contains(content, "Read and follow: deft/") {
			t.Errorf("%s thin pointer still references legacy `deft/` path:\n%s", skill, content)
		}
	}
}

// TestInstallPathConsistency_OnlyExpectedRootFiles verifies that the install
// workflow creates only AGENTS.md, .agents/, .gitignore, vbrief/, and the
// canonical .deft/ framework parent at the project root.
func TestInstallPathConsistency_OnlyExpectedRootFiles(t *testing.T) {
	origFetch := fetchCoreTarballFunc
	defer func() { fetchCoreTarballFunc = origFetch }()

	// Vendor a tarball fixture into result.DeftDir (.deft/core) -- git-free, so
	// the deposit leaves no .git and no stray root files of its own.
	tarball := makeCoreTarball(t, "deftai-directive-abc1234", map[string]string{"SKILL.md": "skill"})
	fetchCoreTarballFunc = func(string) (string, error) { return tarball, nil }

	tmp := t.TempDir()
	projectDir := filepath.Join(tmp, "myproj")
	os.MkdirAll(projectDir, 0o755)

	result := &WizardResult{
		ProjectName: "myproj",
		ProjectDir:  projectDir,
		DeftDir:     filepath.Join(projectDir, ".deft", "core"),
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	if _, err := VendorDeft(w, result, ""); err != nil {
		t.Fatal(err)
	}
	if err := WriteAgentsMD(w, result.ProjectDir); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteAgentsSkills(w, result.ProjectDir); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureGitignoreLines(w, result.ProjectDir); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteConsumerVbrief(w, result.ProjectDir, result.DeftDir); err != nil {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(projectDir)
	if err != nil {
		t.Fatal(err)
	}

	allowed := map[string]bool{
		".deft":      true, // canonical framework parent
		"AGENTS.md":  true,
		".agents":    true,
		".gitignore": true, // #1015 F2 baseline
		"vbrief":     true, // consumer-root scope vBRIEF workspace
	}
	for _, e := range entries {
		if !allowed[e.Name()] {
			t.Errorf("unexpected file at project root: %s", e.Name())
		}
	}

	// Legacy deft/ MUST NOT be created.
	if _, err := os.Stat(filepath.Join(projectDir, "deft")); err == nil {
		t.Error("legacy deft/ created at project root (canonical install must not create it)")
	}
}

// TestWizardLayoutDefaultsCanonical asserts the wizard's default layout
// produces the canonical .deft/core/ subdir (#1020).
func TestWizardLayoutDefaultsCanonical(t *testing.T) {
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	got := w.frameworkSubdir()
	want := filepath.Join(".deft", "core")
	if got != want {
		t.Errorf("default frameworkSubdir = %q, want %q", got, want)
	}
}

// TestWizardLayoutLegacyFlag asserts --legacy-layout selects the pre-v0.27
// `deft/` subdir for back-compat / in-flight migration paths.
func TestWizardLayoutLegacyFlag(t *testing.T) {
	w := NewWizardWithLayout(strings.NewReader(""), &bytes.Buffer{}, false, true)
	got := w.frameworkSubdir()
	want := "deft"
	if got != want {
		t.Errorf("legacy frameworkSubdir = %q, want %q", got, want)
	}
}

func TestPrintNextSteps(t *testing.T) {
	var buf bytes.Buffer
	w := NewWizard(strings.NewReader(""), &buf, false)
	result := &WizardResult{
		ProjectName: "myproj",
		ProjectDir:  `E:\Repos\myproj`,
		DeftDir:     `E:\Repos\myproj\deft`,
	}

	PrintNextSteps(w, result, `C:\Users\me\AppData\Roaming\deft`, true)

	out := buf.String()
	for _, want := range []string{
		"Deft installed successfully",
		result.DeftDir,
		"AGENTS.md",
		"User config",
		"Use AGENTS.md",
		"USER.md and PROJECT-DEFINITION.vbrief.json",
		"created",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q", want)
		}
	}
}

func TestPrintNextSteps_SkillsAlreadyPresent(t *testing.T) {
	var buf bytes.Buffer
	w := NewWizard(strings.NewReader(""), &buf, false)
	result := &WizardResult{
		ProjectName: "myproj",
		ProjectDir:  `E:\Repos\myproj`,
		DeftDir:     `E:\Repos\myproj\deft`,
	}

	PrintNextSteps(w, result, `C:\Users\me\AppData\Roaming\deft`, false)

	out := buf.String()
	if !strings.Contains(out, "already present") {
		t.Error("output missing \"already present\" for skillsCreated=false")
	}
	if strings.Contains(out, "created") {
		t.Error("output should not contain \"created\" for skillsCreated=false")
	}
}

// ---------------------------------------------------------------------------
// Skill count and new skill coverage
// ---------------------------------------------------------------------------

func TestWriteAgentsSkills_CreatesNineSkills(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	if _, err := WriteAgentsSkills(w, tmp); err != nil {
		t.Fatal(err)
	}

	// Count directories under .agents/skills/.
	skillsDir := filepath.Join(tmp, ".agents", "skills")
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		t.Fatal(err)
	}

	dirCount := 0
	for _, e := range entries {
		if e.IsDir() {
			dirCount++
		}
	}
	if dirCount != 9 {
		t.Errorf("expected 9 skill directories, got %d", dirCount)
	}
}

func TestWriteAgentsSkills_InterviewPointer(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	WriteAgentsSkills(w, tmp)

	path := filepath.Join(tmp, ".agents", "skills", "deft-directive-interview", "SKILL.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing deft-directive-interview thin pointer: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "name: deft-directive-interview") {
		t.Error("interview pointer missing name frontmatter")
	}
	if !strings.Contains(content, ".deft/core/skills/deft-directive-interview/SKILL.md") {
		t.Error("interview pointer missing canonical .deft/core/ path")
	}
}

func TestWriteAgentsSkills_PrePrPointer(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	WriteAgentsSkills(w, tmp)

	path := filepath.Join(tmp, ".agents", "skills", "deft-directive-pre-pr", "SKILL.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing deft-directive-pre-pr thin pointer: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "name: deft-directive-pre-pr") {
		t.Error("pre-pr pointer missing name frontmatter")
	}
	if !strings.Contains(content, ".deft/core/skills/deft-directive-pre-pr/SKILL.md") {
		t.Error("pre-pr pointer missing canonical .deft/core/ path")
	}
}

func TestWriteAgentsSkills_SyncPointer(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	WriteAgentsSkills(w, tmp)

	path := filepath.Join(tmp, ".agents", "skills", "deft-directive-sync", "SKILL.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing deft-directive-sync thin pointer: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "name: deft-directive-sync") {
		t.Error("sync pointer missing name frontmatter")
	}
	if !strings.Contains(content, ".deft/core/skills/deft-directive-sync/SKILL.md") {
		t.Error("sync pointer missing canonical .deft/core/ path")
	}
}

// ---------------------------------------------------------------------------
// .gitignore upkeep + consumer-root vbrief deposit (#1020)
// ---------------------------------------------------------------------------

func TestEnsureGitignoreLines_CreatesNew(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	changed, err := EnsureGitignoreLines(w, tmp)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true on greenfield consumer")
	}
	data, err := os.ReadFile(filepath.Join(tmp, ".gitignore"))
	if err != nil {
		t.Fatalf("missing .gitignore: %v", err)
	}
	for _, want := range []string{".deft-cache/", "vbrief/.eval/"} {
		if !strings.Contains(string(data), want) {
			t.Errorf(".gitignore missing canonical line %q", want)
		}
	}
}

func TestEnsureGitignoreLines_AppendsToExisting(t *testing.T) {
	tmp := t.TempDir()
	pre := "# consumer pre-existing\nnode_modules/\n.env\n"
	if err := os.WriteFile(filepath.Join(tmp, ".gitignore"), []byte(pre), 0o644); err != nil {
		t.Fatal(err)
	}
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	if _, err := EnsureGitignoreLines(w, tmp); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(tmp, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	// Pre-existing lines MUST be preserved byte-for-byte at the start.
	if !strings.HasPrefix(content, pre) {
		t.Errorf(".gitignore preamble lost; got:\n%s", content)
	}
	for _, want := range []string{"node_modules/", ".env", ".deft-cache/", "vbrief/.eval/"} {
		if !strings.Contains(content, want) {
			t.Errorf(".gitignore missing %q after augment", want)
		}
	}
}

func TestEnsureGitignoreLines_Idempotent(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	if _, err := EnsureGitignoreLines(w, tmp); err != nil {
		t.Fatal(err)
	}
	changed, err := EnsureGitignoreLines(w, tmp)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("expected changed=false on second invocation")
	}
	data, _ := os.ReadFile(filepath.Join(tmp, ".gitignore"))
	countCache := strings.Count(string(data), ".deft-cache/")
	countEval := strings.Count(string(data), "vbrief/.eval/")
	if countCache != 1 || countEval != 1 {
		t.Errorf("expected exactly one of each canonical line, got cache=%d eval=%d", countCache, countEval)
	}
}

// TestEnsureGitignoreLines_LeakedArtifactGuards asserts the canonical deposit
// carries every leaked-artefact guard so a consumer's `git add -A` never traps
// installer/render scratch files (#1311 locks, #1445 backups, #1450 migration
// snapshots). The `*.premigrate.*` glob is leading-slash-free so it matches
// both the repo-root snapshots (ROADMAP.premigrate.md) and the nested
// vbrief/specification.premigrate.vbrief.json at any depth.
func TestEnsureGitignoreLines_LeakedArtifactGuards(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	if _, err := EnsureGitignoreLines(w, tmp); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(tmp, ".gitignore"))
	if err != nil {
		t.Fatalf("missing .gitignore: %v", err)
	}
	content := string(data)
	for _, want := range []string{"vbrief/*.lock", ".deft/core.bak-*/", ".deft/*.bak-*", "*.premigrate.*"} {
		if !strings.Contains(content, want) {
			t.Errorf(".gitignore deposit missing leaked-artefact guard %q", want)
		}
	}
}

func TestWriteConsumerVbrief_CreatesNew(t *testing.T) {
	tmp := t.TempDir()
	projectDir := filepath.Join(tmp, "proj")
	os.MkdirAll(projectDir, 0o755)
	// Simulate the framework deposit at .deft/core/ with a schemas/ + vbrief.md.
	deftDir := filepath.Join(projectDir, ".deft", "core")
	fwSchemas := filepath.Join(deftDir, "vbrief", "schemas")
	os.MkdirAll(fwSchemas, 0o755)
	os.WriteFile(filepath.Join(fwSchemas, "vbrief-core.schema.json"), []byte(`{"name":"fixture"}`), 0o644)
	os.WriteFile(filepath.Join(deftDir, "vbrief", "vbrief.md"), []byte("# fixture vbrief\n"), 0o644)

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	changed, err := WriteConsumerVbrief(w, projectDir, deftDir)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true on first deposit")
	}
	if _, err := os.Stat(filepath.Join(projectDir, "vbrief", "schemas", "vbrief-core.schema.json")); err != nil {
		t.Errorf("schemas/ was not seeded: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projectDir, "vbrief", "vbrief.md")); err != nil {
		t.Errorf("vbrief.md was not deposited: %v", err)
	}
	// Lifecycle dirs MUST be pre-created (#1179 reverses the #1020 4g
	// "do not pre-create" contract -- AGENTS.md pre-cutover condition 3
	// fires on a fresh install when any of the five lifecycle subfolders is
	// missing, dead-ending the very first agent turn before Phase 2 of
	// deft-directive-setup runs). Order matches the canonical setup.go
	// `vbriefLifecycleDirs` (proposed -> pending -> active -> completed ->
	// cancelled); imported via `vbriefLifecycleDirsExpected` from
	// `setup_test.go` (same package) so a typo here cannot drift away
	// from the production contract. Each lifecycle directory MUST also
	// carry the `.gitkeep` placeholder so the empty directory survives
	// `git add` and installer packaging (#1179 / tests reviewer MINOR-5).
	for _, lifecycle := range vbriefLifecycleDirsExpected {
		dir := filepath.Join(projectDir, "vbrief", lifecycle)
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Errorf("consumer-root vbrief/%s/ MUST be auto-created (#1179): %v", lifecycle, err)
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, ".gitkeep")); err != nil {
			t.Errorf("consumer-root vbrief/%s/.gitkeep MUST be deposited so the empty lifecycle dir survives packaging (#1179): %v", lifecycle, err)
		}
	}
}

func TestWriteConsumerVbrief_FallbackWhenFrameworkMissing(t *testing.T) {
	tmp := t.TempDir()
	projectDir := filepath.Join(tmp, "proj")
	os.MkdirAll(projectDir, 0o755)
	// deftDir intentionally absent -- exercises the fallback branch.
	deftDir := filepath.Join(projectDir, ".deft", "core")

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if _, err := WriteConsumerVbrief(w, projectDir, deftDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(projectDir, "vbrief", "schemas")); err != nil {
		t.Errorf("schemas dir was not created via fallback: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(projectDir, "vbrief", "vbrief.md"))
	if err != nil {
		t.Fatalf("vbrief.md fallback was not written: %v", err)
	}
	if !strings.Contains(string(data), "scope vBRIEF lifecycle workspace") {
		t.Errorf("vbrief.md fallback body unexpected:\n%s", data)
	}
}

func TestWriteConsumerVbrief_Idempotent(t *testing.T) {
	tmp := t.TempDir()
	projectDir := filepath.Join(tmp, "proj")
	os.MkdirAll(projectDir, 0o755)
	deftDir := filepath.Join(projectDir, ".deft", "core")

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if _, err := WriteConsumerVbrief(w, projectDir, deftDir); err != nil {
		t.Fatal(err)
	}
	// Stash sentinel content -- a second call must not overwrite.
	vbriefPath := filepath.Join(projectDir, "vbrief", "vbrief.md")
	sentinel := []byte("# operator-edited\n")
	os.WriteFile(vbriefPath, sentinel, 0o644)

	changed, err := WriteConsumerVbrief(w, projectDir, deftDir)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("expected changed=false on second invocation")
	}
	data, _ := os.ReadFile(vbriefPath)
	if string(data) != string(sentinel) {
		t.Errorf("WriteConsumerVbrief overwrote operator edit; got:\n%s", data)
	}
}

// TestWriteAgentsMD_RewritesLegacySentinelOnCanonicalInstall asserts that a
// canonical install over a pre-v0.27 AGENTS.md that still advertises the
// legacy `deft/main.md` layout REWRITES the file to the canonical `.deft/core/`
// v3 body. Pre-#1060 the legacy sentinel caused a silent skip and left the
// consumer in cross-layout drift (`AGENTS.md` claims `deft/` while the
// installer just deposited `.deft/core/`), which the framework:doctor probe
// then flagged as a drift on a brand-new install. Layout-aware sentinel
// logic (#1060) now treats the legacy sentinel as a trigger for rewrite,
// not a skip.
func TestWriteAgentsMD_RewritesLegacySentinelOnCanonicalInstall(t *testing.T) {
	tmp := t.TempDir()
	legacy := "# AGENTS\nDeft is installed in deft/. Full guidelines: deft/main.md\n"
	if err := os.WriteFile(filepath.Join(tmp, "AGENTS.md"), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)
	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	content := string(data)
	if content == legacy {
		t.Errorf("AGENTS.md was NOT rewritten despite legacy sentinel + canonical install (#1060 regression); got:\n%s", content)
	}
	if !strings.Contains(content, agentsMDSentinel) {
		t.Errorf("rewritten AGENTS.md missing v3 sentinel; got:\n%s", content)
	}
	if !strings.Contains(content, agentsMDLayoutClaim(".deft/core")) {
		t.Errorf("rewritten AGENTS.md missing canonical install-root claim; got:\n%s", content)
	}
	if !strings.Contains(out.String(), "rewriting AGENTS.md") {
		t.Errorf("installer did not log the rewrite (silent rewrite is a footgun); got log:\n%s", out.String())
	}
}

func TestWriteAgentsSkills_RefinementReplacesRoadmapRefresh(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	WriteAgentsSkills(w, tmp)

	// deft-directive-refinement should exist.
	path := filepath.Join(tmp, ".agents", "skills", "deft-directive-refinement", "SKILL.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing deft-directive-refinement thin pointer: %v", err)
	}
	if !strings.Contains(string(data), "name: deft-directive-refinement") {
		t.Error("refinement pointer missing name frontmatter")
	}

	// Legacy deft-roadmap-refresh should NOT exist.
	legacyPath := filepath.Join(tmp, ".agents", "skills", "deft-roadmap-refresh", "SKILL.md")
	if _, err := os.Stat(legacyPath); err == nil {
		t.Error("legacy deft-roadmap-refresh pointer should not be created")
	}
}

// ---------------------------------------------------------------------------
// buildNonInteractiveResult coverage (Epic-3 #1337, SLizard P1 else-branch)
// ---------------------------------------------------------------------------

// TestBuildNonInteractiveResult_FreshInstall verifies the function reports
// Update=false when the deft dir does not yet exist (the expected fresh-
// install case). Exercises the os.ErrNotExist path of the else-if branch
// added for SLizard P1 go-silent-error-branch.
func TestBuildNonInteractiveResult_FreshInstall(t *testing.T) {
	tmp := t.TempDir()
	res := buildNonInteractiveResult(tmp, false, false)
	if res == nil {
		t.Fatal("expected non-nil result")
	}
	if res.Update {
		t.Error("expected Update=false on fresh install (deftDir absent)")
	}
	if res.LegacyLayout {
		t.Error("expected LegacyLayout=false by default")
	}
	if res.ProjectDir != tmp {
		t.Errorf("ProjectDir = %q, want %q", res.ProjectDir, tmp)
	}
	wantDeft := filepath.Join(tmp, CanonicalFrameworkSubdir)
	if res.DeftDir != wantDeft {
		t.Errorf("DeftDir = %q, want %q", res.DeftDir, wantDeft)
	}
}

// TestBuildNonInteractiveResult_ExistingDirSetsUpdate verifies the function
// reports Update=true when the canonical framework dir already exists --
// agents re-running the installer over an existing install should land on
// the update/refresh path automatically (Epic-3 AC: "safe to re-run").
func TestBuildNonInteractiveResult_ExistingDirSetsUpdate(t *testing.T) {
	tmp := t.TempDir()
	deftDir := filepath.Join(tmp, CanonicalFrameworkSubdir)
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	res := buildNonInteractiveResult(tmp, false, false)
	if !res.Update {
		t.Error("expected Update=true when deftDir already present")
	}
}

// TestBuildNonInteractiveResult_UpgradeShortCircuits verifies the --upgrade
// flag forces Update=true regardless of whether the deft dir exists, so
// agents that explicitly opt into upgrade don't get downgraded to a fresh
// install when the framework dir was wiped between runs.
func TestBuildNonInteractiveResult_UpgradeShortCircuits(t *testing.T) {
	tmp := t.TempDir() // deftDir absent
	res := buildNonInteractiveResult(tmp, false, true)
	if !res.Update {
		t.Error("expected Update=true when upgrade=true even on fresh install")
	}
}

// TestBuildNonInteractiveResult_LegacyLayout verifies the legacy `deft/`
// subdir is selected when legacyLayout=true.
func TestBuildNonInteractiveResult_LegacyLayout(t *testing.T) {
	tmp := t.TempDir()
	res := buildNonInteractiveResult(tmp, true, false)
	if !res.LegacyLayout {
		t.Error("expected LegacyLayout=true")
	}
	wantDeft := filepath.Join(tmp, LegacyFrameworkSubdir)
	if res.DeftDir != wantDeft {
		t.Errorf("DeftDir = %q, want %q", res.DeftDir, wantDeft)
	}
}

// TestBuildNonInteractiveResult_EmptyBasenameFallsBackToProject verifies
// that when filepath.Base sanitises away to empty (e.g. running under a
// path made entirely of invalid chars after sanitisation) the project name
// defaults to "project" instead of returning an empty WizardResult name.
func TestBuildNonInteractiveResult_EmptyBasenameFallsBackToProject(t *testing.T) {
	// Use an absolute path whose basename sanitises to empty: "..." trims
	// to nothing via SanitizeProjectName.
	tmp := t.TempDir()
	dotsDir := filepath.Join(tmp, "...")
	if err := os.MkdirAll(dotsDir, 0o755); err != nil {
		t.Skipf("could not create dotted dir on this OS: %v", err)
	}
	res := buildNonInteractiveResult(dotsDir, false, false)
	if res.ProjectName == "" {
		t.Error("ProjectName should never be empty -- expected fallback to \"project\"")
	}
}
