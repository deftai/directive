package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
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

// ---------------------------------------------------------------------------
// #1437: attributed-marker recognition + self-heal collapse to one section
// ---------------------------------------------------------------------------

// countManagedSections reports how many deft managed-section closing fences a
// body carries -- one per managed section. A correct AGENTS.md has exactly one.
func countManagedSections(body string) int {
	return strings.Count(body, agentsMDFenceClose)
}

// TestWriteAgentsMD_AttributedV3Marker_RewritesInPlaceToSingleSection is the
// #1437 regression (a): an AGENTS.md whose open marker carries the v3
// provenance attributes (sha=/refreshed=/session=) -- the form `agents:refresh`
// / the relocator emit -- is RECOGNISED and rewritten in place to a single
// canonical managed section. Pre-fix the bare-string matcher missed it and
// APPENDED a second section. Operator prose around the fence is preserved.
func TestWriteAgentsMD_AttributedV3Marker_RewritesInPlaceToSingleSection(t *testing.T) {
	tmp := t.TempDir()
	operatorTop := "# Project AGENTS\n\nOperator notes above the fence.\n\n"
	operatorBottom := "\n## Appendix\n\nOperator notes below the fence.\n"
	attributed := "<!-- deft:managed-section v3 sha=6136b66c42c8 refreshed=2026-06-01T03:08:04Z session=d7bc893a5c2d -->\n" +
		"Deft is installed in .deft/core/. (older managed body)\n" +
		agentsMDFenceClose + "\n"
	if err := os.WriteFile(filepath.Join(tmp, "AGENTS.md"), []byte(operatorTop+attributed+operatorBottom), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)
	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatalf("WriteAgentsMD: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	content := string(data)
	if n := countManagedSections(content); n != 1 {
		t.Errorf("attributed marker produced %d managed sections, want exactly 1 (append-instead-of-rewrite bug #1437):\n%s", n, content)
	}
	if n := strings.Count(content, "<!-- deft:managed-section v"); n != 1 {
		t.Errorf("want exactly 1 managed-section open marker, got %d:\n%s", n, content)
	}
	if !strings.Contains(content, agentsMDSentinel) {
		t.Errorf("attributed marker was not rewritten to the bare canonical marker:\n%s", content)
	}
	if strings.Contains(content, "sha=6136b66c42c8") {
		t.Errorf("stale attributed-marker provenance survived the rewrite:\n%s", content)
	}
	for _, prose := range []string{"Operator notes above the fence.", "Operator notes below the fence."} {
		if !strings.Contains(content, prose) {
			t.Errorf("operator prose %q was lost during the rewrite:\n%s", prose, content)
		}
	}
	if !strings.Contains(out.String(), "rewriting AGENTS.md") {
		t.Errorf("installer did not log the in-place rewrite; got log:\n%s", out.String())
	}
}

// TestWriteAgentsMD_TwoManagedSections_CollapseToOne is the #1437 regression
// (b): an AGENTS.md that already carries TWO managed sections (the state this
// bug produced) is collapsed to exactly one canonical section on the next
// upgrade, preserving operator prose before, between, and after the fences.
func TestWriteAgentsMD_TwoManagedSections_CollapseToOne(t *testing.T) {
	tmp := t.TempDir()
	top := "# Project AGENTS\n\nTop operator prose.\n\n"
	first := "<!-- deft:managed-section v3 sha=aaa111 refreshed=2026-06-01T00:00:00Z session=s1 -->\n" +
		"Deft is installed in .deft/core/. (old body 1)\n" + agentsMDFenceClose + "\n"
	middle := "\nMiddle operator prose between two managed sections.\n\n"
	second := agentsMDSentinel + "\n" +
		"Deft is installed in .deft/core/. (old body 2)\n" + agentsMDFenceClose + "\n"
	bottom := "\nBottom operator prose.\n"
	if err := os.WriteFile(filepath.Join(tmp, "AGENTS.md"), []byte(top+first+middle+second+bottom), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)
	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatalf("WriteAgentsMD: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	content := string(data)
	if n := countManagedSections(content); n != 1 {
		t.Errorf("two managed sections did not collapse to one; got %d:\n%s", n, content)
	}
	if n := strings.Count(content, "<!-- deft:managed-section v"); n != 1 {
		t.Errorf("want exactly 1 open marker after collapse, got %d:\n%s", n, content)
	}
	for _, prose := range []string{"Top operator prose.", "Middle operator prose between two managed sections.", "Bottom operator prose."} {
		if !strings.Contains(content, prose) {
			t.Errorf("operator prose %q was lost during the collapse:\n%s", prose, content)
		}
	}
	if strings.Contains(content, "old body 1") || strings.Contains(content, "old body 2") {
		t.Errorf("stale managed bodies survived the collapse:\n%s", content)
	}
}

// TestWriteAgentsMD_CleanSingleSection_StaysSingleIdempotent is the #1437
// regression (c): a clean single-section file (the installer's own output)
// stays a single section and is a byte-for-byte no-op on a re-run.
func TestWriteAgentsMD_CleanSingleSection_StaysSingleIdempotent(t *testing.T) {
	tmp := t.TempDir()
	w1 := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	if err := WriteAgentsMD(w1, tmp); err != nil { // fresh install -> one canonical section
		t.Fatal(err)
	}
	path := filepath.Join(tmp, "AGENTS.md")
	first, _ := os.ReadFile(path)
	if n := countManagedSections(string(first)); n != 1 {
		t.Fatalf("fresh install did not produce exactly one managed section; got %d:\n%s", n, first)
	}

	var out bytes.Buffer
	w2 := NewWizard(strings.NewReader(""), &out, false)
	if err := WriteAgentsMD(w2, tmp); err != nil {
		t.Fatalf("WriteAgentsMD (re-run): %v", err)
	}
	second, _ := os.ReadFile(path)
	if string(first) != string(second) {
		t.Errorf("re-run changed a clean single-section file (not idempotent)")
	}
	if n := countManagedSections(string(second)); n != 1 {
		t.Errorf("clean single-section file did not stay single; got %d", n)
	}
	if !strings.Contains(out.String(), "skipping") {
		t.Errorf("expected the idempotent re-run to skip; got log:\n%s", out.String())
	}
}

// TestRewriteAgentsMDBlock_CollapsesAllSectionsToOne unit-tests the self-heal
// directly: N managed sections (v3 attributed + bare) converge to exactly one
// replacement, with operator prose before/between/after preserved (#1437).
func TestRewriteAgentsMDBlock_CollapsesAllSectionsToOne(t *testing.T) {
	replacement := agentsMDSentinel + "\nNEW CANONICAL BODY\n" + agentsMDFenceClose + "\n"
	body := "A\n" +
		agentsMDSentinel + "\nold1\n" + agentsMDFenceClose + "\n" +
		"B\n" +
		"<!-- deft:managed-section v3 sha=xyz -->\nold2\n" + agentsMDFenceClose + "\n" +
		"C\n"
	got, surgical := rewriteAgentsMDBlock(body, replacement)
	if !surgical {
		t.Fatal("expected surgical=true when fenced sections exist")
	}
	if n := countManagedSections(got); n != 1 {
		t.Errorf("want exactly 1 managed section after collapse, got %d:\n%s", n, got)
	}
	for _, want := range []string{"A\n", "B\n", "C\n", "NEW CANONICAL BODY"} {
		if !strings.Contains(got, want) {
			t.Errorf("expected %q preserved/inserted, missing from:\n%s", want, got)
		}
	}
	if strings.Contains(got, "old1") || strings.Contains(got, "old2") {
		t.Errorf("stale managed bodies survived the collapse:\n%s", got)
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

// TestEnsureCoreTools_ReportsMissing is a smoke for Epic-4 item 3/4 on
// non-Linux hosts: the probe returns a list (possibly empty) and never
// panics; in real runs the list drives the JSON result and fallback messaging.
func TestEnsureCoreTools_ReportsMissing(t *testing.T) {
	origGOOS := goosForCoreTools
	goosForCoreTools = func() string { return "darwin" }
	defer func() { goosForCoreTools = origGOOS }()

	w := NewWizardWithLayout(strings.NewReader(""), io.Discard, false, false)
	missing, err := EnsureCoreTools(w, true)
	if err != nil {
		t.Fatalf("EnsureCoreTools errored: %v", err)
	}
	_ = missing
}

func TestEnsureMaintainerTools_ReportsSeparateMaintainerOnlyStatuses(t *testing.T) {
	origLookPath := lookPathFunc
	defer func() { lookPathFunc = origLookPath }()

	lookPathFunc = func(name string) (string, error) {
		switch name {
		case "go", "node":
			return "/usr/bin/" + name, nil
		default:
			return "", exec.ErrNotFound
		}
	}

	var out bytes.Buffer
	w := NewWizardWithLayout(strings.NewReader(""), &out, false, false)
	statuses := EnsureMaintainerTools(w)

	byName := map[string]maintainerToolStatus{}
	for _, status := range statuses {
		byName[status.Name] = status
	}
	if !byName["go"].Present || !byName["go"].Required {
		t.Errorf("go status = %#v, want present required maintainer tool", byName["go"])
	}
	if !byName["node"].Present || !byName["node"].Required {
		t.Errorf("node status = %#v, want present required maintainer tool", byName["node"])
	}
	if byName["ghx"].Present || byName["ghx"].Required {
		t.Errorf("ghx status = %#v, want missing optional maintainer acceleration tool", byName["ghx"])
	}
	if !strings.Contains(out.String(), "consumers only need gh") {
		t.Errorf("maintainer tool guidance should distinguish ghx from consumer gh requirement; got:\n%s", out.String())
	}
}

func TestMaintainerCheckoutDetection(t *testing.T) {
	tmp := t.TempDir()
	for _, rel := range []string{
		"main.md",
		"cmd/deft-install/main.go",
		"templates/agent-prompt-preamble.md",
		"scripts/setup_ghx.py",
	} {
		path := filepath.Join(tmp, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if !isDirectiveFrameworkCheckout(tmp) {
		t.Fatal("expected fixture with maintainer source markers to be detected as directive framework checkout")
	}
	if err := os.Remove(filepath.Join(tmp, "main.md")); err != nil {
		t.Fatal(err)
	}
	if isDirectiveFrameworkCheckout(tmp) {
		t.Fatal("missing main.md must fail maintainer checkout detection")
	}
	if err := validateMaintainerCheckout(tmp); err == nil {
		t.Fatal("validateMaintainerCheckout must fail outside a directive framework checkout")
	}
}

func withLinuxCoreToolSeams(t *testing.T, lookPath func(string) (string, error), bootstrap func(*Wizard, []string) error) func() {
	t.Helper()
	origGOOS := goosForCoreTools
	origLook := lookPathFunc
	origBootstrap := bootstrapLinuxCoreToolsFunc
	goosForCoreTools = func() string { return "linux" }
	lookPathFunc = lookPath
	bootstrapLinuxCoreToolsFunc = bootstrap
	return func() {
		goosForCoreTools = origGOOS
		lookPathFunc = origLook
		bootstrapLinuxCoreToolsFunc = origBootstrap
	}
}

// TestEnsureCoreTools_LinuxBootstrapSuccess verifies Linux --yes bootstrap
// clears doctor-required tools from missing_tools after a successful portable
// install (#1538).
func TestEnsureCoreTools_LinuxBootstrapSuccess(t *testing.T) {
	present := map[string]bool{}
	restore := withLinuxCoreToolSeams(t,
		func(file string) (string, error) {
			if present[file] {
				return "/home/test/.local/bin/" + file, nil
			}
			return "", exec.ErrNotFound
		},
		func(w *Wizard, missing []string) error {
			for _, tool := range missing {
				switch tool {
				case "uv", "task", "gh":
					present[tool] = true
				}
			}
			return nil
		},
	)
	defer restore()

	var out bytes.Buffer
	w := NewWizardWithLayout(strings.NewReader(""), &out, false, false)
	missing, err := EnsureCoreTools(w, true)
	if err != nil {
		t.Fatalf("EnsureCoreTools returned error: %v", err)
	}
	for _, tool := range []string{"uv", "task", "gh"} {
		if !present[tool] {
			t.Errorf("bootstrap seam did not mark %q installed", tool)
		}
	}
	for _, tool := range missing {
		if tool == "uv" || tool == "task" || tool == "gh" {
			t.Errorf("required tool %q still reported missing after bootstrap: %v", tool, missing)
		}
	}
	if !strings.Contains(out.String(), "Bootstrapping required core tools") {
		t.Errorf("expected bootstrap log line; got:\n%s", out.String())
	}
}

// TestEnsureCoreTools_LinuxBootstrapUnsupportedFailLoud verifies unsupported
// Linux bootstrap returns a structured ErrCoreToolsBootstrap instead of
// success-plus-fallback prose (#1538).
func TestEnsureCoreTools_LinuxBootstrapUnsupportedFailLoud(t *testing.T) {
	restore := withLinuxCoreToolSeams(t,
		func(file string) (string, error) {
			return "", exec.ErrNotFound
		},
		func(w *Wizard, missing []string) error {
			return &ErrCoreToolsBootstrap{
				Missing: missing,
				Detail:  "no supported fetcher on PATH (need curl or wget for portable Linux bootstrap)",
			}
		},
	)
	defer restore()

	var out bytes.Buffer
	w := NewWizardWithLayout(strings.NewReader(""), &out, false, false)
	missing, err := EnsureCoreTools(w, true)
	if err == nil {
		t.Fatal("expected bootstrap failure error, got nil")
	}
	var bootErr *ErrCoreToolsBootstrap
	if !errors.As(err, &bootErr) {
		t.Fatalf("expected *ErrCoreToolsBootstrap, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), "curl or wget") {
		t.Errorf("expected fetcher detail in error, got: %v", err)
	}
	for _, want := range []string{"uv", "task", "gh"} {
		if !containsString(missing, want) {
			t.Errorf("missing_tools should include %q, got %v", want, missing)
		}
	}
	if strings.Contains(out.String(), "consent implied by --yes") {
		t.Errorf("unsupported bootstrap must not emit legacy success fallback prose; got:\n%s", out.String())
	}
}

// TestEnsureCoreTools_LinuxBootstrapStillMissingAfterInstall verifies bootstrap
// that completes without wiring tools onto PATH fails loud (#1538).
func TestEnsureCoreTools_LinuxBootstrapStillMissingAfterInstall(t *testing.T) {
	restore := withLinuxCoreToolSeams(t,
		func(file string) (string, error) {
			return "", exec.ErrNotFound
		},
		func(w *Wizard, missing []string) error {
			return nil
		},
	)
	defer restore()

	_, err := EnsureCoreTools(NewWizardWithLayout(strings.NewReader(""), io.Discard, false, false), true)
	if err == nil {
		t.Fatal("expected error when required tools remain missing after bootstrap")
	}
	if !strings.Contains(err.Error(), "still missing") {
		t.Errorf("expected post-bootstrap missing detail, got: %v", err)
	}
}

// TestEnsureCoreTools_NonLinuxNonInteractiveKeepsFallback verifies non-Linux
// --yes runs still emit manual fallback guidance without attempting bootstrap.
func TestEnsureCoreTools_NonLinuxNonInteractiveKeepsFallback(t *testing.T) {
	origGOOS := goosForCoreTools
	origLook := lookPathFunc
	goosForCoreTools = func() string { return "windows" }
	lookPathFunc = func(file string) (string, error) {
		if file == "uv" {
			return "", exec.ErrNotFound
		}
		return "/bin/" + file, nil
	}
	defer func() {
		goosForCoreTools = origGOOS
		lookPathFunc = origLook
	}()

	var out bytes.Buffer
	missing, err := EnsureCoreTools(NewWizardWithLayout(strings.NewReader(""), &out, false, false), true)
	if err != nil {
		t.Fatalf("non-Linux fallback path should not error: %v", err)
	}
	if len(missing) != 1 || missing[0] != "uv" {
		t.Fatalf("expected only uv missing, got %v", missing)
	}
	if !strings.Contains(out.String(), "Fallbacks") {
		t.Errorf("expected fallback guidance on non-Linux host; got:\n%s", out.String())
	}
}

// TestCoreToolsBootstrapBlockResult_JSONShape pins the structured --json
// refusal object for Linux bootstrap failures (#1538).
func TestCoreToolsBootstrapBlockResult_JSONShape(t *testing.T) {
	missing := []string{"gh", "task", "uv"}
	err := &ErrCoreToolsBootstrap{
		Missing: missing,
		Detail:  "no supported fetcher on PATH (need curl or wget for portable Linux bootstrap)",
	}
	obj := coreToolsBootstrapBlockResult(missing, err)
	if obj["success"] != false {
		t.Errorf("success = %v, want false", obj["success"])
	}
	if obj["error_code"] != coreToolsBootstrapBlockCode {
		t.Errorf("error_code = %v, want %q", obj["error_code"], coreToolsBootstrapBlockCode)
	}
	gotMissing, ok := obj["missing_tools"].([]string)
	if !ok {
		t.Fatalf("missing_tools type = %T, want []string", obj["missing_tools"])
	}
	if len(gotMissing) != 3 {
		t.Errorf("missing_tools = %v, want 3 entries", gotMissing)
	}
	rem, ok := obj["remediation"].([]string)
	if !ok || len(rem) == 0 {
		t.Fatalf("remediation must be a non-empty []string, got %T %v", obj["remediation"], obj["remediation"])
	}
	if _, err := json.Marshal(obj); err != nil {
		t.Fatalf("block result is not JSON-marshalable: %v", err)
	}
}

func containsString(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

// TestPrependLinuxLocalBin_PrependsHomeLocalBin verifies ~/.local/bin is
// injected ahead of the existing PATH for post-bootstrap re-probes (#1538).
func TestPrependLinuxLocalBin_PrependsHomeLocalBin(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	localBin := filepath.Join(home, ".local", "bin")
	orig := os.Getenv("PATH")
	t.Cleanup(func() { os.Setenv("PATH", orig) })

	os.Setenv("PATH", "/usr/bin")
	if err := prependLinuxLocalBin(); err != nil {
		t.Fatalf("prependLinuxLocalBin: %v", err)
	}
	got := os.Getenv("PATH")
	if !strings.HasPrefix(got, localBin+string(os.PathListSeparator)) {
		t.Errorf("PATH = %q, want prefix %q", got, localBin+string(os.PathListSeparator))
	}
}

// TestInstallTaskLinux_PassesInstallerFlagsDirectly pins the go-task installer
// invocation that the Linux CI path exercises. The downloaded installer expects
// its own flags directly; passing the shell-style "-s --" sentinel makes it exit
// with "Illegal option -s" (#1538 CI follow-up).
func TestInstallTaskLinux_PassesInstallerFlagsDirectly(t *testing.T) {
	origRun := runCmdFunc
	defer func() { runCmdFunc = origRun }()

	var gotName string
	var gotArgs []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		gotName = name
		gotArgs = append([]string{}, args...)
		return nil
	}

	w := NewWizardWithLayout(strings.NewReader(""), io.Discard, false, false)
	if err := installTaskLinux(w); err != nil {
		t.Fatalf("installTaskLinux returned error: %v", err)
	}
	if gotName != "sh" {
		t.Fatalf("run command name = %q, want sh", gotName)
	}
	if len(gotArgs) != 2 || gotArgs[0] != "-c" {
		t.Fatalf("run command args = %v, want [-c <script>]", gotArgs)
	}
	script := gotArgs[1]
	if strings.Contains(script, "-s --") {
		t.Fatalf("task installer script still contains invalid shell sentinel -s --:\n%s", script)
	}
	if !strings.Contains(script, `sh "$tmpdir/install.sh" -d -b "${HOME}/.local/bin"`) {
		t.Fatalf("task installer script missing direct flag invocation; got:\n%s", script)
	}
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

// ---------------------------------------------------------------------------
// Python interpreter preflight (#1668)
// ---------------------------------------------------------------------------

// withPythonSeams swaps the lookPathFunc + pythonVersionProbeFunc seams so the
// interpreter preflight can be exercised deterministically without a real
// interpreter on PATH. It also neutralizes any ambient DEFT_PYTHON so the
// no-override candidate order is the default unless a test sets it explicitly.
func withPythonSeams(t *testing.T, look func(string) (string, error), probe func(string, ...string) (string, error)) {
	t.Helper()
	t.Setenv("DEFT_PYTHON", "")
	origLook := lookPathFunc
	origProbe := pythonVersionProbeFunc
	lookPathFunc = look
	pythonVersionProbeFunc = probe
	pythonPreflightReported = nil
	t.Cleanup(func() {
		lookPathFunc = origLook
		pythonVersionProbeFunc = origProbe
		pythonPreflightReported = nil
	})
}

// lookOnly builds a lookPathFunc stub where only the named bins resolve.
func lookOnly(present ...string) func(string) (string, error) {
	set := map[string]bool{}
	for _, p := range present {
		set[p] = true
	}
	return func(name string) (string, error) {
		if set[name] {
			return "/usr/bin/" + name, nil
		}
		return "", exec.ErrNotFound
	}
}

func TestParsePythonVersion(t *testing.T) {
	cases := []struct {
		in                  string
		ok                  bool
		major, minor, patch int
	}{
		{"Python 3.13.1", true, 3, 13, 1},
		{"Python 3.11", true, 3, 11, 0},
		{"Python 3.10.6", true, 3, 10, 6},
		{"Python 2.7.18", true, 2, 7, 18},
		{"not a version", false, 0, 0, 0},
	}
	for _, c := range cases {
		v, ok := parsePythonVersion(c.in)
		if ok != c.ok {
			t.Errorf("parsePythonVersion(%q) ok=%v, want %v", c.in, ok, c.ok)
			continue
		}
		if !ok {
			continue
		}
		if v.major != c.major || v.minor != c.minor || v.patch != c.patch {
			t.Errorf("parsePythonVersion(%q) = %d.%d.%d, want %d.%d.%d", c.in, v.major, v.minor, v.patch, c.major, c.minor, c.patch)
		}
	}
}

func TestPythonVersionMeetsMinimum(t *testing.T) {
	cases := []struct {
		v    pythonVersion
		want bool
	}{
		{pythonVersion{major: 3, minor: 11}, true},
		{pythonVersion{major: 3, minor: 13, patch: 2}, true},
		{pythonVersion{major: 4, minor: 0}, true},
		{pythonVersion{major: 3, minor: 10, patch: 99}, false},
		{pythonVersion{major: 2, minor: 7}, false},
	}
	for _, c := range cases {
		if got := c.v.meetsMinimum(); got != c.want {
			t.Errorf("%s meetsMinimum() = %v, want %v", c.v.String(), got, c.want)
		}
	}
}

func TestIsAppExecutionAliasStub(t *testing.T) {
	stub := "Python was not found; run without arguments to install from the " +
		"Microsoft Store, or disable this shortcut from Settings > Apps > " +
		"Advanced app settings > App execution aliases."
	if !isAppExecutionAliasStub(stub) {
		t.Error("expected the Windows App-Execution-Alias stub text to be detected")
	}
	if isAppExecutionAliasStub("Python 3.13.1") {
		t.Error("a real version banner must not be treated as the alias stub")
	}
}

// TestRunPythonPreflight_TooOldRejected: an interpreter older than 3.11 is
// recorded as bestFound but never resolved (AC: version-too-old rejection).
func TestRunPythonPreflight_TooOldRejected(t *testing.T) {
	withPythonSeams(t, lookOnly("python"), func(bin string, _ ...string) (string, error) {
		if bin == "python" {
			return "Python 3.10.6", nil
		}
		return "", exec.ErrNotFound
	})
	pf := runPythonPreflight()
	if pf.ok {
		t.Fatalf("expected preflight to reject Python 3.10, got ok=true (%+v)", pf)
	}
	if !pf.foundAny {
		t.Fatal("expected foundAny=true for a present-but-too-old interpreter")
	}
	if pf.bestFound.source != "python" || pf.bestVersion.minor != 10 {
		t.Errorf("bestFound=%q version=%s, want python 3.10.x", pf.bestFound.source, pf.bestVersion.String())
	}
}

// TestRunPythonPreflight_PyLauncherResolves models a Windows host where the
// `python3` on PATH is the App-Execution-Alias stub, `python` is absent, and
// the `py -3` launcher resolves a real 3.13 interpreter (AC: resolution order
// incl. the py launcher, skipping the alias stub).
func TestRunPythonPreflight_PyLauncherResolves(t *testing.T) {
	stub := "Python was not found; run without arguments to install from the Microsoft Store ... App execution aliases."
	withPythonSeams(t, lookOnly("python3", "py"), func(bin string, prefix ...string) (string, error) {
		switch bin {
		case "python3":
			return stub, nil
		case "py":
			if len(prefix) == 1 && prefix[0] == "-3" {
				return "Python 3.13.1", nil
			}
		}
		return "", exec.ErrNotFound
	})
	pf := runPythonPreflight()
	if !pf.ok {
		t.Fatalf("expected the py launcher to resolve a 3.13 interpreter, got ok=false (%+v)", pf)
	}
	if pf.resolved.source != "py launcher" {
		t.Errorf("resolved.source = %q, want %q", pf.resolved.source, "py launcher")
	}
	if len(pf.resolved.prefixArgs) != 1 || pf.resolved.prefixArgs[0] != "-3" {
		t.Errorf("resolved.prefixArgs = %v, want [-3]", pf.resolved.prefixArgs)
	}
	if pf.version.major != 3 || pf.version.minor != 13 {
		t.Errorf("resolved version = %s, want 3.13.x", pf.version.String())
	}
}

// TestRunPythonPreflight_DeftPythonOverride: an explicit DEFT_PYTHON path is
// probed first and directly (no PATH gate), even when nothing else resolves
// (AC: resolution probes DEFT_PYTHON).
func TestRunPythonPreflight_DeftPythonOverride(t *testing.T) {
	withPythonSeams(t, lookOnly(), func(bin string, _ ...string) (string, error) {
		if bin == "/opt/py311/bin/python" {
			return "Python 3.11.7", nil
		}
		return "", exec.ErrNotFound
	})
	t.Setenv("DEFT_PYTHON", "/opt/py311/bin/python")

	pf := runPythonPreflight()
	if !pf.ok {
		t.Fatalf("expected DEFT_PYTHON override to resolve, got ok=false (%+v)", pf)
	}
	if pf.resolved.source != "DEFT_PYTHON" || pf.resolved.bin != "/opt/py311/bin/python" {
		t.Errorf("resolved = %q/%q, want DEFT_PYTHON//opt/py311/bin/python", pf.resolved.source, pf.resolved.bin)
	}
}

// TestRunPythonPreflight_NoneFound: nothing on PATH and no override -> ok=false
// and foundAny=false (AC: graceful handling of a missing interpreter).
func TestRunPythonPreflight_NoneFound(t *testing.T) {
	withPythonSeams(t, lookOnly(), func(string, ...string) (string, error) {
		return "", exec.ErrNotFound
	})
	pf := runPythonPreflight()
	if pf.ok || pf.foundAny {
		t.Fatalf("expected ok=false, foundAny=false when no interpreter resolves, got %+v", pf)
	}
}

// TestRunPythonPreflight_Python3BeforePython pins the resolution order to match
// the git hooks: when both `python3` and `python` are present and compatible,
// `python3` is resolved first (Greptile #1676 -- the installer order MUST mirror
// .githooks/pre-commit / pre-push, which probe python3 -> python -> py -3).
func TestRunPythonPreflight_Python3BeforePython(t *testing.T) {
	withPythonSeams(t, lookOnly("python3", "python"), func(bin string, _ ...string) (string, error) {
		switch bin {
		case "python3":
			return "Python 3.11.0", nil
		case "python":
			return "Python 3.13.0", nil
		}
		return "", exec.ErrNotFound
	})
	pf := runPythonPreflight()
	if !pf.ok {
		t.Fatalf("expected a resolved interpreter, got ok=false (%+v)", pf)
	}
	if pf.resolved.source != "python3" {
		t.Errorf("resolved.source = %q, want python3 (must be tried before python to match the hooks)", pf.resolved.source)
	}
	if pf.version.minor != 11 {
		t.Errorf("resolved version = %s, want 3.11.0 (the python3 candidate)", pf.version.String())
	}
}

// TestDoHandoffToDoctor_NoDuplicateFailureMessage pins Greptile #1676 finding 2:
// on the --yes/CI path reportPythonPreflight prints the actionable block, and
// the subsequent doHandoffToDoctor must NOT print it a second time -- it reuses
// the cached preflight and emits only a short pointer.
func TestDoHandoffToDoctor_NoDuplicateFailureMessage(t *testing.T) {
	withPythonSeams(t, lookOnly("python"), func(bin string, _ ...string) (string, error) {
		if bin == "python" {
			return "Python 3.10.6", nil
		}
		return "", exec.ErrNotFound
	})

	// A doctor.py must exist so doHandoffToDoctor reaches the preflight branch
	// (it returns early when the canonical doctor is absent).
	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")
	if err := os.MkdirAll(filepath.Join(deftDir, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deftDir, "scripts", "doctor.py"), []byte("# stub\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := &WizardResult{ProjectDir: proj, DeftDir: deftDir}

	var out bytes.Buffer
	w := NewWizardWithLayout(strings.NewReader(""), &out, false, false)

	// Simulate the --yes/CI ordering: EnsureCoreTools -> reportPythonPreflight,
	// then the install epilogue -> doHandoffToDoctor.
	reportPythonPreflight(w)
	doHandoffToDoctor(w, result, false)

	const marker = "Deft requires Python 3.11+"
	if n := strings.Count(out.String(), marker); n != 1 {
		t.Errorf("actionable preflight message printed %d times, want exactly 1; output:\n%s", n, out.String())
	}
	if !strings.Contains(out.String(), "Doctor handoff skipped") {
		t.Errorf("doctor handoff should be skipped on an incompatible interpreter; output:\n%s", out.String())
	}
}

// TestDoHandoffToDoctor_PrintsMessageOnInteractivePath verifies the interactive
// path (no prior reportPythonPreflight) still prints the full actionable
// message from doHandoffToDoctor itself.
func TestDoHandoffToDoctor_PrintsMessageOnInteractivePath(t *testing.T) {
	withPythonSeams(t, lookOnly("python"), func(bin string, _ ...string) (string, error) {
		if bin == "python" {
			return "Python 3.10.6", nil
		}
		return "", exec.ErrNotFound
	})

	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")
	if err := os.MkdirAll(filepath.Join(deftDir, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deftDir, "scripts", "doctor.py"), []byte("# stub\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := &WizardResult{ProjectDir: proj, DeftDir: deftDir}

	var out bytes.Buffer
	w := NewWizardWithLayout(strings.NewReader(""), &out, false, false)
	// No reportPythonPreflight call -> nothing cached -> message printed here.
	doHandoffToDoctor(w, result, false)

	if n := strings.Count(out.String(), "Deft requires Python 3.11+"); n != 1 {
		t.Errorf("interactive path must print the actionable message exactly once; got %d:\n%s", n, out.String())
	}
}

func TestPythonPreflightMessage_IsActionable(t *testing.T) {
	tooOld := pythonPreflight{foundAny: true, bestFound: pythonInterpreterCandidate{source: "python"}, bestVersion: pythonVersion{major: 3, minor: 10, patch: 6}}
	msg := pythonPreflightMessage(tooOld)
	for _, want := range []string{"3.11", "DEFT_PYTHON", "3.10.6", "python"} {
		if !strings.Contains(msg, want) {
			t.Errorf("too-old message missing %q; got:\n%s", want, msg)
		}
	}
	none := pythonPreflight{}
	msg = pythonPreflightMessage(none)
	for _, want := range []string{"3.11", "DEFT_PYTHON", "py` launcher"} {
		if !strings.Contains(msg, want) {
			t.Errorf("not-found message missing %q; got:\n%s", want, msg)
		}
	}
}

// TestDoctorHandoffCommand_PyLauncherAndJSON pins the doctor handoff argv
// wiring: the resolved interpreter's prefix args lead, --session --full always
// present, --json gated on jsonOut, and the project root forwarded (AC:
// graceful doctor-handoff path uses the resolved interpreter).
func TestDoctorHandoffCommand_PyLauncherAndJSON(t *testing.T) {
	pf := pythonPreflight{
		ok:       true,
		resolved: pythonInterpreterCandidate{source: "py launcher", bin: "py", prefixArgs: []string{"-3"}},
		version:  pythonVersion{major: 3, minor: 13, patch: 1},
	}
	bin, args := doctorHandoffCommand(pf, "/proj/.deft/core/scripts/doctor.py", "/proj", true)
	if bin != "py" {
		t.Errorf("bin = %q, want py", bin)
	}
	want := []string{"-3", "/proj/.deft/core/scripts/doctor.py", "--session", "--full", "--json", "--project-root", "/proj"}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Errorf("args = %v, want %v", args, want)
	}

	// Non-JSON, plain interpreter (no prefix) drops --json and the prefix.
	pf2 := pythonPreflight{ok: true, resolved: pythonInterpreterCandidate{source: "python3", bin: "python3"}}
	bin2, args2 := doctorHandoffCommand(pf2, "/proj/.deft/core/scripts/doctor.py", "/proj", false)
	if bin2 != "python3" {
		t.Errorf("bin = %q, want python3", bin2)
	}
	if containsString(args2, "--json") {
		t.Errorf("non-JSON handoff must not carry --json; got %v", args2)
	}
	if args2[0] != "/proj/.deft/core/scripts/doctor.py" {
		t.Errorf("plain interpreter must not prepend a prefix arg; got %v", args2)
	}
}

// TestReportPythonPreflight_DocumentsDeftPythonOnSuccess: AC #4 -- the success
// path documents the DEFT_PYTHON override in installer output.
func TestReportPythonPreflight_DocumentsDeftPythonOnSuccess(t *testing.T) {
	withPythonSeams(t, lookOnly("python3"), func(bin string, _ ...string) (string, error) {
		if bin == "python3" {
			return "Python 3.13.1", nil
		}
		return "", exec.ErrNotFound
	})
	var out bytes.Buffer
	w := NewWizardWithLayout(strings.NewReader(""), &out, false, false)
	pf := reportPythonPreflight(w)
	if !pf.ok {
		t.Fatalf("expected ok preflight, got %+v", pf)
	}
	if !strings.Contains(out.String(), "DEFT_PYTHON") {
		t.Errorf("success output must document DEFT_PYTHON; got:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "3.13.1") {
		t.Errorf("success output should report the resolved version; got:\n%s", out.String())
	}
}

// TestReportPythonPreflight_ActionableOnFailure: AC #1 -- a too-old interpreter
// produces a loud, actionable message naming 3.11+ and DEFT_PYTHON.
func TestReportPythonPreflight_ActionableOnFailure(t *testing.T) {
	withPythonSeams(t, lookOnly("python"), func(bin string, _ ...string) (string, error) {
		if bin == "python" {
			return "Python 3.10.6", nil
		}
		return "", exec.ErrNotFound
	})
	var out bytes.Buffer
	w := NewWizardWithLayout(strings.NewReader(""), &out, false, false)
	pf := reportPythonPreflight(w)
	if pf.ok {
		t.Fatal("expected failed preflight for Python 3.10")
	}
	s := out.String()
	for _, want := range []string{"FAILED", "3.11", "DEFT_PYTHON"} {
		if !strings.Contains(s, want) {
			t.Errorf("failure output missing %q; got:\n%s", want, s)
		}
	}
}

// ---------------------------------------------------------------------------
// #1671: upgrade refresh side-effect disclosure + full-lifecycle commit guidance
// ---------------------------------------------------------------------------

// TestPorcelainStatusPaths_ParsesEntriesAndRenames pins the porcelain v1 path
// extraction the refresh disclosure depends on: ordinary entries drop the XY
// status prefix, untracked (`??`) entries are parsed, and a rename/copy entry
// (`R  ORIG -> NEW`) yields the NEW path.
func TestPorcelainStatusPaths_ParsesEntriesAndRenames(t *testing.T) {
	lines := []string{
		" M AGENTS.md",
		"?? .deft/core/uv.lock",
		"R  vbrief/old.md -> vbrief/vbrief.md",
		"A  .deft/core/new.txt",
		"x", // malformed / too short -- skipped
	}
	got := porcelainStatusPaths(lines)
	want := []string{"AGENTS.md", ".deft/core/uv.lock", "vbrief/vbrief.md", ".deft/core/new.txt"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("porcelainStatusPaths = %v, want %v", got, want)
	}
}

// TestFrameworkRefreshSideEffects_FiltersToFrameworkManaged asserts the refresh
// side-effect set keeps ONLY framework-managed changes (the .deft/core payload
// plus the installer-managed deposit surface) and excludes consumer app files
// AND consumer vBRIEF data (PROJECT-DEFINITION). The result is sorted. (#1671)
func TestFrameworkRefreshSideEffects_FiltersToFrameworkManaged(t *testing.T) {
	orig := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = orig }()
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) {
		return []string{
			" M AGENTS.md",
			"?? .deft/core/uv.lock",
			"R  vbrief/old.md -> vbrief/vbrief.md",
			" M myapp/main.go",                         // consumer app -- excluded
			" M vbrief/PROJECT-DEFINITION.vbrief.json", // consumer vBRIEF data -- excluded
		}, true, nil
	}
	got := frameworkRefreshSideEffects("/proj")
	want := []string{".deft/core/uv.lock", "AGENTS.md", "vbrief/vbrief.md"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("frameworkRefreshSideEffects = %v, want %v", got, want)
	}
}

// TestFrameworkRefreshSideEffects_NonGitIsNoop confirms the disclosure is
// best-effort: a non-git project yields nil so WriteAgentsMD stays silent about
// side effects (mirrors the dirty-tree advisory contract). (#1671)
func TestFrameworkRefreshSideEffects_NonGitIsNoop(t *testing.T) {
	orig := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = orig }()
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) { return nil, false, nil }
	if got := frameworkRefreshSideEffects("/proj"); got != nil {
		t.Errorf("non-git project must yield nil, got %v", got)
	}
}

// TestPrintCommitGuidance_WalksFullPRLifecycle pins AC-3 + AC-4: the hygiene
// block no longer stops at `git commit` -- it walks branch -> commit -> push ->
// `gh pr create` -> merge so the operator follows the framework deposit through
// the standalone PR deft-core-guard actually requires. The scoped `git add`
// path list is still enumerated. (#1671)
func TestPrintCommitGuidance_WalksFullPRLifecycle(t *testing.T) {
	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)
	paths := []string{".deft/core", "AGENTS.md"}
	printCommitGuidance(w, paths, true)
	s := out.String()
	for _, want := range []string{
		"git switch -c",
		"git commit -m",
		"git push -u origin",
		"gh pr create",
		"gh pr merge",
		".deft/core",
		"AGENTS.md",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("commit guidance missing lifecycle step / path %q; got:\n%s", want, s)
		}
	}
}

// TestWriteAgentsMD_RefreshDisclosesSideEffectFiles pins AC-2: when the refresh
// rewrites the managed section during an upgrade, it reports the SPECIFIC
// framework files it/the payload swap changed (AGENTS.md, .deft/core/uv.lock)
// instead of a single silent success line, and never nudges a consumer app file
// into the framework deposit commit. (#1671)
func TestWriteAgentsMD_RefreshDisclosesSideEffectFiles(t *testing.T) {
	orig := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = orig }()
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) {
		return []string{
			" M AGENTS.md",
			" M .deft/core/uv.lock",
			" M myapp/main.go",
		}, true, nil
	}

	tmp := t.TempDir()
	// A stale legacy-sentinel AGENTS.md forces the rewrite (refresh) path.
	legacyBody := "# Project AGENTS\n" +
		"Deft is installed in deft/. Full guidelines: deft/main.md\n"
	if err := os.WriteFile(filepath.Join(tmp, "AGENTS.md"), []byte(legacyBody), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)
	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatalf("WriteAgentsMD: %v", err)
	}
	s := out.String()
	if !strings.Contains(s, "refresh side effects") {
		t.Errorf("refresh did not disclose side effects (single silent line regression #1671); got:\n%s", s)
	}
	// The disclosure enumerates each framework straggler as its own bullet.
	for _, want := range []string{"  AGENTS.md\n", "  .deft/core/uv.lock\n"} {
		if !strings.Contains(s, want) {
			t.Errorf("disclosure missing framework straggler bullet %q; got:\n%s", want, s)
		}
	}
	if strings.Contains(s, "myapp/main.go") {
		t.Errorf("disclosure leaked a consumer app file into the framework set; got:\n%s", s)
	}
}

// TestUpgradeRefreshBeforeStage_NoStragglers_RealGit drives the main.go upgrade
// ordering against a REAL git repo and asserts AC-1 + AC-4: the AGENTS.md
// refresh runs BEFORE staging (disclosing the side-effect files), and after the
// scoped staging there are NO post-stage stragglers -- every framework-managed
// change the refresh / payload swap produced is already staged.
func TestUpgradeRefreshBeforeStage_NoStragglers_RealGit(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available; skipping refresh-before-stage real-git test")
	}
	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Baseline payload file + a STALE committed AGENTS.md (an old managed
	// section). Committing the stale body means the refresh below genuinely
	// dirties AGENTS.md relative to HEAD (as a real upgrade does).
	if err := os.WriteFile(filepath.Join(deftDir, "uv.lock"), []byte("version = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	staleBody := "<!-- deft:managed-section v3 sha=deadbeef01 refreshed=2026-01-01T00:00:00Z session=abc123 -->\n" +
		"# Deft\n\nDeft is installed in .deft/core/. Full guidelines: .deft/core/main.md\n\n" +
		"(stale managed body from an older framework version)\n" + agentsMDFenceClose + "\n"
	if err := os.WriteFile(filepath.Join(proj, "AGENTS.md"), []byte(staleBody), 0o644); err != nil {
		t.Fatal(err)
	}

	runGitIn(t, gitPath, proj, "init", "-b", "master")
	runGitIn(t, gitPath, proj, "config", "user.email", "test@example.com")
	runGitIn(t, gitPath, proj, "config", "user.name", "Test")
	runGitIn(t, gitPath, proj, "config", "commit.gpgsign", "false")
	runGitIn(t, gitPath, proj, "add", "AGENTS.md", ".deft/core/uv.lock")
	runGitIn(t, gitPath, proj, "commit", "-m", "baseline install")

	// Simulate the upgrade payload swap: the vendored uv.lock is regenerated.
	if err := os.WriteFile(filepath.Join(deftDir, "uv.lock"), []byte("version = 2\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// --- main.go ordering: REFRESH (WriteAgentsMD) BEFORE STAGE. ---
	var refreshOut bytes.Buffer
	w := NewWizard(strings.NewReader(""), &refreshOut, false)
	if err := WriteAgentsMD(w, proj); err != nil {
		t.Fatalf("WriteAgentsMD (refresh): %v", err)
	}
	rs := refreshOut.String()
	for _, want := range []string{"  AGENTS.md\n", "  .deft/core/uv.lock\n"} {
		if !strings.Contains(rs, want) {
			t.Errorf("refresh did not disclose side-effect file %q BEFORE staging; got:\n%s", want, rs)
		}
	}

	// Stage exactly as main.go does, AFTER the refresh.
	stagePaths := frameworkStagePaths(proj, deftDir)
	staged, serr := stageFrameworkPaths(proj, stagePaths)
	if serr != nil {
		t.Fatalf("stageFrameworkPaths: %v", serr)
	}
	if !staged {
		t.Fatalf("expected scoped staging to occur")
	}

	// AC-1: no post-stage stragglers. Every framework-managed change is staged;
	// nothing framework-managed remains unstaged ('?' untracked or ' ' worktree-
	// modified with an empty index column).
	lines, isRepo, perr := defaultGitPorcelainStatus(proj)
	if perr != nil || !isRepo {
		t.Fatalf("porcelain status: isRepo=%v err=%v", isRepo, perr)
	}
	for _, ln := range lines {
		if len(ln) < 4 {
			continue
		}
		paths := porcelainStatusPaths([]string{ln})
		if len(paths) == 0 {
			continue
		}
		core, managed, _ := classifyChangedPaths(paths)
		if len(core)+len(managed) == 0 {
			continue // consumer app file -- not a framework straggler
		}
		if x := ln[0]; x == '?' || x == ' ' {
			t.Errorf("post-stage straggler: framework file %q is unstaged (status %q) -- refresh-before-stage invariant violated (#1671)", paths[0], ln[:2])
		}
	}
}
