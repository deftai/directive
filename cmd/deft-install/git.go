package main

import (
	"crypto/sha256"
	"encoding/hex"
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

// ---------------------------------------------------------------------------
// Git-for-Windows trust anchor (#2908 / tracker #2904, finding install-deposit-01)
// ---------------------------------------------------------------------------
//
// The Windows fallback path downloads the Git-for-Windows 64-bit installer and
// runs it /SILENT /NORESTART. Historically the download resolved GitHub's
// "latest" release and executed it with TLS + GitHub-latest as the ONLY trust
// signal -- a compromised release/asset or a MitM yielded arbitrary code
// execution as the installing user. This build instead pins a single
// known-good release and verifies the downloaded bytes against a hard-coded
// SHA-256 BEFORE any execution, failing closed on mismatch.
//
// Bumping the pinned git version requires updating ALL of the constants below
// together (tag, winget version, asset name) AND the pinned digest var. The
// digest was captured out-of-band at pin time and cross-checked against BOTH
// the GitHub release asset `digest` field and the Git-for-Windows-published
// SHA-256 in the release body for tag v2.55.0.windows.3.
const (
	// pinnedGitForWindowsTag is the Git-for-Windows release tag whose 64-bit
	// installer asset is trusted by this build.
	pinnedGitForWindowsTag = "v2.55.0.windows.3"

	// pinnedGitForWindowsVersion is the winget (Git.Git) package version that
	// corresponds to pinnedGitForWindowsTag. Used to pin the preferred winget
	// install so it cannot silently pull an unexpected version.
	pinnedGitForWindowsVersion = "2.55.0.3"

	// pinnedGitForWindowsAsset is the EXACT 64-bit installer asset name we will
	// download from the pinned release. Matching by exact name (not a
	// "-64-bit.exe" suffix scan) removes asset-name ambiguity as an attack
	// surface.
	pinnedGitForWindowsAsset = "Git-2.55.0.3-64-bit.exe"
)

// pinnedGitForWindowsSHA256 is the known-good lowercase-hex SHA-256 of
// pinnedGitForWindowsAsset. It is the trust anchor for the silent install and
// is a var ONLY so the fail-closed / pass-through unit tests can substitute a
// digest for synthetic fixture bytes; production never mutates it.
var pinnedGitForWindowsSHA256 = "af12577d0fdff74243a5988197aa49b957d5044edc17004f6ddf0768996f1dca"

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
	lookPathFunc                  = exec.LookPath
	runCmdFunc                    = defaultRunCmd
	downloadGitInstallerFunc      = downloadGitInstaller
	refreshPathFunc               = refreshPathFromRegistry
	resolvePinnedInstallerURLFunc = resolvePinnedInstallerURL
	fetchInstallerToTempFunc      = fetchInstallerToTemp
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
	// Attempt 1: winget (Windows 11 + updated Windows 10), pinned to the
	// known-good package version (#2908). Pinning the winget version keeps the
	// preferred install path consistent with the digest-verified download
	// fallback and prevents winget from silently resolving an unexpected
	// version. If the pinned version is unavailable winget fails and we fall
	// through to the SHA-256-verified download below -- which is itself
	// fail-closed -- so there is no less-safe path.
	w.printf("Trying to install git via winget (pinned %s)...\n", pinnedGitForWindowsVersion)
	if err := runCmdFunc(w.out, "winget", "install", "--id", "Git.Git", "-e",
		"--version", pinnedGitForWindowsVersion, "--source", "winget"); err == nil {
		return nil
	}
	w.printf("winget not available or failed. Downloading pinned git installer...\n\n")

	// Attempt 2: download installer from GitHub.
	if err := downloadGitInstallerFunc(w); err != nil {
		w.printf("\nAutomatic installation failed.\n")
		w.printf("Please download and install git manually from:\n")
		w.printf("  https://git-scm.com/download/win\n\n")
		return fmt.Errorf("could not install git automatically")
	}
	return nil
}

// downloadGitInstaller resolves the PINNED Git-for-Windows release, downloads
// its 64-bit installer, verifies the bytes against the hard-coded SHA-256, and
// only then runs it silently. Verification is fail-closed: on any digest
// mismatch (or hashing error) the installer is NOT executed and the temp file
// is removed (#2908 / install-deposit-01).
func downloadGitInstaller(w *Wizard) error {
	dlURL, err := resolvePinnedInstallerURLFunc(w)
	if err != nil {
		return err
	}

	tmpPath, err := fetchInstallerToTempFunc(w, dlURL)
	if err != nil {
		return err
	}
	// Always clean up the downloaded installer -- including on the success
	// path, since the Windows installer invocation below is synchronous
	// (/SILENT) -- and on every fail-closed verification branch so a rejected
	// (potentially tampered) binary is never left on disk.
	defer os.Remove(tmpPath)

	// FAIL-CLOSED trust gate (#2908): verify the downloaded bytes against the
	// pinned SHA-256 BEFORE exec. A compromised release/asset or a MitM that
	// alters the payload changes the digest and is refused here, before any
	// code runs.
	if err := verifyFileSHA256(tmpPath, pinnedGitForWindowsSHA256); err != nil {
		return fmt.Errorf("refusing to run unverified git installer (pinned %s): %w",
			pinnedGitForWindowsTag, err)
	}
	w.printf("Verified installer SHA-256 against pinned %s.\n", pinnedGitForWindowsTag)

	w.printf("Running git installer (silent)...\n")
	return runCmdFunc(w.out, tmpPath, "/SILENT", "/NORESTART")
}

// resolvePinnedInstallerURL fetches the PINNED release (by tag, not "latest")
// and returns the browser download URL for the exact pinned 64-bit asset. It
// fails if the pinned tag or asset is absent so we never silently drift to a
// different release than the one whose digest we trust.
func resolvePinnedInstallerURL(w *Wizard) (string, error) {
	w.printf("Resolving pinned git release %s ...\n", pinnedGitForWindowsTag)

	releaseAPIURL := "https://api.github.com/repos/git-for-windows/git/releases/tags/" + pinnedGitForWindowsTag
	resp, err := installerHTTPClient.Get(releaseAPIURL)
	if err != nil {
		return "", fmt.Errorf("failed to fetch pinned git release %s: %w", pinnedGitForWindowsTag, err)
	}
	defer resp.Body.Close()
	// An unchecked non-2xx response (e.g. a GitHub anonymous rate-limit 403 or
	// a 404 for a mistyped tag) would decode cleanly into an empty release{}
	// struct and surface as the generic "asset not found" error far
	// downstream. Fail fast with the real HTTP status.
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("GET %s: HTTP %s", releaseAPIURL, resp.Status)
	}

	var release struct {
		Assets []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return "", fmt.Errorf("failed to parse pinned release info: %w", err)
	}

	// Match the EXACT pinned asset name -- not a "-64-bit.exe" suffix scan --
	// so asset-name ambiguity is not an attack surface. The digest is still
	// the authoritative gate, but resolving the precise asset keeps the
	// download aligned with the pinned digest.
	for _, a := range release.Assets {
		if a.Name == pinnedGitForWindowsAsset {
			return a.BrowserDownloadURL, nil
		}
	}
	return "", fmt.Errorf("pinned git installer asset %q not found in release %s",
		pinnedGitForWindowsAsset, pinnedGitForWindowsTag)
}

// fetchInstallerToTemp downloads dlURL to a unique temp .exe and returns its
// path. The caller owns cleanup of the returned path. On any error the partial
// temp file is removed so a failed download never leaves an unverified binary
// on disk.
func fetchInstallerToTemp(w *Wizard, dlURL string) (string, error) {
	w.printf("Downloading %s ...\n", dlURL)
	// Use the dedicated installerDownloadClient for the large GET so the body
	// stream is not killed by a 60s whole-request deadline on slow links
	// (#1303 review, windows-security #2).
	resp, err := installerDownloadClient.Get(dlURL)
	if err != nil {
		return "", fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	// Without this check a 4xx/5xx body (HTML error page, JSON error blob,
	// etc.) was being written to the installer file and then executed. Refuse
	// to proceed on non-2xx (#1303 review, windows-security #1).
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("GET %s: HTTP %s", dlURL, resp.Status)
	}

	// os.CreateTemp so two concurrent `deft-install` runs in the same user
	// account do not race on a static path; the "*" is expanded to a unique
	// suffix and the ".exe" trailer is preserved so the silent installer still
	// runs (#1303 review, windows-security #5).
	f, err := os.CreateTemp(os.TempDir(), "deft-git-installer-*.exe")
	if err != nil {
		return "", fmt.Errorf("could not create temp file: %w", err)
	}
	tmpPath := f.Name()
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("download interrupted: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("could not finalize download: %w", err)
	}
	return tmpPath, nil
}

// verifyFileSHA256 hashes the file at path and compares it, case-insensitively,
// against wantHex (an optional "sha256:" prefix is tolerated). It returns a
// descriptive error on any open/read failure or digest mismatch so callers can
// fail closed. This is the single trust gate for the silent Git-for-Windows
// install (#2908).
func verifyFileSHA256(path, wantHex string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("cannot open installer for verification: %w", err)
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("cannot hash installer: %w", err)
	}
	got := hex.EncodeToString(h.Sum(nil))
	want := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(wantHex), "sha256:"))
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("installer SHA-256 mismatch: got %s, want %s", got, want)
	}
	return nil
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
