package main

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// newGithooksWizard returns a Wizard whose output is discarded -- the hook
// tests assert on filesystem + git state, not on printed prose.
func newGithooksWizard() *Wizard {
	return NewWizard(strings.NewReader(""), io.Discard, false)
}

// seedPayloadHooks writes minimal stand-in hook scripts into
// <deftDir>/.githooks/{pre-commit,pre-push} so WriteConsumerGitHooks has a
// source to copy from. Returns the two bodies for byte-for-byte comparison.
func seedPayloadHooks(t *testing.T, deftDir string) (string, string) {
	t.Helper()
	hooksDir := filepath.Join(deftDir, ".githooks")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		t.Fatal(err)
	}
	preCommit := "#!/usr/bin/env sh\n# stand-in pre-commit\nexit 0\n"
	prePush := "#!/usr/bin/env sh\n# stand-in pre-push\nexit 0\n"
	if err := os.WriteFile(filepath.Join(hooksDir, "pre-commit"), []byte(preCommit), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hooksDir, "pre-push"), []byte(prePush), 0o755); err != nil {
		t.Fatal(err)
	}
	return preCommit, prePush
}

// TestWriteConsumerGitHooks_DepositsAndConfigures pins #1463 Layers 1+2: the
// installer copies the payload hooks to the consumer root .githooks/ and points
// core.hooksPath at it. git is stubbed so the test is deterministic and never
// shells out.
func TestWriteConsumerGitHooks_DepositsAndConfigures(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	origGet := gitConfigGetHooksPathFunc
	origSet := setGitHooksPathFunc
	origIdx := gitIndexChmodExecFunc
	defer func() {
		gitPorcelainStatusFunc = origStatus
		gitConfigGetHooksPathFunc = origGet
		setGitHooksPathFunc = origSet
		gitIndexChmodExecFunc = origIdx
	}()

	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")
	wantPreCommit, wantPrePush := seedPayloadHooks(t, deftDir)

	gitPorcelainStatusFunc = func(string) ([]string, bool, error) { return nil, true, nil }
	gitConfigGetHooksPathFunc = func(string) (string, error) { return "", nil } // unset
	var gotDir, gotVal string
	setGitHooksPathFunc = func(dir, value string) error {
		gotDir, gotVal = dir, value
		return nil
	}
	var gotIdxPaths []string
	gitIndexChmodExecFunc = func(_ string, relPaths ...string) error {
		gotIdxPaths = relPaths
		return nil
	}

	changed, err := WriteConsumerGitHooks(newGithooksWizard(), proj, deftDir)
	if err != nil {
		t.Fatalf("WriteConsumerGitHooks: %v", err)
	}
	if !changed {
		t.Error("expected changed=true on a fresh wire")
	}

	// The tracked hook deposit MUST be git-index-recorded with the exec bit so
	// it is mode 100755 cross-platform (#1477).
	wantIdx := []string{".githooks/pre-commit", ".githooks/pre-push"}
	if strings.Join(gotIdxPaths, ",") != strings.Join(wantIdx, ",") {
		t.Errorf("git-index chmod called with %v, want %v", gotIdxPaths, wantIdx)
	}

	// Hooks copied byte-for-byte to the consumer root .githooks/.
	gotPC, err := os.ReadFile(filepath.Join(proj, ".githooks", "pre-commit"))
	if err != nil {
		t.Fatalf("read deposited pre-commit: %v", err)
	}
	if string(gotPC) != wantPreCommit {
		t.Errorf("pre-commit body mismatch:\n got %q\nwant %q", gotPC, wantPreCommit)
	}
	gotPP, err := os.ReadFile(filepath.Join(proj, ".githooks", "pre-push"))
	if err != nil {
		t.Fatalf("read deposited pre-push: %v", err)
	}
	if string(gotPP) != wantPrePush {
		t.Errorf("pre-push body mismatch:\n got %q\nwant %q", gotPP, wantPrePush)
	}

	// core.hooksPath set to the consumer-root-relative dir name.
	if gotDir != proj {
		t.Errorf("core.hooksPath set on dir %q, want %q", gotDir, proj)
	}
	if gotVal != consumerHooksDirName {
		t.Errorf("core.hooksPath = %q, want %q", gotVal, consumerHooksDirName)
	}
}

// TestWriteConsumerGitHooks_Idempotent: a second run over an already-wired
// project is a clean no-op -- no hook rewrite, and core.hooksPath is not
// re-set because it already equals the target.
func TestWriteConsumerGitHooks_Idempotent(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	origGet := gitConfigGetHooksPathFunc
	origSet := setGitHooksPathFunc
	origIdx := gitIndexChmodExecFunc
	defer func() {
		gitPorcelainStatusFunc = origStatus
		gitConfigGetHooksPathFunc = origGet
		setGitHooksPathFunc = origSet
		gitIndexChmodExecFunc = origIdx
	}()

	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")
	seedPayloadHooks(t, deftDir)

	gitPorcelainStatusFunc = func(string) ([]string, bool, error) { return nil, true, nil }
	// Simulate "already configured" so the idempotency branch is exercised.
	gitConfigGetHooksPathFunc = func(string) (string, error) { return consumerHooksDirName, nil }
	setCalls := 0
	setGitHooksPathFunc = func(string, string) error { setCalls++; return nil }
	gitIndexChmodExecFunc = func(string, ...string) error { return nil }

	// First wire deposits the hooks (config already set, so config is skipped).
	if _, err := WriteConsumerGitHooks(newGithooksWizard(), proj, deftDir); err != nil {
		t.Fatalf("first wire: %v", err)
	}
	// Second wire: hooks already byte-for-byte present AND config already set.
	changed, err := WriteConsumerGitHooks(newGithooksWizard(), proj, deftDir)
	if err != nil {
		t.Fatalf("second wire: %v", err)
	}
	if changed {
		t.Error("expected changed=false on a fully-wired re-run")
	}
	if setCalls != 0 {
		t.Errorf("core.hooksPath must not be re-set when already correct; got %d set calls", setCalls)
	}
}

// TestWriteConsumerGitHooks_NonGitDepositsButSkipsConfig: a non-git project
// still gets the hooks on disk (so a later `git init` + `task setup` finishes
// the wiring) but core.hooksPath is never written.
func TestWriteConsumerGitHooks_NonGitDepositsButSkipsConfig(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	origSet := setGitHooksPathFunc
	defer func() {
		gitPorcelainStatusFunc = origStatus
		setGitHooksPathFunc = origSet
	}()

	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")
	seedPayloadHooks(t, deftDir)

	gitPorcelainStatusFunc = func(string) ([]string, bool, error) { return nil, false, nil } // not a repo
	setCalled := false
	setGitHooksPathFunc = func(string, string) error { setCalled = true; return nil }

	changed, err := WriteConsumerGitHooks(newGithooksWizard(), proj, deftDir)
	if err != nil {
		t.Fatalf("WriteConsumerGitHooks: %v", err)
	}
	if !changed {
		t.Error("expected changed=true (hooks deposited) even in a non-git project")
	}
	if setCalled {
		t.Error("core.hooksPath must NOT be set in a non-git project")
	}
	if !pathExists(filepath.Join(proj, ".githooks", "pre-commit")) {
		t.Error("pre-commit hook should be deposited even in a non-git project")
	}
}

// TestWriteConsumerGitHooks_MissingSourceSkips: when the framework payload ships
// no .githooks/ there is nothing to copy -- skip cleanly, never error.
func TestWriteConsumerGitHooks_MissingSourceSkips(t *testing.T) {
	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// No .githooks/ under deftDir.
	changed, err := WriteConsumerGitHooks(newGithooksWizard(), proj, deftDir)
	if err != nil {
		t.Fatalf("missing source must not error: %v", err)
	}
	if changed {
		t.Error("expected changed=false when the payload ships no .githooks/")
	}
	if pathExists(filepath.Join(proj, ".githooks")) {
		t.Error("no consumer .githooks/ should be created when the source is absent")
	}
}

// TestWriteConsumerGitHooks_DepositsExecutableMode pins #1477: the deposited
// consumer hooks are written executable (the mode carries the 0o111 bits) so
// git runs them on POSIX hosts. POSIX-only -- Windows has no executable bit.
func TestWriteConsumerGitHooks_DepositsExecutableMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable-bit semantics are POSIX-only")
	}
	origStatus := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = origStatus }()
	// Non-git project: hooks are still deposited on disk; the git-index path is
	// skipped so no git stub is needed.
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) { return nil, false, nil }

	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")
	seedPayloadHooks(t, deftDir)

	if _, err := WriteConsumerGitHooks(newGithooksWizard(), proj, deftDir); err != nil {
		t.Fatalf("WriteConsumerGitHooks: %v", err)
	}
	for _, name := range []string{"pre-commit", "pre-push"} {
		info, err := os.Stat(filepath.Join(proj, ".githooks", name))
		if err != nil {
			t.Fatalf("stat deposited %s: %v", name, err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Errorf("deposited hook %s is not executable (mode %o)", name, info.Mode().Perm())
		}
	}
}

// TestWriteConsumerGitHooks_HealsNonExecutableExistingHook pins #1477: when an
// older installer left a hook non-executable (0o644), a re-run heals the exec
// bit even though the content is byte-identical -- the WRITE is skipped but the
// chmod is not. POSIX-only.
func TestWriteConsumerGitHooks_HealsNonExecutableExistingHook(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable-bit semantics are POSIX-only")
	}
	origStatus := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = origStatus }()
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) { return nil, false, nil }

	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")
	preCommit, prePush := seedPayloadHooks(t, deftDir)

	// Pre-existing consumer hooks: identical content, but NON-executable (the
	// #1477 bug state from an older installer or a Windows-origin commit).
	dstDir := filepath.Join(proj, ".githooks")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dstDir, "pre-commit"), []byte(preCommit), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dstDir, "pre-push"), []byte(prePush), 0o644); err != nil {
		t.Fatal(err)
	}

	changed, err := WriteConsumerGitHooks(newGithooksWizard(), proj, deftDir)
	if err != nil {
		t.Fatalf("WriteConsumerGitHooks: %v", err)
	}
	// A heal-only run (content already current, exec bit repaired) must report
	// changed=true so the consumer sees confirmation rather than a no-op (#1477).
	if !changed {
		t.Error("expected changed=true when a non-executable hook is healed")
	}
	for _, name := range []string{"pre-commit", "pre-push"} {
		info, err := os.Stat(filepath.Join(dstDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Errorf("byte-identical non-executable hook %s was not healed to executable (mode %o)", name, info.Mode().Perm())
		}
	}
}

// TestFrameworkStagePaths_IncludesGithooks pins that the deposited .githooks/
// is part of the installer-managed stage set (#1463): the deft-core-guard
// exempts it and the scoped commit stages it with the framework deposit.
func TestFrameworkStagePaths_IncludesGithooks(t *testing.T) {
	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")
	if err := os.MkdirAll(deftDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(proj, ".githooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proj, ".githooks", "pre-commit"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := frameworkStagePaths(proj, deftDir)
	found := false
	for _, p := range got {
		if p == ".githooks" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf(".githooks must be in the framework stage set; got %v", got)
	}

	// And the guard must treat .githooks/ paths as installer-managed (not app),
	// so a framework-deposit PR carrying them alongside .deft/core/** passes.
	_, managed, app := classifyChangedPaths([]string{".deft/core/VERSION", ".githooks/pre-commit", ".githooks/pre-push"})
	if len(app) != 0 {
		t.Errorf(".githooks/ must not classify as app; got app=%v", app)
	}
	if len(managed) != 2 {
		t.Errorf("expected both .githooks/ paths installer-managed; got managed=%v", managed)
	}
}

// TestWriteConsumerGitHooks_VendoredCommitBlocked_RealGit is the headline #1463
// regression: in a VENDORED consumer layout (framework at .deft/core/), the
// installer-wired hooks must (a) resolve their helper scripts under
// .deft/core/scripts/ and (b) block a commit to the default branch, while
// honoring the documented DEFT_ALLOW_DEFAULT_BRANCH_COMMIT opt-out. It exercises
// the REAL hook scripts end to end via `git commit`, so it is skipped when git
// or a python interpreter is unavailable.
func TestWriteConsumerGitHooks_VendoredCommitBlocked_RealGit(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available; skipping vendored real-git hook test")
	}
	pyPath := lookPython(t)
	if pyPath == "" {
		t.Skip("no python interpreter on PATH; skipping vendored real-git hook test")
	}

	repoRoot := repoRootDir(t)
	proj := t.TempDir()
	deftDir := filepath.Join(proj, ".deft", "core")

	// Build the vendored payload: copy the real (LF-normalized) hooks into
	// .deft/core/.githooks/ and the real gate scripts into .deft/core/scripts/.
	copyHookLF(t, filepath.Join(repoRoot, ".githooks", "pre-commit"), filepath.Join(deftDir, ".githooks", "pre-commit"))
	copyHookLF(t, filepath.Join(repoRoot, ".githooks", "pre-push"), filepath.Join(deftDir, ".githooks", "pre-push"))
	for _, s := range []string{"preflight_branch.py", "policy.py", "verify_encoding.py", "preflight_gh.py"} {
		copyFileRaw(t, filepath.Join(repoRoot, "scripts", s), filepath.Join(deftDir, "scripts", s))
	}

	// A consumer PROJECT-DEFINITION that does NOT allow direct commits to the
	// default branch -- so preflight_branch.py blocks (exit 1) by policy.
	writeFile(t, filepath.Join(proj, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
		`{"vBRIEFInfo":{"version":"0.6"},"plan":{"title":"T","status":"running","items":[],"policy":{"allowDirectCommitsToMaster":false}}}`)

	// Real git repo on the default branch `master`.
	runGitIn(t, gitPath, proj, "init", "-b", "master")
	runGitIn(t, gitPath, proj, "config", "user.email", "test@example.com")
	runGitIn(t, gitPath, proj, "config", "user.name", "Test")
	runGitIn(t, gitPath, proj, "config", "commit.gpgsign", "false")

	// Wire the hooks via the REAL installer routine (real git config).
	if _, err := WriteConsumerGitHooks(newGithooksWizard(), proj, deftDir); err != nil {
		t.Fatalf("WriteConsumerGitHooks: %v", err)
	}
	// core.hooksPath must now point at the consumer-root hooks dir.
	if got := strings.TrimSpace(gitOut(t, gitPath, proj, "config", "--get", "core.hooksPath")); got != consumerHooksDirName {
		t.Fatalf("core.hooksPath = %q, want %q", got, consumerHooksDirName)
	}

	// Stage ONLY a clean ASCII file so the encoding gate (step 2) has nothing
	// to flag -- the branch gate (step 1) is what we are exercising here.
	writeFile(t, filepath.Join(proj, "app.txt"), "hello\n")
	runGitIn(t, gitPath, proj, "add", "app.txt")

	env := append(os.Environ(), "DEFT_PYTHON="+pyPath)

	// (a) A `git commit` on master with policy=false MUST be blocked by the wired
	// hook, proving the helper resolved under .deft/core/scripts/ in the vendored layout.
	out, err := gitCommitWithEnv(gitPath, proj, env, "should be blocked")
	if err == nil {
		t.Fatalf("expected the pre-commit hook to BLOCK a master commit in the vendored layout; commit succeeded.\nHook output:\n%s", out)
	}
	if !strings.Contains(out, "branch-protection") {
		t.Fatalf("block output should come from preflight_branch.py (resolved under .deft/core/scripts/); got:\n%s", out)
	}

	// (b) The documented opt-out env-var lets the same commit through, proving
	// the gate honors DEFT_ALLOW_DEFAULT_BRANCH_COMMIT end to end.
	optOutEnv := append(env, "DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1")
	if out, err := gitCommitWithEnv(gitPath, proj, optOutEnv, "opt-out commit"); err != nil {
		t.Fatalf("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 must allow the commit; got error: %v\n%s", err, out)
	}
}

// ---------------------------------------------------------------------------
// real-git test helpers
// ---------------------------------------------------------------------------

// lookPython returns a path to a WORKING python interpreter, or "" when none
// is usable. It validates each candidate by actually running it (so the Windows
// Store "App execution alias" stub -- which prints "Python was not found" and
// exits non-zero -- is rejected), and falls back to the Windows `py -3`
// launcher to resolve the real interpreter path when PATH only exposes the stub.
func lookPython(t *testing.T) string {
	t.Helper()
	validate := func(p string) bool {
		out, err := exec.Command(p, "-c", "import sys; sys.stdout.write('ok')").Output()
		if err != nil {
			return false // interpreter not runnable (e.g. Windows Store alias stub)
		}
		return strings.Contains(string(out), "ok")
	}
	for _, name := range []string{"python3", "python"} {
		p, err := exec.LookPath(name)
		if err != nil {
			continue // not on PATH; try the next candidate
		}
		if validate(p) {
			return p
		}
	}
	// Windows py launcher -> resolve the real interpreter path behind it.
	pyl, err := exec.LookPath("py")
	if err != nil {
		return "" // no direct interpreter and no py launcher; caller will t.Skip loudly
	}
	out, err := exec.Command(pyl, "-3", "-c", "import sys; sys.stdout.write(sys.executable)").Output()
	if err != nil {
		return "" // `py -3` failed; caller will t.Skip loudly
	}
	if exe := strings.TrimSpace(string(out)); exe != "" && validate(exe) {
		return exe
	}
	return ""
}

// repoRootDir resolves the directive repo root from the test's working dir
// (cmd/deft-install/ -> ../../).
func repoRootDir(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return root
}

// copyHookLF copies src to dst with CRLF normalized to LF so the deposited
// shell hook runs under Git-for-Windows' sh (a CRLF shebang breaks it).
func copyHookLF(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("read %s: %v", src, err)
	}
	lf := strings.ReplaceAll(string(data), "\r\n", "\n")
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte(lf), 0o755); err != nil {
		t.Fatalf("write %s: %v", dst, err)
	}
}

func copyFileRaw(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("read %s: %v", src, err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", dst, err)
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func runGitIn(t *testing.T, gitPath, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(gitPath, append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func gitOut(t *testing.T, gitPath, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command(gitPath, append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return string(out)
}

// gitCommitWithEnv runs `git commit -m <msg>` in dir with the given env and
// returns the combined output plus any error (a non-zero exit means a hook
// blocked the commit).
func gitCommitWithEnv(gitPath, dir string, env []string, msg string) (string, error) {
	cmd := exec.Command(gitPath, "-C", dir, "commit", "-m", msg)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	return string(out), err
}
