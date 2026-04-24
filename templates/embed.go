// Package templates exposes the deft template files as build-time embedded
// assets. Embedding from the templates/ directory keeps templates/agents-entry.md
// as the single canonical source of truth for the AGENTS.md body that the Go
// installer, task agents:init, and QUICK-START.md all emit.
//
// Editing templates/agents-entry.md alone is sufficient to change what the
// installer writes -- no Go file edit required (closes #636).
package templates

import _ "embed"

// AgentsEntry is the canonical AGENTS.md entry body written into consumer
// projects by cmd/deft-install. It is embedded at build time from
// templates/agents-entry.md via //go:embed so the installer can never drift
// from the template on disk. The accompanying drift test in embed_test.go
// asserts that the embedded bytes equal the file on disk so CI fails if the
// embed target is removed or the path is reorganised.
//
//go:embed agents-entry.md
var AgentsEntry string
