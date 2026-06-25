import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectLegacyLayout, type LegacyLayoutKind } from "../init-deposit/legacy-detect.js";
import { buildInstallManifestText } from "../init-deposit/scaffold.js";
import type { SpawnResult } from "../release/types.js";
import { EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import { parseE2EFlags } from "./flags.js";
import * as ghOps from "./gh-ops.js";
import {
  assertInstallerVersionMigrateAcceptable,
  assertLegacyFixturesDetectedAndRefused,
  assertNpmHybridMigration,
  CANONICAL_INSTALLER_MANIFEST_FIELDS,
  downloadAndRunFrozenBridge,
  installerManifestFieldKeys,
  LEGACY_FIXTURES,
  provisionCanonicalVendoredDeposit,
  provisionLegacyFixture,
  runLegacyBridgeLeg,
  selectBridgeAsset,
} from "./legacy-bridge-leg.js";
import { runE2e } from "./main.js";
import * as rehearsalModule from "./rehearsal.js";
import type { E2EConfig, E2ESeams } from "./types.js";

const REAL_AGENTS_TEMPLATE = join(process.cwd(), "content", "templates", "agents-entry.md");

const created: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

/** A `which` seam where only the named binaries resolve. */
function whichFor(...present: string[]): (name: string) => string | null {
  return (name) => (present.includes(name) ? `/usr/bin/${name}` : null);
}

function ok(): SpawnResult {
  return { status: 0, stdout: "", stderr: "" };
}

describe("parseE2EFlags --legacy-bridge", () => {
  it("defaults legacyBridge OFF", () => {
    expect(parseE2EFlags([]).legacyBridge).toBe(false);
    expect(parseE2EFlags(["--dry-run"]).legacyBridge).toBe(false);
  });

  it("sets legacyBridge when the opt-in flag is present", () => {
    expect(parseE2EFlags(["--legacy-bridge"]).legacyBridge).toBe(true);
    expect(parseE2EFlags(["--dry-run", "--legacy-bridge"]).legacyBridge).toBe(true);
  });
});

describe("legacy fixtures", () => {
  it("each fixture is classified as legacy with its expected kind", () => {
    for (const spec of LEGACY_FIXTURES) {
      const dir = freshRoot(`legacy-${spec.kind}-`);
      provisionLegacyFixture(dir, spec.kind);
      const detection = detectLegacyLayout(dir);
      expect(detection.legacy).toBe(true);
      expect(detection.kind).toBe(spec.kind);
    }
  });

  it("provisionLegacyFixture throws on an unknown kind", () => {
    const dir = freshRoot("legacy-unknown-");
    expect(() => provisionLegacyFixture(dir, "not-a-kind" as LegacyLayoutKind)).toThrow(
      /unknown legacy fixture kind/,
    );
  });

  it("assertLegacyFixturesDetectedAndRefused passes for the full fixture set", () => {
    const work = freshRoot("legacy-set-");
    const [okFlag, reason] = assertLegacyFixturesDetectedAndRefused(work);
    expect(okFlag).toBe(true);
    expect(reason).toContain(`${LEGACY_FIXTURES.length} legacy fixtures detected`);
    expect(reason).toContain("refuse-boundary");
  });

  it("reports FAIL when a fixture dir is sabotaged into a not-legacy layout", () => {
    // Pre-seed the orphan-deft-version fixture path with a canonical .deft/core
    // deposit so the detector returns not-legacy even after the orphan VERSION
    // file is written -- driving the FAIL branch of the assertion.
    const work = freshRoot("legacy-sabotage-");
    mkdirSync(join(work, "legacy-orphan-deft-version", ".deft", "core"), { recursive: true });
    const [okFlag, reason] = assertLegacyFixturesDetectedAndRefused(work);
    expect(okFlag).toBe(false);
    expect(reason).toContain("orphan-deft-version");
  });
});

describe("assertNpmHybridMigration", () => {
  it("drives a canonical deposit through migrate to a valid npm-hybrid end state", () => {
    const work = freshRoot("hybrid-");
    const [okFlag, reason] = assertNpmHybridMigration(work, null, {
      resolveEngine: () => "npm",
      nowIso: () => "2026-06-24T00:00:00Z",
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("npm-hybrid deposit valid");
    expect(reason).toContain("managed_by: 'npm'");
  });

  it("asserts the installer VERSION is migrate-acceptable before stamping (a1)", () => {
    const work = freshRoot("hybrid-handshake-");
    const [okFlag, reason] = assertNpmHybridMigration(work, null, {
      resolveEngine: () => "npm",
      nowIso: () => "2026-06-24T00:00:00Z",
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("installer VERSION migrate-acceptable");
  });

  it("FAILs with a handshake mismatch when the installer VERSION field shape drifts (a2)", () => {
    const work = freshRoot("hybrid-drift-");
    const [okFlag, reason] = assertNpmHybridMigration(work, null, {
      resolveEngine: () => "npm",
      // A drifted VERSION missing the install_root / fetched_* installer fields:
      // migrate alone would still stamp it, so the handshake assertion must catch it.
      versionTextOverride: "ref: 'v0.0.1'\nsha: 'content-package'\ntag: 'v0.0.1'\n",
    });
    expect(okFlag).toBe(false);
    expect(reason).toContain("handshake mismatch");
    expect(reason).toContain("install_root");
  });

  it("renders + asserts the AGENTS.md managed-section when the template is available", () => {
    if (!existsSync(REAL_AGENTS_TEMPLATE)) {
      return; // not a source checkout -- the template-less path is covered above
    }
    const work = freshRoot("hybrid-agents-");
    const [okFlag, reason] = assertNpmHybridMigration(work, REAL_AGENTS_TEMPLATE, {
      resolveEngine: () => "npm",
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("AGENTS.md managed-section");
    const agents = readFileSync(join(work, "post-bridge", "AGENTS.md"), "utf8");
    expect(agents).toContain("deft:managed-section");
  });

  it("FAILs when the engine does not resolve (migrate stays needs-action)", () => {
    const work = freshRoot("hybrid-no-engine-");
    const [okFlag, reason] = assertNpmHybridMigration(work, null, {
      resolveEngine: () => null,
    });
    expect(okFlag).toBe(false);
    expect(reason).toContain("expected 'migrated'");
  });
});

describe("provisionCanonicalVendoredDeposit", () => {
  it("writes a canonical-vendored .deft/core deposit the detector treats as not-legacy", () => {
    const project = freshRoot("canonical-");
    const { deftDir, agentsRendered, manifestPath } = provisionCanonicalVendoredDeposit(
      project,
      null,
    );
    expect(existsSync(join(deftDir, "VERSION"))).toBe(true);
    expect(existsSync(join(deftDir, "main.md"))).toBe(true);
    expect(agentsRendered).toBe(false);
    expect(manifestPath).toBe(join(deftDir, "VERSION"));
    expect(detectLegacyLayout(project).legacy).toBe(false);
  });

  it("writes an installer-shaped VERSION carrying every installer manifest field", () => {
    const project = freshRoot("canonical-shape-");
    const { manifestPath } = provisionCanonicalVendoredDeposit(project, null);
    const version = readFileSync(manifestPath, "utf8");
    for (const key of installerManifestFieldKeys()) {
      expect(version).toContain(`${key}:`);
    }
    const [okFlag, reason] = assertInstallerVersionMigrateAcceptable(version);
    expect(okFlag).toBe(true);
    expect(reason).toContain("migrate-acceptable");
  });

  it("writes the raw override VERSION verbatim when versionTextOverride is supplied", () => {
    const project = freshRoot("canonical-override-");
    const drifted = "ref: 'v0.0.1'\nsha: 'content-package'\n"; // missing tag/install_root/...
    const { manifestPath } = provisionCanonicalVendoredDeposit(project, null, drifted);
    expect(readFileSync(manifestPath, "utf8")).toBe(drifted);
  });
});

describe("assertInstallerVersionMigrateAcceptable", () => {
  it("accepts a canonical installer-shaped VERSION (the buildInstallManifestText shape)", () => {
    const version = buildInstallManifestText(CANONICAL_INSTALLER_MANIFEST_FIELDS);
    const [okFlag, reason] = assertInstallerVersionMigrateAcceptable(version);
    expect(okFlag).toBe(true);
    expect(reason).toContain("installer VERSION migrate-acceptable");
    for (const key of installerManifestFieldKeys()) {
      expect(reason).toContain(key);
    }
  });

  it("rejects an empty / fieldless VERSION as a handshake mismatch", () => {
    const [okFlag, reason] = assertInstallerVersionMigrateAcceptable("\n# no key/value lines\n");
    expect(okFlag).toBe(false);
    expect(reason).toContain("handshake mismatch");
    expect(reason).toContain("empty manifest");
  });

  it("rejects a VERSION whose installer field shape drifted (missing fields)", () => {
    const drifted = "ref: 'v0.0.1'\nsha: 'content-package'\ntag: 'v0.0.1'\n";
    const [okFlag, reason] = assertInstallerVersionMigrateAcceptable(drifted);
    expect(okFlag).toBe(false);
    expect(reason).toContain("handshake mismatch");
    expect(reason).toContain("install_root");
    expect(reason).toContain("fetched_at");
    expect(reason).toContain("fetched_by");
  });

  it("rejects a VERSION with a renamed installer key (camelCase drift)", () => {
    // installRoot is the TS field name; the on-disk manifest key is install_root.
    const renamed =
      "ref: 'v0.0.1'\nsha: 'content-package'\ntag: 'v0.0.1'\n" +
      "installRoot: '.deft/core'\nfetched_at: '2026-06-24T00:00:00Z'\nfetched_by: 'frozen-go-bridge'\n";
    const [okFlag, reason] = assertInstallerVersionMigrateAcceptable(renamed);
    expect(okFlag).toBe(false);
    expect(reason).toContain("handshake mismatch");
    expect(reason).toContain("install_root");
  });
});

describe("selectBridgeAsset", () => {
  // The real published release asset names (release.yml softprops upload):
  // install-<os>-<arch>, with macOS shipping a single universal fat binary.
  const multi = [
    "install-linux-amd64",
    "install-linux-arm64",
    "install-macos-universal",
    "install-windows-amd64.exe",
    "install-windows-arm64.exe",
    "checksums.txt",
  ];

  it("returns none when no installer asset is present", () => {
    expect(selectBridgeAsset(["checksums.txt", "README.md"])).toEqual({ kind: "none" });
  });

  it("uses the sole installer asset for a single-binary release", () => {
    expect(selectBridgeAsset(["install", "checksums.txt"])).toEqual({
      kind: "ok",
      name: "install",
    });
  });

  it("accepts the legacy deft-install- prefix for back-compat", () => {
    expect(selectBridgeAsset(["deft-install-linux-amd64", "checksums.txt"], "linux", "x64")).toEqual(
      { kind: "ok", name: "deft-install-linux-amd64" },
    );
  });

  it("selects the OS/arch-matching asset, not the alphabetical first", () => {
    // Alphabetical assets[0] would be install-linux-amd64; the host match must win.
    expect(selectBridgeAsset(multi, "linux", "arm64")).toEqual({
      kind: "ok",
      name: "install-linux-arm64",
    });
    expect(selectBridgeAsset(multi, "win32", "x64")).toEqual({
      kind: "ok",
      name: "install-windows-amd64.exe",
    });
  });

  it("resolves the macOS universal binary on a darwin host (any arch)", () => {
    // install-macos-universal carries no arch token, so the OS-only fallback
    // picks it for both amd64 and arm64 darwin hosts.
    expect(selectBridgeAsset(multi, "darwin", "arm64")).toEqual({
      kind: "ok",
      name: "install-macos-universal",
    });
    expect(selectBridgeAsset(multi, "darwin", "x64")).toEqual({
      kind: "ok",
      name: "install-macos-universal",
    });
  });

  it("falls back to an OS-only match when the arch suffix is absent", () => {
    expect(selectBridgeAsset(["install-linux", "install-macos"], "linux", "x64")).toEqual({
      kind: "ok",
      name: "install-linux",
    });
  });

  it("reports no-platform-match (with candidates) when nothing matches the host", () => {
    const result = selectBridgeAsset(
      ["install-macos-universal", "install-windows-amd64.exe"],
      "linux",
      "x64",
    );
    expect(result.kind).toBe("no-platform-match");
    if (result.kind === "no-platform-match") {
      expect(result.candidates).toEqual([
        "install-macos-universal",
        "install-windows-amd64.exe",
      ]);
    }
  });
});

describe("downloadAndRunFrozenBridge", () => {
  it("delegates to the runFrozenBridge seam when provided", () => {
    const [okFlag, reason] = downloadAndRunFrozenBridge("v9.9.9", "/fixture", {
      runFrozenBridge: (pin, dir) => [true, `seam ran ${pin} on ${dir}`],
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("seam ran v9.9.9 on /fixture");
  });

  it("soft-skips when gh is absent", () => {
    const [okFlag, reason] = downloadAndRunFrozenBridge("v9.9.9", "/fixture", {
      which: whichFor(),
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("SKIP");
    expect(reason).toContain("gh not on PATH");
  });

  it("FAILs when gh release download fails", () => {
    const [okFlag, reason] = downloadAndRunFrozenBridge("v9.9.9", "/fixture", {
      which: whichFor("gh"),
      spawnText: () => ({ status: 1, stdout: "", stderr: "release not found" }),
    });
    expect(okFlag).toBe(false);
    expect(reason).toContain("gh release download v9.9.9");
    expect(reason).toContain("release not found");
  });

  it("FAILs when no installer asset is present in the download", () => {
    const emptyDir = freshRoot("frozen-empty-");
    const [okFlag, reason] = downloadAndRunFrozenBridge("v9.9.9", "/fixture", {
      which: whichFor("gh"),
      spawnText: () => ok(),
      mkdtemp: () => emptyDir,
    });
    expect(okFlag).toBe(false);
    expect(reason).toContain("no installer asset");
  });

  it("cleans up the downloaded-binary temp dir on an early-return failure path", () => {
    const assetDir = freshRoot("frozen-cleanup-fail-");
    const removed: string[] = [];
    downloadAndRunFrozenBridge("v9.9.9", "/fixture", {
      which: whichFor("gh"),
      spawnText: () => ({ status: 1, stdout: "", stderr: "release not found" }),
      mkdtemp: () => assetDir,
      rmTemp: (p) => removed.push(p),
    });
    expect(removed).toEqual([assetDir]);
  });

  it("cleans up the downloaded-binary temp dir on the success path", () => {
    // Provision an assetDir holding a deft-install binary so the download +
    // run path reaches the success return, then assert the finally cleanup ran.
    const assetDir = freshRoot("frozen-cleanup-ok-");
    writeFileSync(join(assetDir, "deft-install-linux-amd64"), "#!/bin/sh\n", "utf8");
    const fixtureDir = freshRoot("frozen-cleanup-fixture-");
    // A canonical-vendored deposit so the post-run not-legacy assertion passes.
    provisionCanonicalVendoredDeposit(fixtureDir, null);
    const removed: string[] = [];
    const [okFlag, reason] = downloadAndRunFrozenBridge("v9.9.9", fixtureDir, {
      which: whichFor("gh"),
      spawnText: () => ok(),
      mkdtemp: () => assetDir,
      rmTemp: (p) => removed.push(p),
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("normalised the legacy fixture");
    expect(removed).toEqual([assetDir]);
  });
});

describe("runLegacyBridgeLeg", () => {
  it("soft-skips when npm is absent", () => {
    const [okFlag, reason] = runLegacyBridgeLeg(process.cwd(), { which: whichFor() });
    expect(okFlag).toBe(true);
    expect(reason).toContain("SKIP");
    expect(reason).toContain("npm not on PATH");
  });

  it("PENDING while the SoT is null: asserts shape, skips the real frozen download", () => {
    const [okFlag, reason] = runLegacyBridgeLeg(process.cwd(), {
      which: whichFor("npm"),
      lastGoInstaller: () => null,
      resolveEngine: () => "npm",
      agentsTemplatePath: null,
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("PENDING (SoT unfrozen)");
    expect(reason).toContain("skipped the real frozen-binary download");
  });

  it("uses the real SoT reader by default (frozen at the pinned tag -> frozen path)", () => {
    // Post-freeze (#1912) the real Tier-0 SoT is pinned, so the default reader
    // takes the frozen stage-1 path. With gh absent (whichFor("npm")) the real
    // frozen-binary download soft-skips while still reporting the frozen pin --
    // proving the leg reads the live SoT rather than a stale null assumption.
    const [okFlag, reason] = runLegacyBridgeLeg(process.cwd(), {
      which: whichFor("npm"),
      resolveEngine: () => "npm",
      agentsTemplatePath: null,
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("frozen pin");
    expect(reason).toContain("SKIP");
  });

  it("validates the VERSION handshake on the SoT-null path with no binary download (a3)", () => {
    // SoT null (pending-pin) means no frozen-binary download; the stage-2
    // handshake must still run. A drifted VERSION must fail the leg even though
    // the real frozen bridge is skipped -- proving the handshake is asserted
    // end-to-end without a network/binary dependency.
    let frozenDownloadAttempts = 0;
    const [okFlag, reason] = runLegacyBridgeLeg(process.cwd(), {
      which: whichFor("npm"),
      lastGoInstaller: () => null,
      resolveEngine: () => "npm",
      agentsTemplatePath: null,
      versionTextOverride: "ref: 'v0.0.1'\nsha: 'content-package'\ntag: 'v0.0.1'\n",
      runFrozenBridge: () => {
        frozenDownloadAttempts += 1;
        return [true, "should not be reached on the SoT-null path"];
      },
    });
    expect(okFlag).toBe(false);
    expect(reason).toContain("npm-hybrid");
    expect(reason).toContain("handshake mismatch");
    expect(frozenDownloadAttempts).toBe(0);
  });

  it("passes the SoT-null path when the installer-shaped VERSION is migrate-acceptable (a3)", () => {
    const [okFlag, reason] = runLegacyBridgeLeg(process.cwd(), {
      which: whichFor("npm"),
      lastGoInstaller: () => null,
      resolveEngine: () => "npm",
      agentsTemplatePath: null,
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("PENDING (SoT unfrozen)");
    expect(reason).toContain("stage-2 npm-hybrid");
  });

  it("runs the real pinned handoff when the SoT is frozen", () => {
    const seenPins: string[] = [];
    const [okFlag, reason] = runLegacyBridgeLeg(process.cwd(), {
      which: whichFor("npm"),
      lastGoInstaller: () => "v0.32.5",
      resolveEngine: () => "npm",
      agentsTemplatePath: null,
      runFrozenBridge: (pin) => {
        seenPins.push(pin);
        return [true, `normalised at ${pin}`];
      },
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("frozen pin v0.32.5");
    expect(seenPins).toEqual(["v0.32.5"]);
  });

  it("FAILs when the frozen bridge handoff fails", () => {
    const [okFlag, reason] = runLegacyBridgeLeg(process.cwd(), {
      which: whichFor("npm"),
      lastGoInstaller: () => "v0.32.5",
      resolveEngine: () => "npm",
      agentsTemplatePath: null,
      runFrozenBridge: () => [false, "download blew up"],
    });
    expect(okFlag).toBe(false);
    expect(reason).toContain("frozen bridge");
    expect(reason).toContain("download blew up");
  });

  it("soft-skips the frozen stage-1 when the bridge handoff skips (gh absent)", () => {
    const [okFlag, reason] = runLegacyBridgeLeg(process.cwd(), {
      which: whichFor("npm"),
      lastGoInstaller: () => "v0.32.5",
      resolveEngine: () => "npm",
      agentsTemplatePath: null,
      runFrozenBridge: () => [
        true,
        "SKIP (gh not on PATH; cannot fetch the frozen bridge v0.32.5)",
      ],
    });
    expect(okFlag).toBe(true);
    expect(reason).toContain("frozen pin v0.32.5");
    expect(reason).toContain("SKIP");
  });
});

describe("runE2e --legacy-bridge wiring", () => {
  function config(overrides: Partial<E2EConfig> = {}): E2EConfig {
    return {
      owner: "deftai",
      projectRoot: process.cwd(),
      dryRun: false,
      keepRepo: false,
      skipNpm: false,
      legacyBridge: true,
      repoSlug: "deftai-release-test-20260624000000-abcdef",
      ...overrides,
    };
  }

  it("dry-run emits the legacy-bridge DRYRUN line only when the flag is set", () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      runE2e(config({ dryRun: true }));
    } finally {
      process.stderr.write = orig;
    }
    const out = lines.join("");
    expect(out).toContain("Legacy-bridge leg");
    expect(out).toContain("DRYRUN");
    expect(out).toContain("Tier-0 SoT");
  });

  it("runs the leg and folds an OK result into the success exit", () => {
    vi.spyOn(ghOps, "provisionTempRepo").mockReturnValue([true, "created"]);
    vi.spyOn(rehearsalModule, "runRehearsal").mockReturnValue([true, "ok"]);
    vi.spyOn(ghOps, "destroyTempRepo").mockReturnValue([true, "deleted"]);
    const seams: E2ESeams & {
      lastGoInstaller?: () => string | null;
      resolveEngine?: () => string | null;
      agentsTemplatePath?: string | null;
    } = {
      which: whichFor("npm"),
      lastGoInstaller: () => null,
      resolveEngine: () => "npm",
      agentsTemplatePath: null,
    };
    expect(runE2e(config(), seams)).toBe(EXIT_OK);
  });

  it("folds a leg FAIL into a violation exit even when the rehearsal passes", () => {
    vi.spyOn(ghOps, "provisionTempRepo").mockReturnValue([true, "created"]);
    vi.spyOn(rehearsalModule, "runRehearsal").mockReturnValue([true, "ok"]);
    vi.spyOn(ghOps, "destroyTempRepo").mockReturnValue([true, "deleted"]);
    const seams: E2ESeams & {
      lastGoInstaller?: () => string | null;
      runFrozenBridge?: (pin: string, dir: string) => [boolean, string];
    } = {
      which: whichFor("npm"),
      lastGoInstaller: () => "v0.32.5",
      runFrozenBridge: () => [false, "boom"],
    };
    expect(runE2e(config(), seams)).toBe(EXIT_VIOLATION);
  });
});
