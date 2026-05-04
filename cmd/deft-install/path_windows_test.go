//go:build windows

package main

import (
	"os"
	"strings"
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
