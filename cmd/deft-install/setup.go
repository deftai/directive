package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	deftRepoURL = "https://github.com/deftai/directive"

	// agentsMDEntry is written into the project's AGENTS.md during install.
	// It must contain agentsMDSentinel ("deft/main.md") for idempotency —
	// WriteAgentsMD checks for that string before appending.
	// TODO: remove the Skills line when #75 (skill auto-discovery) ships.
	agentsMDEntry = `# Deft — AI Development Framework

Deft is installed in deft/. Full guidelines: deft/main.md

## First Session

Check what exists before doing anything else:

**USER.md missing** (~/.config/deft/USER.md or %APPDATA%\deft\USER.md):
→ Read deft/skills/deft-setup/SKILL.md and start Phase 1 (user preferences)

**USER.md exists, PROJECT.md missing** (project root):
→ Read deft/skills/deft-setup/SKILL.md and start Phase 2 (project configuration)

**USER.md and PROJECT.md exist, SPECIFICATION.md missing** (project root):
→ Read deft/skills/deft-setup/SKILL.md and start Phase 3 (specification interview)

## Returning Sessions

When all config exists: read the guidelines, your USER.md preferences, and PROJECT.md, then continue with your task.

## Commands

- /deft:change <name>        — Propose a scoped change
- /deft:run:interview        — Structured spec interview
- /deft:run:speckit          — Five-phase spec workflow (large projects)
- /deft:run:discuss <topic>  — Feynman-style alignment
- /deft:run:research <topic> — Research before planning
- /deft:run:map              — Map an existing codebase
- deft/run bootstrap         — CLI setup (terminal users)
- deft/run spec              — CLI spec generation

Skills: deft/SKILL.md, deft/skills/deft-setup/SKILL.md, deft/skills/deft-build/SKILL.md
`
	// Sentinel used to detect an existing deft entry in AGENTS.md.
	agentsMDSentinel = "deft/main.md"
)

// ---------------------------------------------------------------------------
// 4.1 Clone deft
// ---------------------------------------------------------------------------

// CloneDeft clones the deft repository into deftDir.
// The parent directory (projectDir) is created if it does not exist.
// If branch is non-empty the clone checks out that branch.
func CloneDeft(w *Wizard, result *WizardResult, branch string) error {
	// Ensure the project directory exists.
	if err := os.MkdirAll(result.ProjectDir, 0o755); err != nil {
		return fmt.Errorf("could not create project directory: %w", err)
	}

	args := []string{"clone"}
	if branch != "" {
		args = append(args, "--branch", branch)
		w.printf("Cloning deft (branch %s) into %s ...\n", branch, result.DeftDir)
	} else {
		w.printf("Cloning deft into %s ...\n", result.DeftDir)
	}
	args = append(args, deftRepoURL, result.DeftDir)

	if err := runCmdFunc(w.out, "git", args...); err != nil {
		w.printf("\nClone failed. Please check your internet connection and try again.\n")
		return fmt.Errorf("git clone failed: %w", err)
	}
	return nil
}

// UpdateDeft fetches the latest changes and optionally switches branch.
// Used when deft/ already exists and the user chose to update.
func UpdateDeft(w *Wizard, result *WizardResult, branch string) error {
	w.printf("Updating deft at %s ...\n", result.DeftDir)

	// Fetch latest from origin.
	if err := runCmdFunc(w.out, "git", "-C", result.DeftDir, "fetch", "origin"); err != nil {
		return fmt.Errorf("git fetch failed: %w", err)
	}

	// Switch branch if requested.
	if branch != "" {
		w.printf("Switching to branch %s ...\n", branch)
		if err := runCmdFunc(w.out, "git", "-C", result.DeftDir, "checkout", branch); err != nil {
			return fmt.Errorf("git checkout %s failed: %w", branch, err)
		}
	}

	// Pull latest changes.
	if err := runCmdFunc(w.out, "git", "-C", result.DeftDir, "pull"); err != nil {
		return fmt.Errorf("git pull failed: %w", err)
	}

	w.printf("Deft updated successfully.\n")
	return nil
}

// ---------------------------------------------------------------------------
// 4.2 Write AGENTS.md
// ---------------------------------------------------------------------------

// WriteAgentsMD creates or appends deft entries to AGENTS.md in the project
// folder. If the entries already exist the file is left unchanged (idempotent).
func WriteAgentsMD(w *Wizard, projectDir string) error {
	path := filepath.Join(projectDir, "AGENTS.md")

	existing, err := os.ReadFile(path)
	if err == nil {
		// File exists — check for existing deft entry.
		if strings.Contains(string(existing), agentsMDSentinel) {
			w.printf("AGENTS.md already contains deft entries — skipping.\n")
			return nil
		}
		// Append to existing file.
		content := string(existing)
		if !strings.HasSuffix(content, "\n") {
			content += "\n"
		}
		content += "\n" + agentsMDEntry
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return fmt.Errorf("could not update AGENTS.md: %w", err)
		}
		w.printf("AGENTS.md updated with deft entries.\n")
		return nil
	}

	// File does not exist — create it.
	if err := os.WriteFile(path, []byte(agentsMDEntry), 0o644); err != nil {
		return fmt.Errorf("could not create AGENTS.md: %w", err)
	}
	w.printf("AGENTS.md created.\n")
	return nil
}

// ---------------------------------------------------------------------------
// 4.3 Create USER.md config directory
// ---------------------------------------------------------------------------

// UserConfigDir returns the platform-appropriate deft config directory.
//
// Windows:    %APPDATA%\deft\
// macOS/Linux: ~/.config/deft/
// Override:    DEFT_USER_PATH env var
func UserConfigDir() string {
	if p := os.Getenv("DEFT_USER_PATH"); p != "" {
		return p
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("APPDATA"), "deft")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "deft")
}

// CreateUserConfigDir ensures the user config directory exists.
// If USER.md already exists inside it, a note is printed but no error is returned.
func CreateUserConfigDir(w *Wizard) (string, error) {
	dir := UserConfigDir()

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("could not create config directory %s: %w", dir, err)
	}

	userMD := filepath.Join(dir, "USER.md")
	if _, err := os.Stat(userMD); err == nil {
		w.printf("USER.md already exists at %s — keeping existing file.\n", userMD)
	}

	return dir, nil
}

// ---------------------------------------------------------------------------
// 4.4 Print next steps
// ---------------------------------------------------------------------------

// PrintNextSteps displays the success banner and post-install instructions.
func PrintNextSteps(w *Wizard, result *WizardResult, configDir string) {
	w.printf("\n✓ Deft installed successfully!\n\n")
	w.printf("  Location  : %s%c\n", result.DeftDir, os.PathSeparator)
	w.printf("  AGENTS.md : updated\n")
	w.printf("  User config: %s%c\n", configDir, os.PathSeparator)
	w.printf("\nNext steps:\n")
	w.printf("  1. Open your AI coding assistant in %s%c\n", result.ProjectDir, os.PathSeparator)
	w.printf("  2. Tell your agent: \"read AGENTS.md and follow it\" to start the Deft setup\n")
	w.printf("  3. On first session, the agent will guide you through creating USER.md and PROJECT.md\n")
	w.printf("     Note: agents do not read AGENTS.md automatically — auto-discovery is planned for a future release\n")
	w.printf("\n")
}
