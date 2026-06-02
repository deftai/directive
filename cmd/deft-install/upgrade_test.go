package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// makeCoreTarball writes a gzipped tar fixture mimicking the GitHub source
// tarball shape: every entry lives under a single wrapper directory named
// `<owner>-<repo>-<sha>`. files maps wrapper-relative paths to contents.
// Returns the tarball path (under t.TempDir(), auto-cleaned).
func makeCoreTarball(t *testing.T, wrapper string, files map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture.tar.gz")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create fixture tarball: %v", err)
	}
	gw := gzip.NewWriter(f)
	tw := tar.NewWriter(gw)

	// Wrapper directory entry first (matches the real tarball ordering).
	if err := tw.WriteHeader(&tar.Header{
		Name:     wrapper + "/",
		Typeflag: tar.TypeDir,
		Mode:     0o755,
	}); err != nil {
		t.Fatalf("write wrapper dir header: %v", err)
	}
	for rel, content := range files {
		hdr := &tar.Header{
			Name:     wrapper + "/" + rel,
			Typeflag: tar.TypeReg,
			Mode:     0o644,
			Size:     int64(len(content)),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("write header %s: %v", rel, err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatalf("write body %s: %v", rel, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close file: %v", err)
	}
	return path
}

func TestClassifyPayloadLayout(t *testing.T) {
	origGit := runGitCaptureFunc
	defer func() { runGitCaptureFunc = origGit }()

	t.Run("absent", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "nope", "core")
		if got := classifyPayloadLayout(missing); got != payloadLayoutAbsent {
			t.Errorf("got %q, want %q", got, payloadLayoutAbsent)
		}
	})

	t.Run("vendored when not a git work tree", func(t *testing.T) {
		dir := t.TempDir()
		runGitCaptureFunc = func(string, ...string) (string, error) {
			return "", fmt.Errorf("fatal: not a git repository")
		}
		if got := classifyPayloadLayout(dir); got != payloadLayoutVendored {
			t.Errorf("got %q, want %q", got, payloadLayoutVendored)
		}
	})

	t.Run("vendored when toplevel is a parent repo", func(t *testing.T) {
		dir := t.TempDir()
		runGitCaptureFunc = func(string, ...string) (string, error) {
			return filepath.Dir(dir), nil // parent, not dir itself
		}
		if got := classifyPayloadLayout(dir); got != payloadLayoutVendored {
			t.Errorf("got %q, want %q", got, payloadLayoutVendored)
		}
	})

	t.Run("clone when toplevel equals deftDir", func(t *testing.T) {
		dir := t.TempDir()
		runGitCaptureFunc = func(string, ...string) (string, error) {
			return dir, nil
		}
		if got := classifyPayloadLayout(dir); got != payloadLayoutClone {
			t.Errorf("got %q, want %q", got, payloadLayoutClone)
		}
	})
}

func TestExtractCoreTarball_ExcludesGitAndExtractsTree(t *testing.T) {
	tarball := makeCoreTarball(t, "deftai-directive-abc1234", map[string]string{
		"SKILL.md":          "skill body",
		"scripts/doctor.py": "print('hi')",
		".git/config":       "[core]",   // must be excluded
		".github/ci.yml":    "on: push", // must be excluded
	})
	dest := t.TempDir()
	root, err := extractCoreTarball(tarball, dest)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if filepath.Base(root) != "deftai-directive-abc1234" {
		t.Errorf("content root = %q, want wrapper dir", root)
	}
	if _, err := os.Stat(filepath.Join(root, "SKILL.md")); err != nil {
		t.Errorf("SKILL.md not extracted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "scripts", "doctor.py")); err != nil {
		t.Errorf("nested scripts/doctor.py not extracted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); !os.IsNotExist(err) {
		t.Errorf(".git was extracted but MUST be excluded (err=%v)", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".github")); !os.IsNotExist(err) {
		t.Errorf(".github was extracted but MUST be excluded (err=%v)", err)
	}
}

func TestShaFromContentRoot(t *testing.T) {
	cases := map[string]string{
		"deftai-directive-6136b66abcdef": "6136b66abcdef",
		"deftai-directive-deadbeef":      "deadbeef",
		"no-sha-here-xyz":                "", // xyz not hex
		"singletoken":                    "",
	}
	for in, want := range cases {
		if got := shaFromContentRoot(filepath.Join("/tmp", in)); got != want {
			t.Errorf("shaFromContentRoot(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSwapInCore_BackupAndReplace(t *testing.T) {
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
	// New content is in place; old content is gone from core.
	if data, err := os.ReadFile(filepath.Join(core, "NEW.txt")); err != nil || string(data) != "new" {
		t.Errorf("NEW.txt not swapped in: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(core, "OLD.txt")); !os.IsNotExist(err) {
		t.Errorf("OLD.txt should be gone from core after swap (err=%v)", err)
	}
	// Backup preserves the old content.
	if data, err := os.ReadFile(filepath.Join(backup, "OLD.txt")); err != nil || string(data) != "old" {
		t.Errorf("backup missing OLD.txt: data=%q err=%v", data, err)
	}
}

// TestUpdateDeft_VendoredUsesFileSwapNoGit proves the #1425 guardrail: a
// vendored payload is refreshed via the git-free file swap and NO mutating git
// command is ever issued through runCmdFunc.
func TestUpdateDeft_VendoredUsesFileSwapNoGit(t *testing.T) {
	origGit := runGitCaptureFunc
	origFetch := fetchCoreTarballFunc
	origRun := runCmdFunc
	defer func() {
		runGitCaptureFunc = origGit
		fetchCoreTarballFunc = origFetch
		runCmdFunc = origRun
	}()

	proj := t.TempDir()
	core := filepath.Join(proj, ".deft", "core")
	if err := os.MkdirAll(core, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(core, "OLD.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Classification: not a git work tree -> vendored.
	runGitCaptureFunc = func(string, ...string) (string, error) {
		return "", fmt.Errorf("not a repo")
	}
	// Tarball fixture stands in for the network download.
	tarball := makeCoreTarball(t, "deftai-directive-cafe1234", map[string]string{
		"marker.txt":  "new",
		".git/config": "[core]",
	})
	fetchCoreTarballFunc = func(ref string) (string, error) { return tarball, nil }

	// Guardrail probe: record any git command. There MUST be none.
	var gitCalls []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		if name == "git" {
			gitCalls = append(gitCalls, strings.Join(args, " "))
		}
		return nil
	}

	result := &WizardResult{ProjectName: "proj", ProjectDir: proj, DeftDir: core, Update: true}
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	outcome, err := UpdateDeft(w, result, "v9.9.9")
	if err != nil {
		t.Fatalf("UpdateDeft (vendored): %v", err)
	}

	if len(gitCalls) != 0 {
		t.Errorf("vendored refresh ran git commands (safety bug): %v", gitCalls)
	}
	if outcome.Layout != payloadLayoutVendored {
		t.Errorf("layout = %q, want vendored", outcome.Layout)
	}
	if outcome.Strategy != strategyFileSwap {
		t.Errorf("strategy = %q, want file-swap", outcome.Strategy)
	}
	if outcome.SHA != "cafe1234" {
		t.Errorf("SHA = %q, want cafe1234 (from tarball wrapper)", outcome.SHA)
	}
	if outcome.Tag != "v9.9.9" {
		t.Errorf("Tag = %q, want v9.9.9", outcome.Tag)
	}
	if data, err := os.ReadFile(filepath.Join(core, "marker.txt")); err != nil || string(data) != "new" {
		t.Errorf("refreshed core missing marker.txt: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(core, ".git")); !os.IsNotExist(err) {
		t.Errorf("refreshed core MUST NOT contain .git (err=%v)", err)
	}
	if outcome.Backup == "" {
		t.Error("expected a backup path on a successful swap")
	}
}

// TestUpdateDeft_VendoredNeverMutatesParentRepo is the gold-standard #1425
// regression test (AC2): a vendored .deft/core nested in a parent repo that
// has a COLLIDING ref must be refreshed without the installer running any
// mutating git command against the parent -- HEAD and tracked files stay put.
func TestUpdateDeft_VendoredNeverMutatesParentRepo(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available; skipping real-git regression test")
	}

	parent := t.TempDir()
	runGit := func(args ...string) string {
		t.Helper()
		cmd := exec.Command(gitPath, append([]string{"-C", parent}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}

	runGit("init", "-q")
	runGit("config", "user.email", "test@example.com")
	runGit("config", "user.name", "Test")
	runGit("config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(parent, "app.txt"), []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit("add", "app.txt")
	runGit("commit", "-q", "-m", "initial")
	// Colliding ref: the installer's upgrade target tag also exists in the
	// PARENT repo. Pre-fix, `git -C .deft/core checkout v9.9.9` would have
	// checked this out in the parent.
	runGit("tag", "v9.9.9")
	headBefore := runGit("rev-parse", "HEAD")
	branchBefore := runGit("rev-parse", "--abbrev-ref", "HEAD")

	// Vendored payload: .deft/core inside the parent work tree, no .git.
	core := filepath.Join(parent, ".deft", "core")
	if err := os.MkdirAll(core, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(core, "OLD.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Stub only the network fetch; classification uses REAL git.
	origFetch := fetchCoreTarballFunc
	origRun := runCmdFunc
	defer func() {
		fetchCoreTarballFunc = origFetch
		runCmdFunc = origRun
	}()
	tarball := makeCoreTarball(t, "deftai-directive-feed1234", map[string]string{
		"marker.txt": "new",
	})
	fetchCoreTarballFunc = func(ref string) (string, error) { return tarball, nil }
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		if name == "git" {
			t.Fatalf("installer ran a git command on a vendored payload: git %s", strings.Join(args, " "))
		}
		return nil
	}

	result := &WizardResult{ProjectName: "proj", ProjectDir: parent, DeftDir: core, Update: true}
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	outcome, err := UpdateDeft(w, result, "v9.9.9")
	if err != nil {
		t.Fatalf("UpdateDeft: %v", err)
	}
	if outcome.Layout != payloadLayoutVendored {
		t.Fatalf("expected vendored layout (real git), got %q", outcome.Layout)
	}

	// Parent repo must be untouched: HEAD unchanged, still on its branch,
	// tracked file unchanged.
	if got := runGit("rev-parse", "HEAD"); got != headBefore {
		t.Errorf("parent HEAD moved: %s -> %s", headBefore, got)
	}
	if got := runGit("rev-parse", "--abbrev-ref", "HEAD"); got != branchBefore {
		t.Errorf("parent branch changed (detached HEAD?): %s -> %s", branchBefore, got)
	}
	if data, err := os.ReadFile(filepath.Join(parent, "app.txt")); err != nil || string(data) != "original" {
		t.Errorf("parent tracked file mutated: data=%q err=%v", data, err)
	}
	// And the refresh actually happened.
	if data, err := os.ReadFile(filepath.Join(core, "marker.txt")); err != nil || string(data) != "new" {
		t.Errorf("vendored core not refreshed: data=%q err=%v", data, err)
	}
}

// TestUpdateDeft_AbsentReportsCloneLayout pins the Greptile #1426 finding: an
// --upgrade against a missing payload performs a fresh clone and MUST report
// the POST-operation layout (clone), not the pre-clone "absent" state, so
// --json consumers inspecting payload_layout see the resulting state.
func TestUpdateDeft_AbsentReportsCloneLayout(t *testing.T) {
	origRun := runCmdFunc
	origGit := runGitCaptureFunc
	defer func() {
		runCmdFunc = origRun
		runGitCaptureFunc = origGit
	}()

	tmp := t.TempDir()
	proj := filepath.Join(tmp, "proj")
	core := filepath.Join(proj, ".deft", "core") // intentionally absent

	// Simulate `git clone` materialising the payload dir.
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		if name == "git" && len(args) > 0 && args[0] == "clone" {
			os.MkdirAll(args[len(args)-1], 0o755)
		}
		return nil
	}
	runGitCaptureFunc = func(string, ...string) (string, error) { return "abc1234", nil }

	result := &WizardResult{ProjectName: "proj", ProjectDir: proj, DeftDir: core, Update: true}
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	outcome, err := UpdateDeft(w, result, "v1.2.3")
	if err != nil {
		t.Fatalf("UpdateDeft (absent): %v", err)
	}
	if outcome.Layout != payloadLayoutClone {
		t.Errorf("absent->clone must report layout=clone, got %q", outcome.Layout)
	}
	if outcome.Strategy != strategyClone {
		t.Errorf("strategy = %q, want clone", outcome.Strategy)
	}
}
