package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// #1453 / #1458 -- installer commit-hygiene: Layer 1 dirty-tree GATE at
// --upgrade. As of #1458 the default is FAIL-LOUD (a dirty tree refuses the
// upgrade); --force / --allow-dirty is the only bypass; --require-clean is an
// accepted no-op alias.
// ---------------------------------------------------------------------------

// TestCheckDirtyTree_FailLoudDefaultBlocks is the #1458 headline behavior: with
// NO flags (the default) a dirty working tree on an --upgrade is reported
// (dirty=true) AND blocked, so the upgrade refuses. This is the same decision
// the interactive and the --yes/non-interactive paths consume (the gate never
// branches on interactivity), so it fails loud on both.
func TestCheckDirtyTree_FailLoudDefaultBlocks(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = origStatus }()
	want := []string{" M app.go", "?? new.txt"}
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) {
		return want, true, nil
	}

	adv := checkDirtyTree("/proj", commitHygieneOptions{})
	if !adv.checked {
		t.Error("expected checked=true when the probe ran in a git work tree")
	}
	if !adv.dirty {
		t.Error("expected dirty=true for a non-empty porcelain status")
	}
	if !adv.blocked {
		t.Error("#1458: a dirty tree must be blocked by DEFAULT (no flags), not warn-and-proceed")
	}
	if strings.Join(adv.files, "\n") != strings.Join(want, "\n") {
		t.Errorf("files = %v, want %v", adv.files, want)
	}
}

// TestCheckDirtyTree_RequireCleanIsNoOpAlias proves --require-clean is an
// accepted no-op alias since #1458: passing it changes NOTHING relative to the
// default (a dirty tree is blocked either way), and it never errors.
func TestCheckDirtyTree_RequireCleanIsNoOpAlias(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = origStatus }()
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) {
		return []string{" M app.go"}, true, nil
	}

	defaultAdv := checkDirtyTree("/proj", commitHygieneOptions{})
	aliasAdv := checkDirtyTree("/proj", commitHygieneOptions{requireClean: true})
	if defaultAdv.blocked != aliasAdv.blocked || !aliasAdv.blocked {
		t.Errorf("--require-clean must be a no-op alias: default.blocked=%v alias.blocked=%v (both must be true)", defaultAdv.blocked, aliasAdv.blocked)
	}
	if !aliasAdv.dirty {
		t.Error("expected dirty=true with --require-clean on a dirty tree")
	}
}

// TestCheckDirtyTree_ForceBypasses proves --force / --allow-dirty is the only
// escape from the #1458 default refusal: dirty is still reported but the
// upgrade is allowed -- with OR without the redundant --require-clean alias.
func TestCheckDirtyTree_ForceBypasses(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = origStatus }()
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) {
		return []string{" M app.go"}, true, nil
	}

	for _, opts := range []commitHygieneOptions{
		{force: true},
		{requireClean: true, force: true},
	} {
		adv := checkDirtyTree("/proj", opts)
		if !adv.dirty {
			t.Fatalf("expected dirty=true for opts %+v", opts)
		}
		if adv.blocked {
			t.Errorf("--force / --allow-dirty must bypass the refusal for opts %+v", opts)
		}
	}
}

// TestCheckDirtyTree_CleanIsNoop: a clean tree is checked but not dirty/blocked.
func TestCheckDirtyTree_CleanIsNoop(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = origStatus }()
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) {
		return nil, true, nil
	}

	adv := checkDirtyTree("/proj", commitHygieneOptions{})
	if !adv.checked {
		t.Error("expected checked=true for a clean git work tree")
	}
	if adv.dirty || adv.blocked {
		t.Errorf("clean tree must not be dirty/blocked, got %+v", adv)
	}
}

// TestCheckDirtyTree_NonRepoSkips: a non-git project (or git absent) is a
// silent no-op -- never checked, never dirty, never blocked.
func TestCheckDirtyTree_NonRepoSkips(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = origStatus }()
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) {
		return nil, false, nil
	}

	adv := checkDirtyTree("/proj", commitHygieneOptions{})
	if adv.checked || adv.dirty || adv.blocked {
		t.Errorf("non-repo must be a no-op, got %+v", adv)
	}
}

// TestDirtyTreeGate_InitialInstallNeverBlocks is the CRITICAL #1453 invariant
// (unchanged by #1458): an INITIAL install (not an upgrade) must NEVER probe
// the tree or block, even with a dirty tree.
func TestDirtyTreeGate_InitialInstallNeverBlocks(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = origStatus }()
	probed := false
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) {
		probed = true
		return []string{" M app.go"}, true, nil
	}

	adv := dirtyTreeGate(false /* isUpgrade */, "/proj", commitHygieneOptions{})
	if probed {
		t.Error("an initial install must NOT probe the working tree")
	}
	if adv.checked || adv.dirty || adv.blocked {
		t.Errorf("initial install must never block, got %+v", adv)
	}
}

// TestDirtyTreeGate_UpgradeBlocksByDefault: an upgrade runs the probe and, with
// no bypass flag, blocks a dirty tree (the #1458 default).
func TestDirtyTreeGate_UpgradeBlocksByDefault(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	defer func() { gitPorcelainStatusFunc = origStatus }()
	probed := false
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) {
		probed = true
		return []string{" M app.go"}, true, nil
	}

	adv := dirtyTreeGate(true /* isUpgrade */, "/proj", commitHygieneOptions{})
	if !probed {
		t.Error("an upgrade must probe the working tree")
	}
	if !adv.dirty || !adv.blocked {
		t.Errorf("upgrade with a dirty tree must block by default, got %+v", adv)
	}
}

// TestDirtyTreeBlockResult_JSON pins the machine-readable refusal surfaced in
// --json mode (no interactive hang, no silent abort). Beyond the original
// error / error_code / dirty_tree / dirty_files fields, #1458 adds the
// structured why / remediation / force_hint signals and a warnings array so a
// stdout-only agent gets the full actionable picture (#1385).
func TestDirtyTreeBlockResult_JSON(t *testing.T) {
	adv := dirtyTreeAdvisory{checked: true, dirty: true, blocked: true, files: []string{" M app.go"}}
	res := dirtyTreeBlockResult(adv)

	if res["success"] != false {
		t.Errorf("success = %v, want false", res["success"])
	}
	if res["error_code"] != dirtyTreeBlockCode {
		t.Errorf("error_code = %v, want %q", res["error_code"], dirtyTreeBlockCode)
	}
	if res["dirty_tree"] != true {
		t.Errorf("dirty_tree = %v, want true", res["dirty_tree"])
	}
	// #1458 structured signals: each must be present and non-empty so a
	// stdout-only consumer can act without parsing stderr prose.
	for _, field := range []string{"error", "why", "remediation", "force_hint"} {
		val, ok := res[field].(string)
		if !ok || val == "" {
			t.Errorf("expected non-empty string field %q, got %v", field, res[field])
		}
	}
	// force_hint must name the exact bypass flag(s).
	if fh, _ := res["force_hint"].(string); !strings.Contains(fh, "--force") {
		t.Errorf("force_hint must reference --force, got %q", fh)
	}
	// dirty_files is a non-nil slice carrying the porcelain status.
	if files, ok := res["dirty_files"].([]string); !ok || len(files) != 1 || files[0] != " M app.go" {
		t.Errorf("dirty_files = %v, want [\" M app.go\"]", res["dirty_files"])
	}
	// warnings is present as a (possibly empty) non-nil array.
	if _, ok := res["warnings"].([]string); !ok {
		t.Errorf("warnings must be a non-nil []string array, got %T", res["warnings"])
	}
	// Must marshal to a single valid JSON object (the --json contract).
	if _, err := json.Marshal(res); err != nil {
		t.Fatalf("block result is not JSON-marshalable: %v", err)
	}
}

// TestDirtyTreeBlockResult_NilFilesAreEmptyArrays guards the stable JSON schema:
// a nil files slice still serialises dirty_files and warnings as [] (never
// null) so consumers can index them unconditionally.
func TestDirtyTreeBlockResult_NilFilesAreEmptyArrays(t *testing.T) {
	res := dirtyTreeBlockResult(dirtyTreeAdvisory{checked: true, dirty: true, blocked: true})
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	text := string(data)
	if !strings.Contains(text, `"dirty_files":[]`) {
		t.Errorf("dirty_files must serialise as [] for a nil files slice, got %s", text)
	}
	if !strings.Contains(text, `"warnings":[]`) {
		t.Errorf("warnings must serialise as [], got %s", text)
	}
}

// ---------------------------------------------------------------------------
// #1453 -- Layer 2: scoped staging path set + best-effort staging
// ---------------------------------------------------------------------------

// TestFrameworkStagePaths_OnlyFrameworkAndManaged is the gold-standard scoped
// path set test: only the framework payload (.deft/core) and installer-managed
// deposits are returned. Consumer app code AND consumer vBRIEF data MUST be
// excluded (the whole point of the deft-core-guard separation).
func TestFrameworkStagePaths_OnlyFrameworkAndManaged(t *testing.T) {
	proj := t.TempDir()
	mustMkdir := func(rel string) {
		if err := os.MkdirAll(filepath.Join(proj, filepath.FromSlash(rel)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite := func(rel, body string) {
		p := filepath.Join(proj, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// Framework payload + installer-managed deposits.
	mustWrite(".deft/core/main.md", "framework")
	mustWrite("AGENTS.md", "agents")
	mustWrite(".agents/skills/deft/SKILL.md", "skill")
	mustWrite(".gitattributes", "x")
	mustWrite(".gitignore", "x")
	mustWrite("vbrief/vbrief.md", "tmpl")
	mustWrite("vbrief/schemas/scope.schema.json", "{}")
	mustMkdir("vbrief/active")
	mustWrite("vbrief/active/.gitkeep", "")

	// Consumer app code + consumer vBRIEF data -- MUST be excluded.
	mustWrite("src/main.go", "package main")
	mustWrite("README.md", "consumer readme")
	mustWrite("vbrief/PROJECT-DEFINITION.vbrief.json", "{}")
	mustWrite("vbrief/active/2026-issue-1.vbrief.json", "{}")

	deftDir := filepath.Join(proj, ".deft", "core")
	got := frameworkStagePaths(proj, deftDir)
	gotSet := map[string]bool{}
	for _, p := range got {
		gotSet[p] = true
	}

	// Framework + a sample of installer-managed paths must be present.
	for _, want := range []string{".deft/core", "AGENTS.md", ".agents", ".gitattributes", ".gitignore", "vbrief/vbrief.md", "vbrief/schemas"} {
		if !gotSet[want] {
			t.Errorf("expected staged path %q in %v", want, got)
		}
	}
	// Consumer files MUST NOT appear, neither directly nor via a parent dir.
	for _, banned := range []string{"src/main.go", "src", "README.md", "vbrief", "vbrief/PROJECT-DEFINITION.vbrief.json"} {
		if gotSet[banned] {
			t.Errorf("consumer path %q must NEVER be staged (got %v)", banned, got)
		}
	}
	// Defensive: no returned path may be a bare consumer file.
	for _, p := range got {
		if p == "vbrief/active/2026-issue-1.vbrief.json" {
			t.Errorf("consumer vBRIEF data leaked into stage set: %q", p)
		}
	}
}

// TestFrameworkStagePaths_SkipsMissing: only paths that actually exist on disk
// are returned (so `git add` never errors on an absent pathspec).
func TestFrameworkStagePaths_SkipsMissing(t *testing.T) {
	proj := t.TempDir()
	if err := os.MkdirAll(filepath.Join(proj, ".deft", "core"), 0o755); err != nil {
		t.Fatal(err)
	}
	deftDir := filepath.Join(proj, ".deft", "core")
	got := frameworkStagePaths(proj, deftDir)
	// .deft/core exists; AGENTS.md etc. do not.
	for _, p := range got {
		full := filepath.Join(proj, filepath.FromSlash(p))
		if !pathExists(full) {
			t.Errorf("returned non-existent path %q", p)
		}
	}
	if len(got) != 1 || got[0] != ".deft/core" {
		t.Errorf("expected only .deft/core, got %v", got)
	}
}

// TestStageFrameworkPaths_StagesOnlyGivenPaths: staging routes EXACTLY the
// provided paths through git add (never `git add -A`).
func TestStageFrameworkPaths_StagesOnlyGivenPaths(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	origStage := runGitStageFunc
	defer func() {
		gitPorcelainStatusFunc = origStatus
		runGitStageFunc = origStage
	}()
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) { return nil, true, nil }
	var gotDir string
	var gotPaths []string
	runGitStageFunc = func(dir string, paths ...string) error {
		gotDir = dir
		gotPaths = paths
		return nil
	}

	in := []string{".deft/core", "AGENTS.md"}
	staged, err := stageFrameworkPaths("/proj", in)
	if err != nil {
		t.Fatalf("stageFrameworkPaths: %v", err)
	}
	if !staged {
		t.Error("expected staged=true on a successful git add")
	}
	if gotDir != "/proj" {
		t.Errorf("staged dir = %q, want /proj", gotDir)
	}
	if strings.Join(gotPaths, " ") != strings.Join(in, " ") {
		t.Errorf("staged paths = %v, want %v (never git add -A)", gotPaths, in)
	}
}

// TestStageFrameworkPaths_NonRepoNoStage: a non-git project is a best-effort
// no-op -- runGitStageFunc is never invoked and staged=false.
func TestStageFrameworkPaths_NonRepoNoStage(t *testing.T) {
	origStatus := gitPorcelainStatusFunc
	origStage := runGitStageFunc
	defer func() {
		gitPorcelainStatusFunc = origStatus
		runGitStageFunc = origStage
	}()
	gitPorcelainStatusFunc = func(string) ([]string, bool, error) { return nil, false, nil }
	called := false
	runGitStageFunc = func(string, ...string) error {
		called = true
		return nil
	}

	staged, err := stageFrameworkPaths("/proj", []string{".deft/core"})
	if err != nil {
		t.Fatalf("stageFrameworkPaths: %v", err)
	}
	if staged {
		t.Error("non-repo must not report staged=true")
	}
	if called {
		t.Error("non-repo must never call git add")
	}
}

// TestDirtyTreeAndStaging_RealGit exercises the REAL git probe + scoped staging
// end to end: a dirty consumer file is detected, and only framework +
// installer-managed paths are staged -- the consumer app file stays UNSTAGED.
func TestDirtyTreeAndStaging_RealGit(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available; skipping real-git commit-hygiene test")
	}
	proj := t.TempDir()
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command(gitPath, append([]string{"-C", proj}, args...)...)
		if out, gerr := cmd.CombinedOutput(); gerr != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), gerr, out)
		}
	}
	runGit("init", "-q")
	runGit("config", "user.email", "test@example.com")
	runGit("config", "user.name", "Test")
	runGit("config", "commit.gpgsign", "false")

	// Framework + installer-managed deposit, plus a consumer app file.
	write := func(rel, body string) {
		p := filepath.Join(proj, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".deft/core/main.md", "framework")
	write("AGENTS.md", "agents")
	write("app/server.go", "package app") // consumer app code

	// Layer 1: the real probe sees a dirty tree.
	lines, isRepo, perr := gitPorcelainStatusFunc(proj)
	if perr != nil {
		t.Fatalf("gitPorcelainStatusFunc: %v", perr)
	}
	if !isRepo {
		t.Fatal("expected isRepo=true for a real git work tree")
	}
	if len(lines) == 0 {
		t.Fatal("expected a dirty porcelain status")
	}

	// Layer 2: stage ONLY framework + installer-managed paths.
	paths := frameworkStagePaths(proj, filepath.Join(proj, ".deft", "core"))
	staged, serr := stageFrameworkPaths(proj, paths)
	if serr != nil {
		t.Fatalf("stageFrameworkPaths: %v", serr)
	}
	if !staged {
		t.Fatal("expected staged=true in a real git repo")
	}

	// Inspect the index: framework paths staged, consumer app file NOT staged.
	cmd := exec.Command(gitPath, "-C", proj, "diff", "--cached", "--name-only")
	out, derr := cmd.Output()
	if derr != nil {
		t.Fatalf("git diff --cached: %v", derr)
	}
	stagedSet := map[string]bool{}
	for _, ln := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if ln != "" {
			stagedSet[ln] = true
		}
	}
	if !stagedSet[".deft/core/main.md"] {
		t.Errorf(".deft/core/main.md should be staged; staged=%v", keysSorted(stagedSet))
	}
	if !stagedSet["AGENTS.md"] {
		t.Errorf("AGENTS.md should be staged; staged=%v", keysSorted(stagedSet))
	}
	if stagedSet["app/server.go"] {
		t.Errorf("consumer app/server.go MUST NOT be staged; staged=%v", keysSorted(stagedSet))
	}
}

func keysSorted(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
