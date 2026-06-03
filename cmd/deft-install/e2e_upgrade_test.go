package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestEndToEnd_VendoredUpgrade_DoctorInvariants is the #1437 end-to-end smoke
// test. It builds a REALISTIC vendored-install fixture and drives the REAL
// vendored upgrade code path -- the exact UpdateDeft -> WriteInstallManifest ->
// WriteAgentsMD sequence main.go runs for a `--upgrade` -- then asserts the two
// doctor invariants the v0.39.3 vendored upgrade violated:
//
//  1. AGENTS.md ends with EXACTLY ONE deft managed section. The duplicate-
//     managed-section bug appended a SECOND section, which defeated the doctor's
//     freshness probe (agents-md-managed-section-fresh -> unreadable).
//  2. The bare vbrief/.deft-version derivative AGREES with the tag recorded in
//     the canonical .deft/core/VERSION manifest. The file-swap refreshed the
//     manifest but left the bare derivative stale (manifest-agreement -> fail).
//
// The fixture mirrors a webinstaller-origin install: a vendored .deft/core
// (no .git) carrying an OLD manifest, a root AGENTS.md whose managed section
// uses the ATTRIBUTED v3 marker (sha=/refreshed=/session=) with operator prose
// above and below it, and a STALE vbrief/.deft-version (0.0.0-dev). The tarball
// uses the real GitHub shape (leading pax_global_header + single wrapper dir).
//
// Hermetic + fast: no network (fetchCoreTarballFunc stubbed) and no real git
// (runGitCaptureFunc stubbed so the payload classifies as vendored). The two
// invariants are asserted directly in Go rather than by invoking
// scripts/doctor.py -- running the real doctor hermetically would require
// bundling the entire framework tree into the fixture; the assertions below ARE
// the invariants those doctor checks enforce.
//
// RED->GREEN: this test FAILS on pre-#1437 code (a second managed section is
// appended AND vbrief/.deft-version stays 0.0.0-dev) and PASSES after the fix.
func TestEndToEnd_VendoredUpgrade_DoctorInvariants(t *testing.T) {
	origGit := runGitCaptureFunc
	origFetch := fetchCoreTarballFunc
	defer func() {
		runGitCaptureFunc = origGit
		fetchCoreTarballFunc = origFetch
	}()

	proj := t.TempDir()
	core := filepath.Join(proj, ".deft", "core")
	if err := os.MkdirAll(core, 0o755); err != nil {
		t.Fatal(err)
	}
	// Old vendored manifest (pre-upgrade payload at v0.39.2).
	oldManifest := "ref: 'v0.39.2'\nsha: 'oldsha0000'\ntag: 'v0.39.2'\n" +
		"install_root: '.deft/core'\nfetched_at: '2026-06-01T00:00:00Z'\nfetched_by: 'deft-install'\n"
	if err := os.WriteFile(filepath.Join(core, "VERSION"), []byte(oldManifest), 0o644); err != nil {
		t.Fatal(err)
	}

	// Root AGENTS.md with an ATTRIBUTED v3 marker + operator prose around the
	// managed fence -- the exact shape that defeated the bare-string matcher.
	const operatorTop = "# My Project — Agent Guide\n\n" +
		"Hand-written operator notes that MUST survive the upgrade.\n\n"
	const operatorBottom = "\n## Operator appendix\n\n" +
		"More hand-written notes below the managed fence.\n"
	attributedSection := "<!-- deft:managed-section v3 sha=6136b66c42c8 refreshed=2026-06-01T03:08:04Z session=d7bc893a5c2d -->\n" +
		"# Deft — AI Development Framework\n\n" +
		"Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md\n\n" +
		"(stale managed body from an older framework version)\n" +
		agentsMDFenceClose + "\n"
	agentsPath := filepath.Join(proj, "AGENTS.md")
	if err := os.WriteFile(agentsPath, []byte(operatorTop+attributedSection+operatorBottom), 0o644); err != nil {
		t.Fatal(err)
	}

	// Stale bare derivative left by an earlier rail.
	vbriefDir := filepath.Join(proj, "vbrief")
	if err := os.MkdirAll(vbriefDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vbriefDir, ".deft-version"), []byte("0.0.0-dev\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Classify as vendored (no git work tree); stand in a real-shaped tarball
	// for the network download.
	runGitCaptureFunc = func(string, ...string) (string, error) {
		return "", fmt.Errorf("not a git repository")
	}
	tarball := makeCoreTarballWithPaxHeader(t, "deftai-directive-abc1234def567", map[string]string{
		"main.md":           "framework main",
		"scripts/doctor.py": "print('hi')",
	})
	fetchCoreTarballFunc = func(string) (string, error) { return tarball, nil }

	const upgradeTag = "v0.39.3"

	// --- Drive the REAL upgrade sequence main.go runs for an --upgrade. ---
	result := &WizardResult{ProjectName: "myproj", ProjectDir: proj, DeftDir: core, Update: true}
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	outcome, err := UpdateDeft(w, result, upgradeTag)
	if err != nil {
		t.Fatalf("UpdateDeft (vendored upgrade): %v", err)
	}

	// main.go overrides the manifest tag with the tarball-resolved tag on a
	// vendored refresh before stamping .deft/core/VERSION.
	fields := InstallManifestFields{
		Ref:         outcome.Tag,
		SHA:         outcome.SHA,
		Tag:         outcome.Tag,
		InstallRoot: ".deft/core",
		FetchedAt:   "2026-06-03T00:00:00Z",
		FetchedBy:   "deft-install",
	}
	if _, err := WriteInstallManifest(result.ProjectDir, result.DeftDir, fields); err != nil {
		t.Fatalf("WriteInstallManifest: %v", err)
	}
	if err := WriteAgentsMD(w, result.ProjectDir); err != nil {
		t.Fatalf("WriteAgentsMD: %v", err)
	}

	// --- Invariant 1: AGENTS.md has EXACTLY ONE managed section. ---
	got, err := os.ReadFile(agentsPath)
	if err != nil {
		t.Fatal(err)
	}
	content := string(got)
	if n := strings.Count(content, agentsMDFenceClose); n != 1 {
		t.Errorf("AGENTS.md has %d managed-section closing fences, want exactly 1 (duplicate-managed-section bug #1437):\n%s", n, content)
	}
	if n := strings.Count(content, "<!-- deft:managed-section v"); n != 1 {
		t.Errorf("AGENTS.md has %d managed-section open markers, want exactly 1:\n%s", n, content)
	}
	// Operator prose above and below the fence MUST be preserved.
	if !strings.Contains(content, "Hand-written operator notes that MUST survive the upgrade.") {
		t.Errorf("operator prose ABOVE the managed fence was lost:\n%s", content)
	}
	if !strings.Contains(content, "More hand-written notes below the managed fence.") {
		t.Errorf("operator prose BELOW the managed fence was lost:\n%s", content)
	}
	// The single section is the refreshed canonical body (the attributed marker
	// is rewritten in place to the bare canonical marker).
	if !strings.Contains(content, agentsMDSentinel) {
		t.Errorf("AGENTS.md missing the canonical bare v3 marker after upgrade:\n%s", content)
	}

	// --- Invariant 2: bare vbrief/.deft-version agrees with the manifest. ---
	bareRaw, err := os.ReadFile(filepath.Join(vbriefDir, ".deft-version"))
	if err != nil {
		t.Fatalf("vbrief/.deft-version missing after upgrade: %v", err)
	}
	bare := strings.TrimSpace(string(bareRaw))
	manifestRaw, err := os.ReadFile(filepath.Join(core, "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	derived := deriveTagFromManifestForTest(t, string(manifestRaw))
	if bare != derived {
		t.Errorf("manifest-agreement invariant violated: bare vbrief/.deft-version=%q does NOT agree with manifest tag-derived %q (#1437)", bare, derived)
	}
	if bare == "0.0.0-dev" {
		t.Errorf("vbrief/.deft-version was not regenerated (still the stale 0.0.0-dev)")
	}
}

// deriveTagFromManifestForTest extracts the bare semver the doctor's
// manifest-agreement check derives from a YAML manifest: the tag: value with a
// single leading 'v' stripped. Test-local so this smoke test does not depend on
// any installer-side helper -- it must compile + run against pre-fix code to
// prove the RED state.
func deriveTagFromManifestForTest(t *testing.T, manifest string) string {
	t.Helper()
	for _, line := range strings.Split(manifest, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "tag:") {
			v := strings.TrimSpace(strings.TrimPrefix(line, "tag:"))
			v = strings.Trim(v, "'\"")
			return strings.TrimPrefix(v, "v")
		}
	}
	t.Fatalf("no tag: line in manifest:\n%s", manifest)
	return ""
}
