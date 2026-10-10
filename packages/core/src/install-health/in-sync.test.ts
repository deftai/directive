/**
 * Owner-boundary tests for the full in-sync check (R2 / AC2.1–2.3, AC2.6).
 * Observes sync outcomes on temp project fixtures — no source-string greps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALLATION_RECOVERY_GUIDANCE,
  RUNTIME_PIN_PACKAGE,
  checkFullInSync,
} from "./index.js";

const temps: string[] = [];

function tempRoot(prefix = "in-sync-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temps.push(root);
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const p = temps.pop();
    if (p) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

const V = "1.2.3";

/** Build a checkout that satisfies all AC2.1 predicates for V. */
function writeInSyncFixture(root: string, version = V): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        name: "consumer",
        devDependencies: { [RUNTIME_PIN_PACKAGE]: version },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        name: "consumer",
        packages: {
          "": {
            name: "consumer",
            devDependencies: { [RUNTIME_PIN_PACKAGE]: version },
          },
          [`node_modules/${RUNTIME_PIN_PACKAGE}`]: {
            version,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const runtimePkg = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(runtimePkg, { recursive: true });
  writeFileSync(
    join(runtimePkg, "package.json"),
    `${JSON.stringify({ name: RUNTIME_PIN_PACKAGE, version }, null, 2)}\n`,
  );
  mkdirSync(join(root, ".deft", "directive"), { recursive: true });
  // Minimal generation shape for 1a (runtimeVersion). Ownership/PM deepen in 1b.
  writeFileSync(
    join(root, ".deft", "GENERATION.json"),
    `${JSON.stringify({ runtimeVersion: version }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, ".deft", "directive", `wiring-ready.${version}.json`),
    `${JSON.stringify({ runtimeVersion: version }, null, 2)}\n`,
  );
  // Present wiring that targets the runtime package prefix (version-free paths).
  writeFileSync(
    join(root, "AGENTS.md"),
    [
      "<!-- deft-directive:start -->",
      `See node_modules/@deftai/directive-runtime/main.md`,
      "<!-- deft-directive:end -->",
      "",
    ].join("\n"),
  );
}

describe("checkFullInSync (AC2.1)", () => {
  it("reports in-sync when pin, lockfile, installed, generation, wiring, readiness agree on V", () => {
    const root = tempRoot();
    writeInSyncFixture(root);
    const result = checkFullInSync(root);
    expect(result.inSync).toBe(true);
    expect(result.version).toBe(V);
    expect(result.predicates.pin.ok).toBe(true);
    expect(result.predicates.lockfile.ok).toBe(true);
    expect(result.predicates.installed.ok).toBe(true);
    expect(result.predicates.generation.ok).toBe(true);
    expect(result.predicates.wiring.ok).toBe(true);
    expect(result.predicates.readiness.ok).toBe(true);
    expect(result.failClosed).toBe(false);
  });

  it("fails when lockfile records a different version than the pin", () => {
    const root = tempRoot();
    writeInSyncFixture(root);
    writeFileSync(
      join(root, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            [`node_modules/${RUNTIME_PIN_PACKAGE}`]: { version: "9.9.9" },
          },
        },
        null,
        2,
      )}\n`,
    );
    const result = checkFullInSync(root);
    expect(result.inSync).toBe(false);
    expect(result.predicates.lockfile.ok).toBe(false);
    expect(result.predicates.lockfile.version).toBe("9.9.9");
  });

  it("fails when GENERATION.json records setup for a different version", () => {
    const root = tempRoot();
    writeInSyncFixture(root);
    writeFileSync(
      join(root, ".deft", "GENERATION.json"),
      `${JSON.stringify({ runtimeVersion: "0.1.0" }, null, 2)}\n`,
    );
    const result = checkFullInSync(root);
    expect(result.inSync).toBe(false);
    expect(result.predicates.generation.ok).toBe(false);
  });

  it("fails when wiring-ready marker for V is missing", () => {
    const root = tempRoot();
    writeInSyncFixture(root);
    rmSync(join(root, ".deft", "directive", `wiring-ready.${V}.json`), { force: true });
    const result = checkFullInSync(root);
    expect(result.inSync).toBe(false);
    expect(result.predicates.readiness.ok).toBe(false);
  });

  it("fails when present wiring does not target the runtime package prefix", () => {
    const root = tempRoot();
    writeInSyncFixture(root);
    writeFileSync(
      join(root, "AGENTS.md"),
      [
        "<!-- deft-directive:start -->",
        "See .deft/core/main.md",
        "<!-- deft-directive:end -->",
        "",
      ].join("\n"),
    );
    const result = checkFullInSync(root);
    expect(result.inSync).toBe(false);
    expect(result.predicates.wiring.ok).toBe(false);
  });
});

describe("checkFullInSync pin≠installed fail-closed (AC2.6)", () => {
  it("fails closed with AC9.7 recovery guidance and does not claim setup should run", () => {
    const root = tempRoot();
    writeInSyncFixture(root);
    const runtimePkg = join(root, "node_modules", "@deftai", "directive-runtime");
    writeFileSync(
      join(runtimePkg, "package.json"),
      `${JSON.stringify({ name: RUNTIME_PIN_PACKAGE, version: "0.9.0" }, null, 2)}\n`,
    );
    const result = checkFullInSync(root);
    expect(result.inSync).toBe(false);
    expect(result.failClosed).toBe(true);
    expect(result.allowSetup).toBe(false);
    expect(result.recoveryGuidance).toBe(INSTALLATION_RECOVERY_GUIDANCE);
    expect(INSTALLATION_RECOVERY_GUIDANCE).toContain("npm i -g @deftai/directive");
    expect(INSTALLATION_RECOVERY_GUIDANCE).toContain("directive install --repair");
  });
});

describe("older xbrief schema is not out-of-sync (AC2.2)", () => {
  it("keeps inSync true and reports data-behind separately", () => {
    const root = tempRoot();
    writeInSyncFixture(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.1" },
          plan: { title: "legacy" },
        },
        null,
        2,
      )}\n`,
    );
    const result = checkFullInSync(root, { currentXbriefSchema: "0.8" });
    expect(result.inSync).toBe(true);
    expect(result.separateSignals.xbriefSchemaBehind).toBe(true);
    expect(result.separateSignals.xbriefRemedy).toBe("directive upgrade");
  });
});

describe("pnpm lockfile agreement", () => {
  it("treats a pnpm-lock.yaml that records V as agreeing with the pin", () => {
    const root = tempRoot();
    writeInSyncFixture(root);
    rmSync(join(root, "package-lock.json"), { force: true });
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "  .:",
        "    devDependencies:",
        `      '${RUNTIME_PIN_PACKAGE}':`,
        `        specifier: ${V}`,
        `        version: ${V}`,
        "",
        "packages:",
        `  '${RUNTIME_PIN_PACKAGE}@${V}':`,
        `    resolution: {integrity: sha512-deadbeef}`,
        "",
      ].join("\n"),
    );
    const result = checkFullInSync(root);
    expect(result.inSync).toBe(true);
    expect(result.predicates.lockfile.ok).toBe(true);
    expect(result.predicates.lockfile.version).toBe(V);
  });
});
