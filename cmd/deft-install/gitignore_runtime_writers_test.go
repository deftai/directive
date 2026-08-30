package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type runtimeWriterManifest struct {
	WriterPaths    []string `json:"writerPaths"`
	UncoveredProbe string   `json:"uncoveredProbe"`
}

func repoRootFromThisFile(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func loadRuntimeWriterManifest(t *testing.T) runtimeWriterManifest {
	t.Helper()
	path := filepath.Join(repoRootFromThisFile(t), "packages", "core", "src", "init-deposit", "runtime-writer-paths.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read writer manifest: %v", err)
	}
	var m runtimeWriterManifest
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse writer manifest: %v", err)
	}
	if len(m.WriterPaths) == 0 || m.UncoveredProbe == "" {
		t.Fatalf("writer manifest empty: %+v", m)
	}
	return m
}

func parseTsCanonicalGitignoreBaseline(t *testing.T) []string {
	t.Helper()
	path := filepath.Join(repoRootFromThisFile(t), "packages", "core", "src", "init-deposit", "gitignore.ts")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read gitignore.ts: %v", err)
	}
	src := string(data)
	start := strings.Index(src, "export const CANONICAL_GITIGNORE_BASELINE")
	if start < 0 {
		t.Fatal("CANONICAL_GITIGNORE_BASELINE not found")
	}
	rest := src[start:]
	open := strings.Index(rest, "[")
	close := strings.Index(rest, "];")
	if open < 0 || close < 0 || close <= open {
		t.Fatal("CANONICAL_GITIGNORE_BASELINE array bounds missing")
	}
	block := rest[open+1 : close]
	var lines []string
	for _, raw := range strings.Split(block, "\n") {
		trimmed := strings.TrimSpace(raw)
		if strings.Contains(trimmed, "DEFT_DIRECTIVE_DISABLE_GITIGNORE_LINE") {
			lines = append(lines, ".deft-directive-disable")
			continue
		}
		i := strings.Index(trimmed, `"`)
		if i < 0 {
			continue
		}
		j := strings.Index(trimmed[i+1:], `"`)
		if j < 0 {
			continue
		}
		lines = append(lines, trimmed[i+1:i+1+j])
	}
	if len(lines) == 0 {
		t.Fatal("parsed zero TS baseline lines")
	}
	return lines
}

func TestRuntimeWritersCoveredByGoBaseline(t *testing.T) {
	m := loadRuntimeWriterManifest(t)
	for _, path := range m.WriterPaths {
		if !ignoreSetCoversPath(canonicalGitignoreLines, path) {
			t.Errorf("Go canonicalGitignoreLines does not cover writer %q", path)
		}
	}
}

func TestUncoveredWriterProbeIsNotCovered(t *testing.T) {
	m := loadRuntimeWriterManifest(t)
	if ignoreSetCoversPath(canonicalGitignoreLines, m.UncoveredProbe) {
		t.Fatalf("probe path %q is covered - containment helper is vacuous", m.UncoveredProbe)
	}
	if ignoreSetCoversPath(parseTsCanonicalGitignoreBaseline(t), m.UncoveredProbe) {
		t.Fatalf("probe path %q is covered by the TS baseline", m.UncoveredProbe)
	}
}

func TestCanonicalGitignoreContainsTypeScriptBaseline(t *testing.T) {
	ts := parseTsCanonicalGitignoreBaseline(t)
	have := map[string]struct{}{}
	for _, line := range canonicalGitignoreLines {
		have[line] = struct{}{}
	}
	for _, line := range ts {
		if _, ok := have[line]; !ok {
			t.Errorf("TS baseline line %q missing from Go canonicalGitignoreLines", line)
		}
	}
}

func TestThrowawayConsumerSeededWithGoBaselineIgnoresRuntimeWriters(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	m := loadRuntimeWriterManifest(t)
	tmp := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = tmp
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}
	run("init")
	run("config", "user.email", "t@t.dev")
	run("config", "user.name", "t")
	body := strings.Join(canonicalGitignoreLines, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(tmp, ".gitignore"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	run("-c", "commit.gpgsign=false", "add", ".gitignore")
	run("-c", "commit.gpgsign=false", "commit", "-qm", "init")

	for _, rel := range m.WriterPaths {
		abs := filepath.Join(tmp, filepath.FromSlash(rel))
		if strings.HasSuffix(rel, ".json") {
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(abs, []byte("{}\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		} else {
			if err := os.MkdirAll(filepath.Join(abs, "probe"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(abs, "probe", "x.json"), []byte("{}\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	status := strings.TrimSpace(run("status", "--short"))
	if status != "" {
		t.Fatalf("expected clean throwaway consumer, git status --short:\n%s", status)
	}

	for _, rel := range m.WriterPaths {
		cmd := exec.Command("git", "check-ignore", "-v", "--", rel)
		cmd.Dir = tmp
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Errorf("git check-ignore %s: %v\n%s", rel, err, out)
		}
		if len(out) == 0 {
			t.Errorf("git check-ignore %s produced no rule", rel)
		}
	}
}
