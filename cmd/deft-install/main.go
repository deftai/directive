package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
)

func main() {
	debug := flag.Bool("debug", false, "print build target and diagnostic info")
	flag.Parse()

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

	// Phases 3–4 will continue from here.
	_ = result
}
