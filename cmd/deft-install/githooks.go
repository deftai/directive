package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// ---------------------------------------------------------------------------
// 4.2d Consumer git-hook wiring (#1463)
// ---------------------------------------------------------------------------
//
// In a vendored consumer project (framework at .deft/core/) the deft git hooks
// never became active before this change: the installer deposited AGENTS.md,
// .gitignore, vbrief/, etc. but NEVER materialized a root-level .githooks/ nor
// ran `git config core.hooksPath`. The hook scripts only shipped inside the
// payload at .deft/core/.githooks/. As a result the #747 branch-protection
// gate, the #798 encoding gate, and the #1019 destructive-gh-verb gate were all
// silently inert in every consumer install, and `task verify:hooks-installed`
// reported false-green.
//
// WriteConsumerGitHooks closes Layer 1 + Layer 2 of #1463 (Option 1): it copies
// the (now layout-aware) hook scripts from the framework payload's .githooks/
// to the consumer root .githooks/ and sets core.hooksPath=.githooks. The copied
// hooks resolve their helper scripts relative to the install root (own-repo
// scripts/ vs vendored .deft/core/scripts/) -- see .githooks/pre-commit -- so
// they fire correctly in the vendored layout. Layer 3b (the honest
// verify:hooks-installed health check) lives in scripts/verify_hooks_installed.py.

// consumerHooksDirName is the repo-root hooks directory the installer deposits
// into and points core.hooksPath at. Kept consumer-root-relative (NOT
// .deft/core/.githooks) so the value matches the directive repo's own
// core.hooksPath and the hardened verify:hooks-installed check (#1463 Option 1).
const consumerHooksDirName = ".githooks"

// hookFileMode is the permission the deposited hooks are written and chmod'd to.
// The executable bits (0o755) are REQUIRED for git to run the hooks on POSIX
// hosts -- a non-executable hook is silently skipped, leaving the #747 / #798 /
// #1019 gates inert on Unix consumers (#1477). On Windows the exec bit is a
// no-op (chmod there only toggles the read-only attribute), which is harmless.
const hookFileMode = 0o755

// hookFilenames is the set of git hook scripts the installer materializes at the
// consumer root. Only hooks the framework actually ships are copied; git
// silently ignores any hook name it does not recognise, and a payload that does
// not ship a given hook name is tolerated (the read is skipped, not fatal).
var hookFilenames = []string{"pre-commit", "pre-push"}

// gitConfigGetHooksPathFunc reads the configured core.hooksPath for the repo at
// dir (empty string when unset). Indirected through a var so tests can drive
// WriteConsumerGitHooks without a real repo. `git config --get` exits 1 when the
// key is unset; that is reported as ("", nil) so the caller's idempotency probe
// sees an empty value. A genuinely unavailable git / non-repo is detected
// separately via gitPorcelainStatusFunc before this is consulted.
var gitConfigGetHooksPathFunc = func(dir string) (string, error) {
	out, err := exec.Command("git", "-C", dir, "config", "--get", "core.hooksPath").Output()
	if err != nil {
		return "", nil
	}
	return string(bytes.TrimSpace(out)), nil
}

// setGitHooksPathFunc sets core.hooksPath=value for the repo at dir. This is the
// only mutating git command WriteConsumerGitHooks issues against the consumer
// repo. Indirected for tests; best-effort by contract (the caller only invokes
// it after confirming dir is inside a git work tree).
var setGitHooksPathFunc = func(dir, value string) error {
	return exec.Command("git", "-C", dir, "config", "core.hooksPath", value).Run()
}

// gitIndexChmodExecFunc records the executable bit (git mode 100755) for the
// given repo-relative paths in the index of the repo at dir, via
// `git update-index --add --chmod=+x`. Indirected for tests. This is what makes
// the TRACKED hook deposit executable cross-platform: on Windows the
// working-tree exec bit is invisible to git, so without this a consumer's
// `git add` would stage the hooks as mode 100644 and git would silently skip
// them on Unix checkouts (#1477). Best-effort by contract -- the caller only
// invokes it after confirming dir is inside a git work tree and treats a
// failure as non-fatal.
var gitIndexChmodExecFunc = func(dir string, relPaths ...string) error {
	if len(relPaths) == 0 {
		return nil
	}
	args := append([]string{"-C", dir, "update-index", "--add", "--chmod=+x"}, relPaths...)
	return exec.Command("git", args...).Run()
}

// WriteConsumerGitHooks copies the framework payload's .githooks/ hook scripts
// to the consumer root .githooks/ and sets core.hooksPath=.githooks so git runs
// them (#1463 Layers 1 + 2). It returns true when anything changed (a hook was
// deposited/updated or core.hooksPath was (re)pointed), false on a clean no-op.
//
// Idempotent: a hook already present byte-for-byte is left untouched, and
// core.hooksPath is only written when it differs from the target. Best-effort
// on the git side: a non-git project (or a missing git binary) still deposits
// the hooks on disk and simply skips the core.hooksPath write, so a later
// `git init` + `task setup` finishes the wiring. A filesystem error (read-only
// tree, permission denied) is returned so the installer can surface it; callers
// treat hook wiring as non-fatal, mirroring depositNeutralization.
func WriteConsumerGitHooks(w *Wizard, projectDir, deftDir string) (bool, error) {
	srcDir := filepath.Join(deftDir, consumerHooksDirName)
	info, err := os.Stat(srcDir)
	if err != nil || !info.IsDir() {
		// The framework payload ships .githooks/; if it is absent there is
		// nothing to wire. Skip rather than fail the install.
		w.printf("git hooks source %s absent — skipping hook wiring.\n", srcDir)
		return false, nil
	}

	dstDir := filepath.Join(projectDir, consumerHooksDirName)
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return false, fmt.Errorf("could not create %s: %w", consumerHooksDirName, err)
	}

	deposited := false
	healed := false           // a present hook was non-executable and the chmod repaired it (#1477)
	var hookRelPaths []string // POSIX repo-relative paths of hooks present on disk
	for _, name := range hookFilenames {
		data, err := os.ReadFile(filepath.Join(srcDir, name))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue // payload does not ship this hook name -- tolerate it
			}
			return false, fmt.Errorf("could not read hook %s: %w", name, err)
		}
		dst := filepath.Join(dstDir, name)
		// Idempotency probe: skip the WRITE ONLY when the hook is already present
		// byte-for-byte. A read error (os.ErrNotExist on first deposit, or an
		// unreadable existing hook) is intentionally folded into upToDate=false so
		// the canonical hook is (re)written either way; the WriteFile below is the
		// authoritative action and returns any real filesystem failure to the
		// caller, so a failed read here needs no separate handling.
		existing, rerr := os.ReadFile(dst)
		upToDate := rerr == nil && bytes.Equal(existing, data)
		if !upToDate {
			if err := os.WriteFile(dst, data, hookFileMode); err != nil {
				return false, fmt.Errorf("could not write hook %s: %w", name, err)
			}
			deposited = true
		}
		// Detect a non-executable hook BEFORE the heal so the caller can report
		// it -- otherwise a byte-identical 0o644 hook (the precise #1477 bug state
		// for existing consumers) is silently repaired and the run reports
		// "already wired -- skipping". The exec bit is meaningless on Windows
		// (Stat reports no 0o111 bits there), so the probe is POSIX-only to avoid
		// a spurious heal on every Windows re-run.
		if runtime.GOOS != "windows" {
			if info, serr := os.Stat(dst); serr != nil {
				// Non-fatal: the chmod below still runs; warn so a transient
				// stat failure leaves a trace rather than silently skipping the
				// heal-detection probe.
				w.printf("Warning: could not stat hook %s to check its exec bit: %v\n", name, serr)
			} else if info.Mode().Perm()&0o111 == 0 {
				healed = true
			}
		}
		// Enforce the executable bit even on a byte-identical re-deposit:
		// os.WriteFile applies its perm ONLY when CREATING a file (an O_TRUNC
		// rewrite of a pre-existing 0o644 hook keeps 0o644) and the create-time
		// perm is subject to umask. An explicit chmod guarantees the on-disk hook
		// is executable so the #747 / #798 / #1019 gates fire on Unix consumers,
		// and heals a hook an older installer deposited non-executable (#1477).
		if err := os.Chmod(dst, hookFileMode); err != nil {
			w.printf("Warning: could not mark hook %s executable: %v\n", name, err)
		}
		hookRelPaths = append(hookRelPaths, consumerHooksDirName+"/"+name)
	}

	// Point core.hooksPath at the consumer-root hooks dir so git runs them, and
	// record the hooks' exec bit (mode 100755) in the git index so the tracked
	// deposit is executable on every platform (#1477).
	hooksWired := false
	if _, isRepo, _ := gitPorcelainStatusFunc(projectDir); isRepo {
		current, _ := gitConfigGetHooksPathFunc(projectDir)
		if current != consumerHooksDirName {
			if err := setGitHooksPathFunc(projectDir, consumerHooksDirName); err != nil {
				w.printf("Warning: could not set core.hooksPath: %v\n", err)
			} else {
				hooksWired = true
			}
		}
		if len(hookRelPaths) > 0 {
			if err := gitIndexChmodExecFunc(projectDir, hookRelPaths...); err != nil {
				w.printf("Warning: could not record hook exec bit in git index: %v\n", err)
			}
		}
	}

	if deposited || hooksWired {
		w.printf("✓ git hooks wired: %s/ deposited and core.hooksPath=%s (#1463 branch gate active).\n", consumerHooksDirName, consumerHooksDirName)
		return true, nil
	}
	if healed {
		// Content was already current but a hook had lost its exec bit; the
		// chmod above repaired it. Surface the heal rather than reporting a
		// no-op so a consumer who re-ran the installer to fix dead hooks sees
		// confirmation (#1477).
		w.printf("✓ git hooks healed: marked %s/ hooks executable (mode 100755) (#1477).\n", consumerHooksDirName)
		return true, nil
	}
	w.printf("git hooks already wired (%s/ + core.hooksPath) — skipping.\n", consumerHooksDirName)
	return false, nil
}
