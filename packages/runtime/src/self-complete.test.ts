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
  DEFT_SKIP_SELF_COMPLETE,
  isDoctorDiagnosticEnv,
  isEligibleSelfCompleteCommand,
  isSkipSelfCompleteEnv,
  maybeSelfCompleteSetup,
  resetSelfCompleteGitHookDisclosureForTests,
} from "./self-complete.js";
import { runSetup } from "./setup.js";
import { DIRECTIVE_GIT_HOOK_BODIES, formatGitHookUpdated } from "./setup-wiring.js";

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

/** Consumer-edited Directive hook (sources the shared helper). */
const CUSTOM_PRE_PUSH = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive preflight-gh --pre-push-stdin --project-root "$REPO_ROOT" || exit $?
`;

afterEach(() => {
  resetSelfCompleteGitHookDisclosureForTests();
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

  it("rejects release:run / release-run so tip cuts stay tree-clean at readiness (#7327)", () => {
    expect(isEligibleSelfCompleteCommand(["release:run"])).toBe(false);
    expect(isEligibleSelfCompleteCommand(["release-run"])).toBe(false);
    expect(
      isEligibleSelfCompleteCommand(["release:run", "1.2.0", "--expires", "2099-01-01T00:00:00Z"]),
    ).toBe(false);
  });

  it("rejects space-form release run (raw argv before router) (#7327)", () => {
    expect(isEligibleSelfCompleteCommand(["release", "run"])).toBe(false);
    expect(
      isEligibleSelfCompleteCommand([
        "release",
        "run",
        "1.2.0",
        "--expires",
        "2099-01-01T00:00:00Z",
      ]),
    ).toBe(false);
    // Other release space-forms stay eligible unless stamped skip-env.
    expect(isEligibleSelfCompleteCommand(["release", "finish"])).toBe(true);
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

describe("isSkipSelfCompleteEnv", () => {
  it("treats 1/true as skip; 0/false/empty as not (#7327)", () => {
    expect(isSkipSelfCompleteEnv({ [DEFT_SKIP_SELF_COMPLETE]: "1" })).toBe(true);
    expect(isSkipSelfCompleteEnv({ [DEFT_SKIP_SELF_COMPLETE]: "true" })).toBe(true);
    expect(isSkipSelfCompleteEnv({ [DEFT_SKIP_SELF_COMPLETE]: "0" })).toBe(false);
    expect(isSkipSelfCompleteEnv({ [DEFT_SKIP_SELF_COMPLETE]: "false" })).toBe(false);
    expect(isSkipSelfCompleteEnv({ [DEFT_SKIP_SELF_COMPLETE]: "no" })).toBe(false);
    expect(isSkipSelfCompleteEnv({})).toBe(false);
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

  it("#7327: release:run skips self-complete on a tip pin+wiring tree without GENERATION", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    // Tip-cut shape: pin + wiring evidence, no GENERATION / readiness marker.
    rmSync(join(root, ".deft", "GENERATION.json"), { force: true });
    rmSync(join(root, ".deft", "directive"), { recursive: true, force: true });
    const before = execFileSync("git", ["-C", root, "status", "--porcelain"], {
      encoding: "utf8",
    });

    const releaseRun = maybeSelfCompleteSetup(root, {
      argv: ["release:run", "1.2.0", "--expires", "2099-01-01T00:00:00Z"],
    });
    expect(releaseRun.ran).toBe(false);
    expect(releaseRun.skipReason).toBe("ineligible");
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(false);
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })).toBe(
      before,
    );

    // Measured writer still fires for ordinary product argv (contrast).
    const ordinary = maybeSelfCompleteSetup(root, { argv: ["verify:branch"] });
    expect(ordinary.ran).toBe(true);
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(true);
  });

  it("#7327: DEFT_SKIP_SELF_COMPLETE carries into child session:start and hooks", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    rmSync(join(root, ".deft", "GENERATION.json"), { force: true });
    rmSync(join(root, ".deft", "directive"), { recursive: true, force: true });
    const before = execFileSync("git", ["-C", root, "status", "--porcelain"], {
      encoding: "utf8",
    });
    const skipEnv = { [DEFT_SKIP_SELF_COMPLETE]: "1" };

    // setupRitual child: session:start is otherwise eligible and would dirt the tip.
    const child = maybeSelfCompleteSetup(root, {
      argv: ["session:start", "--primary-claim-exception=release-cut"],
      environ: skipEnv,
    });
    expect(child.ran).toBe(false);
    expect(child.skipReason).toBe("skip-self-complete");
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(false);

    // fromHook bypasses argv eligibility; the env still suppresses (#7327 P1).
    const hook = maybeSelfCompleteSetup(root, { fromHook: true, environ: skipEnv });
    expect(hook.ran).toBe(false);
    expect(hook.skipReason).toBe("skip-self-complete");
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })).toBe(
      before,
    );

    // Without the carry, the same session:start dirties the tip (contrast / cut path).
    const bare = maybeSelfCompleteSetup(root, {
      argv: ["session:start", "--primary-claim-exception=release-cut"],
    });
    expect(bare.ran).toBe(true);
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(true);
  });

  it("names a replaced tracked hook on writeErr once per process (#5885 / D-023)", () => {
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
    const expected = formatGitHookUpdated(hookRel, true);
    const first = maybeSelfCompleteSetup(root, {
      argv: ["verify:branch"],
      writeErr: (text) => err.push(text),
    });
    expect(first.ran).toBe(true);
    expect(first.skipReason).toBeNull();
    expect(err.join("")).toContain(expected);
    expect(out).toEqual([]);

    rmSync(readyRel, { force: true });
    writeFileSync(join(root, hookRel), CUSTOM_PRE_PUSH, "utf8");
    const second = maybeSelfCompleteSetup(root, {
      argv: ["verify:branch"],
      writeErr: (text) => err.push(text),
    });
    expect(second.ran).toBe(true);
    expect(err.filter((chunk) => chunk.includes(expected))).toHaveLength(1);
  });

  it("another core.hooksPath: never taken over, no readiness, fix named once (#4960 / #5846)", () => {
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
    execFileSync("git", ["-C", root, "config", "core.hooksPath", "custom-hooks"]);

    const err: string[] = [];
    const first = maybeSelfCompleteSetup(root, {
      argv: ["verify:branch"],
      writeErr: (text) => err.push(text),
    });
    expect(first.ran).toBe(true);
    expect(first.setup?.conflicts).toEqual([]);
    expect(existsSync(readyRel)).toBe(false);
    expect(
      execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("custom-hooks");
    const text = err.join("");
    expect(text).toContain("core.hooksPath is 'custom-hooks'");
    expect(text).toContain("directive install --repair");

    maybeSelfCompleteSetup(root, { argv: ["verify:branch"], writeErr: (t) => err.push(t) });
    expect(err.filter((chunk) => chunk.includes("custom-hooks"))).toHaveLength(1);
  });

  it("hook-dispatch run threads seams.writeErr for the hook update line (#5885 / D-023)", () => {
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
    expect(err.join("")).toContain(formatGitHookUpdated(hookRel, true));
  });

  it("e2e: automatic setup replaces an edited tracked hook, names it, records readiness (D-023)", () => {
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
    expect(err.join("")).toContain(formatGitHookUpdated(hookRel, true));
    expect(result.setup?.conflicts ?? []).toEqual([]);
    expect(existsSync(readyRel)).toBe(true);
    expect(readFileSync(join(root, hookRel), "utf8")).toBe(DIRECTIVE_GIT_HOOK_BODIES[hookRel]);
  });

  it("AC14.10 / HT-17: pin+installed at W, GENERATION/wiring still V → eligible refreshes at W; pin+xbrief unchanged", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    const W = installed.runtimeVersion;
    const V = "0.129.0";
    expect(W).not.toBe(V);
    pinRuntime(root, W);

    const genPath = join(root, ".deft", "GENERATION.json");
    const gen = JSON.parse(readFileSync(genPath, "utf8")) as Record<string, unknown>;
    expect(gen.runtimeVersion).toBe(W);
    writeFileSync(genPath, `${JSON.stringify({ ...gen, runtimeVersion: V }, null, 2)}\n`);

    const readyW = join(root, ".deft", "directive", `wiring-ready.${W}.json`);
    const readyV = join(root, ".deft", "directive", `wiring-ready.${V}.json`);
    rmSync(readyW, { force: true });
    mkdirSync(join(root, ".deft", "directive"), { recursive: true });
    writeFileSync(readyV, `${JSON.stringify({ runtimeVersion: V }, null, 2)}\n`);

    const xbriefPath = join(root, "xbrief", "proposed", "stay-put.xbrief.json");
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const xbriefBody = `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8", description: "AC14.10 must not migrate" },
        plan: { id: "stay-put", title: "stay", status: "proposed" },
      },
      null,
      2,
    )}\n`;
    writeFileSync(xbriefPath, xbriefBody);
    const pinBefore = readFileSync(join(root, "package.json"), "utf8");

    const result = maybeSelfCompleteSetup(root, { argv: ["verify:branch"] });
    expect(result.ran).toBe(true);
    expect(result.skipReason).toBeNull();
    expect(result.setup?.conflicts ?? []).toEqual([]);
    expect(result.setup?.runtimeVersion).toBe(W);

    const genAfter = JSON.parse(readFileSync(genPath, "utf8")) as { runtimeVersion: string };
    expect(genAfter.runtimeVersion).toBe(W);
    expect(existsSync(readyW)).toBe(true);
    expect(JSON.parse(readFileSync(readyW, "utf8")).runtimeVersion).toBe(W);
    expect(existsSync(readyV)).toBe(false);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(pinBefore);
    expect(readFileSync(xbriefPath, "utf8")).toBe(xbriefBody);
  });
});
