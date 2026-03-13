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
var errBackToDrives = errors.New("user chose to reselect drive")

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
	Update      bool // true when deft/ already exists and user chose to update
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
		if err == errBackToDrives {
			startDir, err = w.selectStartingLocation()
			if err != nil {
				return nil, err
			}
			continue
		}
		if err != nil {
			return nil, err
		}

		deftDir := filepath.Join(projectDir, "deft")

		// If deft/ already exists, offer to update instead of blocking.
		if info, statErr := os.Stat(deftDir); statErr == nil && info.IsDir() {
			update, err := w.askUpdate(deftDir)
			if err != nil {
				return nil, err
			}
			if update {
				return &WizardResult{
					ProjectName: filepath.Base(projectDir),
					ProjectDir:  projectDir,
					DeftDir:     deftDir,
					Update:      true,
				}, nil
			}
			continue
		}

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
	w.printf("\nWelcome to Deft! — AI coding standards, installed in seconds.\n")
	w.printf("Installer version: %s\n\n", version)
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
// "Install in this directory" uses the current folder as the project directory.
// "Create a new subfolder" creates a child folder and uses it as the project directory.
func (w *Wizard) selectProjectDir(root, projectName string) (string, error) {
	w.printf("Navigate to your project's root directory.\n")
	w.printf("Deft will be installed as a subfolder (deft/) inside it.\n")

	current := root
	for {
		dirs, err := ListSubdirs(current)
		if err != nil {
			return "", fmt.Errorf("could not read %s: %w", current, err)
		}
		sort.Strings(dirs)

		w.printf("\nBrowsing: %s\n\n", current)

		// --- Action options first (stable numbering) ---
		nextIdx := 1

		// Only offer "Install here" when we're below a drive/volume root.
		useIdx := 0
		if !isDriveRoot(current) {
			useIdx = nextIdx
			w.printf("  %d. ** Install in this directory ** (%s%cdeft)\n", useIdx, current, os.PathSeparator)
			nextIdx++
		}

		createIdx := nextIdx
		w.printf("  %d. Create a new subfolder        (%s%cdeft)\n", createIdx,
			filepath.Join(current, projectName), os.PathSeparator)
		nextIdx++

		enterIdx := nextIdx
		w.printf("  %d. Type a path manually\n", enterIdx)
		nextIdx++

		exitIdx := nextIdx
		w.printf("  %d. Exit\n", exitIdx)
		nextIdx++

		// --- Navigation listing (go up + subfolders) ---
		w.printf("\n  Navigate:\n")

		upIdx := 0
		parent := filepath.Dir(current)
		if parent != current {
			upIdx = nextIdx
			w.printf("  %d. .. (go up to %s)\n", upIdx, parent)
			nextIdx++
		}

		driveIdx := 0
		if isDriveRoot(current) {
			driveIdx = nextIdx
			w.printf("  %d. Back to drive selection\n", driveIdx)
			nextIdx++
		}

		dirStartIdx := nextIdx
		for i, d := range dirs {
			w.printf("  %d. %s%c\n", dirStartIdx+i, d, os.PathSeparator)
		}

		maxIdx := dirStartIdx + len(dirs) - 1
		if maxIdx < exitIdx {
			maxIdx = exitIdx
		}
		if upIdx > 0 && maxIdx < upIdx {
			maxIdx = upIdx
		}
		if driveIdx > 0 && maxIdx < driveIdx {
			maxIdx = driveIdx
		}

		defaultChoice := createIdx
		if useIdx > 0 {
			defaultChoice = useIdx
		}
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

		case useIdx > 0 && choice == useIdx:
			// Current directory IS the project root.
			return current, nil

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

		case upIdx > 0 && choice == upIdx:
			current = parent

		case driveIdx > 0 && choice == driveIdx:
			return "", errBackToDrives

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
			current = filepath.Clean(p)

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
	// Guard: write permission on the nearest existing ancestor.
	parentDir := filepath.Dir(deftDir) // <project>/
	if err := CheckWritePermission(parentDir); err != nil {
		return err
	}

	return nil
}

func (w *Wizard) askUpdate(deftDir string) (bool, error) {
	w.printf("\nA deft/ folder already exists at %s\n", deftDir)
	w.printf("Would you like to update it with the latest version? [Y/n]: ")
	input, err := w.readLine()
	if err != nil {
		return false, err
	}
	input = strings.TrimSpace(strings.ToLower(input))
	return input == "" || input == "y" || input == "yes", nil
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

// isDriveRoot returns true when path is a filesystem root (e.g. C:\ on Windows,
// / on Unix). Deft should never be installed directly off a drive root.
func isDriveRoot(path string) bool {
	clean := filepath.Clean(path)
	// Unix root.
	if clean == "/" {
		return true
	}
	// Windows drive root: exactly "X:\".
	if len(clean) == 3 && clean[1] == ':' && (clean[2] == '\\' || clean[2] == '/') {
		return true
	}
	return false
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
