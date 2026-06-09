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
		"SKILL.md":                                              "skill body",
		"scripts/doctor.py":                                     "print('hi')",
		"scripts/verify_encoding.py":                            "MOJIBAKE_PATTERNS = {}",
		"vbrief/schemas/vbrief-core.schema.json":                "{}",
		"history/archive/2026-03-20/tasks.vbrief.json":          "{}",
		"vbrief/completed/2026-05-01-798-detect.vbrief.json":    "{}",
		"vbrief/cancelled/2026-05-01-old-cancelled.vbrief.json": "{}",
		".git/config":                                           "[core]",   // must be excluded
		".github/ci.yml":                                        "on: push", // must be excluded
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
	if _, err := os.Stat(filepath.Join(root, "scripts", "verify_encoding.py")); err != nil {
		t.Errorf("runtime verifier script not extracted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "vbrief", "schemas", "vbrief-core.schema.json")); err != nil {
		t.Errorf("runtime vBRIEF schema not extracted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); !os.IsNotExist(err) {
		t.Errorf(".git was extracted but MUST be excluded (err=%v)", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".github")); !os.IsNotExist(err) {
		t.Errorf(".github was extracted but MUST be excluded (err=%v)", err)
	}
	excludedPaths := []string{
		filepath.Join(root, "history", "archive", "2026-03-20", "tasks.vbrief.json"),
		filepath.Join(root, "vbrief", "completed", "2026-05-01-798-detect.vbrief.json"),
		filepath.Join(root, "vbrief", "cancelled", "2026-05-01-old-cancelled.vbrief.json"),
	}
	for _, path := range excludedPaths {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s was extracted but MUST be excluded (err=%v)", path, err)
		}
	}
}

// makeCoreTarballWithPaxHeader writes a gzipped tar fixture whose FIRST entry
// is a `pax_global_header` global-PAX record (exactly how GitHub source
// tarballs lead off), followed by the usual single wrapper directory and its
// files. Mirrors makeCoreTarball but exercises the #1433 path where the leading
// PAX header must not be mistaken for the content root.
func makeCoreTarballWithPaxHeader(t *testing.T, wrapper string, files map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture-pax.tar.gz")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create fixture tarball: %v", err)
	}
	gw := gzip.NewWriter(f)
	tw := tar.NewWriter(gw)

	// Leading global PAX header, as emitted by GitHub's source tarballs.
	if err := tw.WriteHeader(&tar.Header{
		Name:       "pax_global_header",
		Typeflag:   tar.TypeXGlobalHeader,
		Format:     tar.FormatPAX,
		PAXRecords: map[string]string{"comment": "0123456789abcdef0123456789abcdef01234567"},
	}); err != nil {
		t.Fatalf("write pax global header: %v", err)
	}

	// Wrapper directory entry, then the wrapped files.
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

// TestExtractCoreTarball_SkipsPaxGlobalHeader is the #1433 regression: GitHub
// source tarballs lead with a `pax_global_header` global-PAX record. Before the
// fix the extractor captured that record's name as the content root, so every
// vendored refresh aborted with `tarball content root "pax_global_header"
// missing after extract`. The content root must instead resolve to the wrapper
// directory and the wrapped files must extract.
func TestExtractCoreTarball_SkipsPaxGlobalHeader(t *testing.T) {
	tarball := makeCoreTarballWithPaxHeader(t, "deftai-directive-abc1234", map[string]string{
		"SKILL.md":          "skill body",
		"scripts/doctor.py": "print('hi')",
	})
	dest := t.TempDir()
	root, err := extractCoreTarball(tarball, dest)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if filepath.Base(root) != "deftai-directive-abc1234" {
		t.Errorf("content root = %q, want wrapper dir (must NOT be pax_global_header)", root)
	}
	if _, err := os.Stat(filepath.Join(root, "SKILL.md")); err != nil {
		t.Errorf("SKILL.md not extracted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "scripts", "doctor.py")); err != nil {
		t.Errorf("nested scripts/doctor.py not extracted: %v", err)
	}
	// The PAX header MUST NOT have been materialised as a filesystem path.
	if _, err := os.Stat(filepath.Join(dest, "pax_global_header")); !os.IsNotExist(err) {
		t.Errorf("pax_global_header was materialised but MUST be skipped (err=%v)", err)
	}
}

// TestExtractCoreTarball_RejectsPathTraversal is the go/zipslip (code-scanning
// alert #6) regression: a tar entry whose name contains a ".." path element
// MUST be rejected before any filesystem write, and nothing may escape the
// destination directory. Exercises the CodeQL-recognized strings.Contains(name,
// "..") barrier in extractCoreTarball.
func TestExtractCoreTarball_RejectsPathTraversal(t *testing.T) {
	// makeCoreTarball prefixes the wrapper dir, so "../evil.txt" becomes the
	// entry "deftai-directive-abc1234/../evil.txt" -- a ".." element.
	tarball := makeCoreTarball(t, "deftai-directive-abc1234", map[string]string{
		"../evil.txt": "pwned",
	})
	dest := t.TempDir()
	if _, err := extractCoreTarball(tarball, dest); err == nil {
		t.Fatal("expected extractCoreTarball to reject a '..' traversal entry, got nil error")
	} else if !strings.Contains(err.Error(), "..") {
		t.Errorf("error should name the rejected '..' entry, got: %v", err)
	}
	// The traversal target MUST NOT have been written outside the destination.
	if _, statErr := os.Stat(filepath.Join(filepath.Dir(dest), "evil.txt")); !os.IsNotExist(statErr) {
		t.Errorf("traversal entry escaped the destination dir (stat err=%v)", statErr)
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

// TestUpdateDeft_AbsentVendorsFreshCopy pins the #1428 behavior: an --upgrade
// against a MISSING payload performs a git-free vendor install (not a clone)
// and reports the post-operation vendored layout + vendor strategy.
func TestUpdateDeft_AbsentVendorsFreshCopy(t *testing.T) {
	origRun := runCmdFunc
	origGit := runGitCaptureFunc
	origFetch := fetchCoreTarballFunc
	defer func() {
		runCmdFunc = origRun
		runGitCaptureFunc = origGit
		fetchCoreTarballFunc = origFetch
	}()

	tmp := t.TempDir()
	proj := filepath.Join(tmp, "proj")
	core := filepath.Join(proj, ".deft", "core") // intentionally absent

	tarball := makeCoreTarball(t, "deftai-directive-abc1234", map[string]string{"marker.txt": "new"})
	fetchCoreTarballFunc = func(string) (string, error) { return tarball, nil }

	// Guardrail: there must be NO git command on a vendored fresh install.
	var gitCalls []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		if name == "git" {
			gitCalls = append(gitCalls, strings.Join(args, " "))
		}
		return nil
	}
	runGitCaptureFunc = func(string, ...string) (string, error) { return "", fmt.Errorf("not a repo") }

	result := &WizardResult{ProjectName: "proj", ProjectDir: proj, DeftDir: core, Update: true}
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	outcome, err := UpdateDeft(w, result, "v1.2.3")
	if err != nil {
		t.Fatalf("UpdateDeft (absent): %v", err)
	}
	if len(gitCalls) != 0 {
		t.Errorf("vendored fresh install ran git commands (safety bug): %v", gitCalls)
	}
	if outcome.Layout != payloadLayoutVendored {
		t.Errorf("absent->vendor must report layout=vendored, got %q", outcome.Layout)
	}
	if outcome.Strategy != strategyVendor {
		t.Errorf("strategy = %q, want %q", outcome.Strategy, strategyVendor)
	}
	if data, err := os.ReadFile(filepath.Join(core, "marker.txt")); err != nil || string(data) != "new" {
		t.Errorf("vendored core missing marker.txt: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(core, ".git")); !os.IsNotExist(err) {
		t.Errorf("vendored core MUST NOT contain .git (err=%v)", err)
	}
}

// TestVendorDeft_FreshInstallNoGit proves the headline #1429 behavior: a fresh
// install vendors the release tarball into a greenfield .deft/core/ WITHOUT any
// git command and WITHOUT leaving .git, and re-stamps the framework source SHA
// recovered from the tarball wrapper.
func TestVendorDeft_FreshInstallNoGit(t *testing.T) {
	origFetch := fetchCoreTarballFunc
	origRun := runCmdFunc
	defer func() {
		fetchCoreTarballFunc = origFetch
		runCmdFunc = origRun
	}()

	tmp := t.TempDir()
	proj := filepath.Join(tmp, "proj")
	core := filepath.Join(proj, ".deft", "core") // greenfield: absent

	tarball := makeCoreTarball(t, "deftai-directive-abc1234", map[string]string{
		"SKILL.md":    "skill body",
		".git/config": "[core]", // must be excluded by extraction
	})
	fetchCoreTarballFunc = func(string) (string, error) { return tarball, nil }

	var gitCalls []string
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		if name == "git" {
			gitCalls = append(gitCalls, strings.Join(args, " "))
		}
		return nil
	}

	result := &WizardResult{ProjectName: "proj", ProjectDir: proj, DeftDir: core}
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	outcome, err := VendorDeft(w, result, "v1.2.3")
	if err != nil {
		t.Fatalf("VendorDeft: %v", err)
	}
	if len(gitCalls) != 0 {
		t.Errorf("fresh vendor ran git commands (safety bug): %v", gitCalls)
	}
	if outcome.Layout != payloadLayoutVendored || outcome.Strategy != strategyVendor {
		t.Errorf("outcome layout/strategy = %q/%q, want vendored/%q", outcome.Layout, outcome.Strategy, strategyVendor)
	}
	if outcome.SHA != "abc1234" {
		t.Errorf("SHA = %q, want abc1234 (from tarball wrapper)", outcome.SHA)
	}
	if outcome.Tag != "v1.2.3" {
		t.Errorf("Tag = %q, want v1.2.3", outcome.Tag)
	}
	if outcome.Backup != "" {
		t.Errorf("greenfield vendor should not back up (no prior payload), got %q", outcome.Backup)
	}
	if data, err := os.ReadFile(filepath.Join(core, "SKILL.md")); err != nil || string(data) != "skill body" {
		t.Errorf("vendored core missing SKILL.md: data=%q err=%v", data, err)
	}
	// Critical: a vendored payload carries NO .git (the #1428/#1425 invariant).
	if _, err := os.Stat(filepath.Join(core, ".git")); !os.IsNotExist(err) {
		t.Errorf("vendored core MUST NOT contain .git (err=%v)", err)
	}
}

// TestUpdateDeft_CloneTagDetachedHeadMigratesWithoutGit is the gold-standard
// #1428 regression: a REAL git clone checked out at a tag (detached HEAD) -- the
// exact state whose `git pull` failed before this change -- is migrated to a
// vendored payload via file swap, with NO git command run and no .git left.
func TestUpdateDeft_CloneTagDetachedHeadMigratesWithoutGit(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available; skipping real-git migration test")
	}

	tmp := t.TempDir()
	proj := filepath.Join(tmp, "proj")
	core := filepath.Join(proj, ".deft", "core")
	if err := os.MkdirAll(core, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command(gitPath, append([]string{"-C", core}, args...)...)
		if out, gerr := cmd.CombinedOutput(); gerr != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), gerr, out)
		}
	}
	// Build a genuine clone-layout payload: core is itself a git work tree
	// (toplevel == core) checked out at a TAG -> detached HEAD.
	runGit("init", "-q")
	runGit("config", "user.email", "test@example.com")
	runGit("config", "user.name", "Test")
	runGit("config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(core, "OLD.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit("add", "-A")
	runGit("commit", "-q", "-m", "seed")
	runGit("tag", "v9.9.9")
	runGit("checkout", "-q", "v9.9.9") // detached HEAD

	origFetch := fetchCoreTarballFunc
	origRun := runCmdFunc
	defer func() {
		fetchCoreTarballFunc = origFetch
		runCmdFunc = origRun
	}()
	tarball := makeCoreTarball(t, "deftai-directive-feed1234", map[string]string{"marker.txt": "new"})
	fetchCoreTarballFunc = func(string) (string, error) { return tarball, nil }
	runCmdFunc = func(out io.Writer, name string, args ...string) error {
		if name == "git" {
			t.Fatalf("migration ran a git command (safety/regression): git %s", strings.Join(args, " "))
		}
		return nil
	}

	result := &WizardResult{ProjectName: "proj", ProjectDir: proj, DeftDir: core, Update: true}
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	outcome, err := UpdateDeft(w, result, "v9.9.9")
	if err != nil {
		t.Fatalf("UpdateDeft (detached-HEAD clone migration): %v", err)
	}
	if outcome.Layout != payloadLayoutVendored {
		t.Fatalf("expected vendored layout post-migration, got %q", outcome.Layout)
	}
	if outcome.Strategy != strategyMigrate {
		t.Errorf("strategy = %q, want %q", outcome.Strategy, strategyMigrate)
	}
	if data, err := os.ReadFile(filepath.Join(core, "marker.txt")); err != nil || string(data) != "new" {
		t.Errorf("migrated core missing marker.txt: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(core, ".git")); !os.IsNotExist(err) {
		t.Errorf("migrated core MUST NOT contain .git (err=%v)", err)
	}
}

// TestBareVersionFromTag pins the tag -> bare-derivative mapping used to keep
// vbrief/.deft-version in agreement with the YAML manifest tag (#1437). Mirrors
// the doctor's _manifest_tag_to_version lstrip("v").
func TestBareVersionFromTag(t *testing.T) {
	cases := map[string]string{
		"v0.39.3":     "0.39.3",
		"0.39.3":      "0.39.3",
		"v1.2.3-rc.1": "1.2.3-rc.1",
		"  v0.40.0  ": "0.40.0",
		"":            "",
	}
	for in, want := range cases {
		if got := bareVersionFromTag(in); got != want {
			t.Errorf("bareVersionFromTag(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestRegenerateBareVersionMarker covers the #1437 derivative writer directly:
// it writes the BARE semver (no leading v) plus a trailing newline at
// vbrief/.deft-version, creates the parent vbrief/ dir when absent, and is a
// no-op for an empty (non-semver) tag.
func TestRegenerateBareVersionMarker(t *testing.T) {
	t.Run("writes bare semver and creates vbrief dir", func(t *testing.T) {
		proj := t.TempDir()
		path, err := regenerateBareVersionMarker(proj, "v0.39.3")
		if err != nil {
			t.Fatalf("regenerateBareVersionMarker: %v", err)
		}
		want := filepath.Join(proj, "vbrief", ".deft-version")
		if path != want {
			t.Errorf("path = %q, want %q", path, want)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "0.39.3\n" {
			t.Errorf("content = %q, want %q (bare semver + trailing newline)", string(data), "0.39.3\n")
		}
	})
	t.Run("empty tag is a no-op", func(t *testing.T) {
		proj := t.TempDir()
		path, err := regenerateBareVersionMarker(proj, "")
		if err != nil {
			t.Fatalf("regenerateBareVersionMarker: %v", err)
		}
		if path != "" {
			t.Errorf("expected empty path for an empty tag, got %q", path)
		}
		if _, statErr := os.Stat(filepath.Join(proj, "vbrief", ".deft-version")); !os.IsNotExist(statErr) {
			t.Errorf("empty tag must not create .deft-version (err=%v)", statErr)
		}
	})
}

// TestRefreshVendoredCore_RegeneratesBareVersionMarker is the #1437 Bug B
// regression: the vendored file-swap upgrade refreshes .deft/core/** AND now
// regenerates the bare vbrief/.deft-version derivative from the resolved tag, so
// a stale derivative left by an earlier rail (here "0.0.0-dev") is brought into
// agreement with the manifest the installer stamps. Drives the REAL UpdateDeft
// vendored path against a real-shaped (pax-header) tarball, hermetically.
func TestRefreshVendoredCore_RegeneratesBareVersionMarker(t *testing.T) {
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
	// Stale bare derivative left by an earlier rail (the #1437 observed state).
	vbriefDir := filepath.Join(proj, "vbrief")
	if err := os.MkdirAll(vbriefDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vbriefDir, ".deft-version"), []byte("0.0.0-dev\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Classify as vendored (no git work tree); stand in a real-shaped tarball.
	runGitCaptureFunc = func(string, ...string) (string, error) { return "", fmt.Errorf("not a repo") }
	tarball := makeCoreTarballWithPaxHeader(t, "deftai-directive-cafef00d1234", map[string]string{"main.md": "framework"})
	fetchCoreTarballFunc = func(string) (string, error) { return tarball, nil }

	result := &WizardResult{ProjectName: "proj", ProjectDir: proj, DeftDir: core, Update: true}
	w := NewWizard(strings.NewReader(""), &bytes.Buffer{}, false)
	outcome, err := UpdateDeft(w, result, "v0.39.3")
	if err != nil {
		t.Fatalf("UpdateDeft (vendored refresh): %v", err)
	}
	if outcome.Strategy != strategyFileSwap {
		t.Fatalf("strategy = %q, want %q", outcome.Strategy, strategyFileSwap)
	}
	got, err := os.ReadFile(filepath.Join(vbriefDir, ".deft-version"))
	if err != nil {
		t.Fatalf("vbrief/.deft-version missing after refresh: %v", err)
	}
	if strings.TrimSpace(string(got)) != "0.39.3" {
		t.Errorf("vbrief/.deft-version = %q, want %q (regenerated from the resolved tag)", strings.TrimSpace(string(got)), "0.39.3")
	}
}
