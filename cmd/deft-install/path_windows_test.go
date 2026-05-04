//go:build windows

package main

import (
	"os"
	"regexp"
	"strings"
	"syscall"
	"testing"
)

// ---------------------------------------------------------------------------
// #899 -- Windows PATH merge: dedup + system-first precedence + edge cases
// ---------------------------------------------------------------------------

func TestMergePaths_TableDriven(t *testing.T) {
	sep := string(os.PathListSeparator)

	tests := []struct {
		name   string
		system string
		user   string
		want   string
	}{
		{
			name:   "both empty",
			system: "",
			user:   "",
			want:   "",
		},
		{
			name:   "user empty -> system unchanged",
			system: `C:\Windows`,
			user:   "",
			want:   `C:\Windows`,
		},
		{
			name:   "system empty -> user unchanged",
			system: "",
			user:   `C:\Users\me\bin`,
			want:   `C:\Users\me\bin`,
		},
		{
			name:   "basic concat with system first",
			system: `C:\Windows`,
			user:   `C:\Users\me\bin`,
			want:   `C:\Windows` + sep + `C:\Users\me\bin`,
		},
		{
			name:   "system-first ordering preserved across multiple entries",
			system: `C:\System32` + sep + `C:\Windows`,
			user:   `C:\UserBin` + sep + `C:\AnotherUserBin`,
			want:   `C:\System32` + sep + `C:\Windows` + sep + `C:\UserBin` + sep + `C:\AnotherUserBin`,
		},
		{
			name:   "exact-duplicate user entry is dropped",
			system: `C:\Windows` + sep + `C:\Windows\System32`,
			user:   `C:\Users\me\bin` + sep + `C:\Windows\System32`,
			want:   `C:\Windows` + sep + `C:\Windows\System32` + sep + `C:\Users\me\bin`,
		},
		{
			name:   "case-insensitive duplicate is dropped (Windows semantics)",
			system: `C:\Windows`,
			user:   `c:\windows`,
			want:   `C:\Windows`,
		},
		{
			name:   "duplicate within system is dropped",
			system: `C:\A` + sep + `C:\B` + sep + `C:\A`,
			user:   "",
			want:   `C:\A` + sep + `C:\B`,
		},
		{
			name:   "empty fragments are dropped",
			system: `C:\A` + sep + sep + `C:\B`,
			user:   "",
			want:   `C:\A` + sep + `C:\B`,
		},
		{
			name:   "trailing separator is dropped",
			system: `C:\A` + sep + `C:\B` + sep,
			user:   "",
			want:   `C:\A` + sep + `C:\B`,
		},
		{
			name:   "first-seen order preserved when system and user share entries",
			system: `C:\A` + sep + `C:\B`,
			user:   `C:\B` + sep + `C:\C` + sep + `C:\A`,
			want:   `C:\A` + sep + `C:\B` + sep + `C:\C`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := mergePaths(tc.system, tc.user)
			if got != tc.want {
				t.Errorf("mergePaths(%q, %q) = %q, want %q",
					tc.system, tc.user, got, tc.want)
			}
		})
	}
}

// TestMergePaths_SystemBeforeUser pins the precedence contract: a user
// entry that does NOT collide with any system entry MUST appear AFTER all
// system entries in the merged output. This matches Win32's documented
// PATH composition order (HKLM Path, then HKCU Path).
func TestMergePaths_SystemBeforeUser(t *testing.T) {
	sep := string(os.PathListSeparator)
	got := mergePaths(`C:\System1`+sep+`C:\System2`, `C:\User1`+sep+`C:\User2`)
	parts := strings.Split(got, sep)
	if len(parts) != 4 {
		t.Fatalf("expected 4 entries, got %d (%v)", len(parts), parts)
	}
	wantOrder := []string{`C:\System1`, `C:\System2`, `C:\User1`, `C:\User2`}
	for i, want := range wantOrder {
		if parts[i] != want {
			t.Errorf("parts[%d] = %q, want %q (full: %v)", i, parts[i], want, parts)
		}
	}
}

// TestMergePaths_UserCannotOverrideSystemOrdering pins that even when a
// user-PATH entry happens to also exist in the system PATH, the surviving
// entry keeps its system-side position (first-seen wins). This matters
// because Windows resolves PATH lookups left-to-right, so ordering is
// security-relevant: a user-writable directory must NOT shadow a
// system-managed equivalent.
func TestMergePaths_UserCannotOverrideSystemOrdering(t *testing.T) {
	sep := string(os.PathListSeparator)
	system := `C:\Windows\System32` + sep + `C:\Windows`
	user := `C:\Windows` + sep + `C:\Users\me\bin`
	got := mergePaths(system, user)
	parts := strings.Split(got, sep)

	// C:\Windows must appear at index 1 (its system-side position), not
	// at the end where the user re-listed it.
	if len(parts) < 2 || parts[1] != `C:\Windows` {
		t.Errorf("system-side position not preserved: %v", parts)
	}
	// And the case-insensitive dedup must mean it appears exactly once.
	count := 0
	for _, p := range parts {
		if strings.EqualFold(p, `C:\Windows`) {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected exactly 1 occurrence of C:\\Windows, got %d (%v)", count, parts)
	}
}

// TestRefreshPathFromRegistry_OnLiveSystem is a smoke test that exercises
// the real registry read on the host running the tests. It MUST NOT
// error on a normal Windows install -- both HKLM\...\Environment\Path
// and HKCU\Environment\Path are part of the default profile. The test
// snapshots and restores the process PATH so subsequent tests run
// against the same env they observed at startup.
func TestRefreshPathFromRegistry_OnLiveSystem(t *testing.T) {
	original := os.Getenv("PATH")
	defer os.Setenv("PATH", original)

	if err := refreshPathFromRegistry(); err != nil {
		t.Fatalf("refreshPathFromRegistry returned error on live Windows host: %v", err)
	}
	// The merged PATH should be non-empty on any normal Windows install.
	if os.Getenv("PATH") == "" {
		t.Errorf("expected non-empty PATH after refresh, got empty string")
	}
}

// TestRefreshPathFromRegistry_PreservesProcessPathAdditions pins the
// #907 cycle-2 P1 contract: a session-level PATH addition (not present
// in either registry hive) MUST survive the refresh as a tier-3 entry
// rather than being silently dropped. Without this guarantee, CI
// runners (e.g. GitHub Actions) and shell sessions that add tool
// directories to PATH outside the registry lose those entries on the
// first refreshPathFunc() call, breaking subsequent exec.LookPath
// resolution for any binary whose only PATH entry is session-level.
func TestRefreshPathFromRegistry_PreservesProcessPathAdditions(t *testing.T) {
	original := os.Getenv("PATH")
	defer os.Setenv("PATH", original)

	// Pick a clearly synthetic directory unlikely to ever appear in
	// HKLM\...\Environment\Path or HKCU\Environment\Path.
	sentinel := `C:\__deft_test_sentinel_only_in_session_path__\bin`
	newPath := original + string(os.PathListSeparator) + sentinel
	if err := os.Setenv("PATH", newPath); err != nil {
		t.Fatalf("os.Setenv(PATH): %v", err)
	}

	if err := refreshPathFromRegistry(); err != nil {
		t.Fatalf("refreshPathFromRegistry: %v", err)
	}

	got := os.Getenv("PATH")
	parts := strings.Split(got, string(os.PathListSeparator))
	found := false
	for _, p := range parts {
		if strings.EqualFold(p, sentinel) {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("session-level PATH entry %q was dropped by refreshPathFromRegistry; tier-3 fold-in must preserve it (full PATH: %q)",
			sentinel, got)
	}
}

// TestReadRegistryString_SystemPath verifies the helper can read the
// canonical system-PATH registry value end-to-end. This is a defence-
// in-depth probe that catches calling-convention regressions in the
// raw advapi32 syscalls (e.g. wrong UTF-16 buffer sizing).
func TestReadRegistryString_SystemPath(t *testing.T) {
	got, err := readRegistryString(hkeyLocalMachine, systemEnvSubKey, pathValueName)
	if err != nil {
		t.Fatalf("readRegistryString HKLM %s\\Path: %v", systemEnvSubKey, err)
	}
	if got == "" {
		t.Errorf("system PATH read came back empty -- registry should always populate this on Windows")
	}
}

// ---------------------------------------------------------------------------
// #907 P1 -- REG_EXPAND_SZ values must be expanded before being written to
// the process PATH. ExpandEnvironmentStringsW is the only correct way to
// resolve %SystemRoot% / %SYSTEMROOT% / etc. tokens against the current
// process environment. Without this expansion, exec.LookPath fails on
// every binary whose registry PATH entry uses a percent-variable.
// ---------------------------------------------------------------------------

// utf16Of helps test inputs read like the buffer shape that
// readRegistryString hands to expandEnvStringsW: NUL-terminated UTF-16.
func utf16Of(t *testing.T, s string) []uint16 {
	t.Helper()
	if s == "" {
		return nil
	}
	u, err := syscall.UTF16FromString(s)
	if err != nil {
		t.Fatalf("UTF16FromString(%q): %v", s, err)
	}
	return u
}

// withEnv sets an env var for the duration of the test and restores the
// previous value (or unsets the var if it was previously absent) on
// cleanup. Tests that depend on a deterministic env var value MUST go
// through this helper.
func withEnv(t *testing.T, key, value string) {
	t.Helper()
	prev, had := os.LookupEnv(key)
	if err := os.Setenv(key, value); err != nil {
		t.Fatalf("os.Setenv(%q): %v", key, err)
	}
	t.Cleanup(func() {
		if had {
			_ = os.Setenv(key, prev)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

// TestExpandEnvStringsW_TableDriven covers the expansion contract that
// readRegistryString relies on for REG_EXPAND_SZ values. These cases are
// the documented Win32 ExpandEnvironmentStringsW behaviours; we pin
// them here so a future Go upgrade or DLL change cannot silently regress
// us back to the literal-percent bug from #907.
func TestExpandEnvStringsW_TableDriven(t *testing.T) {
	// Make %DEFT_TEST_TOKEN% resolve to a known fixed value for the
	// duration of these tests so we are not depending on the host's
	// SystemRoot value (which differs across machines).
	withEnv(t, "DEFT_TEST_TOKEN", `C:\fixed\value`)

	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "empty input",
			in:   "",
			want: "",
		},
		{
			name: "no tokens passes through unchanged",
			in:   `C:\Program Files\Git\cmd`,
			want: `C:\Program Files\Git\cmd`,
		},
		{
			name: "single token expands",
			in:   `%DEFT_TEST_TOKEN%\bin`,
			want: `C:\fixed\value\bin`,
		},
		{
			name: "multiple tokens in PATH-like string",
			in:   `%DEFT_TEST_TOKEN%\system32;%DEFT_TEST_TOKEN%\Wbem`,
			want: `C:\fixed\value\system32;C:\fixed\value\Wbem`,
		},
		{
			name: "unmatched single percent left in place",
			in:   `100%% literal`,
			want: `100%% literal`,
		},
		{
			name: "unknown token left in place (Win32 contract)",
			in:   `%THIS_VAR_DOES_NOT_EXIST_12345%\x`,
			want: `%THIS_VAR_DOES_NOT_EXIST_12345%\x`,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("expandEnvStringsW panicked on input %q: %v", tc.in, r)
				}
			}()
			got, err := expandEnvStringsW(utf16Of(t, tc.in))
			if err != nil {
				t.Fatalf("expandEnvStringsW(%q) error: %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("expandEnvStringsW(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestExpandEnvStringsW_SystemRootResolves verifies the canonical case
// the #907 P1 fix targets: a registry-style REG_EXPAND_SZ value
// containing %SystemRoot% MUST be expanded against the live env so the
// resulting PATH segment is something exec.LookPath can resolve.
func TestExpandEnvStringsW_SystemRootResolves(t *testing.T) {
	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		t.Skip("SystemRoot is not set on this host; skipping live-env expansion check")
	}
	in := `%SystemRoot%\system32`
	got, err := expandEnvStringsW(utf16Of(t, in))
	if err != nil {
		t.Fatalf("expandEnvStringsW(%q): %v", in, err)
	}
	if strings.Contains(got, "%") {
		t.Errorf("expanded value still contains %%: %q", got)
	}
	if !strings.HasSuffix(strings.ToLower(got), `\system32`) {
		t.Errorf("expanded value %q does not look like a System32 path", got)
	}
}

// TestRefreshPathFromRegistry_NoLiteralPercentTokens is the top-level
// sentinel for the #907 P1 fix: after refreshPathFromRegistry() runs,
// the process PATH MUST NOT contain any literal `%LETTER...` token in
// the system-PATH segment. exec.LookPath does not expand percent-
// variables, so any leftover token is a regression.
//
// Detection regex: a `%` immediately followed by an ASCII letter and
// at least one more identifier character (so `100%%` literal-percent
// pairs collapsed to `%%` are NOT flagged, while real env-var refs
// like `%SystemRoot%` ARE).
func TestRefreshPathFromRegistry_NoLiteralPercentTokens(t *testing.T) {
	original := os.Getenv("PATH")
	defer os.Setenv("PATH", original)

	if err := refreshPathFromRegistry(); err != nil {
		t.Fatalf("refreshPathFromRegistry returned error: %v", err)
	}

	got := os.Getenv("PATH")
	if got == "" {
		t.Fatalf("PATH is empty after refresh; expected populated PATH on Windows host")
	}

	// Match a percent followed by an env-var-like identifier (letter,
	// then more identifier chars). REG_EXPAND_SZ tokens are always of
	// this shape (e.g. %SystemRoot%, %SYSTEMROOT%, %ProgramFiles%).
	percentToken := regexp.MustCompile(`%[A-Za-z][A-Za-z0-9_]*%?`)
	if loc := percentToken.FindStringIndex(got); loc != nil {
		t.Errorf("refreshed PATH contains an unexpanded %%TOKEN%% reference at offset %d: %q (full PATH: %q)",
			loc[0], got[loc[0]:loc[1]], got)
	}
}

// TestReadRegistryString_SystemPathExpanded combines the live registry
// read with the post-expansion contract: HKLM Path is REG_EXPAND_SZ on
// virtually every real Windows install, so the value returned by
// readRegistryString MUST already be expanded -- not literal
// %SystemRoot%.
func TestReadRegistryString_SystemPathExpanded(t *testing.T) {
	got, err := readRegistryString(hkeyLocalMachine, systemEnvSubKey, pathValueName)
	if err != nil {
		t.Fatalf("readRegistryString HKLM %s\\Path: %v", systemEnvSubKey, err)
	}
	if got == "" {
		t.Skip("system PATH is empty on this host; nothing to assert about expansion")
	}
	percentToken := regexp.MustCompile(`%[A-Za-z][A-Za-z0-9_]*%`)
	if tok := percentToken.FindString(got); tok != "" {
		t.Errorf("system PATH from registry still contains literal token %q after readRegistryString: %q",
			tok, got)
	}
}
