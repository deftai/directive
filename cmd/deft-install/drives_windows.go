//go:build windows

package main

import (
	"fmt"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procGetLogicalDrives = kernel32.NewProc("GetLogicalDrives")
	procGetDriveType     = kernel32.NewProc("GetDriveTypeW")
	procGetVolInfo       = kernel32.NewProc("GetVolumeInformationW")
	procGetDiskFreeSpace = kernel32.NewProc("GetDiskFreeSpaceExW")
)

const driveFixed = 3

// DriveInfo describes a fixed drive visible to the installer.
type DriveInfo struct {
	Letter string
	Label  string
	FreeGB float64
}

// EnumerateDrives returns all fixed drives with their labels and free space.
func EnumerateDrives() ([]DriveInfo, error) {
	// procGetLogicalDrives returns a bitmask of drive letters in r1; r3 is
	// the Win32 LastError. Per the Win32 contract, a non-zero r1 is success
	// even when r3 carries a non-nil syscall.Errno (LazyProc.Call surfaces
	// the LastError unconditionally). Only inspect the error when r1 == 0
	// so we don't false-positive on a successful call (#1281).
	mask, _, callErr := procGetLogicalDrives.Call()
	if mask == 0 {
		return nil, fmt.Errorf("GetLogicalDrives returned 0: %v", callErr)
	}

	var drives []DriveInfo
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		letter := string(rune('A' + i))
		root := letter + ":\\"
		rootPtr, err := syscall.UTF16PtrFromString(root)
		if err != nil {
			// syscall.UTF16PtrFromString only fails when the input
			// contains an embedded NUL byte; that can't happen for a
			// drive-letter root like "C:\\", but skip rather than panic
			// if someone hand-constructs a pathological enumeration
			// (#1281).
			continue
		}

		// Only include fixed drives.
		dt, _, _ := procGetDriveType.Call(uintptr(unsafe.Pointer(rootPtr)))
		if dt != driveFixed {
			continue
		}

		info := DriveInfo{Letter: letter}

		// Volume label.
		labelBuf := make([]uint16, 256)
		ret, _, _ := procGetVolInfo.Call(
			uintptr(unsafe.Pointer(rootPtr)),
			uintptr(unsafe.Pointer(&labelBuf[0])),
			uintptr(len(labelBuf)),
			0, 0, 0, 0, 0,
		)
		if ret != 0 {
			info.Label = syscall.UTF16ToString(labelBuf)
		}

		// Free space.
		var freeBytes uint64
		ret, _, _ = procGetDiskFreeSpace.Call(
			uintptr(unsafe.Pointer(rootPtr)),
			uintptr(unsafe.Pointer(&freeBytes)),
			0, 0,
		)
		if ret != 0 {
			info.FreeGB = float64(freeBytes) / (1024 * 1024 * 1024)
		}

		drives = append(drives, info)
	}

	if len(drives) == 0 {
		return nil, fmt.Errorf("no fixed drives found")
	}
	return drives, nil
}

func (w *Wizard) selectStartingLocation() (string, error) {
	drives, err := EnumerateDrives()
	if err != nil {
		return "", err
	}

	// Single drive — skip the menu.
	if len(drives) == 1 {
		if w.debug {
			w.printf("[debug] single drive %s:, skipping selection\n", drives[0].Letter)
		}
		return drives[0].Letter + ":\\", nil
	}

	// Default to the drive with the most free space.
	bestIdx := 0
	for i, d := range drives {
		if d.FreeGB > drives[bestIdx].FreeGB {
			bestIdx = i
		}
	}

	for {
		w.printf("Select a drive:\n")
		for i, d := range drives {
			label := d.Label
			if label == "" {
				label = "Local Disk"
			}
			w.printf("  %d. %s: (%s) — %.1f GB free\n", i+1, d.Letter, label, d.FreeGB)
		}
		exitIdx := len(drives) + 1
		w.printf("  %d. Exit\n", exitIdx)
		w.printf("\nChoice [%d]: ", bestIdx+1)

		input, err := w.readLine()
		if err != nil {
			return "", err
		}

		choice := bestIdx + 1
		input = strings.TrimSpace(input)
		if input != "" {
			choice, err = strconv.Atoi(input)
			if err != nil || choice < 1 || choice > exitIdx {
				w.printf("Invalid choice. Please enter a number between 1 and %d.\n\n", exitIdx)
				continue
			}
		}

		if choice == exitIdx {
			if w.confirmExit() {
				return "", errUserExit
			}
			continue
		}

		return drives[choice-1].Letter + ":\\", nil
	}
}
