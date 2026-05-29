package main

import (
	"bytes"
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
		Ref:       "v0.28.0",
		SHA:       "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		Tag:       "v0.28.0",
		FetchedAt: "2026-05-12T02:08:16Z",
		FetchedBy: "deft-install",
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

// ---------------------------------------------------------------------------
// Layout-aware WriteAgentsMD sentinel logic (#1060)
// ---------------------------------------------------------------------------

// TestWriteAgentsMD_FreshInstall_WritesCanonicalV3Body covers the (a)
// fresh-install case from the #1060 acceptance criteria: no AGENTS.md
// present at the project root -> the installer writes the v3 body keyed to
// the canonical `.deft/core/` install root.
func TestWriteAgentsMD_FreshInstall_WritesCanonicalV3Body(t *testing.T) {
	tmp := t.TempDir()
	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)

	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatalf("WriteAgentsMD returned error on fresh install: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	if err != nil {
		t.Fatalf("AGENTS.md not created: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, agentsMDSentinel) {
		t.Errorf("fresh-install AGENTS.md missing v3 sentinel %q", agentsMDSentinel)
	}
	if !strings.Contains(content, agentsMDLayoutClaim(".deft/core")) {
		t.Errorf("fresh-install AGENTS.md missing canonical install-root claim; got:\n%s", content)
	}
	if strings.Contains(content, agentsMDLayoutClaim("deft")) {
		t.Errorf("fresh-install AGENTS.md leaked legacy install-root claim:\n%s", content)
	}
	if !strings.Contains(out.String(), "AGENTS.md created") {
		t.Errorf("installer did not log fresh-create event; got log:\n%s", out.String())
	}
}

// TestWriteAgentsMD_StaleLegacyAGENTSMD_RewritesToCanonical covers the (b)
// case: a canonical install lands on a project whose AGENTS.md still carries
// the pre-v0.27 `deft/main.md` legacy sentinel. The installer MUST rewrite
// the file to the canonical `.deft/core/` v3 body and log the rewrite.
// This is the load-bearing regression that #1060 closes -- pre-fix, the
// legacy sentinel triggered a silent skip and the framework:doctor probe
// (#1046 PR-B AC-3) then flagged the install as drifted.
func TestWriteAgentsMD_StaleLegacyAGENTSMD_RewritesToCanonical(t *testing.T) {
	tmp := t.TempDir()
	legacyBody := "# Project AGENTS\n" +
		"Deft is installed in deft/. Full guidelines: deft/main.md\n" +
		"Read deft/skills/deft-directive-setup/SKILL.md for setup.\n"
	if err := os.WriteFile(filepath.Join(tmp, "AGENTS.md"), []byte(legacyBody), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)
	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatalf("WriteAgentsMD returned error on legacy-layout AGENTS.md: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	content := string(data)
	if content == legacyBody {
		t.Fatalf("AGENTS.md was NOT rewritten despite legacy sentinel + canonical install (#1060); got verbatim legacy body:\n%s", content)
	}
	if !strings.Contains(content, agentsMDSentinel) {
		t.Errorf("rewritten AGENTS.md missing v3 sentinel:\n%s", content)
	}
	if !strings.Contains(content, agentsMDLayoutClaim(".deft/core")) {
		t.Errorf("rewritten AGENTS.md missing canonical install-root claim:\n%s", content)
	}
	if strings.Contains(content, agentsMDLegacySentinel) {
		t.Errorf("rewritten AGENTS.md still references legacy `deft/main.md`:\n%s", content)
	}
	if !strings.Contains(out.String(), "rewriting AGENTS.md") {
		t.Errorf("installer did not log the rewrite (silent rewrite is a footgun per #1060); got log:\n%s", out.String())
	}
	if !strings.Contains(out.String(), ".deft/core") {
		t.Errorf("installer log did not name the target layout; got log:\n%s", out.String())
	}
}

// TestWriteAgentsMD_UpToDateCanonical_Skips covers the (c) case: a canonical
// install lands on a project whose AGENTS.md already carries the canonical
// v3 body. The installer MUST detect the layout match and skip the rewrite.
func TestWriteAgentsMD_UpToDateCanonical_Skips(t *testing.T) {
	tmp := t.TempDir()

	// Seed AGENTS.md with the canonical body via a first WriteAgentsMD call,
	// then capture its byte length so we can prove the second call is a
	// no-op rewrite-wise.
	w1 := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := WriteAgentsMD(w1, tmp); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(tmp, "AGENTS.md")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	w2 := NewWizard(strings.NewReader(""), &out, false)
	if err := WriteAgentsMD(w2, tmp); err != nil {
		t.Fatalf("WriteAgentsMD returned error on up-to-date canonical AGENTS.md: %v", err)
	}

	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Errorf("AGENTS.md byte-changed despite up-to-date canonical body")
	}
	afterInfo, _ := os.Stat(path)
	if !afterInfo.ModTime().Equal(beforeInfo.ModTime()) {
		t.Errorf("AGENTS.md was rewritten despite up-to-date canonical body (mtime drifted)")
	}
	if !strings.Contains(out.String(), "skipping") {
		t.Errorf("installer did not log the skip; got log:\n%s", out.String())
	}
	if strings.Contains(out.String(), "rewriting AGENTS.md") {
		t.Errorf("installer incorrectly logged a rewrite for up-to-date canonical AGENTS.md; got log:\n%s", out.String())
	}
}

// TestWriteAgentsMD_UpToDateLegacy_LegacyInstallSkips covers the (d) case:
// `--legacy-layout` install lands on a project whose AGENTS.md already
// carries the v3 body keyed to the legacy `deft/` install root. The
// installer MUST detect the layout match and skip the rewrite -- the legacy
// layout selector is symmetric to the canonical happy path.
func TestWriteAgentsMD_UpToDateLegacy_LegacyInstallSkips(t *testing.T) {
	tmp := t.TempDir()

	// Seed AGENTS.md with a v3 body keyed to the legacy `deft/` install
	// root by running a first --legacy-layout install.
	wSeed := NewWizardWithLayout(strings.NewReader(""), &bytes.Buffer{}, false, true)
	if err := WriteAgentsMD(wSeed, tmp); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(tmp, "AGENTS.md")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(before), agentsMDLayoutClaim("deft")) {
		t.Fatalf("seed AGENTS.md missing legacy install-root claim; got:\n%s", before)
	}
	if strings.Contains(string(before), agentsMDLayoutClaim(".deft/core")) {
		t.Errorf("legacy-seeded AGENTS.md leaked canonical claim:\n%s", before)
	}

	var out bytes.Buffer
	wRerun := NewWizardWithLayout(strings.NewReader(""), &out, false, true)
	if err := WriteAgentsMD(wRerun, tmp); err != nil {
		t.Fatalf("WriteAgentsMD returned error on up-to-date legacy AGENTS.md: %v", err)
	}

	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Errorf("AGENTS.md byte-changed despite up-to-date legacy body")
	}
	if !strings.Contains(out.String(), "skipping") {
		t.Errorf("installer did not log the skip on up-to-date legacy install; got log:\n%s", out.String())
	}
	if strings.Contains(out.String(), "rewriting AGENTS.md") {
		t.Errorf("installer incorrectly logged a rewrite for up-to-date legacy AGENTS.md; got log:\n%s", out.String())
	}
}

// TestRenderAgentsEntry_CanonicalUnchanged pins the no-substitution contract
// for the canonical install root: the rendered body is byte-identical to the
// embedded templates.AgentsEntry. Guards against a future refactor that
// accidentally introduces a normalisation pass for the canonical case.
func TestRenderAgentsEntry_CanonicalUnchanged(t *testing.T) {
	got := renderAgentsEntry(".deft/core")
	if got != agentsMDEntry {
		t.Errorf("renderAgentsEntry(\".deft/core\") drifted from embedded template (canonical install MUST be unchanged)")
	}
	if renderAgentsEntry("") != agentsMDEntry {
		t.Errorf("renderAgentsEntry(\"\") drifted from embedded template (empty install root MUST fall back to canonical)")
	}
}

// TestRenderAgentsEntry_LegacySubstitutesPaths pins the substitution
// contract for the legacy install root: every `.deft/core/` path prefix in
// the embedded body is rewritten to `deft/`. Without this the legacy install
// would write a body that advertises `.deft/core/` while the framework is
// deposited at `deft/` -- the symmetric form of the #1060 cross-layout drift.
func TestRenderAgentsEntry_LegacySubstitutesPaths(t *testing.T) {
	got := renderAgentsEntry("deft")
	if got == agentsMDEntry {
		t.Fatal("renderAgentsEntry(\"deft\") returned the canonical body verbatim (no substitution applied)")
	}
	if strings.Contains(got, ".deft/core/") {
		t.Errorf("legacy-rendered AGENTS.md still contains `.deft/core/` after substitution:\n%s", got)
	}
	if !strings.Contains(got, agentsMDLayoutClaim("deft")) {
		t.Errorf("legacy-rendered AGENTS.md missing legacy install-root claim:\n%s", got)
	}
}

// TestWriteAgentsMD_StaleCanonicalAGENTSMD_RewrittenByLegacyInstall covers
// the canonical->legacy symmetric counterpart of acceptance criterion (b)
// (Greptile P1 on PR #1066 issue 3): a `--legacy-layout` install run against
// a project whose AGENTS.md still carries the canonical `.deft/core/` v3
// body MUST rewrite the file to the `deft/` v3 body. Pre-#1066 only the
// legacy->canonical direction was tested; a future refactor could break
// this direction silently without tripping the existing suite.
func TestWriteAgentsMD_StaleCanonicalAGENTSMD_RewrittenByLegacyInstall(t *testing.T) {
	tmp := t.TempDir()

	// Seed AGENTS.md with the canonical body via a first canonical install.
	wSeed := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := WriteAgentsMD(wSeed, tmp); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(tmp, "AGENTS.md")
	seed, _ := os.ReadFile(path)
	if !strings.Contains(string(seed), agentsMDLayoutClaim(".deft/core")) {
		t.Fatalf("seed AGENTS.md missing canonical claim; got:\n%s", seed)
	}

	// Run --legacy-layout install against the canonical-seeded file.
	var out bytes.Buffer
	wLegacy := NewWizardWithLayout(strings.NewReader(""), &out, false, true)
	if err := WriteAgentsMD(wLegacy, tmp); err != nil {
		t.Fatalf("WriteAgentsMD returned error on canonical->legacy rewrite: %v", err)
	}

	after, _ := os.ReadFile(path)
	content := string(after)
	if content == string(seed) {
		t.Fatal("AGENTS.md was NOT rewritten on canonical->legacy cross-layout install (Greptile #1066 issue 3 regression)")
	}
	if strings.Contains(content, agentsMDLayoutClaim(".deft/core")) {
		t.Errorf("rewritten AGENTS.md still carries canonical install-root claim:\n%s", content)
	}
	if !strings.Contains(content, agentsMDLayoutClaim("deft")) {
		t.Errorf("rewritten AGENTS.md missing legacy install-root claim:\n%s", content)
	}
	if strings.Contains(content, ".deft/core/") {
		t.Errorf("rewritten AGENTS.md still references canonical `.deft/core/` paths:\n%s", content)
	}
	if !strings.Contains(out.String(), "rewriting AGENTS.md") {
		t.Errorf("installer did not log the rewrite; got log:\n%s", out.String())
	}
}

// TestWriteAgentsMD_ClaimScopedToManagedSlice_NoFalseSkip pins the
// Greptile P1 #1066 issue 1 fix: the `hasClaim` idempotency probe is
// scoped to the fenced managed slice, NOT the full file. An operator-
// authored callout OUTSIDE the fence that happens to contain the layout
// claim string MUST NOT mask a stale claim inside the managed block.
func TestWriteAgentsMD_ClaimScopedToManagedSlice_NoFalseSkip(t *testing.T) {
	tmp := t.TempDir()

	// Construct an AGENTS.md whose managed section advertises the LEGACY
	// layout (stale for a canonical install) but whose operator prose
	// OUTSIDE the fence quotes the canonical claim verbatim (a plausible
	// shape: a documentation callout citing the rendered template).
	stale := agentsMDSentinel + "\nDeft is installed in deft/.\n" + agentsMDFenceClose + "\n\n" +
		"## Operator notes\n\n" +
		"Migration historical context: \"Deft is installed in .deft/core/.\" was the canonical claim.\n"
	if err := os.WriteFile(filepath.Join(tmp, "AGENTS.md"), []byte(stale), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)
	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	content := string(data)
	if content == stale {
		t.Fatal("AGENTS.md was NOT rewritten despite stale claim inside managed slice (Greptile #1066 issue 1 regression)")
	}
	if !strings.Contains(out.String(), "rewriting AGENTS.md") {
		t.Errorf("installer did not log the rewrite; got log:\n%s", out.String())
	}
	// Operator prose outside the fence MUST survive verbatim.
	if !strings.Contains(content, "## Operator notes") {
		t.Errorf("operator prose outside fence was lost on rewrite; got:\n%s", content)
	}
}

// TestRewriteAgentsMDBlock_NoTrailingNewlineAccumulation pins the
// Greptile P1 #1066 issue 2 fix: repeated surgical rewrites MUST NOT
// accumulate blank lines at the boundary between the closing fence and
// any operator prose that follows it. The replacement template ends with
// `<!-- /deft:managed-section -->\n` and the body slice after the close
// marker typically begins with `\n`, so a naive concatenation produces
// `\n\n` at the junction on every cycle.
func TestRewriteAgentsMDBlock_NoTrailingNewlineAccumulation(t *testing.T) {
	body := agentsMDSentinel + "\nDeft is installed in deft/.\n" + agentsMDFenceClose + "\n\n## After fence\n"
	replacement := agentsMDSentinel + "\nDeft is installed in .deft/core/.\n" + agentsMDFenceClose + "\n"

	// Apply the rewrite twice -- if the accumulation bug were live the
	// second cycle would add another `\n` between the closing fence and
	// `## After fence`, monotonically growing the body across upgrades.
	after1, surgical1 := rewriteAgentsMDBlock(body, replacement)
	if !surgical1 {
		t.Fatal("first rewrite was not surgical (fenced)")
	}
	after2, surgical2 := rewriteAgentsMDBlock(after1, replacement)
	if !surgical2 {
		t.Fatal("second rewrite was not surgical (fenced)")
	}
	if after1 != after2 {
		t.Errorf("repeated surgical rewrites must be idempotent; got:\n--- after1 ---\n%s\n--- after2 ---\n%s", after1, after2)
	}
	// Defence in depth: the junction MUST NOT carry doubled newlines
	// between the closing fence and the operator prose that follows.
	junction := agentsMDFenceClose + "\n\n\n## After fence"
	if strings.Contains(after2, junction) {
		t.Errorf("trailing-newline accumulation regressed; junction contains tripled newlines:\n%s", after2)
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

// ---------------------------------------------------------------------------
// #1179 vbrief lifecycle-dir regression tests
// ---------------------------------------------------------------------------

// vbriefLifecycleDirsExpected mirrors the canonical lifecycle list the setup.go
// var carries; duplicated here so the test stays a pure black-box assertion
// of the contract (a typo in the production list would otherwise be invisible
// to the test).
var vbriefLifecycleDirsExpected = []string{"proposed", "pending", "active", "completed", "cancelled"}

// simulatesPartialVbriefPreCutover models the deft-directive-setup pre-cutover
// condition 3 check whose canonical text lives at
// `skills/deft-directive-setup/SKILL.md:32` and `main.md:159` -- NOT in
// AGENTS.md, which does not enumerate the condition. The condition fires
// when `./vbrief/` exists but any of the five lifecycle subfolders is
// missing. The function returns true when the guard would FIRE on the given
// projectDir's vbrief tree.
//
// SUPERSET note: this helper deliberately does NOT gate on
// `vbrief/specification.vbrief.json` existing (the SKILL.md:32 condition
// 3 is scoped to projects that already carry the pre-cutover
// specification artifact). The Go installer's invariant is the looser
// shape -- any vbrief/ that is missing lifecycle subfolders is a
// half-state we must repair -- so this helper fires more broadly than
// the production guard on purpose. Reviewers should read the assertions
// in light of that broader contract.
//
// Kept tiny on purpose -- the production guard lives in
// `skills/deft-directive-setup/SKILL.md` (Markdown) and is not a Go
// function, so this is the closest faithful simulation the Go test layer
// can carry.
func simulatesPartialVbriefPreCutover(projectDir string) bool {
	vbriefRoot := filepath.Join(projectDir, "vbrief")
	if info, err := os.Stat(vbriefRoot); err != nil || !info.IsDir() {
		return false
	}
	for _, sub := range vbriefLifecycleDirsExpected {
		if info, err := os.Stat(filepath.Join(vbriefRoot, sub)); err != nil || !info.IsDir() {
			return true
		}
	}
	return false
}

// TestWriteConsumerVbrief_CreatesLifecycleDirs is the positive #1179
// regression: it asserts that after a fresh WriteConsumerVbrief call all
// five canonical lifecycle subdirectories exist under `vbrief/`, each with
// a `.gitkeep` placeholder, and that the partial-pre-cutover probe (see
// `simulatesPartialVbriefPreCutover` above for the canonical source
// references at `skills/deft-directive-setup/SKILL.md:32` and
// `main.md:159`) does not fire on the resulting tree.
func TestWriteConsumerVbrief_CreatesLifecycleDirs(t *testing.T) {
	tmp := t.TempDir()
	projectDir := filepath.Join(tmp, "proj")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	deftDir := filepath.Join(projectDir, ".deft", "core")
	fwSchemas := filepath.Join(deftDir, "vbrief", "schemas")
	if err := os.MkdirAll(fwSchemas, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fwSchemas, "vbrief-core.schema.json"), []byte(`{"name":"fixture"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deftDir, "vbrief", "vbrief.md"), []byte("# fixture vbrief\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	changed, err := WriteConsumerVbrief(w, projectDir, deftDir)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true on first deposit")
	}

	for _, sub := range vbriefLifecycleDirsExpected {
		dir := filepath.Join(projectDir, "vbrief", sub)
		info, err := os.Stat(dir)
		if err != nil {
			t.Errorf("lifecycle directory vbrief/%s/ was not created: %v", sub, err)
			continue
		}
		if !info.IsDir() {
			t.Errorf("vbrief/%s exists but is not a directory", sub)
			continue
		}
		gitkeep := filepath.Join(dir, ".gitkeep")
		if _, err := os.Stat(gitkeep); err != nil {
			t.Errorf("vbrief/%s/.gitkeep placeholder missing: %v", sub, err)
		}
	}

	if simulatesPartialVbriefPreCutover(projectDir) {
		t.Error("deft-directive-setup pre-cutover condition 3 (SKILL.md:32 / main.md:159) would still fire on the resulting tree (#1179 not closed)")
	}
}

// TestWriteConsumerVbrief_RepairsHalfState_LifecycleDirs models the pre-#1179
// installer output: schemas/ and vbrief.md already exist but the lifecycle
// directories are missing (the exact half-state the v0.30.0 installer rail
// shipped). A re-run of WriteConsumerVbrief must add the lifecycle
// directories without overwriting the existing schemas + vbrief.md, and the
// `simulatesPartialVbriefPreCutover` probe must transition from returning
// true (before the repair) to false (after the repair).
func TestWriteConsumerVbrief_RepairsHalfState_LifecycleDirs(t *testing.T) {
	tmp := t.TempDir()
	projectDir := filepath.Join(tmp, "proj")
	deftDir := filepath.Join(projectDir, ".deft", "core")
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Pre-seed the pre-#1179 half-state: vbrief/ + schemas/ + vbrief.md
	// present, lifecycle dirs absent.
	consumerVbrief := filepath.Join(projectDir, "vbrief")
	if err := os.MkdirAll(filepath.Join(consumerVbrief, "schemas"), 0o755); err != nil {
		t.Fatal(err)
	}
	operatorVbriefMD := []byte("# operator-edited\n")
	if err := os.WriteFile(filepath.Join(consumerVbrief, "vbrief.md"), operatorVbriefMD, 0o644); err != nil {
		t.Fatal(err)
	}

	if !simulatesPartialVbriefPreCutover(projectDir) {
		t.Fatal("test fixture sanity: half-state must trip the pre-cutover guard before the fix runs")
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	changed, err := WriteConsumerVbrief(w, projectDir, deftDir)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("expected changed=true when repairing a half-state install")
	}

	for _, sub := range vbriefLifecycleDirsExpected {
		if info, err := os.Stat(filepath.Join(consumerVbrief, sub)); err != nil || !info.IsDir() {
			t.Errorf("lifecycle directory vbrief/%s/ was not repaired: %v", sub, err)
		}
	}

	// Operator-edited vbrief.md MUST NOT be clobbered.
	vbriefMDPath := filepath.Join(consumerVbrief, "vbrief.md")
	got, err := os.ReadFile(vbriefMDPath)
	if err != nil {
		t.Fatalf("read %s: %v", vbriefMDPath, err)
	}
	if string(got) != string(operatorVbriefMD) {
		t.Errorf("operator vbrief.md edits were clobbered during half-state repair; got:\n%s", got)
	}

	if simulatesPartialVbriefPreCutover(projectDir) {
		t.Error("deft-directive-setup pre-cutover condition 3 (SKILL.md:32 / main.md:159) still fires after half-state repair (#1179 regression)")
	}
}

// TestWriteConsumerVbrief_LifecycleDirs_Idempotent verifies that re-running
// WriteConsumerVbrief on a fully-populated tree returns changed=false and
// does not overwrite the operator's `.gitkeep` placeholders (so an operator
// who tweaked a placeholder body, or who has filed real scope vBRIEFs in a
// lifecycle directory, will see those preserved on the next install pass).
func TestWriteConsumerVbrief_LifecycleDirs_Idempotent(t *testing.T) {
	tmp := t.TempDir()
	projectDir := filepath.Join(tmp, "proj")
	deftDir := filepath.Join(projectDir, ".deft", "core")
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}

	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if _, err := WriteConsumerVbrief(w, projectDir, deftDir); err != nil {
		t.Fatal(err)
	}

	// Stash an operator edit in one of the lifecycle .gitkeep files.
	activeKeep := filepath.Join(projectDir, "vbrief", "active", ".gitkeep")
	sentinel := []byte("# operator note\n")
	if err := os.WriteFile(activeKeep, sentinel, 0o644); err != nil {
		t.Fatal(err)
	}

	// Drop a fake scope vBRIEF in proposed/ so .gitkeep is no longer needed
	// there -- a follow-up call must NOT create a stray .gitkeep alongside
	// real content.
	proposedDir := filepath.Join(projectDir, "vbrief", "proposed")
	if err := os.Remove(filepath.Join(proposedDir, ".gitkeep")); err != nil {
		t.Fatal(err)
	}
	scopePath := filepath.Join(proposedDir, "fixture.vbrief.json")
	if err := os.WriteFile(scopePath, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	changed, err := WriteConsumerVbrief(w, projectDir, deftDir)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("expected changed=false on idempotent re-run")
	}

	// Operator-edited .gitkeep preserved. Fail loudly on a read error
	// rather than silently turning a permission/IO failure into a
	// "clobbered" assertion against an empty body -- the sibling test in
	// main_test.go was tightened the same way in this PR (#1303 review,
	// Greptile #3 / SLizard P1).
	got, err := os.ReadFile(activeKeep)
	if err != nil {
		t.Fatalf("read %s: %v", activeKeep, err)
	}
	if string(got) != string(sentinel) {
		t.Errorf("operator-edited .gitkeep was clobbered; got:\n%s", got)
	}

	// proposed/ has real content + no recreated .gitkeep.
	proposedKeep := filepath.Join(proposedDir, ".gitkeep")
	if _, err := os.Stat(proposedKeep); err == nil {
		t.Error(".gitkeep was recreated alongside real scope vBRIEF content -- should be skipped")
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected stat error for %s: %v", proposedKeep, err)
	}
	if _, err := os.Stat(scopePath); err != nil {
		t.Errorf("operator-filed scope vBRIEF was lost during idempotent re-run: %v", err)
	}
}

// TestEnsureVbriefLifecycleDirs_DirectCall is a focused unit test on the
// helper so future refactors that touch the helper (without touching
// WriteConsumerVbrief) still get covered.
func TestEnsureVbriefLifecycleDirs_DirectCall(t *testing.T) {
	tmp := t.TempDir()
	if err := ensureVbriefLifecycleDirs(tmp); err != nil {
		t.Fatal(err)
	}
	for _, sub := range vbriefLifecycleDirsExpected {
		if info, err := os.Stat(filepath.Join(tmp, sub)); err != nil || !info.IsDir() {
			t.Errorf("ensureVbriefLifecycleDirs did not create %s: %v", sub, err)
		}
		if _, err := os.Stat(filepath.Join(tmp, sub, ".gitkeep")); err != nil {
			t.Errorf("ensureVbriefLifecycleDirs did not drop .gitkeep in %s: %v", sub, err)
		}
	}

	// Calling again must be a no-op on the filesystem.
	if err := ensureVbriefLifecycleDirs(tmp); err != nil {
		t.Fatal(err)
	}
}

// TestVbriefLifecycleDirsPresent_DetectsHalfState verifies the half-state
// detector returns false when any single lifecycle directory is absent and
// true only when all five are present. Pins the contract the
// WriteConsumerVbrief idempotency probe relies on.
func TestVbriefLifecycleDirsPresent_DetectsHalfState(t *testing.T) {
	tmp := t.TempDir()
	if vbriefLifecycleDirsPresent(tmp) {
		t.Error("empty tree should not report lifecycle dirs as present")
	}
	for _, sub := range vbriefLifecycleDirsExpected[:len(vbriefLifecycleDirsExpected)-1] {
		if err := os.MkdirAll(filepath.Join(tmp, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if vbriefLifecycleDirsPresent(tmp) {
		t.Error("4 of 5 lifecycle dirs should still report half-state (false)")
	}
	if err := os.MkdirAll(filepath.Join(tmp, vbriefLifecycleDirsExpected[len(vbriefLifecycleDirsExpected)-1]), 0o755); err != nil {
		t.Fatal(err)
	}
	if !vbriefLifecycleDirsPresent(tmp) {
		t.Error("all 5 lifecycle dirs present but detector returned false")
	}
}

// TestEnsureTaskfile_CreatesMinimalWhenAbsent exercises Epic-4 item 1:
// when no Taskfile.yml exists, EnsureTaskfile (called under --yes) writes
// the minimal version + deft include.
func TestEnsureTaskfile_CreatesMinimalWhenAbsent(t *testing.T) {
	tmp := t.TempDir()
	w := NewWizardWithLayout(strings.NewReader(""), io.Discard, false, false)
	changed, err := EnsureTaskfile(w, tmp)
	if err != nil {
		t.Fatalf("EnsureTaskfile failed: %v", err)
	}
	if !changed {
		t.Error("expected changed=true for fresh create")
	}
	data, err := os.ReadFile(filepath.Join(tmp, "Taskfile.yml"))
	if err != nil {
		t.Fatalf("Taskfile not created: %v", err)
	}
	if !strings.Contains(string(data), canonicalTaskfileIncludeFragment) {
		t.Errorf("created Taskfile missing include fragment; got:\n%s", data)
	}
}

// TestEnsureTaskfile_IdempotentWhenPresent exercises Epic-4 item 2:
// existing Taskfile with the fragment is left untouched.
func TestEnsureTaskfile_IdempotentWhenPresent(t *testing.T) {
	tmp := t.TempDir()
	tf := filepath.Join(tmp, "Taskfile.yml")
	content := "version: '3'\nincludes:\n  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n    optional: true\n"
	if err := os.WriteFile(tf, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	w := NewWizardWithLayout(strings.NewReader(""), io.Discard, false, false)
	changed, err := EnsureTaskfile(w, tmp)
	if err != nil {
		t.Fatalf("EnsureTaskfile failed: %v", err)
	}
	if changed {
		t.Error("expected changed=false (idempotent)")
	}
}

// TestEnsureCoreTools_ReportsMissing is a smoke for Epic-4 item 3/4:
// the probe returns a list (possibly empty) and never panics; in real runs
// the list drives the JSON result and fallback messaging.
func TestEnsureCoreTools_ReportsMissing(t *testing.T) {
	w := NewWizardWithLayout(strings.NewReader(""), io.Discard, false, false)
	missing, err := EnsureCoreTools(w, true)
	if err != nil {
		t.Fatalf("EnsureCoreTools errored: %v", err)
	}
	// missing may be non-empty on test runner (no task/uv etc); just assert
	// it is a slice (possibly empty) and function is safe.
	_ = missing
}

// TestEnsureTaskfile_PreservesExistingIncludes covers the Greptile P1 fix:
// when a Taskfile already declares a top-level includes: block (with user
// namespaces), EnsureTaskfile extends that block rather than appending a
// second includes: key (which would silently drop the user's entries under
// go-task's last-wins map merge).
func TestEnsureTaskfile_PreservesExistingIncludes(t *testing.T) {
	tmp := t.TempDir()
	tf := filepath.Join(tmp, "Taskfile.yml")
	initial := "version: '3'\n" +
		"includes:\n" +
		"  myapp:\n" +
		"    taskfile: ./myapp/Taskfile.yml\n" +
		"  infra:\n" +
		"    taskfile: ./infra/Taskfile.yml\n"
	if err := os.WriteFile(tf, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}
	w := NewWizardWithLayout(strings.NewReader(""), io.Discard, false, false)
	changed, err := EnsureTaskfile(w, tmp)
	if err != nil {
		t.Fatalf("EnsureTaskfile failed: %v", err)
	}
	if !changed {
		t.Fatal("expected changed=true for pre-existing includes case")
	}
	content, err := os.ReadFile(tf)
	if err != nil {
		t.Fatal(err)
	}
	s := string(content)
	// Exactly one top-level includes: key (no duplicate)
	if strings.Count(s, "\nincludes:") != 1 && !strings.HasPrefix(strings.TrimLeft(s, " \t\r\n"), "includes:") {
		// allow starting case too
		if strings.Count(s, "includes:") != 1 {
			t.Errorf("expected exactly one includes: key, got duplicates or loss: %s", s)
		}
	}
	if !strings.Contains(s, "deft:") {
		t.Error("deft include entry missing")
	}
	if !strings.Contains(s, "myapp:") || !strings.Contains(s, "infra:") {
		t.Error("user pre-existing includes were lost")
	}
}

// TestEnsureTaskfile_IncludesFollowedByTasksAndVars closes Greptile P0 on
// PR #1385 (review of head 6f7520c): when an existing Taskfile carries
// `includes:` followed by other top-level keys (`tasks:` / `vars:`),
// EnsureTaskfile must insert the deft entry INSIDE the includes: block,
// not append at EOF -- otherwise the appended `  deft:` lines land under
// the last opened mapping (e.g. `tasks:`), wiring deft into the wrong
// block and producing a structurally-broken Taskfile that go-task
// silently ignores while the installer reports `taskfile_wired:true`.
//
// Verifies the canonical fix by asserting that the deft entry appears
// AFTER `includes:` and BEFORE `tasks:` in the file, that user-authored
// content under `tasks:` and `vars:` is preserved verbatim, and that the
// includes: block remains the unique top-level mapping for include
// declarations.
func TestEnsureTaskfile_IncludesFollowedByTasksAndVars(t *testing.T) {
	tmp := t.TempDir()
	tf := filepath.Join(tmp, "Taskfile.yml")
	initial := "version: '3'\n" +
		"\n" +
		"includes:\n" +
		"  myapp:\n" +
		"    taskfile: ./myapp/Taskfile.yml\n" +
		"\n" +
		"vars:\n" +
		"  BUILD_TARGET: release\n" +
		"  ARTIFACT_DIR: ./dist\n" +
		"\n" +
		"tasks:\n" +
		"  hello:\n" +
		"    desc: Say hello\n" +
		"    cmds:\n" +
		"      - echo hi\n"
	if err := os.WriteFile(tf, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}
	w := NewWizardWithLayout(strings.NewReader(""), io.Discard, false, false)
	changed, err := EnsureTaskfile(w, tmp)
	if err != nil {
		t.Fatalf("EnsureTaskfile failed: %v", err)
	}
	if !changed {
		t.Fatal("expected changed=true for includes+tasks+vars case")
	}
	content, err := os.ReadFile(tf)
	if err != nil {
		t.Fatal(err)
	}
	s := string(content)

	// Structural assertion: deft entry MUST appear between `includes:` and
	// `vars:` / `tasks:` so YAML indent-scope rules place it under
	// includes:. If the entry slid past `vars:` or `tasks:` the fix is
	// broken and SLizard/go-task would silently drop the include.
	idxIncludes := strings.Index(s, "\nincludes:")
	if idxIncludes == -1 {
		idxIncludes = strings.Index(s, "includes:") // file may start with it
	}
	idxDeft := strings.Index(s, "  deft:")
	idxVars := strings.Index(s, "\nvars:")
	idxTasks := strings.Index(s, "\ntasks:")
	if idxIncludes < 0 || idxDeft < 0 || idxVars < 0 || idxTasks < 0 {
		t.Fatalf("expected all of includes:/  deft:/vars:/tasks: in result; got:\n%s", s)
	}
	if !(idxIncludes < idxDeft && idxDeft < idxVars && idxDeft < idxTasks) {
		t.Errorf("deft entry must be inserted under includes: (after includes:, before vars: and tasks:); ordering broken; got:\n%s", s)
	}

	// Exactly one top-level includes: key.
	if strings.Count(s, "\nincludes:")+func() int {
		if strings.HasPrefix(s, "includes:") {
			return 1
		}
		return 0
	}() != 1 {
		t.Errorf("expected exactly one top-level includes:, got duplicates; result:\n%s", s)
	}

	// User-authored content preserved.
	for _, fragment := range []string{
		"  myapp:\n    taskfile: ./myapp/Taskfile.yml",
		"vars:\n  BUILD_TARGET: release",
		"  ARTIFACT_DIR: ./dist",
		"tasks:\n  hello:\n    desc: Say hello",
		"      - echo hi",
	} {
		if !strings.Contains(s, fragment) {
			t.Errorf("user-authored fragment lost from Taskfile; missing %q; full result:\n%s", fragment, s)
		}
	}

	// Canonical include fragment is present (idempotency probe will skip
	// a re-run after this point).
	if !strings.Contains(s, canonicalTaskfileIncludeFragment) {
		t.Errorf("canonical include fragment missing; got:\n%s", s)
	}
}

// TestEnsureTaskfile_IncludesFollowedByTasksAndVars_RerunIsIdempotent
// verifies that running EnsureTaskfile a second time on the now-wired
// Taskfile is a no-op (no duplicate deft entries, no churn) -- the
// canonical-fragment short-circuit at the top of EnsureTaskfile owns this
// path, and the rerun must NOT call insertDeftIncludeAfterIncludesLine
// again.
func TestEnsureTaskfile_IncludesFollowedByTasksAndVars_RerunIsIdempotent(t *testing.T) {
	tmp := t.TempDir()
	tf := filepath.Join(tmp, "Taskfile.yml")
	initial := "version: '3'\n" +
		"includes:\n" +
		"  myapp:\n" +
		"    taskfile: ./myapp/Taskfile.yml\n" +
		"tasks:\n" +
		"  hello:\n" +
		"    cmds: [echo hi]\n"
	if err := os.WriteFile(tf, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}
	w := NewWizardWithLayout(strings.NewReader(""), io.Discard, false, false)
	if _, err := EnsureTaskfile(w, tmp); err != nil {
		t.Fatalf("first EnsureTaskfile failed: %v", err)
	}
	firstPass, err := os.ReadFile(tf)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := EnsureTaskfile(w, tmp)
	if err != nil {
		t.Fatalf("second EnsureTaskfile failed: %v", err)
	}
	if changed {
		t.Error("expected second EnsureTaskfile to be a no-op (idempotent)")
	}
	secondPass, err := os.ReadFile(tf)
	if err != nil {
		t.Fatal(err)
	}
	if string(firstPass) != string(secondPass) {
		t.Errorf("Taskfile content drifted between EnsureTaskfile calls; first:\n%s\nsecond:\n%s", firstPass, secondPass)
	}
	// Exactly one deft: entry under includes:.
	if n := strings.Count(string(secondPass), "  deft:\n"); n != 1 {
		t.Errorf("expected exactly one `  deft:` entry; got %d; content:\n%s", n, secondPass)
	}
}

// TestInsertDeftIncludeAfterIncludesLine_NoIncludesLine returns (content,
// false) when the input has no top-level `includes:` line. Pins the
// fallback contract so EnsureTaskfile can route to the safe append path.
func TestInsertDeftIncludeAfterIncludesLine_NoIncludesLine(t *testing.T) {
	content := "version: '3'\ntasks:\n  hello:\n    cmds: [echo hi]\n"
	out, ok := insertDeftIncludeAfterIncludesLine(content)
	if ok {
		t.Error("expected ok=false when no top-level includes: line is present")
	}
	if out != content {
		t.Errorf("expected content unchanged on no-includes input; got:\n%s", out)
	}
}

// TestInsertDeftIncludeAfterIncludesLine_IgnoresCommentedLine refuses to
// match a commented-out `# includes:` line; the structural insertion
// requires the literal top-level key.
func TestInsertDeftIncludeAfterIncludesLine_IgnoresCommentedLine(t *testing.T) {
	content := "version: '3'\n# includes:  -- commented out\ntasks:\n  hello:\n    cmds: [echo hi]\n"
	_, ok := insertDeftIncludeAfterIncludesLine(content)
	if ok {
		t.Error("expected ok=false on commented-out # includes: line")
	}
}

// TestInsertDeftIncludeAfterIncludesLine_TolerateInlineComment matches a
// line shaped like `includes:  # comment` -- the comment is informational
// and the key is still a real top-level mapping declaration.
func TestInsertDeftIncludeAfterIncludesLine_TolerateInlineComment(t *testing.T) {
	content := "version: '3'\nincludes:  # user notes here\n  myapp:\n    taskfile: ./myapp/Taskfile.yml\ntasks:\n  hello:\n    cmds: [echo hi]\n"
	out, ok := insertDeftIncludeAfterIncludesLine(content)
	if !ok {
		t.Fatal("expected ok=true on includes: with inline comment")
	}
	idxIncludes := strings.Index(out, "includes:")
	idxDeft := strings.Index(out, "  deft:")
	idxTasks := strings.Index(out, "\ntasks:")
	if !(idxIncludes < idxDeft && idxDeft < idxTasks) {
		t.Errorf("expected ordering includes: < deft: < tasks:; got:\n%s", out)
	}
}
