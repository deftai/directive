package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
)

// version is set at build time via ldflags:
//
//	go build -ldflags "-X main.version=v1.0.0" ./cmd/deft-install/
var version = "dev"

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	debug := flag.Bool("debug", false, "print build target and diagnostic info")
	flag.Parse()

	if *showVersion {
		fmt.Printf("deft-install %s\n", version)
		return
	}

	if *debug {
		fmt.Printf("[debug] OS=%s ARCH=%s\n", runtime.GOOS, runtime.GOARCH)
	}

	w := NewWizard(os.Stdin, os.Stdout, *debug)
	result, err := w.Run()
	if err != nil {
		if err == errUserExit {
			fmt.Println("\nGoodbye!")
			return
		}
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if *debug {
		fmt.Printf("[debug] project=%s deft=%s\n", result.ProjectDir, result.DeftDir)
	}

	// Phase 3: ensure git is available.
	if err := EnsureGit(w); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Phase 4: clone deft and set up the project.
	if err := CloneDeft(w, result); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if err := WriteAgentsMD(w, result.ProjectDir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	configDir, err := CreateUserConfigDir(w)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	PrintNextSteps(w, result, configDir)
}
