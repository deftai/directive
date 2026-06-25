import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GO_BRIDGE_RELEASES_URL } from "../doctor/constants.js";
import { parseInstallManifest } from "../doctor/manifest.js";
import {
  buildLegacyRefusalMessage,
  detectLegacyLayout,
  type LegacyLayoutKind,
} from "../init-deposit/legacy-detect.js";
import { isNpmManaged, NPM_MANAGED_SENTINEL_VALUE, runMigrate } from "../init-deposit/migrate.js";
import {
  buildInstallManifestText,
  CANONICAL_INSTALL_ROOT,
  type InitDepositIo,
  type InstallManifestFields,
  writeAgentsMd,
  writeInstallManifest,
} from "../init-deposit/scaffold.js";
// NOTE: the Tier-0 SoT lives at packages/core/src/legacy-bridge/sot.ts and is
// deliberately NOT edited here (operator-only freeze step). This leg only READS
// it via lastGoInstaller(). deft:last-go-installer -- the bridge tag is read
// from the SoT (lastGoInstaller()), never restated as a literal on this line.
import { lastGoInstaller } from "../legacy-bridge/sot.js";
import { defaultWhich, spawnText } from "../release/spawn.js";
import { emit } from "./flags.js";
import type { E2ESeams } from "./types.js";

/**
 * legacy-bridge-leg.ts -- the opt-in Tier-1 pinned migration e2e leg (#1912).
 *
 * Exercises the two-stage legacy migration end-to-end:
 *   - Stage 1 (the frozen Go bridge installer): normalises a LEGACY on-disk
 *     layout (pre-v0.27 sentinel AGENTS.md / git-clone / submodule / orphan
 *     `.deft/VERSION` / legacy `deft/`-prefixed root) to the canonical-vendored
 *     `.deft/core` layout.
 *   - Stage 2 (the npm CLI): `directive migrate` stamps the deposit npm-managed,
 *     then `directive init`/`update` own the canonical-vendored payload, yielding
 *     a valid npm-hybrid deposit (canonical `.deft/core` + AGENTS.md
 *     managed-section + a `managed_by: 'npm'` install manifest).
 *
 * SEMANTICS -- pending-pin (the key #1912 contract):
 *   The bridge tag is the Tier-0 SoT `lastGoInstaller()` (story G). While it is
 *   `null` (unfrozen -- today), the leg cannot download/run a real frozen bridge
 *   binary, so it runs every fixture-shape + stage-2 assertion it can WITHOUT the
 *   network and SKIPS the real frozen-binary download with a clear
 *   `PENDING (SoT unfrozen)` advisory. The moment the operator freezes (pins the
 *   SoT), the same leg runs the real pinned bridge -> npm handoff.
 *
 * The leg mirrors the npm-ops leg (npm-ops.ts): a self-contained function
 * returning `[ok, reason]`, invoked from main.ts behind the opt-in
 * `--legacy-bridge` flag (default OFF -- the default `task release:e2e` budget is
 * unaffected). It soft-skips (ok=true) when the npm channel is absent, symmetric
 * to `rehearseNpmPublish`'s npm soft-skip.
 *
 * Refs #1912 (capstone), #1942 (deposit journey), #1941 (migrate), #1669 (Wave 5).
 */

const NOOP_IO: InitDepositIo = { printf: () => {} };

/** The frozen Go bridge repo (the published release lives under deftai/directive). */
export const GO_BRIDGE_REPO = "deftai/directive";

/** A legacy on-disk shape the stage-1 bridge migrates and the npm CLI refuses. */
export interface LegacyFixtureSpec {
  readonly kind: LegacyLayoutKind;
  readonly provision: (dir: string) => void;
}

/**
 * The legacy layouts the leg provisions + asserts. Covers the four shapes the
 * detector recognises (legacy-detect.ts): orphan `.deft/VERSION`, legacy
 * `deft/`-prefixed root, git-clone / submodule, and a pre-v0.27 sentinel-only
 * AGENTS.md. Each fixture lands in its own clean throwaway dir.
 */
export const LEGACY_FIXTURES: readonly LegacyFixtureSpec[] = [
  {
    kind: "orphan-deft-version",
    provision: (dir) => {
      mkdirSync(join(dir, ".deft"), { recursive: true });
      writeFileSync(
        join(dir, ".deft", "VERSION"),
        "ref: 'v0.1.0'\nsha: 'legacy'\ntag: 'v0.1.0'\n",
        "utf8",
      );
    },
  },
  {
    kind: "legacy-deft-prefixed",
    provision: (dir) => {
      mkdirSync(join(dir, "deft"), { recursive: true });
      writeFileSync(join(dir, "deft", "VERSION"), "ref: 'v0.1.0'\n", "utf8");
      writeFileSync(join(dir, "deft", "main.md"), "# Deft (legacy prefixed)\n", "utf8");
    },
  },
  {
    kind: "git-clone-or-submodule",
    provision: (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, ".gitmodules"),
        '[submodule "deft"]\n\tpath = .deft\n\turl = https://github.com/deftai/directive.git\n',
        "utf8",
      );
    },
  },
  {
    kind: "pre-v0.27-sentinel-agents-md",
    provision: (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# AGENTS\n\n<!-- deft:managed-section -->\nLegacy pre-v0.27 sentinel-only body (no v2/v3 markers).\n",
        "utf8",
      );
    },
  },
];

/** Provision the named legacy fixture under `dir`. */
export function provisionLegacyFixture(dir: string, kind: LegacyLayoutKind): void {
  const spec = LEGACY_FIXTURES.find((f) => f.kind === kind);
  if (!spec) {
    throw new Error(`unknown legacy fixture kind: ${kind}`);
  }
  spec.provision(dir);
}

/**
 * Stage-0 fixture-shape assertions: every legacy fixture is classified as legacy
 * with its expected kind, and the npm refuse-preflight surface (story P) would
 * refuse it (we exercise the version-neutral two-step refusal message). This is
 * the boundary that makes the two-stage migration load-bearing: the npm path
 * NEVER migrates a legacy layout -- the frozen Go bridge does (stage 1) first.
 */
export function assertLegacyFixturesDetectedAndRefused(workRoot: string): [boolean, string] {
  for (const spec of LEGACY_FIXTURES) {
    const dir = join(workRoot, `legacy-${spec.kind}`);
    provisionLegacyFixture(dir, spec.kind);

    const detection = detectLegacyLayout(dir);
    if (!detection.legacy) {
      return [false, `legacy fixture ${spec.kind} was NOT detected as legacy`];
    }
    if (detection.kind !== spec.kind) {
      return [
        false,
        `legacy fixture ${spec.kind} misclassified: detector returned ${detection.kind}`,
      ];
    }
    for (const command of ["init", "update"] as const) {
      const refusal = buildLegacyRefusalMessage(command, detection);
      if (!refusal.includes("frozen final Go bridge")) {
        return [
          false,
          `npm ${command} refusal for ${spec.kind} did not signpost the frozen Go bridge`,
        ];
      }
    }
  }
  return [
    true,
    `${LEGACY_FIXTURES.length} legacy fixtures detected + npm init/update refuse-boundary asserted ` +
      `(${LEGACY_FIXTURES.map((f) => f.kind).join(", ")})`,
  ];
}

/**
 * The canonical installer manifest fields the frozen Go bridge writes into
 * `.deft/core/VERSION`. Field names + order come from the installer's
 * `buildInstallManifestText` (the TS port of the Go `BuildInstallManifestText`),
 * so this fixture is the same shape a real frozen-bridge run deposits.
 */
export const CANONICAL_INSTALLER_MANIFEST_FIELDS: InstallManifestFields = {
  ref: "v0.0.1",
  sha: "content-package",
  tag: "v0.0.1",
  installRoot: CANONICAL_INSTALL_ROOT,
  fetchedAt: "2026-06-24T00:00:00Z",
  fetchedBy: "frozen-go-bridge",
};

/**
 * The install-manifest field keys a canonical installer VERSION carries, derived
 * from the installer's own `buildInstallManifestText` output so the handshake
 * expectation tracks the real installer field shape rather than restating it.
 * `directive migrate` consumes this VERSION; a drift away from these keys is the
 * handshake break this leg now asserts against.
 */
export function installerManifestFieldKeys(): string[] {
  return Object.keys(
    parseInstallManifest(buildInstallManifestText(CANONICAL_INSTALLER_MANIFEST_FIELDS)),
  );
}

/**
 * Assert an installer-shaped VERSION is migrate-acceptable: `parseInstallManifest`
 * accepts it AND it carries every canonical installer manifest field
 * ({@link installerManifestFieldKeys}) with a non-empty value. A drifted field
 * shape (missing or renamed key, empty value) returns a handshake mismatch
 * reason so the leg fails loudly rather than letting `directive migrate` stamp a
 * non-installer VERSION npm-managed. This is the stage-2 handshake the #1912
 * freeze hinges on (the installer VERSION the npm CLI accepts as canonical-ready).
 */
export function assertInstallerVersionMigrateAcceptable(versionText: string): [boolean, string] {
  const manifest = parseInstallManifest(versionText);
  if (Object.keys(manifest).length === 0) {
    return [false, "handshake mismatch: installer VERSION parsed to an empty manifest"];
  }
  const required = installerManifestFieldKeys();
  const missing = required.filter((key) => {
    const value = manifest[key];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    return [
      false,
      `handshake mismatch: installer VERSION missing migrate-required field(s): ${missing.join(", ")}`,
    ];
  }
  return [true, `installer VERSION migrate-acceptable (${required.join(", ")})`];
}

/**
 * Provision a canonical-vendored `.deft/core` deposit -- the shape the stage-1
 * bridge produces from a legacy layout. Writes an installer-shaped VERSION (via
 * the installer's own `writeInstallManifest`) unless `versionTextOverride` is
 * supplied, in which case the raw override text is written verbatim so a test can
 * drive a drifted VERSION through the stage-2 handshake. Optionally renders
 * AGENTS.md when the agents-entry template is available (so the npm-hybrid
 * end-state check can assert the managed-section the way `directive init`/`update`
 * do). Returns the VERSION manifest path so the caller can assert the handshake.
 */
export function provisionCanonicalVendoredDeposit(
  projectDir: string,
  agentsTemplatePath: string | null,
  versionTextOverride: string | null = null,
): { deftDir: string; agentsRendered: boolean; manifestPath: string } {
  const deftDir = join(projectDir, CANONICAL_INSTALL_ROOT);
  mkdirSync(join(deftDir, "templates"), { recursive: true });
  writeFileSync(join(deftDir, "main.md"), "# Deft\n", "utf8");

  let manifestPath: string;
  if (versionTextOverride !== null) {
    // deftDir already exists: the `mkdirSync(join(deftDir, "templates"))` above
    // created it as an ancestor (recursive). Just write the override VERSION.
    manifestPath = join(deftDir, "VERSION");
    writeFileSync(manifestPath, versionTextOverride, "utf8");
  } else {
    manifestPath = writeInstallManifest(projectDir, deftDir, CANONICAL_INSTALLER_MANIFEST_FIELDS);
  }

  let agentsRendered = false;
  if (agentsTemplatePath !== null && existsSync(agentsTemplatePath)) {
    copyFileSync(agentsTemplatePath, join(deftDir, "templates", "agents-entry.md"));
    writeAgentsMd(projectDir, deftDir, NOOP_IO);
    agentsRendered = true;
  }
  return { deftDir, agentsRendered, manifestPath };
}

/**
 * Stage-2 assertion: drive a canonical-vendored deposit through `directive
 * migrate` (and the init/update AGENTS.md render) to a valid npm-hybrid deposit.
 * Asserts migrate stamps the deposit npm-managed, is idempotent (already-hybrid
 * on the second run), and leaves a `managed_by: 'npm'` manifest.
 */
export function assertNpmHybridMigration(
  workRoot: string,
  agentsTemplatePath: string | null,
  seams: LegacyBridgeLegSeams = {},
): [boolean, string] {
  const projectDir = join(workRoot, "post-bridge");
  mkdirSync(projectDir, { recursive: true });

  const { agentsRendered, manifestPath } = provisionCanonicalVendoredDeposit(
    projectDir,
    agentsTemplatePath,
    seams.versionTextOverride ?? null,
  );

  // Stage-2 handshake: the installer-shaped VERSION must be migrate-acceptable
  // (parseInstallManifest accepts it AND it carries the canonical installer
  // fields) BEFORE `directive migrate` stamps managed_by. migrate itself only
  // appends the sentinel and would happily stamp a drifted VERSION, so asserting
  // the installer field shape here is what makes the freeze handshake end-to-end
  // rather than assumed. Runs regardless of the SoT pin (the pending-pin path
  // still validates the handshake without any binary download).
  const versionText = readFileSync(manifestPath, "utf8");
  const [handshakeOk, handshakeReason] = assertInstallerVersionMigrateAcceptable(versionText);
  if (!handshakeOk) {
    return [false, `npm-hybrid FAIL: ${handshakeReason}`];
  }

  if (agentsRendered) {
    const agents = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    if (!agents.includes("deft:managed-section")) {
      return [false, "npm-hybrid FAIL: rendered AGENTS.md missing the managed-section"];
    }
  }

  const resolveEngine = seams.resolveEngine ?? (() => "npm-channel");
  const nowIso = seams.nowIso;

  const first = runMigrate(projectDir, { resolveEngine, nowIso });
  if (first.outcome !== "migrated") {
    return [
      false,
      `npm-hybrid FAIL: directive migrate expected 'migrated', got '${first.outcome}'`,
    ];
  }
  const second = runMigrate(projectDir, { resolveEngine, nowIso });
  if (second.outcome !== "already-hybrid") {
    return [
      false,
      `npm-hybrid FAIL: directive migrate not idempotent (second run: '${second.outcome}')`,
    ];
  }
  if (first.manifestPath === null) {
    return [false, "npm-hybrid FAIL: migrate reported no manifest path"];
  }
  const manifest = parseInstallManifest(readFileSync(first.manifestPath, "utf8"));
  if (!isNpmManaged(manifest)) {
    return [false, "npm-hybrid FAIL: manifest is not stamped npm-managed after migrate"];
  }
  const agentsNote = agentsRendered ? " + AGENTS.md managed-section" : "";
  return [
    true,
    `npm-hybrid deposit valid (canonical ${CANONICAL_INSTALL_ROOT}${agentsNote}; ` +
      `installer VERSION migrate-acceptable; ` +
      `directive migrate -> managed_by: '${NPM_MANAGED_SENTINEL_VALUE}', idempotent)`,
  ];
}

/**
 * Map a Node `process.platform` value to the published release OS asset token.
 *
 * The release workflow (.github/workflows/release.yml) uploads assets named
 * `install-<os>-<arch>` where <os> is `windows` / `macos` / `linux` -- NOT the Go
 * `GOOS` token. In particular macOS publishes a single `install-macos-universal`
 * binary (the lipo'd fat binary), so a darwin host must look for `macos`, not
 * `darwin`.
 */
function goOsToken(platform: NodeJS.Platform): string {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos"; // assets are install-macos-universal
  return platform; // "linux" lines up as-is
}

/** Map a Node `process.arch` value to the Go release `GOARCH` asset token. */
function goArchToken(arch: string): string {
  if (arch === "x64") return "amd64";
  return arch; // "arm64" lines up with GOARCH as-is
}

/** The outcome of resolving which downloaded asset is the bridge binary for this host. */
export type BridgeAssetSelection =
  | { kind: "ok"; name: string }
  | { kind: "none" }
  | { kind: "no-platform-match"; candidates: string[] };

/**
 * Match an installer binary asset. The release workflow uploads
 * `install-<os>-<arch>` (e.g. `install-linux-amd64`, `install-windows-amd64.exe`,
 * `install-macos-universal`); the legacy single-binary / `deft-install-` naming is
 * also accepted for back-compat. Anchored at the start of the basename so sibling
 * assets like `checksums.txt` / `README.md` are excluded.
 */
const INSTALLER_ASSET_RE = /^(?:deft-)?install(?:-|\.exe$|$)/i;

/**
 * Pick the installer bridge binary matching the current host platform/arch.
 *
 * The release publishes one asset per OS (`install-<os>-<arch>`, with macOS as a
 * single `install-macos-universal` fat binary). Selecting `assets[0]`
 * alphabetically silently picks the wrong binary on a multi-asset release,
 * producing an exec-format failure on a mismatched runner. This resolves the
 * host-matching asset instead and reports a precise outcome when none matches:
 *   - single installer asset -> use it (single-binary releases, back-compat);
 *   - prefer an asset whose name carries BOTH the OS and arch tokens;
 *   - else fall back to an OS-only match (e.g. the macOS universal binary, which
 *     carries no arch suffix, or releases that omit the arch suffix);
 *   - else `no-platform-match` so the caller fails loudly rather than guessing.
 */
export function selectBridgeAsset(
  fileNames: readonly string[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BridgeAssetSelection {
  const candidates = fileNames.filter((name) => INSTALLER_ASSET_RE.test(name));
  if (candidates.length === 0) {
    return { kind: "none" };
  }
  if (candidates.length === 1) {
    return { kind: "ok", name: candidates[0] as string };
  }
  const os = goOsToken(platform).toLowerCase();
  const cpu = goArchToken(arch).toLowerCase();
  const osArch = candidates.find((name) => {
    const lower = name.toLowerCase();
    return lower.includes(os) && lower.includes(cpu);
  });
  if (osArch !== undefined) {
    return { kind: "ok", name: osArch };
  }
  const osOnly = candidates.find((name) => name.toLowerCase().includes(os));
  if (osOnly !== undefined) {
    return { kind: "ok", name: osOnly };
  }
  return { kind: "no-platform-match", candidates: [...candidates] };
}

/**
 * The frozen-mode real handoff (reached ONLY once the operator pins the SoT):
 * download the frozen Go bridge binary at the pinned tag and run it against a
 * legacy fixture to normalise it to canonical-vendored. Soft-skips when `gh` is
 * absent. Never builds/cuts a release -- it consumes an already-published one.
 */
export function downloadAndRunFrozenBridge(
  pin: string,
  fixtureDir: string,
  seams: E2ESeams & LegacyBridgeLegSeams = {},
): [boolean, string] {
  if (seams.runFrozenBridge) {
    return seams.runFrozenBridge(pin, fixtureDir);
  }
  const which = seams.which ?? seams.whichGh ?? defaultWhich;
  const spawn = seams.spawnText ?? spawnText;
  const gh = which("gh");
  if (gh === null) {
    return [true, `SKIP (gh not on PATH; cannot fetch the frozen bridge ${pin})`];
  }
  const mkdtemp = seams.mkdtemp ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)));
  const rmTemp = seams.rmTemp ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const assetDir = mkdtemp("deft-frozen-bridge-");

  // Clean up the downloaded-binary temp dir on every exit path (mirrors the
  // workRoot try/finally in runLegacyBridgeLeg). Once the SoT is pinned this
  // runs on every --legacy-bridge CI invocation, so a leaked assetDir would
  // accumulate full Go-bridge binaries.
  try {
    const download = spawn(
      gh,
      ["release", "download", pin, "--repo", GO_BRIDGE_REPO, "--dir", assetDir, "--clobber"],
      { env: { ...process.env }, timeoutMs: 300_000 },
    );
    if (download.status !== 0) {
      return [
        false,
        `gh release download ${pin} from ${GO_BRIDGE_REPO} failed: ${download.stderr.trim()}`,
      ];
    }

    const selection = selectBridgeAsset(readdirSync(assetDir));
    if (selection.kind === "none") {
      return [
        false,
        `frozen bridge ${pin} downloaded but no installer asset (install-*) found in ${assetDir} ` +
          `(see ${GO_BRIDGE_RELEASES_URL})`,
      ];
    }
    if (selection.kind === "no-platform-match") {
      return [
        false,
        `frozen bridge ${pin} downloaded but no installer asset matches ` +
          `${goOsToken(process.platform)}/${goArchToken(process.arch)} ` +
          `(candidates: ${selection.candidates.join(", ")}; see ${GO_BRIDGE_RELEASES_URL})`,
      ];
    }
    const binaryPath = join(assetDir, selection.name);
    try {
      chmodSync(binaryPath, 0o755);
    } catch {
      // best-effort; non-fatal on platforms that ignore the bit
    }
    const run = spawn(binaryPath, ["--yes", "--upgrade", "--repo-root", fixtureDir], {
      env: { ...process.env },
      timeoutMs: 300_000,
    });
    if (run.status !== 0) {
      return [false, `frozen bridge ${pin} run failed (exit ${run.status}): ${run.stderr.trim()}`];
    }
    if (detectLegacyLayout(fixtureDir).legacy) {
      return [false, `frozen bridge ${pin} ran but the fixture is still a legacy layout`];
    }
    return [true, `frozen bridge ${pin} normalised the legacy fixture to canonical-vendored`];
  } finally {
    rmTemp(assetDir);
  }
}

export interface LegacyBridgeLegSeams {
  /** Test seam: override the Tier-0 SoT reader (default: real lastGoInstaller). */
  lastGoInstaller?: () => string | null;
  /** Test seam: engine-resolve check used by the stage-2 migrate (default: npm present). */
  resolveEngine?: () => string | null;
  /** Test seam: deterministic ISO timestamp for the migrate backup filename. */
  nowIso?: () => string;
  /** Test seam: override the frozen-mode bridge handoff (default: gh release download + run). */
  runFrozenBridge?: (pin: string, fixtureDir: string) => [boolean, string];
  /** Override the agents-entry template path (default: <projectRoot>/content/templates/agents-entry.md). */
  agentsTemplatePath?: string | null;
  /**
   * Test seam: write this raw text to the stage-2 `.deft/core/VERSION` instead of
   * the installer-shaped manifest, to drive a drifted VERSION through the
   * migrate-acceptable handshake assertion (default: installer-shaped manifest).
   */
  versionTextOverride?: string;
}

/**
 * Run the pinned legacy -> bridge -> npm-hybrid migration leg.
 *
 * Returns `[ok, reason]` like the other release-e2e legs. Soft-skips (ok=true)
 * when npm is absent. While the SoT is null (pending-pin) it asserts the
 * fixture-shape + stage-2 npm-hybrid checks and SKIPS the real frozen-binary
 * download; once the SoT is pinned it additionally runs the real bridge handoff.
 */
export function runLegacyBridgeLeg(
  projectRoot: string,
  seams: E2ESeams & LegacyBridgeLegSeams = {},
): [boolean, string] {
  const which = seams.which ?? seams.whichGh ?? defaultWhich;
  if (which("npm") === null) {
    return [
      true,
      "SKIP (npm not on PATH; Node-less operator) -- the npm-hybrid stage needs the npm channel",
    ];
  }

  const pin = (seams.lastGoInstaller ?? lastGoInstaller)();
  const frozen = pin !== null;

  const agentsTemplatePath =
    seams.agentsTemplatePath !== undefined
      ? seams.agentsTemplatePath
      : join(projectRoot, "content", "templates", "agents-entry.md");

  const mkdtemp = seams.mkdtemp ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)));
  const rmTemp = seams.rmTemp ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const workRoot = mkdtemp("deft-legacy-bridge-");

  try {
    let [ok, reason] = assertLegacyFixturesDetectedAndRefused(workRoot);
    emit(
      "  legacy-bridge step: legacy fixtures + refuse-boundary",
      `${ok ? "OK" : "FAIL"} (${reason})`,
    );
    if (!ok) {
      return [false, `legacy fixtures: ${reason}`];
    }

    // Stage 1: the frozen Go bridge normalises legacy -> canonical-vendored.
    if (frozen && pin !== null) {
      const fixtureDir = join(workRoot, "frozen-fixture");
      provisionLegacyFixture(fixtureDir, "pre-v0.27-sentinel-agents-md");
      const [bridgeOk, bridgeReason] = downloadAndRunFrozenBridge(pin, fixtureDir, seams);
      emit(
        "  legacy-bridge step: frozen bridge handoff",
        `${bridgeOk ? "OK" : "FAIL"} (${bridgeReason})`,
      );
      if (!bridgeOk) {
        return [false, `frozen bridge: ${bridgeReason}`];
      }
      if (bridgeReason.startsWith("SKIP")) {
        return [true, `frozen pin ${pin}: ${bridgeReason}; stage-1 deferred (gh absent)`];
      }
    } else {
      emit(
        "  legacy-bridge step: frozen bridge handoff",
        "PENDING (SoT unfrozen) -- skipped the real frozen-binary download (pin: null)",
      );
    }

    // Stage 2: directive migrate (+ init/update AGENTS.md render) -> npm-hybrid.
    [ok, reason] = assertNpmHybridMigration(workRoot, agentsTemplatePath, seams);
    emit("  legacy-bridge step: stage-2 npm-hybrid", `${ok ? "OK" : "FAIL"} (${reason})`);
    if (!ok) {
      return [false, `npm-hybrid: ${reason}`];
    }

    if (frozen) {
      return [
        true,
        `frozen pin ${pin}: real legacy -> bridge -> npm-hybrid handoff verified ` +
          "(legacy fixtures detected; frozen bridge normalised; stage-2 migrate npm-hybrid)",
      ];
    }
    return [
      true,
      "PENDING (SoT unfrozen): legacy fixtures + npm refuse-boundary + stage-2 npm-hybrid shape " +
        "asserted; skipped the real frozen-binary download (pin: null) until the operator freezes",
    ];
  } finally {
    rmTemp(workRoot);
  }
}
