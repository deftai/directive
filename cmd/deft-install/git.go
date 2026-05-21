package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// installerHTTPTimeout bounds the SHORT installer HTTP calls -- specifically
// the GitHub release-metadata API call (#1281). 60s is generous for a small
// JSON response and still bounds the worst-case stall against api.github.com.
//
// Note: this is the whole-request deadline (http.Client.Timeout) and therefore
// MUST NOT be applied to the ~70-100 MB git-for-windows installer download --
// on links slower than ~9.3 Mbps a 60s whole-request timeout aborts the body
// stream mid-flight even though the connection is healthy. The download path
// uses installerDownloadClient instead, which keeps tight transport-level
// timeouts but lets the body stream run to completion.
const installerHTTPTimeout = 60 * time.Second

// installerDownloadConnectTimeout / ...HeaderTimeout / ...TLSHandshakeTimeout
// bound the *connection* and *header* phases of the installer download GET so
// a wedged GitHub edge or a stalled TLS handshake still fails fast, while the
// body-streaming phase is permitted to run for as long as bytes keep flowing.
// installerDownloadOverallTimeout is a backstop ceiling on the whole download
// (15 min) -- long enough for a multi-hundred-MB file on a slow link, short
// enough that a truly stuck stream eventually unwedges the installer.
const (
	installerDownloadConnectTimeout      = 30 * time.Second
	installerDownloadTLSHandshakeTimeout = 30 * time.Second
	installerDownloadHeaderTimeout       = 30 * time.Second
	installerDownloadOverallTimeout      = 15 * time.Minute
)

// installerHTTPClient is the shared *http.Client used for SHORT installer
// HTTP calls (release metadata). It is a var (not a const-shaped struct
// literal at call site) so tests or future flag-driven overrides can swap it
// out without rewriting call sites; the default value is what production uses.
var installerHTTPClient = &http.Client{Timeout: installerHTTPTimeout}

// installerDownloadClient is the shared *http.Client used for the LARGE
// git-for-windows installer download. Unlike installerHTTPClient (which uses
// a tight 60s whole-request deadline appropriate for the small release-metadata
// JSON), this client primarily relies on transport-level timeouts (dial / TLS /
// header) so the body-streaming phase can run as long as bytes keep flowing.
// It DOES set http.Client.Timeout, but only as a generous 15-minute backstop
// against truly wedged streams -- not as a per-request deadline -- so a
// multi-hundred-MB download on a slow link still completes while a hung edge
// eventually unwedges the installer. See the installerDownload*Timeout
// constants above for the per-phase rationale (#1303 review, Greptile #1).
var installerDownloadClient = &http.Client{
	Timeout: installerDownloadOverallTimeout,
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   installerDownloadConnectTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   installerDownloadTLSHandshakeTimeout,
		ResponseHeaderTimeout: installerDownloadHeaderTimeout,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	},
}

// Function variables — replaceable in tests.
var (
	lookPathFunc             = exec.LookPath
	runCmdFunc               = defaultRunCmd
	downloadGitInstallerFunc = downloadGitInstaller
	refreshPathFunc          = refreshPathFromRegistry
)

func defaultRunCmd(out io.Writer, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = out
	cmd.Stderr = out
	return cmd.Run()
}

// EnsureGit checks for git and installs it if missing.
func EnsureGit(w *Wizard) error {
	// Refresh PATH from the persistent registry hives BEFORE the initial
	// probe (#899). exec.LookPath resolves against os.Getenv("PATH") which
	// is the process startup snapshot; on Windows the registry PATH may
	// already include git from a prior install that this process has not
	// picked up. Errors are best-effort: a registry read failure leaves
	// the in-process PATH unchanged and we fall back to the existing probe
	// behaviour. This is a no-op on non-Windows platforms (see
	// path_other.go).
	if err := refreshPathFunc(); err != nil && w.debug {
		w.printf("[debug] refreshPathFromRegistry (pre-probe) failed: %v\n", err)
	}

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

	// Refresh PATH from the persistent registry hives AFTER a successful
	// install but BEFORE the re-check (#899). The silent Git-for-Windows
	// installer mutates the registry PATH but the running deft-install
	// process keeps its startup PATH snapshot; without this refresh the
	// re-check below always fails on a clean Windows box. No-op on
	// non-Windows.
	if err := refreshPathFunc(); err != nil && w.debug {
		w.printf("[debug] refreshPathFromRegistry (post-install) failed: %v\n", err)
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

	const releaseAPIURL = "https://api.github.com/repos/git-for-windows/git/releases/latest"
	resp, err := installerHTTPClient.Get(releaseAPIURL)
	if err != nil {
		return fmt.Errorf("failed to check latest git version: %w", err)
	}
	defer resp.Body.Close()
	// #1303 review (windows-security #1): an unchecked non-2xx response on the
	// release-metadata endpoint -- e.g. a GitHub anonymous rate-limit 403 --
	// would decode cleanly into an empty release{} struct and surface as the
	// generic "could not find git installer" error far downstream. Fail fast
	// with the real HTTP status so users see the actual cause.
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("GET %s: HTTP %s", releaseAPIURL, resp.Status)
	}

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
	// #1303 review (windows-security #2 / correctness): use the dedicated
	// installerDownloadClient for the large GET so the body stream is not
	// killed by a 60s whole-request deadline on slow links.
	resp2, err := installerDownloadClient.Get(dlURL)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer resp2.Body.Close()
	// #1303 review (windows-security #1): without this check a 4xx/5xx body
	// (HTML error page, JSON error blob, etc.) was being written to
	// git-installer.exe and then executed. Refuse to proceed on non-2xx.
	if resp2.StatusCode < 200 || resp2.StatusCode >= 300 {
		return fmt.Errorf("GET %s: HTTP %s", dlURL, resp2.Status)
	}

	// #1303 review (windows-security #5): use os.CreateTemp so two concurrent
	// `deft-install` runs in the same user account do not race on a static
	// %TEMP%\git-installer.exe path. The "*" in the pattern is expanded by
	// CreateTemp to a unique suffix; the ".exe" trailer is preserved so the
	// silent installer still runs.
	f, err := os.CreateTemp(os.TempDir(), "deft-git-installer-*.exe")
	if err != nil {
		return fmt.Errorf("could not create temp file: %w", err)
	}
	tmpPath := f.Name()
	// #1303 review (windows-security #4): always clean up the downloaded
	// installer -- including on the success path, since the Windows installer
	// invocation below is synchronous (/SILENT). On failure paths this avoids
	// leaving stale ~70-100 MB binaries in %TEMP%.
	defer os.Remove(tmpPath)
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
