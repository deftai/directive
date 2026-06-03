package main

import (
	"encoding/json"
	"encoding/xml"
	"os"
	"strings"
	"testing"
)

// These tests are the acceptance check for issue #1441: the released Windows
// installer binaries must embed an application manifest declaring
// `requestedExecutionLevel level="asInvoker"` so Windows' installer-detection
// heuristic does not auto-elevate the install-*.exe asset (which would pop a
// UAC prompt and break headless `deft-install --yes ...` runs).
//
// The checks are intentionally platform-independent (no build constraints) so
// they run on the Linux release/CI runners that actually cross-compile the
// Windows binaries -- the committed .syso files are what `go build` links, so
// CI must guard them even though it never executes the Windows binary.

const (
	manifestFile    = "deft-install.manifest"
	versionInfoFile = "versioninfo.json"
	sysoAMD64       = "resource_windows_amd64.syso"
	sysoARM64       = "resource_windows_arm64.syso"
)

// manifestXML models just enough of the Win32 application manifest to assert
// the requested execution level. encoding/xml matches on local element names
// when the struct tag omits a namespace, so the asm.v1/asm.v3 namespaces in
// the manifest do not need to be spelled out here.
type manifestXML struct {
	XMLName   xml.Name `xml:"assembly"`
	TrustInfo struct {
		Security struct {
			RequestedPrivileges struct {
				RequestedExecutionLevel struct {
					Level    string `xml:"level,attr"`
					UIAccess string `xml:"uiAccess,attr"`
				} `xml:"requestedExecutionLevel"`
			} `xml:"requestedPrivileges"`
		} `xml:"security"`
	} `xml:"trustInfo"`
}

func TestManifestDeclaresAsInvoker(t *testing.T) {
	data, err := os.ReadFile(manifestFile)
	if err != nil {
		t.Fatalf("reading %s: %v", manifestFile, err)
	}
	var m manifestXML
	if err := xml.Unmarshal(data, &m); err != nil {
		t.Fatalf("parsing %s: %v", manifestFile, err)
	}
	level := m.TrustInfo.Security.RequestedPrivileges.RequestedExecutionLevel.Level
	if level != "asInvoker" {
		t.Errorf("requestedExecutionLevel level = %q, want %q (UAC auto-elevation must stay disabled, #1441)", level, "asInvoker")
	}
	uiAccess := m.TrustInfo.Security.RequestedPrivileges.RequestedExecutionLevel.UIAccess
	if uiAccess != "false" {
		t.Errorf("requestedExecutionLevel uiAccess = %q, want %q", uiAccess, "false")
	}
}

// versionInfoConfig captures the goversioninfo field that wires the manifest
// into the generated .syso resources.
type versionInfoConfig struct {
	ManifestPath string `json:"ManifestPath"`
}

func TestVersionInfoReferencesManifest(t *testing.T) {
	data, err := os.ReadFile(versionInfoFile)
	if err != nil {
		t.Fatalf("reading %s: %v", versionInfoFile, err)
	}
	var cfg versionInfoConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("parsing %s: %v", versionInfoFile, err)
	}
	if cfg.ManifestPath != manifestFile {
		t.Errorf("versioninfo.json ManifestPath = %q, want %q (regeneration must embed the asInvoker manifest)", cfg.ManifestPath, manifestFile)
	}
}

// COFF object files begin with a 2-byte little-endian machine type. We assert
// each per-arch .syso carries the matching machine type so `go build` links
// the right object for each GOARCH (a swapped/duplicated file would silently
// ship the wrong resource).
var sysoCases = []struct {
	name        string
	wantMachine [2]byte // little-endian IMAGE_FILE_MACHINE_*
}{
	{sysoAMD64, [2]byte{0x64, 0x86}}, // 0x8664 IMAGE_FILE_MACHINE_AMD64
	{sysoARM64, [2]byte{0x64, 0xAA}}, // 0xAA64 IMAGE_FILE_MACHINE_ARM64
}

func TestSysoResourcesEmbedManifest(t *testing.T) {
	for _, tc := range sysoCases {
		t.Run(tc.name, func(t *testing.T) {
			data, err := os.ReadFile(tc.name)
			if err != nil {
				t.Fatalf("reading %s: %v (run `go generate ./cmd/deft-install/`)", tc.name, err)
			}
			if len(data) < 2 {
				t.Fatalf("%s is too small to be a COFF object (%d bytes)", tc.name, len(data))
			}
			if data[0] != tc.wantMachine[0] || data[1] != tc.wantMachine[1] {
				t.Errorf("%s machine type = 0x%02X%02X, want 0x%02X%02X",
					tc.name, data[1], data[0], tc.wantMachine[1], tc.wantMachine[0])
			}
			// The manifest XML is embedded verbatim as an RT_MANIFEST
			// resource, so the literal "asInvoker" bytes must be present.
			// This catches a stale .syso that no longer matches the manifest.
			if !strings.Contains(string(data), "asInvoker") {
				t.Errorf("%s does not embed the asInvoker manifest; regenerate with `go generate ./cmd/deft-install/`", tc.name)
			}
		})
	}
}
