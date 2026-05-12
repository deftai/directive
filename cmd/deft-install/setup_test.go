package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// failingCloseWriter wraps an io.Writer with a Close() that always returns
// errSimulatedFullDisk. Used to exercise the copyStream close-error
// propagation path without filesystem trickery (a real full-disk condition is
// not portable across Windows/Linux/macOS test runners).
type failingCloseWriter struct {
	w io.Writer
}

func (f *failingCloseWriter) Write(p []byte) (int, error) { return f.w.Write(p) }
func (f *failingCloseWriter) Close() error                { return errSimulatedFullDisk }

var errSimulatedFullDisk = errors.New("simulated full-disk close failure")

// TestCopyStream_ClosePropagatesError verifies the close-error capture
// pattern in copyStream: when io.Copy succeeds but Close() fails (the silent-
// truncation scenario Greptile flagged on PR #1043), the close error must
// override the nil io.Copy return so the caller sees the truncation.
func TestCopyStream_ClosePropagatesError(t *testing.T) {
	src := strings.NewReader("payload that copies cleanly\n")
	out := &failingCloseWriter{w: io.Discard}

	err := copyStream(src, out)
	if err == nil {
		t.Fatal("expected close error to propagate, got nil")
	}
	if !errors.Is(err, errSimulatedFullDisk) {
		t.Errorf("expected errSimulatedFullDisk, got %v", err)
	}
}

// recordingCloseWriter tracks Close() invocations to assert the defer fires
// even when io.Copy returns an error.
type recordingCloseWriter struct {
	writeErr error
	closed   bool
}

func (r *recordingCloseWriter) Write(p []byte) (int, error) {
	if r.writeErr != nil {
		return 0, r.writeErr
	}
	return len(p), nil
}
func (r *recordingCloseWriter) Close() error {
	r.closed = true
	return nil
}

// TestCopyStream_CopyErrorWinsOverNilClose verifies that when io.Copy fails,
// the original io.Copy error is returned (a nil Close() must NOT mask it).
// This guards the `&& err == nil` clause inside the deferred close.
func TestCopyStream_CopyErrorWinsOverNilClose(t *testing.T) {
	wantErr := errors.New("write boom")
	src := strings.NewReader("payload")
	out := &recordingCloseWriter{writeErr: wantErr}

	err := copyStream(src, out)
	if !errors.Is(err, wantErr) {
		t.Errorf("expected io.Copy error to win, got %v", err)
	}
	if !out.closed {
		t.Error("expected Close() to fire even when io.Copy failed")
	}
}

// TestCopyStream_HappyPath verifies the no-error case still returns nil and
// closes the destination.
func TestCopyStream_HappyPath(t *testing.T) {
	src := strings.NewReader("hello")
	out := &recordingCloseWriter{}

	if err := copyStream(src, out); err != nil {
		t.Errorf("unexpected error on happy path: %v", err)
	}
	if !out.closed {
		t.Error("expected Close() to fire on happy path")
	}
}

// TestCopyFile_RoundTrip is the end-to-end happy path for copyFile, kept here
// alongside the close-error tests so both axes are covered in one file.
func TestCopyFile_RoundTrip(t *testing.T) {
	tmp := t.TempDir()
	src := filepath.Join(tmp, "src.txt")
	dst := filepath.Join(tmp, "dst.txt")

	payload := []byte("schema fixture content\nline 2\n")
	if err := os.WriteFile(src, payload, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copyFile returned error: %v", err)
	}

	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Errorf("copyFile output mismatch:\nwant=%q\ngot =%q", payload, got)
	}
}

// TestCopyFile_SrcMissingReturnsError ensures the missing-source error path
// surfaces an error to the caller (no silent success).
func TestCopyFile_SrcMissingReturnsError(t *testing.T) {
	tmp := t.TempDir()
	src := filepath.Join(tmp, "does-not-exist.txt")
	dst := filepath.Join(tmp, "dst.txt")

	if err := copyFile(src, dst); err == nil {
		t.Fatal("expected error when src is missing, got nil")
	}
}

// ---------------------------------------------------------------------------
// Install manifest writer (#1062)
// ---------------------------------------------------------------------------

// TestBuildInstallManifestText_RendersAllFields verifies the renderer emits
// the canonical YAML shape with single-quoted values, the
// ref/sha/tag/install_root/fetched_at/fetched_by order, and the v-prefix
// normalisation contract mirrored from run::_build_install_manifest_text.
func TestBuildInstallManifestText_RendersAllFields(t *testing.T) {
	fields := InstallManifestFields{
		Ref:         "v0.28.0",
		SHA:         "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		Tag:         "v0.28.0",
		InstallRoot: ".deft/core",
		FetchedAt:   "2026-05-12T02:08:16Z",
		FetchedBy:   "deft-install",
	}
	got := BuildInstallManifestText(fields)
	want := "ref: 'v0.28.0'\n" +
		"sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'\n" +
		"tag: 'v0.28.0'\n" +
		"install_root: '.deft/core'\n" +
		"fetched_at: '2026-05-12T02:08:16Z'\n" +
		"fetched_by: 'deft-install'\n"
	if got != want {
		t.Errorf("BuildInstallManifestText mismatch:\nwant=%q\ngot =%q", want, got)
	}
}

// TestBuildInstallManifestText_NormalisesTagPrefix verifies a bare 0.X.Y tag
// is normalised to v0.X.Y (mirrors run::_build_install_manifest_text).
func TestBuildInstallManifestText_NormalisesTagPrefix(t *testing.T) {
	fields := InstallManifestFields{
		SHA:         "abc",
		Tag:         "0.28.0",
		InstallRoot: ".deft/core",
		FetchedAt:   "2026-05-12T02:08:16Z",
		FetchedBy:   "deft-install",
	}
	got := BuildInstallManifestText(fields)
	if !strings.Contains(got, "tag: 'v0.28.0'") {
		t.Errorf("expected v-prefixed tag, got: %s", got)
	}
	if !strings.Contains(got, "ref: 'v0.28.0'") {
		t.Errorf("expected ref to default to normalised tag, got: %s", got)
	}
}

// TestDeriveInstallRootString_Canonical verifies the canonical .deft/core
// install root is rendered POSIX-style on every OS.
func TestDeriveInstallRootString_Canonical(t *testing.T) {
	tmp := t.TempDir()
	deftDir := filepath.Join(tmp, ".deft", "core")
	got := deriveInstallRootString(tmp, deftDir)
	if got != ".deft/core" {
		t.Errorf("derived install_root = %q, want %q", got, ".deft/core")
	}
}

// TestDeriveInstallRootString_Legacy verifies the legacy deft/ install root.
func TestDeriveInstallRootString_Legacy(t *testing.T) {
	tmp := t.TempDir()
	deftDir := filepath.Join(tmp, "deft")
	got := deriveInstallRootString(tmp, deftDir)
	if got != "deft" {
		t.Errorf("derived install_root = %q, want %q", got, "deft")
	}
}

// TestWriteInstallManifest_HappyPath verifies the manifest is written at
// <deftDir>/VERSION with all fields including the install_root row (#1062).
func TestWriteInstallManifest_HappyPath(t *testing.T) {
	tmp := t.TempDir()
	projectDir := filepath.Join(tmp, "myproj")
	deftDir := filepath.Join(projectDir, ".deft", "core")
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fields := InstallManifestFields{
		Ref:         "v0.28.0",
		SHA:         "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		Tag:         "v0.28.0",
		FetchedAt:   "2026-05-12T02:08:16Z",
		FetchedBy:   "deft-install",
	}
	path, err := WriteInstallManifest(projectDir, deftDir, fields)
	if err != nil {
		t.Fatalf("WriteInstallManifest returned error: %v", err)
	}
	wantPath := filepath.Join(deftDir, "VERSION")
	if path != wantPath {
		t.Errorf("WriteInstallManifest returned %q, want %q", path, wantPath)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	for _, want := range []string{
		"ref: 'v0.28.0'",
		"sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'",
		"tag: 'v0.28.0'",
		"install_root: '.deft/core'",
		"fetched_at: '2026-05-12T02:08:16Z'",
		"fetched_by: 'deft-install'",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("manifest body missing %q:\n%s", want, content)
		}
	}
}

// TestWriteInstallManifest_DerivesInstallRootWhenEmpty verifies that when
// the caller leaves InstallRoot empty, WriteInstallManifest derives it from
// the project + deft dirs so the field is always populated (#1062).
func TestWriteInstallManifest_DerivesInstallRootWhenEmpty(t *testing.T) {
	tmp := t.TempDir()
	projectDir := filepath.Join(tmp, "myproj")
	deftDir := filepath.Join(projectDir, "deft")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fields := InstallManifestFields{
		Ref:       "v0.28.0",
		SHA:       "abc",
		Tag:       "v0.28.0",
		FetchedAt: "2026-05-12T02:08:16Z",
		FetchedBy: "deft-install",
	}
	path, err := WriteInstallManifest(projectDir, deftDir, fields)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "install_root: 'deft'") {
		t.Errorf("expected derived install_root 'deft', got:\n%s", string(data))
	}
}

// TestWriteInstallManifest_RejectsEmptyDeftDir verifies the writer fails
// loudly when called without a deftDir (defensive programming guard).
func TestWriteInstallManifest_RejectsEmptyDeftDir(t *testing.T) {
	projectDir := t.TempDir()
	_, err := WriteInstallManifest(projectDir, "", InstallManifestFields{
		Tag:       "v0.28.0",
		FetchedBy: "deft-install",
	})
	if err == nil {
		t.Fatal("expected error when deftDir is empty, got nil")
	}
	if !strings.Contains(err.Error(), "deftDir") {
		t.Errorf("expected error to mention deftDir, got: %v", err)
	}
}

// TestBuildInstallManifestText_BranchRefNotVPrefixed regression-guards the
// Greptile P1 finding on PR #1063: a branch ref like `master` previously got
// `v`-prefixed to `vmaster` because the normalisation was unconditional. The
// fix gates v-prefixing on bareSemverPattern.
func TestBuildInstallManifestText_BranchRefNotVPrefixed(t *testing.T) {
	cases := []struct {
		name   string
		tag    string
		prefix string
	}{
		{"plain master", "master", "tag: 'master'"},
		{"plain main", "main", "tag: 'main'"},
		{"feature branch", "feat/foo", "tag: 'feat/foo'"},
		{"empty tag", "", "tag: ''"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fields := InstallManifestFields{
				SHA:         "abc",
				Tag:         tc.tag,
				InstallRoot: ".deft/core",
				FetchedAt:   "2026-05-12T02:08:16Z",
				FetchedBy:   "deft-install",
			}
			got := BuildInstallManifestText(fields)
			if !strings.Contains(got, tc.prefix) {
				t.Errorf("%s: expected %q in output, got:\n%s", tc.name, tc.prefix, got)
			}
			// Explicit regression-pin against the `vmaster` mangling.
			if tc.tag != "" && strings.Contains(got, "tag: 'v"+tc.tag+"'") {
				t.Errorf("%s: branch ref %q was incorrectly v-prefixed, got:\n%s", tc.name, tc.tag, got)
			}
		})
	}
}

// TestResolveInstallManifestFields_BranchLeavesTagEmpty regression-guards the
// Greptile P1 finding on PR #1063: the resolver must NOT propagate a branch
// name into the Tag field. Ref is still recorded so the manifest carries
// full provenance.
func TestResolveInstallManifestFields_BranchLeavesTagEmpty(t *testing.T) {
	tmp := t.TempDir()
	result := &WizardResult{
		ProjectDir: tmp,
		DeftDir:    filepath.Join(tmp, ".deft", "core"),
	}
	if err := os.MkdirAll(result.DeftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		branch string
		want   string
	}{
		{"master", "master", ""},
		{"main", "main", ""},
		{"feature branch", "feat/foo", ""},
		{"prefixed semver", "v0.28.0", "v0.28.0"},
		{"bare semver", "0.28.0", "0.28.0"},
		{"rc tag", "v0.28.0-rc.1", "v0.28.0-rc.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fields := resolveInstallManifestFields(result, tc.branch)
			if fields.Tag != tc.want {
				t.Errorf("branch %q: Tag = %q, want %q", tc.branch, fields.Tag, tc.want)
			}
			// Ref always preserves the verbatim resolution.
			if fields.Ref != tc.branch {
				t.Errorf("branch %q: Ref = %q, want %q", tc.branch, fields.Ref, tc.branch)
			}
		})
	}
}

// TestResolveInstallManifestFields_BranchRefDoesNotProduceVmasterManifest is
// the end-to-end regression: resolve fields for branch `master`, run them
// through BuildInstallManifestText, and assert the rendered body does NOT
// contain `vmaster`.
func TestResolveInstallManifestFields_BranchRefDoesNotProduceVmasterManifest(t *testing.T) {
	tmp := t.TempDir()
	result := &WizardResult{
		ProjectDir: tmp,
		DeftDir:    filepath.Join(tmp, ".deft", "core"),
	}
	if err := os.MkdirAll(result.DeftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fields := resolveInstallManifestFields(result, "master")
	body := BuildInstallManifestText(fields)
	if strings.Contains(body, "vmaster") {
		t.Errorf("branch ref `master` produced `vmaster` in manifest body:\n%s", body)
	}
	if !strings.Contains(body, "ref: 'master'") {
		t.Errorf("expected `ref: 'master'` in body, got:\n%s", body)
	}
	if !strings.Contains(body, "tag: ''") {
		t.Errorf("expected empty `tag: ''` in body, got:\n%s", body)
	}
}
