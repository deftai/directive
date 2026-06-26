package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/deftai/directive/content/templates"
)

// gate_test.go -- behavioral contract for the read-only gate subcommand
// (#1933 Option 3 / #2001 §1). Mirrors the Python contract pinned by
// tests/cmd_gate/ for the state-vector detectors:
//
//   - OK v<current>                                              (exit 0)
//   - NEEDS-UPGRADE recorded=.. current=.. precutover=.. agents-md=.. (exit 1)
//
// The fixtures construct a temp project root rather than chdir-ing so the
// tests are parallel-safe; runGateInDir is the testable core that runGate
// wraps around os.Getwd() + os.Stdout.

// writeCurrentAgentsMD writes an AGENTS.md whose managed section is
// byte-identical to the embedded canonical template, so gateClassifyAgentsMD
// returns "current".
func writeCurrentAgentsMD(t *testing.T, root string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte(templates.AgentsEntry), 0o644); err != nil {
		t.Fatalf("write AGENTS.md: %v", err)
	}
}

// --- Healthy vector ---------------------------------------------------------

func TestGate_Healthy_CurrentAgentsMD_NoMarker(t *testing.T) {
	root := t.TempDir()
	writeCurrentAgentsMD(t, root)

	var buf bytes.Buffer
	code := runGateInDir(root, false, &buf)

	if code != 0 {
		t.Fatalf("exit code = %d, want 0 (healthy)", code)
	}
	got := strings.TrimSpace(buf.String())
	want := "OK v" + version
	if got != want {
		t.Errorf("line = %q, want %q", got, want)
	}
}

func TestGate_Healthy_EmptyProject(t *testing.T) {
	// No AGENTS.md (agents-md=absent), no version marker, no precutover docs:
	// the gate passes per the Python `_gate_state_is_ok` (only stale/missing
	// agents-md fail; absent passes).
	root := t.TempDir()

	var buf bytes.Buffer
	code := runGateInDir(root, false, &buf)

	if code != 0 {
		t.Fatalf("exit code = %d, want 0 (absent agents-md passes)", code)
	}
	if got := strings.TrimSpace(buf.String()); got != "OK v"+version {
		t.Errorf("line = %q, want %q", got, "OK v"+version)
	}
}

func TestGate_Healthy_RecordedMatchesCurrent(t *testing.T) {
	root := t.TempDir()
	writeCurrentAgentsMD(t, root)
	vbrief := filepath.Join(root, "vbrief")
	if err := os.MkdirAll(vbrief, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vbrief, ".deft-version"), []byte(version+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	if code := runGateInDir(root, false, &buf); code != 0 {
		t.Fatalf("exit code = %d, want 0 (recorded == current)", code)
	}
}

// withVersion temporarily overrides the package-level ldflags `version` for a
// test and restores it afterward. These gate tests do not call t.Parallel(), so
// mutating the global is safe within a single sequential test.
func withVersion(t *testing.T, v string) {
	t.Helper()
	orig := version
	version = v
	t.Cleanup(func() { version = orig })
}

// writeInstallManifest writes a minimal canonical <root>/.deft/core/VERSION
// manifest carrying the given tag, mirroring BuildInstallManifestText's shape.
func writeInstallManifest(t *testing.T, root, tag string) {
	t.Helper()
	coreDir := filepath.Join(root, ".deft", "core")
	if err := os.MkdirAll(coreDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "ref: '" + tag + "'\ntag: '" + tag + "'\n"
	if err := os.WriteFile(filepath.Join(coreDir, "VERSION"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestGate_Healthy_ProductionVPrefixedVersion is the regression for the bug
// where release CI sets the binary version via `-X main.version=${github.ref_name}`
// (e.g. `v0.57.0`, WITH the leading `v`) while the installer writes the
// `vbrief/.deft-version` marker BARE (`0.57.0`). Before the fix, `current`
// carried the `v` and the raw string compare `recorded != current` always
// failed, so every healthy production-built install reported NEEDS-UPGRADE.
func TestGate_Healthy_ProductionVPrefixedVersion(t *testing.T) {
	withVersion(t, "v0.57.0")
	root := t.TempDir()
	writeCurrentAgentsMD(t, root)
	vbrief := filepath.Join(root, "vbrief")
	if err := os.MkdirAll(vbrief, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vbrief, ".deft-version"), []byte("0.57.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	if code := runGateInDir(root, false, &buf); code != 0 {
		t.Fatalf("exit code = %d, want 0 (v-prefixed binary version vs bare marker)\nline=%q", code, buf.String())
	}
	if got := strings.TrimSpace(buf.String()); got != "OK v0.57.0" {
		t.Errorf("line = %q, want %q", got, "OK v0.57.0")
	}
}

// TestGate_Healthy_ManifestAheadOfFrozenBinary asserts `current` is resolved
// from the INSTALLED payload manifest, not the frozen binary. An npm-era
// project can move its payload ahead of the frozen installer; sourcing `current`
// from the binary would false-report drift. Here the binary is a stale v0.50.0
// but the installed manifest + marker are 0.57.0, so the gate is healthy.
func TestGate_Healthy_ManifestAheadOfFrozenBinary(t *testing.T) {
	withVersion(t, "v0.50.0")
	root := t.TempDir()
	writeCurrentAgentsMD(t, root)
	writeInstallManifest(t, root, "v0.57.0")
	vbrief := filepath.Join(root, "vbrief")
	if err := os.MkdirAll(vbrief, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vbrief, ".deft-version"), []byte("0.57.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	if code := runGateInDir(root, false, &buf); code != 0 {
		t.Fatalf("exit code = %d, want 0 (current must come from manifest, not binary)\nline=%q", code, buf.String())
	}
	if got := strings.TrimSpace(buf.String()); got != "OK v0.57.0" {
		t.Errorf("line = %q, want %q (current from .deft/core/VERSION)", got, "OK v0.57.0")
	}
}

// TestGateResolveCurrentVersion covers the resolver directly: manifest wins
// (bare), a non-semver branch ref falls through to the normalized binary
// version, and the binary fallback strips a leading `v`.
func TestGateResolveCurrentVersion(t *testing.T) {
	t.Run("manifest tag wins, bare", func(t *testing.T) {
		withVersion(t, "v0.50.0")
		root := t.TempDir()
		writeInstallManifest(t, root, "v0.57.0")
		if got := gateResolveCurrentVersion(root); got != "0.57.0" {
			t.Errorf("current = %q, want %q (from manifest, v stripped)", got, "0.57.0")
		}
	})
	t.Run("branch ref manifest falls through to binary", func(t *testing.T) {
		withVersion(t, "v0.57.0")
		root := t.TempDir()
		writeInstallManifest(t, root, "master")
		if got := gateResolveCurrentVersion(root); got != "0.57.0" {
			t.Errorf("current = %q, want %q (non-semver manifest -> normalized binary)", got, "0.57.0")
		}
	})
	t.Run("no manifest, binary v stripped", func(t *testing.T) {
		withVersion(t, "v1.2.3")
		root := t.TempDir()
		if got := gateResolveCurrentVersion(root); got != "1.2.3" {
			t.Errorf("current = %q, want %q (binary fallback, v stripped)", got, "1.2.3")
		}
	})
}

// --- Needs-upgrade vectors --------------------------------------------------

func TestGate_NeedsUpgrade_VersionDrift(t *testing.T) {
	root := t.TempDir()
	writeCurrentAgentsMD(t, root)
	if err := os.WriteFile(filepath.Join(root, ".deft-version"), []byte("0.0.1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	code := runGateInDir(root, false, &buf)

	if code != 1 {
		t.Fatalf("exit code = %d, want 1 (version drift)", code)
	}
	got := strings.TrimSpace(buf.String())
	if !strings.HasPrefix(got, "NEEDS-UPGRADE ") {
		t.Fatalf("line = %q, want NEEDS-UPGRADE prefix", got)
	}
	for _, want := range []string{
		"recorded=0.0.1",
		"current=" + version,
		"precutover=",
		"agents-md=current",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("line = %q, missing %q", got, want)
		}
	}
}

func TestGate_NeedsUpgrade_AgentsMDMissing(t *testing.T) {
	root := t.TempDir()
	// AGENTS.md exists but carries no managed-section markers -> missing.
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("# AGENTS\n\nhand-rolled\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	code := runGateInDir(root, false, &buf)

	if code != 1 {
		t.Fatalf("exit code = %d, want 1 (agents-md missing)", code)
	}
	if got := strings.TrimSpace(buf.String()); !strings.Contains(got, "agents-md=missing") {
		t.Errorf("line = %q, want agents-md=missing", got)
	}
}

func TestGate_NeedsUpgrade_AgentsMDStaleLegacyMarker(t *testing.T) {
	root := t.TempDir()
	// A v2 marker forces upgrade to v3 -> stale, regardless of body bytes.
	body := "# AGENTS\n\n<!-- deft:managed-section v2 -->\nold body\n<!-- /deft:managed-section -->\n"
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	code := runGateInDir(root, false, &buf)

	if code != 1 {
		t.Fatalf("exit code = %d, want 1 (legacy v2 marker is stale)", code)
	}
	if got := strings.TrimSpace(buf.String()); !strings.Contains(got, "agents-md=stale") {
		t.Errorf("line = %q, want agents-md=stale", got)
	}
}

func TestGate_NeedsUpgrade_Precutover(t *testing.T) {
	root := t.TempDir()
	writeCurrentAgentsMD(t, root)
	// A legacy SPECIFICATION.md / PROJECT.md without the deprecation-redirect
	// sentinel is the canonical pre-cutover signal.
	if err := os.WriteFile(filepath.Join(root, "SPECIFICATION.md"), []byte("# Spec\nlegacy content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "PROJECT.md"), []byte("# Project\nlegacy content\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	code := runGateInDir(root, false, &buf)

	if code != 1 {
		t.Fatalf("exit code = %d, want 1 (precutover legacy docs)", code)
	}
	got := strings.TrimSpace(buf.String())
	if !strings.Contains(got, "precutover=SPECIFICATION.md,PROJECT.md") {
		t.Errorf("line = %q, want precutover=SPECIFICATION.md,PROJECT.md", got)
	}
}

func TestGate_Precutover_DeprecationRedirectNotLegacy(t *testing.T) {
	// A deprecation-redirect stub is NOT a pre-cutover legacy doc.
	root := t.TempDir()
	writeCurrentAgentsMD(t, root)
	if err := os.WriteFile(filepath.Join(root, "SPECIFICATION.md"),
		[]byte("<!-- deft:deprecated-redirect -->\nmoved\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := gateDetectPreCutoverLegacy(root); len(got) != 0 {
		t.Errorf("precutover = %v, want empty (redirect stub is not legacy)", got)
	}
}

// --- JSON surface -----------------------------------------------------------

func TestGate_JSON_HealthyShape(t *testing.T) {
	root := t.TempDir()
	writeCurrentAgentsMD(t, root)

	var buf bytes.Buffer
	code := runGateInDir(root, true, &buf)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}

	var payload map[string]any
	if err := json.Unmarshal(buf.Bytes(), &payload); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, buf.String())
	}
	if payload["status"] != "ok" {
		t.Errorf("status = %v, want ok", payload["status"])
	}
	if payload["current"] != version {
		t.Errorf("current = %v, want %s", payload["current"], version)
	}
	if payload["agents-md"] != "current" {
		t.Errorf("agents-md = %v, want current", payload["agents-md"])
	}
	if payload["recorded"] != nil {
		t.Errorf("recorded = %v, want null (no marker)", payload["recorded"])
	}
}

func TestGate_JSON_NeedsUpgradeShape(t *testing.T) {
	root := t.TempDir()
	writeCurrentAgentsMD(t, root)
	if err := os.WriteFile(filepath.Join(root, ".deft-version"), []byte("0.0.1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	code := runGateInDir(root, true, &buf)
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}

	var payload map[string]any
	if err := json.Unmarshal(buf.Bytes(), &payload); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, buf.String())
	}
	if payload["status"] != "needs-upgrade" {
		t.Errorf("status = %v, want needs-upgrade", payload["status"])
	}
	if payload["recorded"] != "0.0.1" {
		t.Errorf("recorded = %v, want 0.0.1", payload["recorded"])
	}
}

// --- Read-only contract -----------------------------------------------------

// TestGate_IsReadOnly asserts the gate never mutates filesystem state on any
// state path (mirrors the operator-consent / read-only contract pinned by
// tests/cmd_gate/test_state_detection.py and test_case_k.py).
func TestGate_IsReadOnly(t *testing.T) {
	root := t.TempDir()
	writeCurrentAgentsMD(t, root)
	if err := os.WriteFile(filepath.Join(root, "SPECIFICATION.md"), []byte("# Spec\nlegacy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".deft-version"), []byte("0.0.1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	before := snapshotTree(t, root)
	var buf bytes.Buffer
	_ = runGateInDir(root, false, &buf)
	_ = runGateInDir(root, true, &buf)
	after := snapshotTree(t, root)

	if len(before) != len(after) {
		t.Fatalf("gate mutated filesystem entry count: before=%d after=%d", len(before), len(after))
	}
	for path, size := range before {
		if after[path] != size {
			t.Errorf("gate mutated %s: before size=%d after size=%d", path, size, after[path])
		}
	}
}

// snapshotTree returns a map of relative path -> file size for every regular
// file under root, used to assert the gate is read-only.
func snapshotTree(t *testing.T, root string) map[string]int64 {
	t.Helper()
	entries := map[string]int64{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				return relErr
			}
			entries[rel] = info.Size()
		}
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot walk: %v", err)
	}
	return entries
}
