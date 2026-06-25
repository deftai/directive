package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// captureStderr redirects os.Stderr to a temp file for the duration of fn and
// returns everything written to it. A temp file (rather than an os.Pipe) avoids
// the pipe-buffer deadlock when fn writes more than the pipe capacity before
// the reader drains it.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	f, err := os.CreateTemp(t.TempDir(), "stderr-*.txt")
	if err != nil {
		t.Fatalf("create temp stderr file: %v", err)
	}
	os.Stderr = f
	defer func() { os.Stderr = old }()
	fn()
	os.Stderr = old
	if err := f.Close(); err != nil {
		t.Fatalf("close temp stderr file: %v", err)
	}
	data, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("read temp stderr file: %v", err)
	}
	return string(data)
}

// handoffMarker is the user-facing command the handoff line MUST steer
// consumers toward; asserting on it (rather than the whole message) keeps the
// test resilient to copy tweaks while still pinning the AC contract (#1972).
const handoffMarker = "npx @deftai/directive init"

// TestInstall_SuccessPrintsNpmHandoff covers AC #1 + #3: a completed install /
// upgrade prints the npm-handoff line, and the success output captured under
// test contains the handoff command. It drives the real install() success path
// (a vendored file-swap upgrade) so the assertion exercises the actual gate
// placement, not a stand-in.
func TestInstall_SuccessPrintsNpmHandoff(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available; skipping install()-level success handoff test")
	}
	origFetch := fetchCoreTarballFunc
	origGit := runGitCaptureFunc
	defer func() {
		fetchCoreTarballFunc = origFetch
		runGitCaptureFunc = origGit
	}()

	proj := newDirtyUpgradeRepo(t, gitPath)
	// Classify the payload as vendored so the upgrade uses the git-free swap,
	// and feed a fixture tarball so no network fetch is attempted.
	runGitCaptureFunc = func(string, ...string) (string, error) { return "", fmt.Errorf("not a repo") }
	tarball := makeCoreTarball(t, "deftai-directive-beef1234", map[string]string{"marker.txt": "new"})
	fetchCoreTarballFunc = func(string) (string, error) { return tarball, nil }
	t.Setenv("DEFT_USER_PATH", filepath.Join(t.TempDir(), "cfg"))

	var code int
	stderr := captureStderr(t, func() {
		// --force upgrades the dirty tree; non-interactive; no update check.
		code = install(false, "", false, true, true, proj, false, false, true, false, true)
	})
	if code != 0 {
		t.Fatalf("successful upgrade must exit 0, got %d (stderr=%q)", code, stderr)
	}
	if !strings.Contains(stderr, handoffMarker) {
		t.Errorf("success output must contain the npm handoff command %q; stderr=%q", handoffMarker, stderr)
	}
	if !strings.Contains(stderr, npmHandoffMessage) {
		t.Errorf("success output must contain the full handoff message %q; stderr=%q", npmHandoffMessage, stderr)
	}
}

// TestInstall_ErrorOmitsNpmHandoff covers AC #2: an install that errors out
// (here a dirty-tree --upgrade refused fail-loud, #1458) exits non-zero and
// MUST NOT print the npm handoff message, because every error path returns
// before printNpmHandoff is reached.
func TestInstall_ErrorOmitsNpmHandoff(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available; skipping install()-level error handoff test")
	}
	origFetch := fetchCoreTarballFunc
	defer func() { fetchCoreTarballFunc = origFetch }()

	proj := newDirtyUpgradeRepo(t, gitPath)
	fetchCoreTarballFunc = func(string) (string, error) {
		return "", fmt.Errorf("a blocked upgrade must never fetch")
	}
	t.Setenv("DEFT_USER_PATH", filepath.Join(t.TempDir(), "cfg"))

	var code int
	stderr := captureStderr(t, func() {
		// No --force: a dirty-tree --upgrade is refused fail-loud (exit 1).
		code = install(false, "", false, true, true, proj, false, false, false, false, true)
	})
	if code == 0 {
		t.Fatalf("dirty-tree --upgrade must fail loud (non-zero exit); got 0 (stderr=%q)", stderr)
	}
	if strings.Contains(stderr, handoffMarker) {
		t.Errorf("errored install must NOT print the npm handoff command %q; stderr=%q", handoffMarker, stderr)
	}
}

// TestPrintNpmHandoff_WritesMessage is a focused unit check that the helper
// emits the constant to stderr, independent of the install() pipeline.
func TestPrintNpmHandoff_WritesMessage(t *testing.T) {
	out := captureStderr(t, printNpmHandoff)
	if !strings.Contains(out, handoffMarker) {
		t.Errorf("printNpmHandoff output %q must contain %q", out, handoffMarker)
	}
}
