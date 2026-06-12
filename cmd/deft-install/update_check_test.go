package main

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func withInstallerUpdateCheckStub(t *testing.T, embedded string, fetch func(string) (installerRelease, error)) {
	t.Helper()
	origVersion := version
	origFetch := fetchLatestInstallerRelease
	version = embedded
	fetchLatestInstallerRelease = fetch
	t.Cleanup(func() {
		version = origVersion
		fetchLatestInstallerRelease = origFetch
	})
}

func TestInstallerUpdateCheck_MatchPrintsLatestConfirmation(t *testing.T) {
	withInstallerUpdateCheckStub(t, "v0.45.1", func(gotVersion string) (installerRelease, error) {
		if gotVersion != "v0.45.1" {
			t.Fatalf("fetch saw version %q, want v0.45.1", gotVersion)
		}
		return installerRelease{TagName: "v0.45.1", PublishedAt: "2026-06-12T12:00:00Z"}, nil
	})
	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)

	if code := runInstallerUpdateCheck(w, true); code != 0 {
		t.Fatalf("match path returned %d, want 0", code)
	}
	if !strings.Contains(out.String(), "[ok] Running latest (v0.45.1)") {
		t.Fatalf("match path did not print latest confirmation:\n%s", out.String())
	}
}

func TestInstallerUpdateCheck_MismatchDefaultsToAbort(t *testing.T) {
	withInstallerUpdateCheckStub(t, "v0.20.0-rc.1", func(string) (installerRelease, error) {
		return installerRelease{
			TagName:     "v0.20.2",
			PublishedAt: "2026-04-24T09:30:00Z",
			HTMLURL:     "https://github.com/deftai/directive/releases/tag/v0.20.2",
		}, nil
	})
	var out bytes.Buffer
	w := NewWizard(strings.NewReader("\n"), &out, false)

	if code := runInstallerUpdateCheck(w, true); code != 1 {
		t.Fatalf("empty response should abort stale installer, got code %d", code)
	}
	text := out.String()
	for _, want := range []string{
		"You are running deft-install v0.20.0-rc.1",
		"Latest release is v0.20.2 (published 2026-04-24)",
		"Continue with v0.20.0-rc.1 anyway? [y/N]: ",
		"Aborted.",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("mismatch output missing %q:\n%s", want, text)
		}
	}
}

func TestInstallerUpdateCheck_MismatchCanContinue(t *testing.T) {
	withInstallerUpdateCheckStub(t, "v0.20.0", func(string) (installerRelease, error) {
		return installerRelease{TagName: "v0.20.2", PublishedAt: "2026-04-24T09:30:00Z"}, nil
	})
	var out bytes.Buffer
	w := NewWizard(strings.NewReader("y\n"), &out, false)

	if code := runInstallerUpdateCheck(w, true); code != 0 {
		t.Fatalf("explicit y should continue stale installer, got code %d", code)
	}
}

func TestInstallerUpdateCheck_UnverifiedPromptsAndCanContinue(t *testing.T) {
	withInstallerUpdateCheckStub(t, "v0.45.1", func(string) (installerRelease, error) {
		return installerRelease{}, errors.New("timeout after 1.5s")
	})
	var out bytes.Buffer
	w := NewWizard(strings.NewReader("yes\n"), &out, false)

	if code := runInstallerUpdateCheck(w, true); code != 0 {
		t.Fatalf("explicit yes should continue after unverified check, got code %d", code)
	}
	if !strings.Contains(out.String(), "Could not verify version (timeout after 1.5s)") {
		t.Fatalf("unverified output missing timeout reason:\n%s", out.String())
	}
}

func TestInstallerUpdateCheck_NonTTYStaleFailsWithoutPrompt(t *testing.T) {
	withInstallerUpdateCheckStub(t, "v0.20.0", func(string) (installerRelease, error) {
		return installerRelease{TagName: "v0.20.2", PublishedAt: "2026-04-24T09:30:00Z"}, nil
	})
	var out bytes.Buffer
	w := NewWizard(strings.NewReader("y\n"), &out, false)

	if code := runInstallerUpdateCheck(w, false); code != 1 {
		t.Fatalf("non-TTY stale installer must fail, got code %d", code)
	}
	if strings.Contains(out.String(), "anyway? [y/N]") {
		t.Fatalf("non-TTY stale path must not prompt:\n%s", out.String())
	}
}

func TestInstallerUpdateCheck_BypassSources(t *testing.T) {
	t.Setenv("DEFT_NO_UPDATE_CHECK", "")
	if updateCheckBypassed(false) {
		t.Fatal("empty env and false flag should not bypass")
	}
	if !updateCheckBypassed(true) {
		t.Fatal("--no-update-check flag should bypass")
	}
	t.Setenv("DEFT_NO_UPDATE_CHECK", "1")
	if !updateCheckBypassed(false) {
		t.Fatal("DEFT_NO_UPDATE_CHECK=1 should bypass")
	}
}

func TestInstallerUpdateCheck_HelpAndVersionFlagsNormalizeWithoutNetworkFlag(t *testing.T) {
	got := normalizeArgs([]string{"/version", "/help", "/no-update-check"})
	want := []string{"--version", "--help", "--no-update-check"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("normalizeArgs = %v, want %v", got, want)
	}
}

func TestCompareInstallerSemverPrereleaseOrdering(t *testing.T) {
	tests := []struct {
		left  string
		right string
		want  int
	}{
		{"v0.20.0-rc.1", "v0.20.0", -1},
		{"v0.20.2", "v0.20.0", 1},
		{"0.20.2+build.1", "v0.20.2", 0},
		{"v0.20.0-rc.2", "v0.20.0-rc.10", -1},
	}
	for _, tc := range tests {
		got, err := compareInstallerSemver(tc.left, tc.right)
		if err != nil {
			t.Fatalf("compareInstallerSemver(%q, %q): %v", tc.left, tc.right, err)
		}
		if got != tc.want {
			t.Fatalf("compareInstallerSemver(%q, %q) = %d, want %d", tc.left, tc.right, got, tc.want)
		}
	}
}

func TestFetchLatestInstallerRelease_SendsUserAgent(t *testing.T) {
	origURL := latestInstallerReleaseURL
	origClient := installerUpdateCheckClient
	t.Cleanup(func() {
		latestInstallerReleaseURL = origURL
		installerUpdateCheckClient = origClient
	})

	var userAgent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userAgent = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"tag_name":"v0.45.1","published_at":"2026-06-12T12:00:00Z","html_url":"https://example.test/release"}`))
	}))
	defer server.Close()
	latestInstallerReleaseURL = server.URL
	installerUpdateCheckClient = server.Client()

	release, err := fetchLatestInstallerReleaseFromGitHub("v0.45.1")
	if err != nil {
		t.Fatalf("fetchLatestInstallerReleaseFromGitHub: %v", err)
	}
	if release.TagName != "v0.45.1" {
		t.Fatalf("tag = %q, want v0.45.1", release.TagName)
	}
	if userAgent != "deft-install/v0.45.1" {
		t.Fatalf("User-Agent = %q, want deft-install/v0.45.1", userAgent)
	}
}
