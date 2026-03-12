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

func printUsage() {
	fmt.Fprintf(os.Stderr, `deft-install %s — Deft project installer

Usage:
  deft-install [options]

Options:
  --branch <name>   Clone from a specific branch (default: repo default)
  --debug           Print build target and diagnostic info
  --version         Print version and exit
  --help            Show this help message

Windows-style aliases:
  /branch <name>    Same as --branch
  /debug            Same as --debug
  /v, /version      Same as --version
  /?, /h, /help     Same as --help

User configuration:
  Config directory : %s
  Override via     : DEFT_USER_PATH environment variable

Examples:
  deft-install                  Install using the default branch
  deft-install --branch beta    Install from the beta branch
  deft-install /branch beta     Same, Windows-style
`, version, UserConfigDir())
}

// normalizeArgs rewrites Windows-style /flag arguments into --flag form
// so the standard flag package can parse them.
func normalizeArgs(args []string) []string {
	slashFlags := map[string]string{
		"/?":       "--help",
		"/h":       "--help",
		"/help":    "--help",
		"/v":       "--version",
		"/version": "--version",
		"/debug":   "--debug",
		"/branch":  "--branch",
	}
	out := make([]string, 0, len(args))
	for _, a := range args {
		if repl, ok := slashFlags[a]; ok {
			out = append(out, repl)
		} else {
			out = append(out, a)
		}
	}
	return out
}

func main() {
	// Rewrite Windows-style /flags to --flags so the flag package handles them.
	os.Args = append(os.Args[:1], normalizeArgs(os.Args[1:])...)

	showVersion := flag.Bool("version", false, "print version and exit")
	debug := flag.Bool("debug", false, "print build target and diagnostic info")
	branch := flag.String("branch", "", "clone from a specific branch")
	flag.Usage = printUsage
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
	if err := CloneDeft(w, result, *branch); err != nil {
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
