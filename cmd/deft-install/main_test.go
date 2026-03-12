package main

import (
	"os"
	"os/exec"
	"testing"
)

func TestMain_Compiles(t *testing.T) {
	// Build the binary to a temp location to confirm the package compiles.
	tmp := t.TempDir()
	out := tmp + string(os.PathSeparator) + "deft-install-test"
	if runtime_goos() == "windows" {
		out += ".exe"
	}

	cmd := exec.Command("go", "build", "-o", out, ".")
	cmd.Dir = "."
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("build failed: %v\n%s", err, output)
	}
}

// runtime_goos returns GOOS without importing runtime in the test to keep it minimal.
func runtime_goos() string {
	if os.PathSeparator == '\\' {
		return "windows"
	}
	return "unix"
}
