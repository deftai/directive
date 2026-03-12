package main

import (
	"bytes"
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
