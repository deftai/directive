package main

import (
	"bytes"
	"fmt"
	"io"
	"runtime"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// #899 -- refreshPathFunc wiring + non-Windows no-op behaviour
// ---------------------------------------------------------------------------

// TestRefreshPathFromRegistry_DoesNotPanic verifies the helper is callable
// on every supported platform without panicking. On Windows it performs a
// real registry read (HKLM + HKCU); on non-Windows it is the no-op stub
// from path_other.go. Both paths MUST return without crashing -- a panic
// here would mean a clean Windows box's installer crashes before it even
// gets to the install attempt.
func TestRefreshPathFromRegistry_DoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("refreshPathFromRegistry panicked: %v", r)
		}
	}()
	_ = refreshPathFromRegistry()
}

// TestRefreshPathFromRegistry_NonWindowsNoOpReturnsNil pins the no-op
// stub's contract: on macOS / Linux the helper MUST return a nil error
// and MUST NOT mutate the process PATH. The stub's job is to be
// invisible to callers on non-Windows hosts.
func TestRefreshPathFromRegistry_NonWindowsNoOpReturnsNil(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("non-Windows no-op contract; Windows stub is exercised by path_windows_test.go")
	}
	if err := refreshPathFromRegistry(); err != nil {
		t.Errorf("expected nil error from non-Windows no-op stub, got %v", err)
	}
}

// TestEnsureGit_RefreshesPathBeforeInitialProbe pins the #899 contract
// that EnsureGit calls refreshPathFunc BEFORE the initial gitAvailable()
// probe. The fix matters when a prior install has updated the registry
// PATH but the running process still has the startup snapshot.
func TestEnsureGit_RefreshesPathBeforeInitialProbe(t *testing.T) {
	origLook := lookPathFunc
	origRefresh := refreshPathFunc
	defer func() {
		lookPathFunc = origLook
		refreshPathFunc = origRefresh
	}()

	var calls []string
	refreshPathFunc = func() error {
		calls = append(calls, "refresh")
		return nil
	}
	lookPathFunc = func(file string) (string, error) {
		calls = append(calls, "lookpath")
		return `C:\Program Files\Git\cmd\git.exe`, nil
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := EnsureGit(w); err != nil {
		t.Fatalf("EnsureGit returned error: %v", err)
	}
	if len(calls) < 2 {
		t.Fatalf("expected at least 2 calls, got %v", calls)
	}
	if calls[0] != "refresh" {
		t.Errorf("expected refresh BEFORE initial probe, got call order %v", calls)
	}
}

// TestEnsureGit_RefreshesPathAfterInstall pins the #899 contract that
// EnsureGit calls refreshPathFunc AFTER a successful installGitWindows
// and BEFORE the post-install gitAvailable() re-check. The Greptile
// regression we are guarding: silent Git-for-Windows installer mutates
// the registry PATH but the running process keeps its startup snapshot;
// without the second refresh the re-check always failed on a clean box.
func TestEnsureGit_RefreshesPathAfterInstall(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows-specific install path; non-Windows runs do not exercise installGitWindows")
	}

	origLook := lookPathFunc
	origRun := runCmdFunc
	origDl := downloadGitInstallerFunc
	origRefresh := refreshPathFunc
	defer func() {
		lookPathFunc = origLook
		runCmdFunc = origRun
		downloadGitInstallerFunc = origDl
		refreshPathFunc = origRefresh
	}()

	var calls []string
	refreshPathFunc = func() error {
		calls = append(calls, "refresh")
		return nil
	}
	// First lookPath: not found. After install + refresh: found.
	lookCount := 0
	lookPathFunc = func(file string) (string, error) {
		lookCount++
		calls = append(calls, fmt.Sprintf("lookpath#%d", lookCount))
		if lookCount <= 1 {
			return "", fmt.Errorf("not found")
		}
		return `C:\Program Files\Git\cmd\git.exe`, nil
	}
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		calls = append(calls, "winget")
		return nil // winget "succeeds"
	}
	downloadGitInstallerFunc = func(w *Wizard) error {
		t.Fatal("downloadGitInstaller should not be reached when winget succeeds")
		return nil
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := EnsureGit(w); err != nil {
		t.Fatalf("EnsureGit returned error: %v", err)
	}

	// Expected ordering: refresh, lookpath#1, winget, refresh, lookpath#2
	wantOrder := []string{"refresh", "lookpath#1", "winget", "refresh", "lookpath#2"}
	if len(calls) != len(wantOrder) {
		t.Fatalf("call sequence length mismatch: got %v, want %v", calls, wantOrder)
	}
	for i, want := range wantOrder {
		if calls[i] != want {
			t.Errorf("call[%d] = %q, want %q (full sequence: %v)", i, calls[i], want, calls)
		}
	}

	// And the second refresh MUST appear AFTER the install step and BEFORE
	// the second lookpath -- this is what closes #899.
	refreshIdx := -1
	for i := len(calls) - 1; i >= 0; i-- {
		if calls[i] == "refresh" {
			refreshIdx = i
			break
		}
	}
	if refreshIdx == -1 {
		t.Fatalf("post-install refresh missing: %v", calls)
	}
	if calls[refreshIdx-1] != "winget" {
		t.Errorf("post-install refresh should follow install step, got %q", calls[refreshIdx-1])
	}
	if calls[refreshIdx+1] != "lookpath#2" {
		t.Errorf("post-install refresh should precede re-check probe, got %q", calls[refreshIdx+1])
	}
}

// TestEnsureGit_RefreshErrorsAreNonFatal verifies that a registry-read
// failure does not propagate out of EnsureGit -- the helper is best-
// effort. If git happens to be on the existing in-process PATH the
// install proceeds successfully even when the registry refresh failed.
func TestEnsureGit_RefreshErrorsAreNonFatal(t *testing.T) {
	origLook := lookPathFunc
	origRefresh := refreshPathFunc
	defer func() {
		lookPathFunc = origLook
		refreshPathFunc = origRefresh
	}()

	refreshPathFunc = func() error {
		return fmt.Errorf("simulated registry read failure")
	}
	lookPathFunc = func(file string) (string, error) {
		return `/usr/bin/git`, nil
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := EnsureGit(w); err != nil {
		t.Errorf("EnsureGit must not propagate refresh errors when git is present, got %v", err)
	}
}
