/**
 * Owner-boundary tests for upgrade / update bookend (Wave 2b / R7 / AC7.* / AC4.10).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isWiringCurrentForVersion,
  parseDoctorDataStatusResponse,
  runUpgrade,
} from "./bookends.js";
import { type ProjectInstallState, readProjectInstallState } from "./pin.js";
import { compareExactVersions } from "./registry.js";

const TEMPS: string[] = [];

function tempProject(name = "wave2b"): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeOut: (t: string) => {
        out.push(t);
      },
      writeErr: (t: string) => {
        err.push(t);
      },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function stateFor(root: string): ProjectInstallState {
  return readProjectInstallState(root);
}

/**
 * Fake runtime bin for AC7.6: V writes ac76-v-marker; W writes ac76-w-marker.
 * Real invokeRuntime spawns this file — no invokeSetup override.
 */
function ac76MarkerRuntimeBinSource(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const version = pkg.version;
const argv = process.argv.slice(2);
const entry = argv[0];
const rootIdx = argv.indexOf("--root");
const root =
  (rootIdx >= 0 ? argv[rootIdx + 1] : null) ||
  process.env.DIRECTIVE_PROJECT_ROOT ||
  process.cwd();
const markerDir = path.join(root, ".deft", "directive");
if (entry === "setup") {
  fs.mkdirSync(markerDir, { recursive: true });
  const isW = version === "2.0.0";
  const rel = isW ? ".deft/directive/ac76-w-marker" : ".deft/directive/ac76-v-marker";
  const body = isW ? "written-by-w-setup\\n" : "written-by-v-setup\\n";
  fs.writeFileSync(path.join(root, rel), body);
  process.stdout.write(
    JSON.stringify({
      contract: 1,
      entry: "setup",
      operation: "upgrade",
      created: [rel],
      modified: [],
      removed: [],
      conflicts: [],
    }) + "\\n",
  );
  process.exit(0);
}
if (entry === "migrate") {
  process.stdout.write(
    JSON.stringify({
      contract: 1,
      entry: "migrate",
      migrated: [],
      created: [],
      modified: [],
      removed: [],
      conflicts: [],
      message: "migrate: data schema already current",
    }) + "\\n",
  );
  process.exit(0);
}
process.stderr.write("ac76 fake runtime: unknown entry " + String(entry) + "\\n");
process.exit(2);
`;
}

function pinExact(
  root: string,
  version: string,
  opts?: { contract?: number; install?: boolean; binSource?: string },
): void {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  pkg.devDependencies = { "@deftai/directive-runtime": version };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  if (opts?.install === false) return;
  const contract = opts?.contract ?? 1;
  const nm = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(nm, { recursive: true });
  writeFileSync(
    join(nm, "package.json"),
    `${JSON.stringify(
      { name: "@deftai/directive-runtime", version, directive: { contract } },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(nm, "dist"), { recursive: true });
  writeFileSync(
    join(nm, "dist", "bin.js"),
    opts?.binSource ?? "#!/usr/bin/env node\nprocess.exit(0);\n",
  );
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": { name: "t", devDependencies: { "@deftai/directive-runtime": version } },
          "node_modules/@deftai/directive-runtime": { version },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function markWiringCurrent(root: string, version: string): void {
  mkdirSync(join(root, ".deft", "directive"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "GENERATION.json"),
    `${JSON.stringify({ runtimeVersion: version, packageManager: "npm", ownership: [] }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, ".deft", "directive", `wiring-ready.${version}.json`),
    `${JSON.stringify({ runtimeVersion: version }, null, 2)}\n`,
  );
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("compareExactVersions", () => {
  it("orders core and prerelease versions", () => {
    expect(compareExactVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareExactVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareExactVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareExactVersions("0.0.0-yolo.cp-wave2a.4", "0.0.0-yolo.cp-wave2b.1")).toBeLessThan(
      0,
    );
  });

  it("strips build metadata so build-tagged pins still compare (Greptile P1)", () => {
    expect(compareExactVersions("1.2.3+build.7", "1.2.3")).toBe(0);
    expect(compareExactVersions("1.2.3+build.7", "2.0.0")).toBeLessThan(0);
    expect(compareExactVersions("2.0.0", "1.2.3+build.7")).toBeGreaterThan(0);
    expect(compareExactVersions("1.2.3+aaa", "1.2.3+bbb")).toBe(0);
  });

  it("never treats parse failure as equal (Greptile P1)", () => {
    expect(() => compareExactVersions("not-a-version", "2.0.0")).toThrow(/invalid exact SemVer/);
    expect(() => compareExactVersions("1.2.3", "nope")).toThrow(/invalid exact SemVer/);
    expect(() => compareExactVersions("1.2.3+", "1.2.3")).toThrow(/invalid exact SemVer/);
  });
});

describe("isWiringCurrentForVersion (Greptile P2)", () => {
  it("rejects malformed readiness JSON even when the path exists", () => {
    const root = tempProject("wiring-bad");
    mkdirSync(join(root, ".deft", "directive"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "GENERATION.json"),
      `${JSON.stringify({ runtimeVersion: "1.2.3" }, null, 2)}\n`,
    );
    writeFileSync(join(root, ".deft", "directive", "wiring-ready.1.2.3.json"), "not-json{\n");
    expect(isWiringCurrentForVersion(root, "1.2.3")).toBe(false);
  });

  it("rejects readiness body naming another runtime", () => {
    const root = tempProject("wiring-mismatch");
    mkdirSync(join(root, ".deft", "directive"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "GENERATION.json"),
      `${JSON.stringify({ runtimeVersion: "1.2.3" }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".deft", "directive", "wiring-ready.1.2.3.json"),
      `${JSON.stringify({ runtimeVersion: "9.9.9" }, null, 2)}\n`,
    );
    expect(isWiringCurrentForVersion(root, "1.2.3")).toBe(false);
  });

  it("accepts readable JSON with matching or absent body version", () => {
    const root = tempProject("wiring-ok");
    markWiringCurrent(root, "1.2.3");
    expect(isWiringCurrentForVersion(root, "1.2.3")).toBe(true);
    writeFileSync(join(root, ".deft", "directive", "wiring-ready.1.2.3.json"), "{}\n");
    expect(isWiringCurrentForVersion(root, "1.2.3")).toBe(true);
  });
});

describe("parseDoctorDataStatusResponse (Greptile P2)", () => {
  it("rejects non-zero exit even when stdout has a recognized dataStatus", () => {
    const parsed = parseDoctorDataStatusResponse({
      exitCode: 1,
      stdout: JSON.stringify({ contract: 1, dataStatus: "current" }),
      message: null,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/exit 1|failed/i);
  });

  it("rejects missing or unsupported contract before accepting dataStatus", () => {
    const missing = parseDoctorDataStatusResponse({
      exitCode: 0,
      stdout: JSON.stringify({ dataStatus: "current" }),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/unsupported contract/i);

    const wrong = parseDoctorDataStatusResponse({
      exitCode: 0,
      stdout: JSON.stringify({ contract: 99, dataStatus: "current" }),
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.message).toMatch(/unsupported contract/i);
  });

  it("accepts exit 0 + contract 1 + known dataStatus", () => {
    const parsed = parseDoctorDataStatusResponse({
      exitCode: 0,
      stdout: JSON.stringify({ contract: 1, dataStatus: "migration_needed" }),
    });
    expect(parsed).toEqual({ ok: true, dataStatus: "migration_needed" });
  });
});

describe("upgrade bookend gates (AC7.1 / AC7.3)", () => {
  it("no pin exits 2 naming install (AC7.1)", () => {
    const root = tempProject();
    const c = capture();
    const code = runUpgrade(root, stateFor(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    expect(c.err() + c.out()).toMatch(/directive install/i);
  });

  it("range pin exits 2 naming install (AC7.1)", () => {
    const root = tempProject();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.devDependencies = { "@deftai/directive-runtime": "^1.2.3" };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.4"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(2);
    expect(c.err() + c.out()).toMatch(/directive install/i);
  });

  it("unknown leftover argv exits 2 before registry/PM", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    const c = capture();
    let resolveCalled = false;
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--dryrun", "--target-version", "1.2.4"],
      "0.0.0-test",
      c.io,
      {
        resolveLatest: () => {
          resolveCalled = true;
          return { ok: true as const, version: "1.2.4" };
        },
        runPmAdd: () => {
          throw new Error("PM must not run");
        },
      },
    );
    expect(code).toBe(2);
    expect(resolveCalled).toBe(false);
    expect(c.err()).toMatch(/Unknown argument/);
  });

  it("target older than pin is rejected (AC7.3)", () => {
    const root = tempProject();
    pinExact(root, "1.2.4");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: () => {
          throw new Error("PM must not run");
        },
      },
    );
    expect(code).toBe(1);
    expect(c.err() + c.out()).toMatch(/older|not older|newer|reject/i);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });
});

describe("equal-version upgrade (AC7.3 / AC4.10)", () => {
  it("current wiring + data current → no-op, no writes", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    markWiringCurrent(root, "1.2.3");
    const beforePkg = readFileSync(join(root, "package.json"), "utf8");
    const beforeGen = readFileSync(join(root, ".deft", "GENERATION.json"), "utf8");
    const c = capture();
    let pmCalled = false;
    let setupCalled = false;
    let migrateCalled = false;
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        invokeDoctorDataStatus: () => ({ ok: true as const, dataStatus: "current" as const }),
        runPmAdd: () => {
          pmCalled = true;
          return { ok: true as const };
        },
        invokeSetup: () => {
          setupCalled = true;
          return { exitCode: 0, stdout: "", stderr: "", spawned: true, message: null };
        },
        invokeMigrate: () => {
          migrateCalled = true;
          return { exitCode: 0, stdout: "", stderr: "", spawned: true, message: null };
        },
      },
    );
    expect(code).toBe(0);
    expect(pmCalled).toBe(false);
    expect(setupCalled).toBe(false);
    expect(migrateCalled).toBe(false);
    expect(c.out() + c.err()).toMatch(/already|current|no-op|nothing to do/i);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(beforePkg);
    expect(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")).toBe(beforeGen);
  });

  it("diagnostic failure is an error, never a no-op (AC4.10)", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    markWiringCurrent(root, "1.2.3");
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        invokeDoctorDataStatus: () => ({
          ok: false as const,
          message: "doctor blew up",
        }),
        runPmAdd: () => {
          throw new Error("PM must not run");
        },
      },
    );
    expect(code).toBe(1);
    expect(c.err() + c.out()).toMatch(/diagnos|failed|doctor/i);
  });

  it("diagnosis_failed discriminant is an error", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    markWiringCurrent(root, "1.2.3");
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        invokeDoctorDataStatus: () => ({
          ok: true as const,
          dataStatus: "diagnosis_failed" as const,
        }),
      },
    );
    expect(code).toBe(1);
  });

  it("wiring stale + data current → setup then migrate plan (dry-run)", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    // no GENERATION / wiring-ready
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--dry-run", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        invokeDoctorDataStatus: () => ({ ok: true as const, dataStatus: "current" as const }),
        runPmAdd: () => {
          throw new Error("PM must not run on dry-run");
        },
      },
    );
    expect(code).toBe(0);
    const text = c.out();
    expect(text).toMatch(/Upgrade Directive/i);
    expect(text).toMatch(/setup/i);
    expect(text).toMatch(/migrat/i);
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(false);
  });

  it("wiring current + migration_needed → migrate-only plan", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    markWiringCurrent(root, "1.2.3");
    const c = capture();
    let setupCalled = false;
    let migrateCalled = false;
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        invokeDoctorDataStatus: () => ({
          ok: true as const,
          dataStatus: "migration_needed" as const,
        }),
        invokeSetup: () => {
          setupCalled = true;
          return { exitCode: 0, stdout: "{}", stderr: "", spawned: true, message: null };
        },
        invokeMigrate: (argv) => {
          migrateCalled = true;
          expect(argv[0]).toBe("migrate");
          expect(argv).toContain("--from");
          expect(argv).toContain("1.2.3");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              contract: 1,
              entry: "migrate",
              migrated: [".deft/directive/data-schema.json"],
              created: [],
              modified: [".deft/directive/data-schema.json"],
              removed: [],
            }),
            stderr: "",
            spawned: true,
            message: null,
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(setupCalled).toBe(false);
    expect(migrateCalled).toBe(true);
  });
});

describe("version-change upgrade (AC7.2 / AC7.4 / AC7.5 / AC7.9)", () => {
  it("contract-too-new preflight leaves pin unchanged (AC4.7 / AC7.2)", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const c = capture();
    let pmCalled = false;
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: (version) => {
          expect(version).toBe("9.9.9");
          return { ok: true as const, contract: 99 };
        },
        runPmAdd: () => {
          pmCalled = true;
          return { ok: true as const };
        },
      },
    );
    expect(code).toBe(1);
    expect(pmCalled).toBe(false);
    expect(c.err() + c.out()).toMatch(/launcher is too old|npm i -g @deftai\/directive@latest/i);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });

  it("--dry-run prints plan and does not mutate pin", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--dry-run", "--target-version", "2.0.0"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: () => {
          throw new Error("PM must not run");
        },
      },
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/Upgrade Directive/i);
    expect(c.out()).toMatch(/2\.0\.0/);
    expect(c.out()).toMatch(/setup|data updates/i);
    // wave 4g: default bullets only; exact PM argv at -v
    expect(c.out()).not.toMatch(/Install command:/);
    expect(c.out()).not.toMatch(/Package manager will run:/);
    expect(c.out()).toMatch(/change this project's Directive version to 2\.0\.0/);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });

  it("version change with --yes: PM add, setup --operation upgrade, migrate", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    let pmVersion: string | null = null;
    let setupArgv: string[] | null = null;
    let migrateArgv: string[] | null = null;
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "2.0.0"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: ({ projectRoot, version }) => {
          pmVersion = version;
          const pkgPath = join(projectRoot, "package.json");
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
          pkg.devDependencies = {
            ...(pkg.devDependencies as object),
            "@deftai/directive-runtime": version,
          };
          writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
          const nm = join(projectRoot, "node_modules", "@deftai", "directive-runtime");
          mkdirSync(nm, { recursive: true });
          writeFileSync(
            join(nm, "package.json"),
            `${JSON.stringify(
              { name: "@deftai/directive-runtime", version, directive: { contract: 1 } },
              null,
              2,
            )}\n`,
          );
          mkdirSync(join(nm, "dist"), { recursive: true });
          writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
          writeFileSync(
            join(projectRoot, "package-lock.json"),
            `${JSON.stringify(
              {
                lockfileVersion: 3,
                packages: {
                  "": {
                    name: "t",
                    devDependencies: { "@deftai/directive-runtime": version },
                  },
                  "node_modules/@deftai/directive-runtime": { version },
                },
              },
              null,
              2,
            )}\n`,
          );
          return { ok: true as const };
        },
        invokeSetup: (argv) => {
          setupArgv = [...argv];
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              contract: 1,
              entry: "setup",
              operation: "upgrade",
              created: [],
              modified: [".deft/GENERATION.json"],
              removed: [],
              conflicts: [],
            }),
            stderr: "",
            spawned: true,
            message: null,
          };
        },
        invokeMigrate: (argv) => {
          migrateArgv = [...argv];
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              contract: 1,
              entry: "migrate",
              migrated: [".deft/directive/data-schema.json"],
              created: [".deft/directive/data-schema.json"],
              modified: [],
              removed: [],
            }),
            stderr: "",
            spawned: true,
            message: null,
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(pmVersion).toBe("2.0.0");
    expect(setupArgv).not.toBeNull();
    expect(setupArgv![0]).toBe("setup");
    expect(setupArgv).toContain("upgrade");
    expect(setupArgv).toContain("1.2.3");
    expect(migrateArgv![0]).toBe("migrate");
    expect(migrateArgv).toContain("1.2.3");
    expect(readProjectInstallState(root).pin.version).toBe("2.0.0");
  });

  it("PM ok but setup fails reports partial failure (AC7.9)", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "2.0.0"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: ({ projectRoot, version }) => {
          pinExact(projectRoot, version);
          return { ok: true as const };
        },
        invokeSetup: () => ({
          exitCode: 1,
          stdout: JSON.stringify({ conflicts: ["AGENTS.md"], message: "setup failed" }),
          stderr: "",
          spawned: true,
          message: null,
        }),
      },
    );
    expect(code).toBe(1);
    expect(readProjectInstallState(root).pin.version).toBe("2.0.0");
    const text = c.err() + c.out();
    expect(text).toMatch(/pin|lockfile|new version|2\.0\.0/i);
    expect(text).toMatch(/install --repair|upgrade/i);
  });

  it("AC7.6: V→W setup handoff writes W-only marker (not V)", () => {
    const root = tempProject("ac76");
    const v = "1.2.3";
    const w = "2.0.0";
    const wMarkerAbs = join(root, ".deft", "directive", "ac76-w-marker");
    const vMarkerAbs = join(root, ".deft", "directive", "ac76-v-marker");
    const fakeBin = ac76MarkerRuntimeBinSource();
    // Pin V with a V-aware fake executable (would write V marker if invoked).
    pinExact(root, v, { binSource: fakeBin });
    markWiringCurrent(root, v);
    expect(existsSync(wMarkerAbs)).toBe(false);
    expect(existsSync(vMarkerAbs)).toBe(false);

    const c = capture();
    // No invokeSetup/invokeMigrate override: real handOff → invokeRuntime spawns
    // the installed package's dist/bin.js (W after PM-add).
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", w],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: ({ projectRoot, version }) => {
          pinExact(projectRoot, version, { binSource: fakeBin });
          return { ok: true as const };
        },
      },
    );
    expect(code).toBe(0);
    expect(readProjectInstallState(root).installed?.version).toBe(w);
    expect(existsSync(wMarkerAbs)).toBe(true);
    expect(readFileSync(wMarkerAbs, "utf8")).toMatch(/written-by-w-setup/);
    // V's executable must not have run after the handoff.
    expect(existsSync(vMarkerAbs)).toBe(false);
    expect(readProjectInstallState(root).pin.version).toBe(w);
  });

  it("AC14.18: one-file migrate failure names file, migrated set, directive upgrade (verbosity 0)", () => {
    const root = tempProject("ac1418");
    pinExact(root, "1.2.3");
    const failedFile = "xbrief/pending/broken.xbrief.json";
    const migratedOk = "xbrief/active/ok.xbrief.json";
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "2.0.0"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: ({ projectRoot, version }) => {
          pinExact(projectRoot, version);
          return { ok: true as const };
        },
        invokeSetup: () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            contract: 1,
            entry: "setup",
            operation: "upgrade",
            created: [],
            modified: [".deft/GENERATION.json"],
            removed: [],
            conflicts: [],
          }),
          stderr: "",
          spawned: true,
          message: null,
        }),
        invokeMigrate: () => ({
          exitCode: 1,
          stdout: JSON.stringify({
            contract: 1,
            entry: "migrate",
            migrated: [migratedOk, ".deft/directive/data-schema.json"],
            created: [],
            modified: [],
            removed: [],
            conflicts: [failedFile],
            message: `migrate failed: could not transform ${failedFile}`,
          }),
          stderr: "",
          spawned: true,
          message: null,
        }),
      },
    );
    expect(code).toBe(1);
    expect(readProjectInstallState(root).pin.version).toBe("2.0.0");
    const text = c.err() + c.out();
    expect(text).toContain(failedFile);
    expect(text).toContain(migratedOk);
    expect(text).toMatch(/directive upgrade/);
    expect(text).toMatch(/pin|lockfile|2\.0\.0/i);
    // Default verbosity must carry the report (not only behind -v).
    expect(text).toMatch(/[Mm]igrat/);
  });

  it("mutating without --yes in non-interactive exits 2 (AC5.5)", () => {
    const root = tempProject();
    pinExact(root, "1.2.3");
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--target-version", "2.0.0"],
      "0.0.0-test",
      c.io,
      {
        stdinIsTTY: false,
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
      },
    );
    expect(code).toBe(2);
    expect(c.err() + c.out()).toMatch(/--yes/);
  });
});
