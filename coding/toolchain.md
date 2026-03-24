# Toolchain Validation

Rules for verifying that required tools are installed and functional before beginning implementation.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**:
- [coding.md](coding.md) — Build Automation section
- [build-output.md](build-output.md) — post-build artifact validation

## Pre-Implementation Gate

- ! Before beginning implementation, verify all required toolchain components are installed and functional
- ! Required components vary by project — at minimum verify: task runner, language compiler/runtime, and platform SDK if applicable
- ! If any required tool is missing or non-functional, stop and report — do not proceed with implementation
- ⊗ Assume a tool is available because it was present in a previous session or referenced in the spec
- ⊗ Proceed with implementation when the build or test toolchain is unavailable

## What to Verify

- ! Task runner: `task --version` (required for quality gates)
- ! Language runtime/compiler: e.g. `go version`, `python --version`, `node --version`, `swift --version`
- ! Platform SDK (if applicable): e.g. `xcode-select -p` for iOS/macOS, Android SDK path for Android
- ! Project-specific tools listed in PROJECT.md or SPECIFICATION.md

## On Missing Tools

- ! Report exactly which tools are missing and provide install guidance
- ! Do not partially implement using available tools while skipping quality gates
- ~ Offer to help install missing tools if the user consents
