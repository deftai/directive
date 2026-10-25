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
  INSTALLATION_RECOVERY_GUIDANCE,
  RUNTIME_PIN_PACKAGE,
} from "@deftai/directive-core/dist/install-health/constants.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_DOCTOR_REMEDY_PATTERNS,
  formatDoctorReport,
  runDoctorDiagnosis,
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

  it("true install skew / missing readiness still gets install/repair guidance", () => {
    const { root, version } = installHealthyBase();
    rmSync(join(root, "node_modules"), { recursive: true, force: true });

    const missingInstall = runDoctorDiagnosis(root, { probeHooks: false });
    expect(missingInstall.surfaces.installed.ok).toBe(false);
    expect(missingInstall.remedy).toBe(INSTALLATION_RECOVERY_GUIDANCE);
    const missingText = formatDoctorReport(missingInstall);
    expect(missingText).toMatch(/npm i -g @deftai\/directive/);
    expect(missingText).toMatch(/install --repair/);

    // Re-install base then drop readiness only.
    const again = installHealthyBase();
    rmSync(join(again.root, ".deft", "directive", `wiring-ready.${again.version}.json`), {
      force: true,
    });
    const readinessGap = runDoctorDiagnosis(again.root, { probeHooks: false });
    expect(readinessGap.surfaces.pin.ok).toBe(true);
    expect(readinessGap.surfaces.installed.ok).toBe(true);
    expect(readinessGap.surfaces.readiness.ok).toBe(false);
    expect(readinessGap.incompleteInstall).toBeNull();
    expect(readinessGap.remedy).toBe(INSTALLATION_RECOVERY_GUIDANCE);
    const readyText = formatDoctorReport(readinessGap);
    expect(readyText).toContain(INSTALLATION_RECOVERY_GUIDANCE);
    // unused version bind keeps fixture honest
    expect(version.length).toBeGreaterThan(0);
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
