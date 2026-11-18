/**
 * Rule 10 / rule 9 inventory for Wave 2e doctor remedies.
 * update-as-repair and agent npx/pnpm-exec must not appear in Contract-1 doctor text.
 * #5798 — failure-shaped remedy map keepers (schema / wiring / install classes).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatEntryGuardMessage,
  INSTALLATION_RECOVERY_GUIDANCE,
  pinInvalidValues,
  projectInstallCommand,
  RUNTIME_PIN_PACKAGE,
} from "@deftai/directive-core/dist/install-health/constants.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_DOCTOR_REMEDY_PATTERNS,
  formatDoctorReport,
  runDoctorDiagnosis,
  WIRING_DAMAGED_RECOVERY_GUIDANCE,
  WIRING_RECOVERY_GUIDANCE,
} from "./doctor-diagnose.js";
import { CURRENT_DATA_SCHEMA_VERSION, DATA_SCHEMA_MARKER_REL } from "./migrate.js";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-remedy-"));
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

/** Healthy pin/lock/installed/GENERATION/readiness fixture; caller may mutate wiring/schema. */
function installHealthyBase(): { root: string; version: string } {
  const root = tempRoot();
  const installed = runSetup({ operation: "install", from: "none", root });
  pinRuntime(root, installed.runtimeVersion);
  writeLockfileNpm(root, installed.runtimeVersion);
  writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);
  return { root, version: installed.runtimeVersion };
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("doctor remedy inventory (rule 10 / rule 9 / AC12.5–12.7)", () => {
  it("AC9.7 recovery string is the install/wiring remedy", () => {
    expect(INSTALLATION_RECOVERY_GUIDANCE).toBe(
      "npm i -g @deftai/directive, then directive install --repair",
    );
  });

  it("forbidden remedy patterns stay stable for message checks", () => {
    expect(FORBIDDEN_DOCTOR_REMEDY_PATTERNS.length).toBeGreaterThanOrEqual(8);
    const sample = formatDoctorReport(
      runDoctorDiagnosis("/tmp/definitely-not-a-directive-project-2e", { probeHooks: false }),
    );
    for (const re of FORBIDDEN_DOCTOR_REMEDY_PATTERNS) {
      expect(sample).not.toMatch(re);
    }
    // AC12.7: never dual-prescribe upgrade + AC9.7 global repair for the same fault report.
    if (sample.includes(INSTALLATION_RECOVERY_GUIDANCE)) {
      expect(sample).not.toMatch(/Next: directive upgrade/);
    }
    if (/Next:\s*directive upgrade/i.test(sample)) {
      expect(sample).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    }
  });
});

describe("doctor failure-shaped remedy map (#5798)", () => {
  it("schema-only red → recovery mentions upgrade/migrate, not only npm i -g + repair", () => {
    const { root } = installHealthyBase();
    writeDataSchema(root, 0);

    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.surfaces.pin.ok).toBe(true);
    expect(diag.surfaces.installed.ok).toBe(true);
    expect(diag.surfaces.wiring.ok).toBe(true);
    expect(diag.surfaces.readiness.ok).toBe(true);
    expect(diag.dataStatus).toBe("migration_needed");
    expect(diag.schemaRemedy).toBe("directive upgrade");
    expect(diag.remedy).toBeNull();

    const text = formatDoctorReport(diag);
    expect(text).toMatch(/directive upgrade|migrate/i);
    expect(text).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(text).not.toMatch(/npm i -g @deftai\/directive/);
  });

  it("wiring-only red naming Taskfile.yml → recovery references wiring/Taskfile (or probe), not only global repair", () => {
    const { root } = installHealthyBase();
    // Legacy Taskfile include → wiring predicate names Taskfile.yml in detail.
    writeFileSync(
      join(root, "Taskfile.yml"),
      [
        'version: "3"',
        "includes:",
        "  deft:",
        "    taskfile: ./.deft/core/Taskfile.yml",
        "    optional: true",
        "",
      ].join("\n"),
    );

    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.surfaces.pin.ok).toBe(true);
    expect(diag.surfaces.installed.ok).toBe(true);
    expect(diag.surfaces.lockfile.ok).toBe(true);
    expect(diag.surfaces.generation.ok).toBe(true);
    expect(diag.surfaces.readiness.ok).toBe(true);
    expect(diag.surfaces.wiring.ok).toBe(false);
    expect(diag.surfaces.wiring.detail).toMatch(/Taskfile\.yml/i);
    expect(diag.dataStatus).toBe("current");

    const text = formatDoctorReport(diag);
    expect(text).toMatch(/Taskfile\.yml|wiring|probe/i);
    // Must not steer solely to the global-install hammer.
    expect(text).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(text).not.toMatch(/npm i -g @deftai\/directive/);
    expect(diag.remedy).toBe(WIRING_RECOVERY_GUIDANCE);
    expect(text).toContain(WIRING_RECOVERY_GUIDANCE);
  });

  it("runtime missing → the project install (no npm i -g, no --repair)", () => {
    const { root } = installHealthyBase();
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.surfaces.installed.ok).toBe(false);
    expect(diag.remedy).toBe(
      formatEntryGuardMessage("runtime-missing", { install: "`npm install`" }),
    );
    const text = formatDoctorReport(diag);
    expect(text).toContain(`Next: ${diag.remedy}\n`);
    expect(text.match(/^(Next|Recovery):/gm)).toHaveLength(1);
    expect(text).not.toMatch(/npm i -g @deftai\/directive/);
    expect(text).not.toContain("--repair");
  });

  it("installed ≠ pin → the project install for the lockfile's package manager", () => {
    const { root } = installHealthyBase();
    writeFileSync(
      join(root, "node_modules", "@deftai", "directive-runtime", "package.json"),
      `${JSON.stringify({ name: RUNTIME_PIN_PACKAGE, version: "0.0.1" })}\n`,
    );
    const npmDiag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(npmDiag.failClosed).toBe(true);
    expect(npmDiag.remedy).toContain("installed @deftai/directive-runtime 0.0.1 is not the pinned");
    expect(npmDiag.remedy).toContain("Run `npm install`");
    rmSync(join(root, "package-lock.json"));
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const pnpmDiag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(pnpmDiag.remedy).toContain(`Run ${projectInstallCommand(root)}`);
    expect(pnpmDiag.remedy).toContain("`pnpm install --frozen-lockfile`");
    const text = formatDoctorReport(pnpmDiag);
    expect(text).not.toMatch(/npm i -g @deftai\/directive/);
    expect(text).not.toContain("--repair");
  });

  it("lockfile disagrees with the pin → repair (AC14.14)", () => {
    const { root } = installHealthyBase();
    writeLockfileNpm(root, "0.0.1");
    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.surfaces.lockfile.ok).toBe(false);
    expect(diag.remedy).toBe(WIRING_DAMAGED_RECOVERY_GUIDANCE);
    expect(formatDoctorReport(diag)).toContain(
      "Recovery: Directive's wiring is damaged. Run `directive install --repair`.",
    );
  });

  it("GENERATION.json missing → repair", () => {
    const { root } = installHealthyBase();
    rmSync(join(root, ".deft", "GENERATION.json"), { force: true });
    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.surfaces.generation.ok).toBe(false);
    expect(diag.remedy).toBe(WIRING_DAMAGED_RECOVERY_GUIDANCE);
  });

  it("readiness missing (with .git) → repair, never the global pair", () => {
    const { root, version } = installHealthyBase();
    rmSync(join(root, ".deft", "directive", `wiring-ready.${version}.json`), { force: true });
    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.surfaces.readiness.ok).toBe(false);
    expect(diag.incompleteInstall).toBeNull();
    expect(diag.remedy).toBe(WIRING_DAMAGED_RECOVERY_GUIDANCE);
    expect(formatDoctorReport(diag)).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
  });

  it("range pin → fix the pin first (shared pin-invalid row, D-042)", () => {
    const { root } = installHealthyBase();
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "t", private: true, devDependencies: { [RUNTIME_PIN_PACKAGE]: "^1.0.0" } })}\n`,
    );
    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.surfaces.pin.ok).toBe(false);
    expect(diag.remedy).toBe(
      formatEntryGuardMessage("pin-invalid", pinInvalidValues(root, "^1.0.0")),
    );
    expect(diag.remedy).toContain("It currently says `^1.0.0`");
    expect(diag.remedy).not.toContain("--repair");
  });

  it("wiring + schema residual lists per-surface remedies (no AC9.7 hammer)", () => {
    const { root } = installHealthyBase();
    writeDataSchema(root, 0);
    writeFileSync(
      join(root, "Taskfile.yml"),
      'version: "3"\nincludes:\n  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n    optional: true\n',
    );

    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.surfaces.wiring.ok).toBe(false);
    expect(diag.dataStatus).toBe("migration_needed");
    expect(diag.remedy).toBe(WIRING_RECOVERY_GUIDANCE);
    expect(diag.schemaRemedy).toBe("directive upgrade");

    const text = formatDoctorReport(diag);
    expect(text).toContain(WIRING_RECOVERY_GUIDANCE);
    expect(text).toMatch(/Next:\s*directive upgrade/i);
    expect(text).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(text).not.toMatch(/npm i -g @deftai\/directive/);
  });
});
