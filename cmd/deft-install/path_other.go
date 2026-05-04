//go:build !windows

package main

// refreshPathFromRegistry is a no-op on non-Windows platforms. The
// registry-based PATH refresh that compensates for the stale-PATH bug
// behind issue #899 is Windows-specific: macOS and Linux do not have a
// persistent PATH in a registry-style store that diverges from the
// process environment, so there is nothing to merge in.
//
// Returning nil keeps the public surface symmetrical with the Windows
// implementation in path_windows.go and lets callers ignore the error
// uniformly across platforms.
func refreshPathFromRegistry() error {
	return nil
}
