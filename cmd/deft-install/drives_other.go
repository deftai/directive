//go:build !windows

package main

import (
	"fmt"
	"os"
)

// DriveInfo describes a fixed drive (unused on non-Windows platforms).
type DriveInfo struct {
	Letter string
	Label  string
	FreeGB float64
}

// EnumerateDrives is a no-op on non-Windows platforms.
func EnumerateDrives() ([]DriveInfo, error) {
	return nil, nil
}

func (w *Wizard) selectStartingLocation() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("could not determine home directory: %w", err)
	}
	return home, nil
}
