/**
 * Wave 2d self-completing setup owner tests (AC8.6 / AC2.5 / AC9.10).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_PIN_PACKAGE } from "@deftai/directive-core/dist/install-health/constants.js";
import { runSetup } from "./setup.js";
import {
  DEFT_DOCTOR_HOOK_DIAGNOSTIC,
  isDoctorDiagnosticEnv,
  isEligibleSelfCompleteCommand,
  maybeSelfCompleteSetup,
} from "./self-complete.js";

const TEMPS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "self-complete-"));
  TEMPS.push(root);
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

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("isEligibleSelfCompleteCommand", () => {
  it("rejects installation-management and help heads", () => {
    for (const head of ["install", "upgrade", "uninstall", "doctor", "setup", "--help", "-V"]) {
      expect(isEligibleSelfCompleteCommand([head])).toBe(false);
    }
  });

  it("accepts ordinary product commands", () => {
    expect(isEligibleSelfCompleteCommand(["verify:branch"])).toBe(true);
    expect(isEligibleSelfCompleteCommand(["check"])).toBe(true);
  });
});

describe("isDoctorDiagnosticEnv", () => {
  it("treats 1/true as diagnostic; 0/false/empty as not", () => {
    expect(isDoctorDiagnosticEnv({ [DEFT_DOCTOR_HOOK_DIAGNOSTIC]: "1" })).toBe(true);
    expect(isDoctorDiagnosticEnv({ [DEFT_DOCTOR_HOOK_DIAGNOSTIC]: "true" })).toBe(true);
    expect(isDoctorDiagnosticEnv({ [DEFT_DOCTOR_HOOK_DIAGNOSTIC]: "0" })).toBe(false);
    expect(isDoctorDiagnosticEnv({ [DEFT_DOCTOR_HOOK_DIAGNOSTIC]: "false" })).toBe(false);
    expect(isDoctorDiagnosticEnv({})).toBe(false);
  });
});

describe("maybeSelfCompleteSetup (AC8.6)", () => {
  it("skips never-configured projects (no GENERATION)", () => {
    const root = tempRoot();
    pinRuntime(root, "1.2.3");
    const result = maybeSelfCompleteSetup(root, { argv: ["verify:branch"] });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("not-configured");
  });

  it("skips when DEFT_DOCTOR_HOOK_DIAGNOSTIC is set", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    rmSync(join(root, ".deft", "directive"), { recursive: true, force: true });
    const result = maybeSelfCompleteSetup(root, {
      fromHook: true,
      environ: { [DEFT_DOCTOR_HOOK_DIAGNOSTIC]: "1" },
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("doctor-diagnostic");
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${installed.runtimeVersion}.json`)),
    ).toBe(false);
  });

  it("fast path when readiness is already valid", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    const result = maybeSelfCompleteSetup(root, { argv: ["verify:branch"] });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("fast-path");
  });

  it("completes wiring when readiness is missing but GENERATION is current", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    const readyRel = join(
      root,
      ".deft",
      "directive",
      `wiring-ready.${installed.runtimeVersion}.json`,
    );
    rmSync(readyRel, { force: true });
    expect(existsSync(readyRel)).toBe(false);

    const result = maybeSelfCompleteSetup(root, { argv: ["verify:branch"] });
    expect(result.ran).toBe(true);
    expect(result.setup?.conflicts ?? []).toEqual([]);
    expect(existsSync(readyRel)).toBe(true);
    expect(JSON.parse(readFileSync(readyRel, "utf8")).runtimeVersion).toBe(
      installed.runtimeVersion,
    );
    // Repair path — no new seeds when seeds already removed
    rmSync(join(root, "xbrief"), { recursive: true, force: true });
    rmSync(readyRel, { force: true });
    const again = maybeSelfCompleteSetup(root, { fromHook: true });
    expect(again.ran).toBe(true);
    expect(existsSync(join(root, "xbrief", ".directive-seed-placeholder"))).toBe(false);
  });

  it("skips ineligible argv even when readiness is missing", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    rmSync(join(root, ".deft", "directive"), { recursive: true, force: true });
    const result = maybeSelfCompleteSetup(root, { argv: ["doctor"] });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("ineligible");
  });
});
