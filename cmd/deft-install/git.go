package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Function variables — replaceable in tests.
var (
	lookPathFunc             = exec.LookPath
	runCmdFunc               = defaultRunCmd
	downloadGitInstallerFunc = downloadGitInstaller
)

func defaultRunCmd(out io.Writer, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = out
	cmd.Stderr = out
	return cmd.Run()
}

// EnsureGit checks for git and installs it if missing.
func EnsureGit(w *Wizard) error {
	if gitAvailable() {
		if w.debug {
			path, _ := lookPathFunc("git")
			w.printf("[debug] git found at %s\n", path)
		}
		return nil
	}

	w.printf("Git is not installed. Let's fix that!\n\n")

	var err error
	switch runtime.GOOS {
	case "windows":
		err = installGitWindows(w)
	case "darwin":
		err = installGitDarwin(w)
	case "linux":
		err = installGitLinux(w)
	default:
		return fmt.Errorf(
			"unsupported platform %s — please install git manually:\n  https://git-scm.com/downloads",
			runtime.GOOS)
	}

	if err != nil {
		return err
	}

	// Re-check after install.
	if !gitAvailable() {
		return fmt.Errorf(
			"git installation completed but git was not found in PATH\n" +
				"You may need to restart your terminal and try again")
	}

	w.printf("Git installed successfully!\n\n")
	return nil
}

func gitAvailable() bool {
	_, err := lookPathFunc("git")
	return err == nil
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

func installGitWindows(w *Wizard) error {
	// Attempt 1: winget (Windows 11 + updated Windows 10).
	w.printf("Trying to install git via winget...\n")
	if err := runCmdFunc(w.out, "winget", "install", "--id", "Git.Git", "-e", "--source", "winget"); err == nil {
		return nil
	}
	w.printf("winget not available or failed. Downloading git installer...\n\n")

	// Attempt 2: download installer from GitHub.
	if err := downloadGitInstallerFunc(w); err != nil {
		w.printf("\nAutomatic installation failed.\n")
		w.printf("Please download and install git manually from:\n")
		w.printf("  https://git-scm.com/download/win\n\n")
		return fmt.Errorf("could not install git automatically")
	}
	return nil
}

func downloadGitInstaller(w *Wizard) error {
	w.printf("Fetching latest git release info...\n")

	resp, err := http.Get("https://api.github.com/repos/git-for-windows/git/releases/latest")
	if err != nil {
		return fmt.Errorf("failed to check latest git version: %w", err)
	}
	defer resp.Body.Close()

	var release struct {
		Assets []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return fmt.Errorf("failed to parse release info: %w", err)
	}

	// Find the 64-bit installer (not the portable edition).
	var dlURL string
	for _, a := range release.Assets {
		if strings.HasSuffix(a.Name, "-64-bit.exe") &&
			!strings.Contains(strings.ToLower(a.Name), "portable") {
			dlURL = a.BrowserDownloadURL
			break
		}
	}
	if dlURL == "" {
		return fmt.Errorf("could not find git installer in latest release")
	}

	w.printf("Downloading %s ...\n", dlURL)
	resp2, err := http.Get(dlURL)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer resp2.Body.Close()

	tmpPath := filepath.Join(os.TempDir(), "git-installer.exe")
	f, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("could not create temp file: %w", err)
	}
	if _, err := io.Copy(f, resp2.Body); err != nil {
		f.Close()
		return fmt.Errorf("download interrupted: %w", err)
	}
	f.Close()

	w.printf("Running git installer (silent)...\n")
	return runCmdFunc(w.out, tmpPath, "/SILENT", "/NORESTART")
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

func installGitDarwin(w *Wizard) error {
	w.printf("On macOS, git comes with the Xcode Command Line Tools.\n")
	w.printf("A system dialog may appear asking you to install developer tools — please approve it.\n\n")

	// Running `git --version` on a fresh Mac triggers the CLT install dialog.
	_ = runCmdFunc(w.out, "git", "--version")

	w.printf("\nPress Enter after the installation completes... ")
	_, _ = w.readLine()

	if gitAvailable() {
		return nil
	}

	w.printf("\nGit was not detected after the Xcode CLT install.\n")
	w.printf("You can also install git via Homebrew:\n")
	w.printf("  brew install git\n\n")
	return fmt.Errorf("git not found after macOS developer tools install")
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

type packageManager struct {
	name string
	args []string
}

var linuxPackageManagers = []packageManager{
	{"apt-get", []string{"install", "-y", "git"}},
	{"dnf", []string{"install", "-y", "git"}},
	{"pacman", []string{"-S", "--noconfirm", "git"}},
	{"zypper", []string{"install", "-y", "git"}},
}

func installGitLinux(w *Wizard) error {
	for _, pm := range linuxPackageManagers {
		if _, err := lookPathFunc(pm.name); err != nil {
			continue
		}
		w.printf("Installing git using %s...\n", pm.name)
		args := append([]string{pm.name}, pm.args...)
		if err := runCmdFunc(w.out, "sudo", args...); err == nil {
			return nil
		}
		w.printf("%s install failed.\n\n", pm.name)
	}

	w.printf("No supported package manager found (tried apt-get, dnf, pacman, zypper).\n")
	w.printf("Please install git manually for your distribution:\n")
	w.printf("  https://git-scm.com/download/linux\n\n")
	return fmt.Errorf("could not install git: no supported package manager found")
}
