package main

// Windows resource embedding for the installer binary (issue #1441).
//
// The two committed `resource_windows_<arch>.syso` files carry an embedded
// application manifest declaring `requestedExecutionLevel level="asInvoker"`,
// which disables Windows' legacy installer-detection auto-elevation heuristic.
// Without it, the release asset (named install-windows-<arch>.exe) triggers a
// UAC prompt purely because its filename contains "install", breaking headless
// `deft-install --yes ...` runs.
//
// The `_windows_<arch>.syso` filename suffix makes `go build` link each object
// ONLY for that GOOS=windows/GOARCH target, so linux/darwin builds (and Linux
// cross-compiles to other targets) are unaffected. The committed .syso files
// are what actually link during release; goversioninfo is needed ONLY to
// regenerate them after editing deft-install.manifest or versioninfo.json.
//
// To regenerate (run from anywhere; `go generate` cd's into this directory):
//
//	go generate ./cmd/deft-install/
//
// goversioninfo is invoked via `go run <pkg>@<ver>` so it never enters go.mod.
//
//go:generate go run github.com/josephspurrier/goversioninfo/cmd/goversioninfo@v1.7.0 -64 -o resource_windows_amd64.syso versioninfo.json
//go:generate go run github.com/josephspurrier/goversioninfo/cmd/goversioninfo@v1.7.0 -64 -arm -o resource_windows_arm64.syso versioninfo.json
