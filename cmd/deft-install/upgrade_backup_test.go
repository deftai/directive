package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain redirects the out-of-tree backup root (#1445) to a hermetic temp
// dir for the whole package test run so swapInCore-exercising tests never
// write into the real user cache dir. Individual tests may override
// backupRootDirFunc further for precise per-test assertions.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "deft-install-backups-*")
	if err != nil {
		panic(err)
	}
	backupRootDirFunc = func() string { return tmp }
	code := m.Run()
	_ = os.RemoveAll(tmp)
	os.Exit(code)
}

// isInsideTree reports whether child resolves to a path inside parent.
func isInsideTree(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

// assertNoInTreeBackup walks root and fails if any `*.bak-*` artefact (the
// historical in-tree `.deft/core.bak-<ts>` shape) survives -- such a file
// would be staged by `git add -A` (#1445).
func assertNoInTreeBackup(t *testing.T, root string) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.Contains(d.Name(), ".bak-") {
			t.Errorf("untracked backup artefact left in working tree: %s (git add -A would trap it) -- see #1445", path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
}

// TestSwapInCore_BackupIsOutsideWorkingTree is the #1445 unit-level regression:
// the pre-swap payload backup is staged OUTSIDE the consumer working tree, so
// (a) no `*.bak-*` artefact is left under the project, and (b) the returned
// backup path is outside projectDir and carries the previous payload.
func TestSwapInCore_BackupIsOutsideWorkingTree(t *testing.T) {
	backupRoot := t.TempDir()
	orig := backupRootDirFunc
	backupRootDirFunc = func() string { return backupRoot }
	defer func() { backupRootDirFunc = orig }()

	proj := t.TempDir()
	core := filepath.Join(proj, ".deft", "core")
	if err := os.MkdirAll(core, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(core, "OLD.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	newTree := t.TempDir()
	if err := os.WriteFile(filepath.Join(newTree, "NEW.txt"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}

	backup, err := swapInCore(core, newTree)
	if err != nil {
		t.Fatalf("swapInCore: %v", err)
	}

	// New payload swapped in; old content gone from core.
	if data, err := os.ReadFile(filepath.Join(core, "NEW.txt")); err != nil || string(data) != "new" {
		t.Errorf("NEW.txt not swapped in: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(core, "OLD.txt")); !os.IsNotExist(err) {
		t.Errorf("OLD.txt should be gone from core after swap (err=%v)", err)
	}

	// The backup is OUTSIDE the project tree and preserves the old payload.
	if isInsideTree(proj, backup) {
		t.Errorf("backup %q is INSIDE the project tree %q (git add -A would trap it) -- see #1445", backup, proj)
	}
	if data, err := os.ReadFile(filepath.Join(backup, "OLD.txt")); err != nil || string(data) != "old" {
		t.Errorf("out-of-tree backup missing OLD.txt: data=%q err=%v", data, err)
	}

	// No in-tree backup artefact survived.
	assertNoInTreeBackup(t, proj)
}

// TestRefreshVendoredCore_NoInTreeBackup proves the end-to-end #1445 behavior:
// a vendored `--upgrade` leaves NO untracked backup anywhere under the consumer
// project tree, and reports the backup at an out-of-tree path.
func TestRefreshVendoredCore_NoInTreeBackup(t *testing.T) {
	backupRoot := t.TempDir()
	origBackup := backupRootDirFunc
	origGit := runGitCaptureFunc
	origFetch := fetchCoreTarballFunc
	backupRootDirFunc = func() string { return backupRoot }
	defer func() {
		backupRootDirFunc = origBackup
		runGitCaptureFunc = origGit
		fetchCoreTarballFunc = origFetch
	}()

	proj := t.TempDir()
	core := filepath.Join(proj, ".deft", "core")
	if err := os.MkdirAll(core, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(core, "OLD.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Classify as vendored (not a git work tree) and stand in a tarball.
	runGitCaptureFunc = func(string, ...string) (string, error) {
		return "", fmt.Errorf("not a repo")
	}
	tarball := makeCoreTarball(t, "deftai-directive-abc1234", map[string]string{"marker.txt": "new"})
	fetchCoreTarballFunc = func(string) (string, error) { return tarball, nil }

	result := &WizardResult{ProjectName: "proj", ProjectDir: proj, DeftDir: core, Update: true}
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	outcome, err := UpdateDeft(w, result, "v1.2.3")
	if err != nil {
		t.Fatalf("UpdateDeft (vendored refresh): %v", err)
	}

	if outcome.Backup == "" {
		t.Fatal("expected a backup path on a successful refresh")
	}
	if isInsideTree(proj, outcome.Backup) {
		t.Errorf("reported backup %q is inside the project tree (#1445)", outcome.Backup)
	}
	// The refresh actually happened.
	if data, err := os.ReadFile(filepath.Join(core, "marker.txt")); err != nil || string(data) != "new" {
		t.Errorf("vendored core not refreshed: data=%q err=%v", data, err)
	}
	// And nothing `*.bak-*` was left in the working tree.
	assertNoInTreeBackup(t, proj)
}
