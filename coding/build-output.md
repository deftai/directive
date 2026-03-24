# Build Output Validation

Rules for validating build output artifacts after custom build scripts run.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**:
- [coding.md](../coding/coding.md) — Build Automation section
- [testing.md](../coding/testing.md) — Build Output Tests section

## Artifact Verification

- ! After running a custom build script, verify expected output files exist and are non-empty
- ! When a build script copies/transforms non-compiled assets (manifests, configs, extension metadata), verify those files are present and structurally valid in the output directory
- ! A build that exits 0 but produces stale or incomplete artifacts is a silent failure — treat it as a build failure (#105)
- ~ Verify required keys/fields are present in structured output files (JSON manifests, config files, etc.)
- ⊗ Assume a zero-exit-code build produced correct output without checking

## Smoke Tests

- ~ Build scripts that produce `dist/` artifacts have a smoke test verifying expected output files exist and contain expected content
- ~ See [testing.md](../coding/testing.md#build-output-tests) for test type guidance and examples
