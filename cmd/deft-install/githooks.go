package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	for _, name := range hookFilenames {
		data, err := os.ReadFile(filepath.Join(srcDir, name))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue // payload does not ship this hook name -- tolerate it
			}
			return false, fmt.Errorf("could not read hook %s: %w", name, err)
		}
		dst := filepath.Join(dstDir, name)
		// Idempotency probe: skip the write ONLY when the hook is already present
		// byte-for-byte. A read error (os.ErrNotExist on first deposit, or an
		// unreadable existing hook) is intentionally folded into upToDate=false so
		// the canonical hook is (re)written either way; the WriteFile below is the
		// authoritative action and returns any real filesystem failure to the
		// caller, so a failed read here needs no separate handling.
		existing, rerr := os.ReadFile(dst)
		upToDate := rerr == nil && bytes.Equal(existing, data)
		if upToDate {
			continue // already up-to-date byte-for-byte
		}
		// 0o755: the hook MUST be executable for git to run it on POSIX hosts.
		if err := os.WriteFile(dst, data, 0o755); err != nil {
			return false, fmt.Errorf("could not write hook %s: %w", name, err)
		}
		deposited = true
	}

	// Point core.hooksPath at the consumer-root hooks dir so git runs them.
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
	}

	if deposited || hooksWired {
		w.printf("✓ git hooks wired: %s/ deposited and core.hooksPath=%s (#1463 branch gate active).\n", consumerHooksDirName, consumerHooksDirName)
		return true, nil
	}
	w.printf("git hooks already wired (%s/ + core.hooksPath) — skipping.\n", consumerHooksDirName)
	return false, nil
}
