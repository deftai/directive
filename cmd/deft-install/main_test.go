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
	deftDir := filepath.Join(tmp, "project", "deft")
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
// Phase 4 — clone and setup
// ---------------------------------------------------------------------------

func TestCloneDeft_CommandArgs(t *testing.T) {
	origRun := runCmdFunc
	defer func() { runCmdFunc = origRun }()

	var gotName string
	var gotArgs []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		gotName = name
		gotArgs = args
		return nil
	}

	tmp := t.TempDir()
	result := &WizardResult{
		ProjectName: "myproj",
		ProjectDir:  filepath.Join(tmp, "myproj"),
		DeftDir:     filepath.Join(tmp, "myproj", "deft"),
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := CloneDeft(w, result, ""); err != nil {
		t.Fatal(err)
	}

	if gotName != "git" {
		t.Errorf("expected command 'git', got %q", gotName)
	}
	if len(gotArgs) != 3 || gotArgs[0] != "clone" || gotArgs[1] != deftRepoURL || gotArgs[2] != result.DeftDir {
		t.Errorf("unexpected args: %v", gotArgs)
	}
	// Project dir should have been created.
	if _, err := os.Stat(result.ProjectDir); err != nil {
		t.Errorf("project dir was not created: %v", err)
	}
}

func TestUpdateDeft_NoBranch(t *testing.T) {
	origRun := runCmdFunc
	defer func() { runCmdFunc = origRun }()

	var cmds []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		cmds = append(cmds, name+" "+strings.Join(args, " "))
		return nil
	}

	tmp := t.TempDir()
	deftDir := filepath.Join(tmp, "myproj", "deft")
	os.MkdirAll(deftDir, 0o755)

	result := &WizardResult{
		ProjectName: "myproj",
		ProjectDir:  filepath.Join(tmp, "myproj"),
		DeftDir:     deftDir,
		Update:      true,
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := UpdateDeft(w, result, ""); err != nil {
		t.Fatal(err)
	}

	// Should fetch + pull (no checkout).
	if len(cmds) != 2 {
		t.Fatalf("expected 2 commands, got %d: %v", len(cmds), cmds)
	}
	if !strings.Contains(cmds[0], "fetch origin") {
		t.Errorf("expected fetch, got: %s", cmds[0])
	}
	if !strings.Contains(cmds[1], "pull") {
		t.Errorf("expected pull, got: %s", cmds[1])
	}
}

func TestUpdateDeft_WithBranch(t *testing.T) {
	origRun := runCmdFunc
	defer func() { runCmdFunc = origRun }()

	var cmds []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		cmds = append(cmds, name+" "+strings.Join(args, " "))
		return nil
	}

	tmp := t.TempDir()
	deftDir := filepath.Join(tmp, "myproj", "deft")
	os.MkdirAll(deftDir, 0o755)

	result := &WizardResult{
		ProjectName: "myproj",
		ProjectDir:  filepath.Join(tmp, "myproj"),
		DeftDir:     deftDir,
		Update:      true,
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := UpdateDeft(w, result, "beta"); err != nil {
		t.Fatal(err)
	}

	// Should fetch + checkout beta + pull.
	if len(cmds) != 3 {
		t.Fatalf("expected 3 commands, got %d: %v", len(cmds), cmds)
	}
	if !strings.Contains(cmds[0], "fetch origin") {
		t.Errorf("expected fetch, got: %s", cmds[0])
	}
	if !strings.Contains(cmds[1], "checkout beta") {
		t.Errorf("expected checkout beta, got: %s", cmds[1])
	}
	if !strings.Contains(cmds[2], "pull") {
		t.Errorf("expected pull, got: %s", cmds[2])
	}
}

func TestCloneDeft_WithBranch(t *testing.T) {
	origRun := runCmdFunc
	defer func() { runCmdFunc = origRun }()

	var gotArgs []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		gotArgs = args
		return nil
	}

	tmp := t.TempDir()
	result := &WizardResult{
		ProjectName: "myproj",
		ProjectDir:  filepath.Join(tmp, "myproj"),
		DeftDir:     filepath.Join(tmp, "myproj", "deft"),
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := CloneDeft(w, result, "beta"); err != nil {
		t.Fatal(err)
	}

	// Expect: clone --branch beta <url> <dir>
	expected := []string{"clone", "--branch", "beta", deftRepoURL, result.DeftDir}
	if len(gotArgs) != len(expected) {
		t.Fatalf("expected %d args, got %d: %v", len(expected), len(gotArgs), gotArgs)
	}
	for i, want := range expected {
		if gotArgs[i] != want {
			t.Errorf("arg[%d] = %q, want %q", i, gotArgs[i], want)
		}
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

	// Write twice.
	WriteAgentsMD(w, tmp)
	WriteAgentsMD(w, tmp)

	data, _ := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	count := strings.Count(string(data), agentsMDSentinel)
	if count != 1 {
		t.Errorf("expected exactly 1 deft entry, found %d", count)
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
		"deft", "deft-setup", "deft-build",
		"deft-review-cycle", "deft-roadmap-refresh", "deft-swarm",
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

	// Second call should skip (all six files exist).
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
// Path consistency — all framework files under ./deft/
// ---------------------------------------------------------------------------

// TestInstallPathConsistency verifies that the installer places all framework
// files under ./deft/ with only AGENTS.md and .agents/ at the project root.
func TestInstallPathConsistency_SkillPointersUseDeftPrefix(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	if _, err := WriteAgentsSkills(w, tmp); err != nil {
		t.Fatal(err)
	}

	allSkills := []string{
		"deft", "deft-setup", "deft-build",
		"deft-review-cycle", "deft-roadmap-refresh", "deft-swarm",
	}
	for _, skill := range allSkills {
		path := filepath.Join(tmp, ".agents", "skills", skill, "SKILL.md")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("missing skill pointer for %s: %v", skill, err)
		}
		content := string(data)
		// Every thin pointer must reference a deft/-prefixed path.
		if !strings.Contains(content, "deft/") {
			t.Errorf("%s thin pointer does not use deft/ prefix:\n%s", skill, content)
		}
	}
}

// TestInstallPathConsistency_OnlyExpectedRootFiles verifies that the install
// workflow creates only AGENTS.md and .agents/ at the project root — all
// other framework files are inside ./deft/.
func TestInstallPathConsistency_OnlyExpectedRootFiles(t *testing.T) {
	origRun := runCmdFunc
	defer func() { runCmdFunc = origRun }()

	// Stub git clone to just create the deft dir.
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		for _, a := range args {
			if strings.HasSuffix(a, "deft") {
				os.MkdirAll(a, 0o755)
			}
		}
		return nil
	}

	tmp := t.TempDir()
	projectDir := filepath.Join(tmp, "myproj")
	os.MkdirAll(projectDir, 0o755)

	result := &WizardResult{
		ProjectName: "myproj",
		ProjectDir:  projectDir,
		DeftDir:     filepath.Join(projectDir, "deft"),
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)

	// Run all setup steps that create files.
	if err := CloneDeft(w, result, ""); err != nil {
		t.Fatal(err)
	}
	if err := WriteAgentsMD(w, result.ProjectDir); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteAgentsSkills(w, result.ProjectDir); err != nil {
		t.Fatal(err)
	}

	// Enumerate top-level entries in the project directory.
	entries, err := os.ReadDir(projectDir)
	if err != nil {
		t.Fatal(err)
	}

	allowed := map[string]bool{
		"deft":      true, // framework directory
		"AGENTS.md": true, // expected exception
		".agents":   true, // expected exception
	}
	for _, e := range entries {
		if !allowed[e.Name()] {
			t.Errorf("unexpected file at project root: %s (framework files must be under ./deft/)", e.Name())
		}
	}
}

// TestInstallPathConsistency_DeftDirAlwaysSubfolder verifies the wizard always
// sets DeftDir as a "deft" subfolder inside ProjectDir.
func TestInstallPathConsistency_DeftDirAlwaysSubfolder(t *testing.T) {
	projectDirs := []string{
		filepath.Join("C:", "repos", "myproj"),
		filepath.Join("/", "home", "user", "projects", "app"),
		filepath.Join("E:", "Work", "project-name"),
	}

	for _, pd := range projectDirs {
		result := &WizardResult{
			ProjectDir: pd,
			DeftDir:    filepath.Join(pd, "deft"),
		}
		// Verify DeftDir is always the "deft" direct child of ProjectDir.
		if result.DeftDir != filepath.Join(result.ProjectDir, "deft") {
			t.Errorf("DeftDir mismatch for %s: got %s, want %s",
				pd, result.DeftDir, filepath.Join(result.ProjectDir, "deft"))
		}
		if filepath.Base(result.DeftDir) != "deft" {
			t.Errorf("DeftDir base should be 'deft', got %s", filepath.Base(result.DeftDir))
		}
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
		"USER.md and PROJECT.md",
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
