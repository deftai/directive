//go:build windows

package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

// Registry primitives.
//
// We use vanilla syscall + advapi32.dll directly rather than pulling in the
// golang.org/x/sys/windows/registry module so this fix does not introduce a
// new third-party dependency on go.mod (the deft module currently has zero
// non-stdlib deps -- see go.mod). The same pattern is already used by
// drives_windows.go, which loads kernel32.dll via syscall.NewLazyDLL.
const (
	hkeyLocalMachine = syscall.Handle(0x80000002)
	hkeyCurrentUser  = syscall.Handle(0x80000001)

	regSZ       = 1
	regExpandSZ = 2

	keyRead = 0x20019

	errorSuccess = 0
)

var (
	advapi32             = syscall.NewLazyDLL("advapi32.dll")
	procRegOpenKeyExW    = advapi32.NewProc("RegOpenKeyExW")
	procRegQueryValueExW = advapi32.NewProc("RegQueryValueExW")
	procRegCloseKey      = advapi32.NewProc("RegCloseKey")

	// kernel32 is declared in drives_windows.go (same package) -- reuse
	// that LazyDLL handle so we don't double-load the DLL. We only need
	// our own NewProc binding for ExpandEnvironmentStringsW.
	procExpandEnvironmentStringsW = kernel32.NewProc("ExpandEnvironmentStringsW")
)

// systemEnvSubKey and userEnvSubKey are the registry subkeys that hold the
// persistent system-wide and per-user PATH variables. These are part of a
// shared registry-key contract with the parallel scripts/refresh-path.ps1
// helper landing under issue #902 -- both helpers MUST read from these exact
// paths so that a Go-side refresh and a PowerShell-side refresh observe the
// same persistent state.
const (
	systemEnvSubKey = `System\CurrentControlSet\Control\Session Manager\Environment`
	userEnvSubKey   = `Environment`
	pathValueName   = "Path"
)

// refreshPathFromRegistry reads the persistent PATH values from the system
// (HKLM) and user (HKCU) registry hives, merges them with system entries
// first, de-duplicates while preserving order, and updates the running
// process's PATH environment variable so subsequent exec.LookPath calls see
// recently-installed binaries.
//
// This is the compensating control for the stale-PATH bug behind issue #899:
// the silent Git-for-Windows installer mutates the registry PATH but the
// running deft-install process keeps its startup PATH snapshot, so the
// post-install gitAvailable() probe always failed on a clean Windows box
// without this refresh.
func refreshPathFromRegistry() error {
	systemPath, sysErr := readRegistryString(hkeyLocalMachine, systemEnvSubKey, pathValueName)
	userPath, usrErr := readRegistryString(hkeyCurrentUser, userEnvSubKey, pathValueName)

	// If both reads fail we surface a single error and leave the in-process
	// PATH unchanged. A missing user PATH key is normal on a fresh profile,
	// so a single failure is treated as "empty user PATH" and the merge
	// proceeds.
	if sysErr != nil && usrErr != nil {
		return fmt.Errorf("read system PATH: %v; read user PATH: %v", sysErr, usrErr)
	}

	merged := mergePaths(systemPath, userPath)
	if merged == "" {
		return nil
	}
	return os.Setenv("PATH", merged)
}

// mergePaths concatenates the system and user PATH lists with system entries
// first, splits on the platform list separator, drops empty fragments, and
// removes duplicates while preserving first-seen order. Comparison is
// case-insensitive to match Windows filesystem semantics so that
// `C:\Windows` and `c:\windows` are correctly recognised as the same entry.
func mergePaths(systemPath, userPath string) string {
	sep := string(os.PathListSeparator)

	combined := systemPath
	switch {
	case combined == "" && userPath != "":
		combined = userPath
	case combined != "" && userPath != "":
		combined = combined + sep + userPath
	}
	if combined == "" {
		return ""
	}

	parts := strings.Split(combined, sep)
	seen := make(map[string]struct{}, len(parts))
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			continue
		}
		key := strings.ToLower(p)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, p)
	}
	return strings.Join(out, sep)
}

// readRegistryString opens the given registry subkey and reads the named
// REG_SZ or REG_EXPAND_SZ value as a Go string. The two-call pattern (size
// query, then read) is the canonical Win32 approach for variable-length
// registry values.
func readRegistryString(hkey syscall.Handle, subKey, valueName string) (string, error) {
	subKeyPtr, err := syscall.UTF16PtrFromString(subKey)
	if err != nil {
		return "", err
	}

	var k syscall.Handle
	r0, _, _ := procRegOpenKeyExW.Call(
		uintptr(hkey),
		uintptr(unsafe.Pointer(subKeyPtr)),
		0,
		uintptr(keyRead),
		uintptr(unsafe.Pointer(&k)),
	)
	if r0 != errorSuccess {
		return "", fmt.Errorf("RegOpenKeyEx %s: error %d", subKey, r0)
	}
	defer procRegCloseKey.Call(uintptr(k))

	valuePtr, err := syscall.UTF16PtrFromString(valueName)
	if err != nil {
		return "", err
	}

	// First call: query buffer size (in bytes).
	var (
		valType uint32
		dataLen uint32
	)
	r0, _, _ = procRegQueryValueExW.Call(
		uintptr(k),
		uintptr(unsafe.Pointer(valuePtr)),
		0,
		uintptr(unsafe.Pointer(&valType)),
		0,
		uintptr(unsafe.Pointer(&dataLen)),
	)
	if r0 != errorSuccess {
		return "", fmt.Errorf("RegQueryValueEx size %s\\%s: error %d", subKey, valueName, r0)
	}
	if valType != regSZ && valType != regExpandSZ {
		return "", fmt.Errorf("unexpected registry value type %d for %s\\%s", valType, subKey, valueName)
	}
	if dataLen == 0 {
		return "", nil
	}

	// dataLen is in bytes; allocate a UTF-16 buffer of the right length.
	buf := make([]uint16, (dataLen+1)/2)
	r0, _, _ = procRegQueryValueExW.Call(
		uintptr(k),
		uintptr(unsafe.Pointer(valuePtr)),
		0,
		uintptr(unsafe.Pointer(&valType)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&dataLen)),
	)
	if r0 != errorSuccess {
		return "", fmt.Errorf("RegQueryValueEx read %s\\%s: error %d", subKey, valueName, r0)
	}

	// REG_EXPAND_SZ values store literal %TOKEN% references that the
	// caller must expand before consuming. The HKLM system PATH hive is
	// almost universally stored as REG_EXPAND_SZ on real Windows hosts
	// and contains tokens like %SystemRoot%\system32; without expansion
	// the merged PATH we hand to os.Setenv contains literal %VAR%
	// strings and exec.LookPath fails to resolve any binary whose
	// registry PATH entry uses an env-var reference (#907 P1).
	if valType == regExpandSZ {
		return expandEnvStringsW(buf)
	}
	return syscall.UTF16ToString(buf), nil
}

// expandEnvStringsW wraps the Win32 ExpandEnvironmentStringsW API. It
// takes a UTF-16 buffer (typically the raw bytes returned by
// RegQueryValueExW for a REG_EXPAND_SZ value) and returns the string
// with %VAR% tokens expanded against the current process environment.
//
// Behaviour notes (matching Win32 documented semantics):
//
//   - An empty input returns an empty string with no error.
//   - A string with no %VAR% tokens is returned unchanged.
//   - Unmatched / unknown %VAR% tokens are left in place rather than
//     causing an error. ExpandEnvironmentStringsW does not raise on
//     these.
//   - The returned size from the first (size-query) call includes the
//     terminating NUL; the second call writes a NUL-terminated buffer
//     and syscall.UTF16ToString stops at the first NUL.
func expandEnvStringsW(src []uint16) (string, error) {
	if len(src) == 0 || src[0] == 0 {
		return "", nil
	}

	// First call: ask for the required destination buffer size in
	// WCHARs (including the trailing NUL). A return of 0 indicates a
	// genuine API failure.
	n, _, callErr := procExpandEnvironmentStringsW.Call(
		uintptr(unsafe.Pointer(&src[0])),
		0,
		0,
	)
	if n == 0 {
		return "", fmt.Errorf("ExpandEnvironmentStringsW size query failed: %v", callErr)
	}

	dst := make([]uint16, n)
	n2, _, callErr := procExpandEnvironmentStringsW.Call(
		uintptr(unsafe.Pointer(&src[0])),
		uintptr(unsafe.Pointer(&dst[0])),
		uintptr(n),
	)
	if n2 == 0 {
		return "", fmt.Errorf("ExpandEnvironmentStringsW expand failed: %v", callErr)
	}
	return syscall.UTF16ToString(dst), nil
}
