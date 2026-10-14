/**
 * Wave 3i / F-015 — `directive doctor` composes install-sync + product doctor (C6).
 * Deep suite must not be silently dropped; AC12.3 surfaces stay additive.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_PIN_PACKAGE } from "@deftai/directive-core/dist/install-health/constants.js";

const productDoctorRun = vi.fn(async (_argv: string[]): Promise<number> => {
  process.stdout.write("Pre-cutover: none -- current vBRIEF document model.\n");
  process.stdout.write("Deposit hygiene: none -- no .deft/core deposit.\n");
  return 0;
});

vi.mock("./doctor.js", () => ({
  run: (argv: string[]) => productDoctorRun(argv),
}));

import {
  buildProductDoctorArgv,
  DOCTOR_PRODUCT_SECTION_SEPARATOR,
  handleContractEntrypoint,
} from "./contract-entry.js";
import {
  GIT_PRECONDITION_READINESS_DETAIL,
  GIT_PRECONDITION_RECOVERY_GUIDANCE,
} from "./doctor-diagnose.js";
import { CURRENT_DATA_SCHEMA_VERSION, DATA_SCHEMA_MARKER_REL } from "./migrate.js";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];

function tempRootNoGit(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-f015-"));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

function tempRootWithGit(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-f015-git-"));
  TEMPS.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

function pinRuntime(root: string, version: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "t",
        version: "0.0.0",
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
}

function writeLockfileNpm(root: string, version: string): void {
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "t",
        lockfileVersion: 3,
        packages: {
          "": { name: "t", version: "0.0.0" },
          [`node_modules/${RUNTIME_PIN_PACKAGE}`]: {
            version,
            resolved: `https://example.test/${RUNTIME_PIN_PACKAGE}/-/${RUNTIME_PIN_PACKAGE}-${version}.tgz`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeDataSchema(root: string, schemaVersion: number): void {
  mkdirSync(join(root, ".deft", "directive"), { recursive: true });
  writeFileSync(
    join(root, DATA_SCHEMA_MARKER_REL),
    `${JSON.stringify({ schemaVersion }, null, 2)}\n`,
  );
}

async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  let captured = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return captured;
}

afterEach(() => {
  productDoctorRun.mockClear();
  productDoctorRun.mockImplementation(async () => {
    process.stdout.write("Pre-cutover: none -- current vBRIEF document model.\n");
    process.stdout.write("Deposit hygiene: none -- no .deft/core deposit.\n");
    return 0;
  });
  while (TEMPS.length > 0) {
    const root = TEMPS.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("buildProductDoctorArgv", () => {
  it("maps --root to --project-root and strips contract-only tokens", () => {
    expect(buildProductDoctorArgv(["doctor", "--root", "/proj", "--full"], "/proj")).toEqual([
      "--project-root",
      "/proj",
      "--full",
    ]);
  });

  it("drops --data-status when composing product argv", () => {
    expect(buildProductDoctorArgv(["doctor", "--data-status"], "/x")).toEqual([
      "--project-root",
      "/x",
    ]);
  });
});

describe("handleContractEntrypoint doctor compose (F-015 / C6)", () => {
  it("prints install-sync surfaces AND invokes product doctor (deep-suite signal)", async () => {
    const root = tempRootNoGit();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeLockfileNpm(root, installed.runtimeVersion);
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);

    let code = -1;
    const out = await captureStdout(async () => {
      code = (await handleContractEntrypoint(["doctor", "--root", root])) ?? -1;
    });

    // No-git incomplete → sync unhealthy.
    expect(code).toBe(1);

    // AC12.3 install-sync surfaces (additive).
    expect(out).toMatch(/pin:/);
    expect(out).toMatch(/lockfile:/);
    expect(out).toMatch(/installed:/);
    expect(out).toMatch(/GENERATION\.json:/);
    expect(out).toMatch(/wiring:/);
    expect(out).toMatch(/readiness:/);
    expect(out).toContain(DOCTOR_PRODUCT_SECTION_SEPARATOR);

    // Deep-suite signal from product doctor (mocked fixture — not host-dependent).
    expect(out).toContain("Pre-cutover:");
    expect(out).toContain("Deposit hygiene:");
    expect(productDoctorRun).toHaveBeenCalledTimes(1);
    expect(productDoctorRun).toHaveBeenCalledWith(["--project-root", root]);

    // Trailing machine discriminant still present after both sections.
    expect(out).toMatch(/"entry":"doctor"/);

    // Order: sync report, then separator, then product suite.
    const syncIdx = out.indexOf("directive doctor:");
    const sepIdx = out.indexOf(DOCTOR_PRODUCT_SECTION_SEPARATOR);
    const deepIdx = out.indexOf("Pre-cutover:");
    expect(syncIdx).toBeGreaterThanOrEqual(0);
    expect(sepIdx).toBeGreaterThan(syncIdx);
    expect(deepIdx).toBeGreaterThan(sepIdx);
  });

  it("preserves F-010 no-git incomplete framing before the product section", async () => {
    const root = tempRootNoGit();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeLockfileNpm(root, installed.runtimeVersion);
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);

    const out = await captureStdout(async () => {
      await handleContractEntrypoint(["doctor", "--root", root]);
    });

    const syncEnd = out.indexOf(DOCTOR_PRODUCT_SECTION_SEPARATOR);
    expect(syncEnd).toBeGreaterThan(0);
    const syncSection = out.slice(0, syncEnd);
    expect(syncSection).toContain("incomplete install (git precondition)");
    expect(syncSection).toContain(GIT_PRECONDITION_READINESS_DETAIL);
    expect(syncSection).toContain(`Recovery: ${GIT_PRECONDITION_RECOVERY_GUIDANCE}`);
    expect(syncSection).not.toMatch(/npm i -g @deftai\/directive/);
    expect(productDoctorRun).toHaveBeenCalledTimes(1);
  });

  it("returns product exit when install-sync is healthy", async () => {
    productDoctorRun.mockImplementation(async () => {
      process.stdout.write("Pre-cutover: none -- current vBRIEF document model.\n");
      return 3;
    });

    const root = tempRootWithGit();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeLockfileNpm(root, installed.runtimeVersion);
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);

    let code = -1;
    const out = await captureStdout(async () => {
      code = (await handleContractEntrypoint(["doctor", "--root", root])) ?? -1;
    });

    expect(out).toContain("directive doctor: in sync");
    expect(out).toContain(DOCTOR_PRODUCT_SECTION_SEPARATOR);
    expect(out).toContain("Pre-cutover:");
    expect(productDoctorRun).toHaveBeenCalledTimes(1);
    expect(code).toBe(3);
  });

  it("prefers install-sync exit when sync is unhealthy even if product returns higher code", async () => {
    productDoctorRun.mockImplementation(async () => 7);
    const root = mkdtempSync(join(tmpdir(), "doctor-f015-combine-"));
    TEMPS.push(root);

    let code = -1;
    await captureStdout(async () => {
      code = (await handleContractEntrypoint(["doctor", "--root", root])) ?? -1;
    });
    expect(productDoctorRun).toHaveBeenCalled();
    expect(code).toBe(1);
  });

  it("doctor --data-status stays machine-only (no product suite)", async () => {
    const root = tempRootNoGit();
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);

    const out = await captureStdout(async () => {
      const code = await handleContractEntrypoint(["doctor", "--data-status", "--root", root]);
      expect(code).toBe(0);
    });

    expect(productDoctorRun).not.toHaveBeenCalled();
    expect(out).not.toContain(DOCTOR_PRODUCT_SECTION_SEPARATOR);
    expect(out).toMatch(/"dataStatus"/);
    expect(out).not.toMatch(/directive doctor:/);
  });

  it("--help skips install-sync preamble and delegates to product doctor", async () => {
    productDoctorRun.mockImplementation(async () => {
      process.stdout.write("Usage: directive doctor\n");
      return 0;
    });
    const out = await captureStdout(async () => {
      const code = await handleContractEntrypoint(["doctor", "--help"]);
      expect(code).toBe(0);
    });
    expect(out).toContain("Usage: directive doctor");
    expect(out).not.toContain(DOCTOR_PRODUCT_SECTION_SEPARATOR);
    expect(out).not.toMatch(/directive doctor: (in sync|not in sync)/);
    expect(productDoctorRun).toHaveBeenCalledTimes(1);
  });
});
