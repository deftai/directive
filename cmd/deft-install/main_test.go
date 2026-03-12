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

func TestCheckGuards_ExistingDeft(t *testing.T) {
	tmp := t.TempDir()
	deftDir := filepath.Join(tmp, "project", "deft")
	os.MkdirAll(deftDir, 0o755)

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	err := w.checkGuards(deftDir)
	if err == nil {
		t.Fatal("expected error for existing deft/ directory")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Errorf("error should mention 'already exists', got: %s", err)
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
