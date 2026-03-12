package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	deftRepoURL = "https://github.com/visionik/deft"

	agentsMDEntry = `See deft/main.md
Skills: deft/skills/deft-setup/SKILL.md, deft/skills/deft-build/SKILL.md
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
//	Windows:    %APPDATA%\deft\
//	macOS/Linux: ~/.config/deft/
//	Override:    DEFT_USER_PATH env var
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
	w.printf("  2. The agent will read deft/main.md automatically via AGENTS.md\n")
	w.printf("  3. On first session, the deft-setup skill will create your USER.md preferences\n")
	w.printf("\n")
}
