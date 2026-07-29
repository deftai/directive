package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
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

// ---------------------------------------------------------------------------
// #2908 -- pin + SHA-256 verify Git-for-Windows installer before silent exec
// (tracker #2904, finding install-deposit-01)
// ---------------------------------------------------------------------------

// TestPinnedGitForWindowsSHA256_WellFormed guards the trust anchor's shape: a
// bare, lowercase, 64-hex-char SHA-256 with no "sha256:" prefix creep and no
// accidental truncation. A malformed pin would either never match (bricking
// every Windows download install) or, worse, be silently mishandled.
func TestPinnedGitForWindowsSHA256_WellFormed(t *testing.T) {
	got := pinnedGitForWindowsSHA256
	if len(got) != 64 {
		t.Fatalf("pinned SHA-256 must be 64 hex chars, got %d (%q)", len(got), got)
	}
	if strings.HasPrefix(got, "sha256:") {
		t.Fatalf("pinned SHA-256 must not carry a sha256: prefix: %q", got)
	}
	if _, err := hex.DecodeString(got); err != nil {
		t.Fatalf("pinned SHA-256 is not valid hex: %v", err)
	}
	if got != strings.ToLower(got) {
		t.Errorf("pinned SHA-256 should be lowercase for stable comparison: %q", got)
	}
}

// TestPinnedGitConstants_Consistent pins the invariant that the winget version
// and the asset name are derived from the same underlying git version, so a
// future bump cannot update the tag while leaving a stale winget version or
// asset name behind.
func TestPinnedGitConstants_Consistent(t *testing.T) {
	// winget version "2.55.0.3" splits into base "2.55.0" + windows revision
	// "3"; the git-for-windows tag is "v<base>.windows.<rev>" and the asset is
	// "Git-<version>-64-bit.exe". A future bump must keep all four aligned.
	idx := strings.LastIndex(pinnedGitForWindowsVersion, ".")
	if idx <= 0 || idx == len(pinnedGitForWindowsVersion)-1 {
		t.Fatalf("pinned version %q is not of the form base.rev", pinnedGitForWindowsVersion)
	}
	base := pinnedGitForWindowsVersion[:idx]
	rev := pinnedGitForWindowsVersion[idx+1:]
	wantTag := "v" + base + ".windows." + rev
	if pinnedGitForWindowsTag != wantTag {
		t.Errorf("tag %q inconsistent with version %q (expected %q)",
			pinnedGitForWindowsTag, pinnedGitForWindowsVersion, wantTag)
	}
	wantAsset := "Git-" + pinnedGitForWindowsVersion + "-64-bit.exe"
	if pinnedGitForWindowsAsset != wantAsset {
		t.Errorf("asset %q inconsistent with version %q (expected %q)",
			pinnedGitForWindowsAsset, pinnedGitForWindowsVersion, wantAsset)
	}
	if !strings.HasSuffix(pinnedGitForWindowsAsset, "-64-bit.exe") {
		t.Errorf("pinned asset %q should be the 64-bit installer", pinnedGitForWindowsAsset)
	}
}

// TestVerifyFileSHA256_Match verifies the trust gate accepts a file whose
// digest matches the expected hash.
func TestVerifyFileSHA256_Match(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "installer.exe")
	content := []byte("pretend git-for-windows installer bytes")
	if err := os.WriteFile(p, content, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	sum := sha256.Sum256(content)
	if err := verifyFileSHA256(p, hex.EncodeToString(sum[:])); err != nil {
		t.Fatalf("expected match, got error: %v", err)
	}
}

// TestVerifyFileSHA256_MatchWithPrefixAndCase verifies the gate tolerates a
// "sha256:" prefix and uppercase hex (defensive normalization) so a correct
// digest expressed in a different textual form still verifies.
func TestVerifyFileSHA256_MatchWithPrefixAndCase(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "installer.exe")
	content := []byte("another installer payload")
	if err := os.WriteFile(p, content, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	sum := sha256.Sum256(content)
	want := "sha256:" + strings.ToUpper(hex.EncodeToString(sum[:]))
	if err := verifyFileSHA256(p, want); err != nil {
		t.Fatalf("expected match with prefixed/uppercase digest, got: %v", err)
	}
}

// TestVerifyFileSHA256_Mismatch is the core fail-closed assertion: a file whose
// digest does not match the expected hash MUST be rejected with a clear
// mismatch error.
func TestVerifyFileSHA256_Mismatch(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "installer.exe")
	if err := os.WriteFile(p, []byte("tampered payload"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	err := verifyFileSHA256(p, pinnedGitForWindowsSHA256)
	if err == nil {
		t.Fatal("expected mismatch error, got nil")
	}
	if !strings.Contains(err.Error(), "mismatch") {
		t.Errorf("expected a mismatch error, got: %v", err)
	}
}

// TestVerifyFileSHA256_MissingFile ensures an unreadable/missing installer is a
// verification failure (fail closed), never a silent pass.
func TestVerifyFileSHA256_MissingFile(t *testing.T) {
	err := verifyFileSHA256(filepath.Join(t.TempDir(), "does-not-exist.exe"), pinnedGitForWindowsSHA256)
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}

// TestDownloadGitInstaller_FailClosedOnDigestMismatch is the end-to-end
// fail-closed contract: when the downloaded bytes do not match the pinned
// SHA-256, downloadGitInstaller MUST return an error, MUST NOT execute the
// installer, and MUST remove the rejected temp file.
func TestDownloadGitInstaller_FailClosedOnDigestMismatch(t *testing.T) {
	origResolve := resolvePinnedInstallerURLFunc
	origFetch := fetchInstallerToTempFunc
	origRun := runCmdFunc
	defer func() {
		resolvePinnedInstallerURLFunc = origResolve
		fetchInstallerToTempFunc = origFetch
		runCmdFunc = origRun
	}()

	dir := t.TempDir()
	tmpPath := filepath.Join(dir, "deft-git-installer-XXXX.exe")
	// Bytes that will NOT hash to the pinned digest -> must be refused.
	if err := os.WriteFile(tmpPath, []byte("MALICIOUS or corrupted installer"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	resolvePinnedInstallerURLFunc = func(w *Wizard) (string, error) {
		return "https://example.invalid/pinned.exe", nil
	}
	fetchInstallerToTempFunc = func(w *Wizard, url string) (string, error) {
		return tmpPath, nil
	}
	ran := false
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		ran = true
		return nil
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	err := downloadGitInstaller(w)
	if err == nil {
		t.Fatal("expected fail-closed error on digest mismatch, got nil")
	}
	if ran {
		t.Fatal("SECURITY: installer was executed despite a SHA-256 mismatch")
	}
	if _, statErr := os.Stat(tmpPath); !os.IsNotExist(statErr) {
		t.Errorf("rejected installer temp file should be removed, stat err = %v", statErr)
	}
}

// TestDownloadGitInstaller_RunsOnDigestMatch verifies the happy path: when the
// downloaded bytes match the (test-substituted) pinned digest, the installer is
// executed exactly once with the silent flags, and the temp file is cleaned up.
func TestDownloadGitInstaller_RunsOnDigestMatch(t *testing.T) {
	origResolve := resolvePinnedInstallerURLFunc
	origFetch := fetchInstallerToTempFunc
	origRun := runCmdFunc
	origPin := pinnedGitForWindowsSHA256
	defer func() {
		resolvePinnedInstallerURLFunc = origResolve
		fetchInstallerToTempFunc = origFetch
		runCmdFunc = origRun
		pinnedGitForWindowsSHA256 = origPin
	}()

	dir := t.TempDir()
	tmpPath := filepath.Join(dir, "deft-git-installer-YYYY.exe")
	content := []byte("verified good installer bytes")
	if err := os.WriteFile(tmpPath, content, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	sum := sha256.Sum256(content)
	pinnedGitForWindowsSHA256 = hex.EncodeToString(sum[:]) // substitute pin for fixture

	resolvePinnedInstallerURLFunc = func(w *Wizard) (string, error) {
		return "https://example.invalid/pinned.exe", nil
	}
	fetchInstallerToTempFunc = func(w *Wizard, url string) (string, error) {
		return tmpPath, nil
	}
	var gotName string
	var gotArgs []string
	runCount := 0
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		runCount++
		gotName = name
		gotArgs = args
		return nil
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := downloadGitInstaller(w); err != nil {
		t.Fatalf("expected success on digest match, got: %v", err)
	}
	if runCount != 1 {
		t.Fatalf("expected installer to run exactly once, ran %d times", runCount)
	}
	if gotName != tmpPath {
		t.Errorf("expected to exec the downloaded temp file %q, got %q", tmpPath, gotName)
	}
	wantArgs := []string{"/SILENT", "/NORESTART"}
	if len(gotArgs) != len(wantArgs) || gotArgs[0] != wantArgs[0] || gotArgs[1] != wantArgs[1] {
		t.Errorf("expected silent install args %v, got %v", wantArgs, gotArgs)
	}
	if _, statErr := os.Stat(tmpPath); !os.IsNotExist(statErr) {
		t.Errorf("installer temp file should be removed after run, stat err = %v", statErr)
	}
}

// TestInstallGitWindows_WingetUsesPinnedVersion verifies the preferred winget
// path is pinned to the known-good package version (#2908) rather than
// resolving whatever winget's "latest" happens to be.
func TestInstallGitWindows_WingetUsesPinnedVersion(t *testing.T) {
	origRun := runCmdFunc
	origDl := downloadGitInstallerFunc
	defer func() {
		runCmdFunc = origRun
		downloadGitInstallerFunc = origDl
	}()

	var gotArgs []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		if name == "winget" {
			gotArgs = append([]string{name}, args...)
		}
		return nil // winget "succeeds" so download is not reached
	}
	downloadGitInstallerFunc = func(w *Wizard) error {
		t.Fatal("download path must not run when winget succeeds")
		return nil
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := installGitWindows(w); err != nil {
		t.Fatalf("installGitWindows returned error: %v", err)
	}
	joined := strings.Join(gotArgs, " ")
	if !strings.Contains(joined, "--version "+pinnedGitForWindowsVersion) {
		t.Errorf("winget invocation should pin --version %s, got: %s", pinnedGitForWindowsVersion, joined)
	}
	if !strings.Contains(joined, "--id Git.Git") {
		t.Errorf("winget invocation should target Git.Git, got: %s", joined)
	}
}
