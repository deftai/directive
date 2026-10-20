/**
 * Wave 3h / F-010 — no-git incomplete install doctor story (C7 warn+partial).
 * AC6.2 in-sync applies only when git preconditions were met.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTALLATION_RECOVERY_GUIDANCE,
  RUNTIME_PIN_PACKAGE,
} from "@deftai/directive-core/dist/install-health/constants.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_DOCTOR_REMEDY_PATTERNS,
  formatDoctorReport,
  GIT_PRECONDITION_READINESS_DETAIL,
  GIT_PRECONDITION_RECOVERY_GUIDANCE,
  runDoctorDiagnosis,
} from "./doctor-diagnose.js";
import { CURRENT_DATA_SCHEMA_VERSION, DATA_SCHEMA_MARKER_REL } from "./migrate.js";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];

/** No-git fixture root (F-010 partial install). */
function tempRootNoGit(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-f010-"));
  TEMPS.push(root);
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

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("F-010 no-git incomplete install doctor (C7 warn+partial)", () => {
  it("no-git install → incomplete install header + git init recovery (not AC9.7)", () => {
    const root = tempRootNoGit();
    expect(existsSync(join(root, ".git"))).toBe(false);

    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeLockfileNpm(root, installed.runtimeVersion);
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${installed.runtimeVersion}.json`)),
    ).toBe(false);

    const diag = runDoctorDiagnosis(root, {
      launcherPresent: true,
      probeHooks: false,
    });
    expect(diag.inSync).toBe(false);
    expect(diag.incompleteInstall).toBe("git-precondition");
    expect(diag.surfaces.pin.ok).toBe(true);
    expect(diag.surfaces.lockfile.ok).toBe(true);
    expect(diag.surfaces.installed.ok).toBe(true);
    expect(diag.surfaces.generation.ok).toBe(true);
    expect(diag.surfaces.wiring.ok).toBe(true);
    expect(diag.surfaces.readiness.ok).toBe(false);
    expect(diag.surfaces.readiness.detail).toBe(GIT_PRECONDITION_READINESS_DETAIL);
    expect(diag.remedy).toBe(GIT_PRECONDITION_RECOVERY_GUIDANCE);
    expect(diag.schemaRemedy).toBeNull();
    expect(diag.exitCode).toBe(1);

    const text = formatDoctorReport(diag);
    expect(text).toMatch(/incomplete install \(git precondition\)/i);
    expect(text).not.toMatch(/^directive doctor: not in sync$/m);
    expect(text).not.toMatch(/^directive doctor: in sync$/m);
    // wave 4g: plain Next: block (same git-init recovery, friendlier layout)
    expect(text).toContain("Next:");
    expect(text).toMatch(/git init/i);
    expect(text).toMatch(/directive install --repair/);
    expect(diag.remedy).toBe(GIT_PRECONDITION_RECOVERY_GUIDANCE);
    expect(text).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(text).not.toMatch(/npm i -g @deftai\/directive/);
    for (const re of FORBIDDEN_DOCTOR_REMEDY_PATTERNS) {
      expect(text, String(re)).not.toMatch(re);
    }
  });

  it("after git init + repair, doctor can be in sync (AC6.2 when git preconditions met)", () => {
    const root = tempRootNoGit();
    const first = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, first.runtimeVersion);
    writeLockfileNpm(root, first.runtimeVersion);
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);

    const before = runDoctorDiagnosis(root, { launcherPresent: true, probeHooks: false });
    expect(before.incompleteInstall).toBe("git-precondition");
    expect(before.inSync).toBe(false);

    execFileSync("git", ["init", "-q"], { cwd: root });
    const repaired = runSetup({
      operation: "repair",
      from: first.runtimeVersion,
      root,
    });
    expect(repaired.conflicts).toEqual([]);
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${repaired.runtimeVersion}.json`)),
    ).toBe(true);

    const after = runDoctorDiagnosis(root, { launcherPresent: true, probeHooks: false });
    expect(after.incompleteInstall).toBeNull();
    expect(after.inSync).toBe(true);
    expect(after.surfaces.readiness.ok).toBe(true);
    expect(after.remedy).toBeNull();
    expect(after.exitCode).toBe(0);
    const text = formatDoctorReport(after);
    expect(text).toMatch(/^directive doctor: in sync$/m);
    expect(text).not.toMatch(/incomplete install/i);
    expect(text).not.toContain(GIT_PRECONDITION_RECOVERY_GUIDANCE);
    expect(text).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
  });

  it("with .git but missing readiness still uses AC9.7 (not git-precondition framing)", () => {
    const root = tempRootNoGit();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeLockfileNpm(root, installed.runtimeVersion);
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);
    const ready = join(root, ".deft", "directive", `wiring-ready.${installed.runtimeVersion}.json`);
    expect(existsSync(ready)).toBe(true);
    rmSync(ready, { force: true });

    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.incompleteInstall).toBeNull();
    expect(diag.inSync).toBe(false);
    expect(diag.remedy).toBe(INSTALLATION_RECOVERY_GUIDANCE);
    const text = formatDoctorReport(diag);
    expect(text).toMatch(/^directive doctor: not in sync$/m);
    expect(text).not.toMatch(/incomplete install \(git precondition\)/i);
    expect(text).toContain(`Recovery: ${INSTALLATION_RECOVERY_GUIDANCE}`);
  });
});
