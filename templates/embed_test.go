package templates

import (
	"os"
	"testing"
)

// TestAgentsEntryMatchesFile asserts that the embedded AgentsEntry bytes
// equal the on-disk contents of templates/agents-entry.md at build time.
// This guards against accidental embed-target drift (path reorganisation,
// file deletion, or a silent rename) so CI fails loudly if the installer
// and the canonical template get out of sync (closes #636).
//
// Go tests run with the package directory as the working directory, so
// reading "agents-entry.md" here is equivalent to reading
// templates/agents-entry.md from the repo root.
func TestAgentsEntryMatchesFile(t *testing.T) {
	onDisk, err := os.ReadFile("agents-entry.md")
	if err != nil {
		t.Fatalf("could not read templates/agents-entry.md: %v", err)
	}
	if AgentsEntry != string(onDisk) {
		t.Errorf("embedded AgentsEntry drift from templates/agents-entry.md:\n"+
			"embedded len=%d, on-disk len=%d",
			len(AgentsEntry), len(onDisk))
	}
}

// TestAgentsEntryNonEmpty guards against a future refactor that accidentally
// empties the embedded template (e.g. a renamed embed target that silently
// produces an empty string).
func TestAgentsEntryNonEmpty(t *testing.T) {
	if len(AgentsEntry) == 0 {
		t.Fatal("AgentsEntry is empty -- templates/agents-entry.md embed is broken")
	}
}
