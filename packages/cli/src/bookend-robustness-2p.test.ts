/**
 * Wave 2p owner-boundary tests: SIG-PM, PM-GUIDE, PLAN-DISC, PLAN-RACE
 * (AC5.15/14.56, AC5.8/14.45, AC5.1/14.54, AC5.13).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInstall } from "./bookends.js";
import { EXIT_CODES, NODE_EOL_NOTE } from "./constants.js";
import { checkNodeVersion } from "./node-check.js";
import { readProjectInstallState, type ProjectInstallState } from "./pin.js";
import {
  ensurePackageManagerAvailable,
  fingerprintPlanCriticalFiles,
  formatMissingPmGuidance,
  interpretPmSpawnResult,
  planFingerprintChanged,
  PARTIAL_CHANGES_MAY_REMAIN,
} from "./pm.js";

const TEMPS: string[] = [];

function tempProject(name = "wave2p"): string {
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

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("SIG-PM: PM interrupt → 130 + partial report (AC5.15 / AC14.56)", () => {
  it("interpretPmSpawnResult maps signal to interrupted result", () => {
    const r = interpretPmSpawnResult("npm", ["install", "x"], {
      status: null,
      signal: "SIGINT",
      error: undefined,
      stdout: "",
      stderr: "killed",
      pid: 1,
      output: [null, "", "killed"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.interrupted).toBe(true);
    expect(r.signal).toBe("SIGINT");
    expect(r.message).toMatch(/SIGINT/);
    expect(r.message).toMatch(/partial changes may remain/i);
  });

  it("install bookend exits 130 and reports partial changes on interrupted PM add", () => {
    const root = tempProject("wave2p-sig");
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        runPmAdd: () => ({
          ok: false as const,
          interrupted: true as const,
          signal: "SIGINT",
          message: `npm interrupted (SIGINT). ${PARTIAL_CHANGES_MAY_REMAIN}`,
          stderr: "",
        }),
      },
    );
    expect(code).toBe(EXIT_CODES.INTERRUPTED);
    expect(c.err() + c.out()).toMatch(/partial changes may remain/i);
  });
});

describe("PM-GUIDE: missing declared PM → how-to before mutation (AC5.8 / AC14.45)", () => {
  it("formatMissingPmGuidance mentions Corepack and PATH", () => {
    const msg = formatMissingPmGuidance("pnpm", "9.15.0");
    expect(msg).toMatch(/pnpm/i);
    expect(msg).toMatch(/Corepack|corepack/i);
    expect(msg).toMatch(/PATH/i);
    expect(msg).not.toMatch(/ENOENT/);
  });

  it("ensurePackageManagerAvailable fails closed when binary missing from PATH", () => {
    const root = tempProject("wave2p-nopm-helper");
    const r = ensurePackageManagerAvailable("pnpm", {
      ...process.env,
      PATH: join(root, "empty-bin"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/pnpm/i);
    expect(r.message).toMatch(/Corepack|corepack|PATH/i);
  });

  it("install stops with how-to when declared PM missing; package.json unchanged", () => {
    const root = tempProject("wave2p-nopm");
    const pkgPath = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    pkg.packageManager = "pnpm@9.15.0";
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const before = readFileSync(pkgPath, "utf8");
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        checkPmAvailable: () => ({
          ok: false as const,
          message: formatMissingPmGuidance("pnpm", "9.15.0"),
        }),
        runPmAdd: () => {
          throw new Error("PM add must not run when PM is missing");
        },
      },
    );
    expect(code).not.toBe(0);
    expect(code).not.toBe(EXIT_CODES.INTERRUPTED);
    expect(c.err() + c.out()).toMatch(/Corepack|corepack|PATH/i);
    expect(c.err() + c.out()).toMatch(/pnpm/i);
    expect(readFileSync(pkgPath, "utf8")).toBe(before);
  });
});

describe("PLAN-DISC: install-script policy + Node best-effort in plan (AC5.1 / AC14.54)", () => {
  it("dry-run plan discloses install-script policy", () => {
    const root = tempProject("wave2p-scripts");
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/Set up Deft Directive/);
    expect(c.out()).toMatch(/Installation may run scripts allowed by your project's settings/);
    expect(c.out()).not.toMatch(/install-script policy:/i);
  });

  it("verbose dry-run plan includes keyed install-script policy", () => {
    const root = tempProject("wave2p-scripts-v");
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "-v", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/Set up Deft Directive/);
    expect(c.out()).toMatch(/install-script policy:/i);
  });

  it("plan includes Node best-effort note when Node major is 20 (AC14.54)", () => {
    expect(checkNodeVersion("20.11.0").warning).toBe(NODE_EOL_NOTE);
    const root = tempProject("wave2p-node20");
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      { nodeVersion: "20.11.0" },
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/Set up Deft Directive/);
    expect(c.out()).toMatch(/best-effort/);
    expect(c.out()).toContain(NODE_EOL_NOTE);
  });
});

describe("PLAN-RACE: fingerprint plan-critical files; re-check before mutate (AC5.13)", () => {
  it("fingerprint detects package.json content change", () => {
    const root = tempProject("wave2p-fp");
    const a = fingerprintPlanCriticalFiles(root, "npm");
    const pkgPath = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    pkg.name = "changed";
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    expect(planFingerprintChanged(root, "npm", a)).toBe(true);
  });

  it("install aborts when plan-critical files change after plan / before mutate", () => {
    const root = tempProject("wave2p-race");
    const pkgPath = join(root, "package.json");
    const c = capture();
    let pmCalled = false;
    const code = runInstall(
      root,
      stateFor(root),
      ["--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        stdinIsTTY: true,
        confirm: () => {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
          pkg.description = "race-changed-after-plan";
          writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
          return true;
        },
        runPmAdd: () => {
          pmCalled = true;
          return { ok: true as const };
        },
        invokeSetup: () => {
          throw new Error("setup must not run after plan invalidation");
        },
      },
    );
    expect(pmCalled).toBe(false);
    expect(code).not.toBe(0);
    expect(c.err() + c.out()).toMatch(/plan.*(invalid|changed|stale)|files? changed/i);
  });
});
