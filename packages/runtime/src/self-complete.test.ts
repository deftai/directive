/**
 * Wave 2d self-completing setup owner tests (AC8.6 / AC2.5 / AC9.10).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PIN_PACKAGE } from "@deftai/directive-core/dist/install-health/constants.js";
import { afterEach, describe, expect, it } from "vitest";
import { run as runHookDispatch } from "./hook-dispatch.js";
import {
  DEFT_DOCTOR_HOOK_DIAGNOSTIC,
  isDoctorDiagnosticEnv,
  isEligibleSelfCompleteCommand,
  maybeSelfCompleteSetup,
  resetSelfCompletePreservedDisclosureForTests,
} from "./self-complete.js";
import { runSetup } from "./setup.js";
import { formatTrackedHookPreserved } from "./setup-wiring.js";

const TEMPS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "self-complete-"));
  TEMPS.push(root);
  // AC8.6: wiring-ready requires activatable core.hooksPath=.githooks.
  execFileSync("git", ["init", "-q"], { cwd: root });
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

/** Consumer-customized managed hook (sources the shared helper). */
const CUSTOM_PRE_PUSH = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive preflight-gh --pre-push-stdin --project-root "$REPO_ROOT" || exit $?
`;

afterEach(() => {
  resetSelfCompletePreservedDisclosureForTests();
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
  it("skips never-configured projects (no GENERATION, pin-only) (AC14.50)", () => {
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

  it("discloses preserved tracked hooks on writeErr once per process (#5885 P1)", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    const hookRel = ".githooks/pre-push";
    writeFileSync(join(root, hookRel), CUSTOM_PRE_PUSH, "utf8");
    execFileSync("git", ["add", "--", hookRel], { cwd: root });
    const readyRel = join(
      root,
      ".deft",
      "directive",
      `wiring-ready.${installed.runtimeVersion}.json`,
    );
    rmSync(readyRel, { force: true });
    try {
      execFileSync("git", ["-C", root, "config", "--unset", "core.hooksPath"]);
    } catch {
      /* may already be unset */
    }

    const err: string[] = [];
    const out: string[] = [];
    const expected = formatTrackedHookPreserved(hookRel);
    const first = maybeSelfCompleteSetup(root, {
      argv: ["verify:branch"],
      writeErr: (text) => err.push(text),
    });
    expect(first.ran).toBe(true);
    expect(first.skipReason).toBeNull();
    expect(err.join("")).toContain(expected);
    expect(out).toEqual([]);

    rmSync(readyRel, { force: true });
    const second = maybeSelfCompleteSetup(root, {
      argv: ["verify:branch"],
      writeErr: (text) => err.push(text),
    });
    expect(second.ran).toBe(true);
    expect(err.filter((chunk) => chunk.includes(expected))).toHaveLength(1);
  });

  it("hook-dispatch run threads seams.writeErr for preserve disclosure (#5885 P1)", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    const hookRel = ".githooks/pre-push";
    writeFileSync(join(root, hookRel), CUSTOM_PRE_PUSH, "utf8");
    execFileSync("git", ["add", "--", hookRel], { cwd: root });
    const readyRel = join(
      root,
      ".deft",
      "directive",
      `wiring-ready.${installed.runtimeVersion}.json`,
    );
    rmSync(readyRel, { force: true });
    try {
      execFileSync("git", ["-C", root, "config", "--unset", "core.hooksPath"]);
    } catch {
      /* may already be unset */
    }

    const err: string[] = [];
    const code = runHookDispatch(
      ["--host", "grok", "--event", "tool.before", `--project-root=${root}`],
      {
        readStdin: () =>
          JSON.stringify({ tool_name: "Read", tool_input: { path: join(root, "package.json") } }),
        writeOut: () => undefined,
        writeErr: (text) => err.push(text),
        cwd: () => root,
        cheapInSync: () => ({
          ok: false,
          failClosed: false,
          pinVersion: installed.runtimeVersion,
          installedVersion: installed.runtimeVersion,
          identityMatch: true,
          readinessValid: false,
          allowSetup: true,
          recoveryGuidance: null,
        }),
        launchingCheckoutRoot: () => root,
        stdinEmptyRetryMs: 0,
      },
    );
    expect(code).toBe(0);
    expect(err.join("")).toContain(formatTrackedHookPreserved(hookRel));
  });

  it("e2e: preserve disclosure, empty conflicts, readiness, unchanged hook bytes (#5885 P3)", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    const hookRel = ".githooks/pre-push";
    writeFileSync(join(root, hookRel), CUSTOM_PRE_PUSH, "utf8");
    execFileSync("git", ["add", "--", hookRel], { cwd: root });
    const readyRel = join(
      root,
      ".deft",
      "directive",
      `wiring-ready.${installed.runtimeVersion}.json`,
    );
    rmSync(readyRel, { force: true });
    expect(existsSync(readyRel)).toBe(false);
    try {
      execFileSync("git", ["-C", root, "config", "--unset", "core.hooksPath"]);
    } catch {
      /* may already be unset */
    }

    const err: string[] = [];
    const result = maybeSelfCompleteSetup(root, {
      argv: ["check"],
      writeErr: (text) => err.push(text),
    });
    expect(result.ran).toBe(true);
    expect(result.skipReason).toBeNull();
    expect(err.join("")).toContain(formatTrackedHookPreserved(hookRel));
    expect(result.setup?.conflicts ?? []).toEqual([]);
    expect(existsSync(readyRel)).toBe(true);
    expect(readFileSync(join(root, hookRel), "utf8")).toBe(CUSTOM_PRE_PUSH);
  });
});
