package main

import (
	"flag"
	"fmt"
	"runtime"
)

func main() {
	debug := flag.Bool("debug", false, "print build target and diagnostic info")
	flag.Parse()

	if *debug {
		fmt.Printf("[debug] OS=%s ARCH=%s\n", runtime.GOOS, runtime.GOARCH)
	}

	fmt.Println("Welcome to Deft!")
	fmt.Println("AI coding standards, installed in seconds.")
}
