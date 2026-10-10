/**
 * Owner-boundary tests for the cheap hook in-sync check (AC2.4, AC2.6).
 * Fast path: pin/installed identity + readiness validity. No sleeps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALLATION_RECOVERY_GUIDANCE,
  RUNTIME_PIN_PACKAGE,
  checkCheapInSync,
} from "./index.js";

const temps: string[] = [];

function tempRoot(prefix = "cheap-sync-"): string {
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

function writeCheapOkFixture(root: string, version = V): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        devDependencies: { [RUNTIME_PIN_PACKAGE]: version },
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
  writeFileSync(
    join(root, ".deft", "directive", `wiring-ready.${version}.json`),
    `${JSON.stringify({ runtimeVersion: version }, null, 2)}\n`,
  );
}

describe("checkCheapInSync (AC2.4)", () => {
  it("passes when pin equals installed and readiness for V is valid", () => {
    const root = tempRoot();
    writeCheapOkFixture(root);
    const result = checkCheapInSync(root);
    expect(result.ok).toBe(true);
    expect(result.identityMatch).toBe(true);
    expect(result.readinessValid).toBe(true);
    expect(result.pinVersion).toBe(V);
    expect(result.installedVersion).toBe(V);
    expect(result.failClosed).toBe(false);
  });

  it("fails when readiness marker is missing (generation may still be current)", () => {
    const root = tempRoot();
    writeCheapOkFixture(root);
    // Generation current is irrelevant to the cheap path — only readiness matters.
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "GENERATION.json"),
      `${JSON.stringify({ runtimeVersion: V }, null, 2)}\n`,
    );
    rmSync(join(root, ".deft", "directive", `wiring-ready.${V}.json`), { force: true });
    const result = checkCheapInSync(root);
    expect(result.ok).toBe(false);
    expect(result.identityMatch).toBe(true);
    expect(result.readinessValid).toBe(false);
    expect(result.failClosed).toBe(false);
  });

  it("fails closed on pin≠installed with recovery guidance and no setup (AC2.6)", () => {
    const root = tempRoot();
    writeCheapOkFixture(root);
    writeFileSync(
      join(root, "node_modules", "@deftai", "directive-runtime", "package.json"),
      `${JSON.stringify({ name: RUNTIME_PIN_PACKAGE, version: "0.9.0" }, null, 2)}\n`,
    );
    const result = checkCheapInSync(root);
    expect(result.ok).toBe(false);
    expect(result.identityMatch).toBe(false);
    expect(result.failClosed).toBe(true);
    expect(result.allowSetup).toBe(false);
    expect(result.recoveryGuidance).toBe(INSTALLATION_RECOVERY_GUIDANCE);
  });

  it("completes without sleeping on a warm fixture (AC2.4 budget)", () => {
    const root = tempRoot();
    writeCheapOkFixture(root);
    const start = performance.now();
    for (let i = 0; i < 50; i += 1) {
      const result = checkCheapInSync(root);
      expect(result.ok).toBe(true);
    }
    const elapsedMs = performance.now() - start;
    // Unit-testable without sleeping; 50 iterations well under 50ms*50 warm budget.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
