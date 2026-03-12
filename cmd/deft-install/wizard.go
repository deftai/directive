package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var errUserExit = errors.New("user chose to exit")

// Wizard guides the user through choosing an install location.
type Wizard struct {
	scanner *bufio.Scanner
	out     io.Writer
	debug   bool
}

// WizardResult holds the chosen paths after the wizard completes.
type WizardResult struct {
	ProjectName string
	ProjectDir  string
	DeftDir     string
}

// NewWizard creates a Wizard reading from in and writing to out.
func NewWizard(in io.Reader, out io.Writer, debug bool) *Wizard {
	return &Wizard{
		scanner: bufio.NewScanner(in),
		out:     out,
		debug:   debug,
	}
}

// Run executes the full install wizard and returns the chosen paths.
func (w *Wizard) Run() (*WizardResult, error) {
	w.printBanner()

	projectName, err := w.askProjectName()
	if err != nil {
		return nil, err
	}

	startDir, err := w.selectStartingLocation()
	if err != nil {
		return nil, err
	}

	for {
		projectDir, err := w.selectProjectDir(startDir, projectName)
		if err != nil {
			return nil, err
		}

		deftDir := filepath.Join(projectDir, "deft")

		if err := w.checkGuards(deftDir); err != nil {
			w.printf("\n%s\n\n", err)
			continue
		}

		confirmed, err := w.confirmInstall(projectDir, deftDir)
		if err != nil {
			return nil, err
		}
		if confirmed {
			return &WizardResult{
				ProjectName: filepath.Base(projectDir),
				ProjectDir:  projectDir,
				DeftDir:     deftDir,
			}, nil
		}
		// Not confirmed — loop back to parent folder selection.
	}
}

// ---------------------------------------------------------------------------
// Interactive steps
// ---------------------------------------------------------------------------

func (w *Wizard) printBanner() {
	w.printf("\nWelcome to Deft!\n")
	w.printf("AI coding standards, installed in seconds.\n\n")
}

func (w *Wizard) askProjectName() (string, error) {
	for {
		w.printf("What is the name of your project? ")
		raw, err := w.readLine()
		if err != nil {
			return "", err
		}

		raw = strings.TrimSpace(raw)
		if raw == "" {
			w.printf("Please enter a project name.\n\n")
			continue
		}

		sanitised := SanitizeProjectName(raw)
		if sanitised == "" {
			w.printf("That name contains only invalid characters. Please try again.\n\n")
			continue
		}

		if sanitised != raw {
			w.printf("Project name adjusted to: %s\n", sanitised)
		}
		return sanitised, nil
	}
}

// selectProjectDir lets the user browse the filesystem and returns the
// chosen project directory (the folder that will contain deft/).
//
// "Use this folder" treats current as the parent and appends projectName.
// "Create a new folder here" treats the new folder as the project directory.
func (w *Wizard) selectProjectDir(root, projectName string) (string, error) {
	current := root
	for {
		dirs, err := ListSubdirs(current)
		if err != nil {
			return "", fmt.Errorf("could not read %s: %w", current, err)
		}
		sort.Strings(dirs)

		preview := filepath.Join(current, projectName, "deft")
		w.printf("\nBrowsing: %s\n", current)
		w.printf("  Deft will be installed into: %s\n\n", preview)

		// --- Action options first (stable numbering) ---
		nextIdx := 1

		useIdx := nextIdx
		w.printf("  %d. ** Use this folder **\n", useIdx)
		nextIdx++

		upIdx := 0
		parent := filepath.Dir(current)
		if parent != current {
			upIdx = nextIdx
			w.printf("  %d. .. (go up)\n", upIdx)
			nextIdx++
		}

		createIdx := nextIdx
		w.printf("  %d. Create a new folder here (%s)\n", createIdx, current)
		nextIdx++

		enterIdx := nextIdx
		w.printf("  %d. Type a path manually\n", enterIdx)
		nextIdx++

		exitIdx := nextIdx
		w.printf("  %d. Exit\n", exitIdx)
		nextIdx++

		// --- Subdirectory listing ---
		dirStartIdx := nextIdx
		if len(dirs) > 0 {
			w.printf("\n  Subfolders:\n")
			for i, d := range dirs {
				w.printf("  %d. %s%c\n", dirStartIdx+i, d, os.PathSeparator)
			}
		}
		maxIdx := dirStartIdx + len(dirs) - 1
		if len(dirs) == 0 {
			maxIdx = exitIdx
		}

		defaultChoice := useIdx
		if len(dirs) > 0 {
			defaultChoice = dirStartIdx // first subfolder
		}

		w.printf("\nChoice [%d]: ", defaultChoice)
		input, err := w.readLine()
		if err != nil {
			return "", err
		}

		choice := defaultChoice
		input = strings.TrimSpace(input)
		if input != "" {
			choice, err = strconv.Atoi(input)
			if err != nil || choice < 1 || choice > maxIdx {
				w.printf("Invalid choice. Please enter a number between 1 and %d.\n", maxIdx)
				continue
			}
		}

		switch {
		case choice == exitIdx:
			if w.confirmExit() {
				return "", errUserExit
			}

		case choice == useIdx:
			// current is the parent; project folder = current/projectName
			return filepath.Join(current, projectName), nil

		case upIdx > 0 && choice == upIdx:
			current = parent

		case choice == enterIdx:
			w.printf("Enter full path: ")
			p, err := w.readLine()
			if err != nil {
				return "", err
			}
			p = strings.TrimSpace(p)
			if p == "" {
				w.printf("No path entered.\n")
				continue
			}
			info, err := os.Stat(p)
			if err != nil || !info.IsDir() {
				w.printf("'%s' is not a valid directory. Please try again.\n", p)
				continue
			}
			current = p

		case choice == createIdx:
			w.printf("Folder name [%s]: ", projectName)
			name, err := w.readLine()
			if err != nil {
				return "", err
			}
			name = strings.TrimSpace(name)
			if name == "" {
				name = projectName
			}
			name = SanitizeProjectName(name)
			if name == "" {
				w.printf("Invalid folder name. Please try again.\n")
				continue
			}
			// The created folder IS the project directory.
			return filepath.Join(current, name), nil

		default:
			// User picked a subfolder — drill into it.
			current = filepath.Join(current, dirs[choice-dirStartIdx])
		}
	}
}

func (w *Wizard) confirmInstall(projectDir, deftDir string) (bool, error) {
	w.printf("\nReady to install!\n")
	w.printf("  Project folder : %s%c\n", projectDir, os.PathSeparator)
	w.printf("  Deft location  : %s%c\n", deftDir, os.PathSeparator)
	w.printf("The project folder will be created if it doesn't already exist.\n")
	w.printf("Continue? [Y/n]: ")

	input, err := w.readLine()
	if err != nil {
		return false, err
	}
	input = strings.TrimSpace(strings.ToLower(input))
	return input == "" || input == "y" || input == "yes", nil
}

func (w *Wizard) checkGuards(deftDir string) error {
	// Guard: deft/ already exists — never overwrite.
	if info, err := os.Stat(deftDir); err == nil && info.IsDir() {
		return fmt.Errorf(
			"a deft/ folder already exists at %s\n"+
				"To repair or re-run the install, remove it first and try again", deftDir)
	}

	// Guard: write permission on the nearest existing ancestor.
	parentDir := filepath.Dir(deftDir) // <project>/
	if err := CheckWritePermission(parentDir); err != nil {
		return err
	}

	return nil
}

func (w *Wizard) confirmExit() bool {
	w.printf("Are you sure you want to exit? [y/N]: ")
	input, _ := w.readLine()
	return strings.TrimSpace(strings.ToLower(input)) == "y"
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

func (w *Wizard) readLine() (string, error) {
	if w.scanner.Scan() {
		return w.scanner.Text(), nil
	}
	if err := w.scanner.Err(); err != nil {
		return "", err
	}
	return "", io.EOF
}

func (w *Wizard) printf(format string, args ...any) {
	fmt.Fprintf(w.out, format, args...)
}

// ---------------------------------------------------------------------------
// Pure / testable helpers (exported for tests)
// ---------------------------------------------------------------------------

// SanitizeProjectName removes characters invalid in directory names and trims
// leading/trailing dots and whitespace.
func SanitizeProjectName(name string) string {
	// Remove characters invalid on Windows (superset of Unix restrictions).
	invalid := regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)
	name = invalid.ReplaceAllString(name, "")

	// Trim leading/trailing spaces and dots (Windows forbids trailing dots).
	name = strings.Trim(name, " .")

	// Collapse runs of whitespace.
	spaces := regexp.MustCompile(`\s+`)
	name = spaces.ReplaceAllString(name, " ")

	return name
}

// ListSubdirs returns the names of visible, non-system subdirectories in dir.
func ListSubdirs(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	var dirs []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if isHidden(name) || isSystemFolder(name) {
			continue
		}
		dirs = append(dirs, name)
	}
	return dirs, nil
}

func isHidden(name string) bool {
	return strings.HasPrefix(name, ".")
}

// isSystemFolder returns true for well-known system directories that should
// not appear in folder selection menus.
func isSystemFolder(name string) bool {
	system := map[string]bool{
		"$recycle.bin":              true,
		"system volume information": true,
		"windows":                  true,
		"program files":            true,
		"program files (x86)":      true,
		"programdata":              true,
		"recovery":                 true,
		"perflogs":                 true,
		"config.msi":               true,
		"msocache":                 true,
		"boot":                     true,
		"documents and settings":   true,
	}
	return system[strings.ToLower(name)]
}

// CheckWritePermission verifies the process can write to dir.
// If dir does not exist yet, it checks the nearest existing ancestor.
func CheckWritePermission(dir string) error {
	check := dir
	for {
		info, err := os.Stat(check)
		if err == nil {
			if !info.IsDir() {
				return fmt.Errorf("%s exists but is not a directory", check)
			}
			break
		}
		parent := filepath.Dir(check)
		if parent == check {
			return fmt.Errorf("cannot find an existing directory in the path %s", dir)
		}
		check = parent
	}

	// Try creating and removing a temp file to verify write access.
	tmp := filepath.Join(check, ".deft-install-write-test")
	f, err := os.Create(tmp)
	if err != nil {
		return fmt.Errorf("no write permission on %s — try running as administrator", check)
	}
	f.Close()
	os.Remove(tmp)
	return nil
}
