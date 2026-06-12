package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const installerUpdateCheckTimeout = 1500 * time.Millisecond

var (
	installerUpdateCheckClient  = &http.Client{Timeout: installerUpdateCheckTimeout}
	latestInstallerReleaseURL   = "https://api.github.com/repos/deftai/directive/releases/latest"
	fetchLatestInstallerRelease = fetchLatestInstallerReleaseFromGitHub
)

type installerRelease struct {
	TagName     string `json:"tag_name"`
	PublishedAt string `json:"published_at"`
	HTMLURL     string `json:"html_url"`
}

func updateCheckBypassed(flagValue bool) bool {
	return flagValue || osEnvEquals("DEFT_NO_UPDATE_CHECK", "1")
}

func stdinAllowsUpdateCheckPrompt() bool {
	info, err := os.Stdin.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func osEnvEquals(key, value string) bool {
	return strings.TrimSpace(os.Getenv(key)) == value
}

func runInstallerUpdateCheck(w *Wizard, promptAllowed bool) int {
	release, err := fetchLatestInstallerRelease(version)
	if err != nil {
		return handleUnverifiedInstallerVersion(w, promptAllowed, err)
	}

	cmp, err := compareInstallerSemver(version, release.TagName)
	if err != nil {
		return handleUnverifiedInstallerVersion(w, promptAllowed, err)
	}
	if cmp == 0 {
		w.printf("Checking for updates...\n")
		w.printf("[ok] Running latest (%s)\n\n", displayInstallerVersion(version))
		return 0
	}
	if cmp > 0 {
		// Locally built or unpublished binaries should not warn just because
		// their embedded version is ahead of the latest public release.
		return 0
	}

	w.printf("Checking for updates...\n")
	w.printf("[!] You are running deft-install %s\n", displayInstallerVersion(version))
	w.printf("    Latest release is %s (published %s)\n", displayInstallerVersion(release.TagName), formatInstallerReleaseDate(release.PublishedAt))
	w.printf("    Download: %s\n\n", installerReleaseDownloadURL(release))
	if !promptAllowed {
		w.printf("Installer version is stale and stdin is non-interactive. Re-run with --no-update-check or DEFT_NO_UPDATE_CHECK=1 to bypass.\n")
		return 1
	}
	if promptYesNo(w, fmt.Sprintf("Continue with %s anyway? [y/N]: ", displayInstallerVersion(version))) {
		return 0
	}
	w.printf("Aborted.\n")
	return 1
}

func handleUnverifiedInstallerVersion(w *Wizard, promptAllowed bool, cause error) int {
	w.printf("Checking for updates...\n")
	w.printf("[?] Could not verify version (%v)\n", cause)
	w.printf("    You are running %s. Latest version unknown.\n\n", displayInstallerVersion(version))
	if !promptAllowed {
		w.printf("Installer version could not be verified and stdin is non-interactive. Re-run with --no-update-check or DEFT_NO_UPDATE_CHECK=1 to bypass.\n")
		return 1
	}
	if promptYesNo(w, "Continue without verification? [y/N]: ") {
		return 0
	}
	w.printf("Aborted.\n")
	return 1
}

func promptYesNo(w *Wizard, prompt string) bool {
	w.printf("%s", prompt)
	input, err := w.readLine()
	if err != nil {
		return false
	}
	input = strings.TrimSpace(strings.ToLower(input))
	return input == "y" || input == "yes"
}

func fetchLatestInstallerReleaseFromGitHub(installerVersion string) (installerRelease, error) {
	req, err := http.NewRequest(http.MethodGet, latestInstallerReleaseURL, nil)
	if err != nil {
		return installerRelease{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "deft-install/"+displayInstallerVersion(installerVersion))

	resp, err := installerUpdateCheckClient.Do(req)
	if err != nil {
		return installerRelease{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return installerRelease{}, fmt.Errorf("latest release API returned HTTP %s", resp.Status)
	}

	var release installerRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return installerRelease{}, err
	}
	if strings.TrimSpace(release.TagName) == "" {
		return installerRelease{}, errors.New("latest release response did not include tag_name")
	}
	return release, nil
}

func installerReleaseDownloadURL(release installerRelease) string {
	if strings.TrimSpace(release.HTMLURL) != "" {
		return release.HTMLURL
	}
	return "https://github.com/deftai/directive/releases/latest"
}

func formatInstallerReleaseDate(value string) string {
	t, err := time.Parse(time.RFC3339, value)
	if err != nil {
		if strings.TrimSpace(value) == "" {
			return "unknown"
		}
		return value
	}
	return t.UTC().Format("2006-01-02")
}

func displayInstallerVersion(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	if strings.HasPrefix(value, "v") {
		return value
	}
	return "v" + value
}

type installerSemver struct {
	major int
	minor int
	patch int
	pre   []string
}

var installerSemverPattern = regexp.MustCompile(`^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$`)

func compareInstallerSemver(left, right string) (int, error) {
	lv, err := parseInstallerSemver(left)
	if err != nil {
		return 0, err
	}
	rv, err := parseInstallerSemver(right)
	if err != nil {
		return 0, err
	}
	return lv.compare(rv), nil
}

func parseInstallerSemver(value string) (installerSemver, error) {
	m := installerSemverPattern.FindStringSubmatch(strings.TrimSpace(value))
	if m == nil {
		return installerSemver{}, fmt.Errorf("version %q is not SemVer", value)
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	patch, _ := strconv.Atoi(m[3])
	var pre []string
	if m[4] != "" {
		pre = strings.Split(m[4], ".")
	}
	return installerSemver{major: major, minor: minor, patch: patch, pre: pre}, nil
}

func (v installerSemver) compare(other installerSemver) int {
	for _, pair := range [][2]int{{v.major, other.major}, {v.minor, other.minor}, {v.patch, other.patch}} {
		if pair[0] < pair[1] {
			return -1
		}
		if pair[0] > pair[1] {
			return 1
		}
	}
	return compareInstallerPrerelease(v.pre, other.pre)
}

func compareInstallerPrerelease(left, right []string) int {
	if len(left) == 0 && len(right) == 0 {
		return 0
	}
	if len(left) == 0 {
		return 1
	}
	if len(right) == 0 {
		return -1
	}
	for i := 0; i < len(left) && i < len(right); i++ {
		li, lnum := numericPrereleaseIdentifier(left[i])
		ri, rnum := numericPrereleaseIdentifier(right[i])
		switch {
		case lnum && rnum:
			if li < ri {
				return -1
			}
			if li > ri {
				return 1
			}
		case lnum:
			return -1
		case rnum:
			return 1
		default:
			if left[i] < right[i] {
				return -1
			}
			if left[i] > right[i] {
				return 1
			}
		}
	}
	if len(left) < len(right) {
		return -1
	}
	if len(left) > len(right) {
		return 1
	}
	return 0
}

func numericPrereleaseIdentifier(value string) (int, bool) {
	if value == "" {
		return 0, false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(value)
	return n, err == nil
}
