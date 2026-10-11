/**
 * Wave 2e doctor diagnosis owner tests (R12 / AC12.* / AC9.10).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFT_DOCTOR_HOOK_DIAGNOSTIC,
  INSTALLATION_RECOVERY_GUIDANCE,
  RUNTIME_PIN_PACKAGE,
} from "@deftai/directive-core/dist/install-health/constants.js";
import { CURRENT_DATA_SCHEMA_VERSION, DATA_SCHEMA_MARKER_REL } from "./migrate.js";
import { runSetup } from "./setup.js";
import {
  FORBIDDEN_DOCTOR_REMEDY_PATTERNS,
  formatDoctorReport,
  runDoctorDiagnosis,
  type DoctorDiagnosis,
} from "./doctor-diagnose.js";

const TEMPS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-2e-"));
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

/** Snapshot relative file paths → sha256 + mtimeMs (AC12.1). */
function snapshotTree(root: string): Map<string, { hash: string; mtimeMs: number }> {
  const out = new Map<string, { hash: string; mtimeMs: number }>();
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules") continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(root, abs);
      const hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
      out.set(rel, { hash, mtimeMs: st.mtimeMs });
    }
  };
  walk(root);
  return out;
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("runDoctorDiagnosis (AC12.3 surfaces)", () => {
  it("reports in-sync project covering pin/lock/installed/GENERATION/wiring/readiness/schema", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeLockfileNpm(root, installed.runtimeVersion);
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);

    const diag = runDoctorDiagnosis(root, {
      launcherPresent: true,
      probeHooks: false,
    });
    expect(diag.inSync).toBe(true);
    expect(diag.surfaces.pin.ok).toBe(true);
    expect(diag.surfaces.lockfile.ok).toBe(true);
    expect(diag.surfaces.installed.ok).toBe(true);
    expect(diag.surfaces.generation.ok).toBe(true);
    expect(diag.surfaces.wiring.ok).toBe(true);
    expect(diag.surfaces.readiness.ok).toBe(true);
    expect(diag.dataStatus).toBe("current");
    expect(diag.remedy).toBeNull();
    expect(diag.info.launcherPresent).toBe(true);
  });

  it("after first-time install alone, doctor is in sync without upgrade (AC6.2)", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeLockfileNpm(root, installed.runtimeVersion);
    // No writeDataSchema — install setup must leave schema currency current.

    const diag = runDoctorDiagnosis(root, {
      launcherPresent: true,
      probeHooks: false,
    });
    expect(diag.dataStatus).toBe("current");
    expect(diag.inSync).toBe(true);
    expect(diag.schemaRemedy).toBeNull();
    expect(diag.remedy).toBeNull();
    const text = formatDoctorReport(diag);
    expect(text).toMatch(/in sync/i);
    expect(text).not.toMatch(/directive upgrade/);
  });

  it("names AC9.7 when installed runtime missing (AC12.2)", () => {
    const root = tempRoot();
    pinRuntime(root, "1.2.3");
    writeLockfileNpm(root, "1.2.3");
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "GENERATION.json"),
      `${JSON.stringify({ runtimeVersion: "1.2.3", packageManager: "npm" }, null, 2)}\n`,
    );
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);
    // Remove installed package after pin+generation
    rmSync(join(root, "node_modules"), { recursive: true, force: true });

    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.inSync).toBe(false);
    expect(diag.surfaces.installed.ok).toBe(false);
    expect(diag.dataStatus).toBe("current");
    expect(diag.remedy).toBe(INSTALLATION_RECOVERY_GUIDANCE);
    const text = formatDoctorReport(diag);
    expect(text).toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(text).not.toMatch(/directive upgrade/);
  });

  it("names directive upgrade when data schema is behind (AC12.2 / AC8.9)", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeLockfileNpm(root, installed.runtimeVersion);
    writeDataSchema(root, 0);

    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.dataStatus).toBe("migration_needed");
    expect(diag.schemaRemedy).toBe("directive upgrade");
    const text = formatDoctorReport(diag);
    expect(text).toContain("directive upgrade");
    expect(text).not.toMatch(/install --repair/);
  });

  it("writes nothing: tree hash/mtime unchanged including missing readiness (AC12.1 / AC9.10)", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeLockfileNpm(root, installed.runtimeVersion);
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);
    const ready = join(
      root,
      ".deft",
      "directive",
      `wiring-ready.${installed.runtimeVersion}.json`,
    );
    rmSync(ready, { force: true });
    expect(existsSync(ready)).toBe(false);

    const before = snapshotTree(root);
    const diag = runDoctorDiagnosis(root, {
      probeHooks: true,
      // Inject a no-op probe that still proves diagnostic env is requested.
      hookProbe: ({ env }) => {
        expect(env[DEFT_DOCTOR_HOOK_DIAGNOSTIC]).toMatch(/^(1|true)$/i);
        return { ok: true, detail: "injected" };
      },
    });
    expect(diag.surfaces.readiness.ok).toBe(false);
    expect(existsSync(ready)).toBe(false);

    const after = snapshotTree(root);
    expect(after.size).toBe(before.size);
    for (const [rel, prev] of before) {
      const next = after.get(rel);
      expect(next, rel).toBeDefined();
      expect(next!.hash, rel).toBe(prev.hash);
      expect(next!.mtimeMs, rel).toBe(prev.mtimeMs);
    }
  });
});

describe("doctor remedy wording (AC12.5–12.7 / rule 9)", () => {
  it("forbids ladder / align-pin / skew / npx / global-runtime remedies in report text", () => {
    const root = tempRoot();
    pinRuntime(root, "9.9.9");
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    const text = formatDoctorReport(runDoctorDiagnosis(root, { probeHooks: false }));
    for (const re of FORBIDDEN_DOCTOR_REMEDY_PATTERNS) {
      expect(text, String(re)).not.toMatch(re);
    }
  });
});

describe("DoctorDiagnosis shape", () => {
  it("exposes informational launcher / newer-release / node notes without making them faults", () => {
    const diag: DoctorDiagnosis = runDoctorDiagnosis(tempRoot(), {
      launcherPresent: false,
      newerReleaseAvailable: true,
      nodeBestEffortNote: "Node 20 best-effort",
      probeHooks: false,
    });
    expect(diag.info.launcherPresent).toBe(false);
    expect(diag.info.newerReleaseAvailable).toBe(true);
    expect(diag.info.nodeBestEffortNote).toBe("Node 20 best-effort");
    expect(diag.inSync).toBe(false);
  });
});

describe("POST-CONV-DOC / AC12.3 header vs skill pointers (AC10.3)", () => {
  it("does not claim 'in sync' when skill pointers FAIL (header tracks exitCode)", () => {
    // Constructed diagnosis: install-health inSync can be true while skill form fails
    // (AC12.3). Header must follow overall exitCode, not inSync alone.
    const diag: DoctorDiagnosis = {
      inSync: true,
      version: "1.2.3",
      failClosed: false,
      dataStatus: "current",
      remedy: null,
      schemaRemedy: null,
      surfaces: {
        pin: { ok: true, detail: null },
        lockfile: { ok: true, detail: null },
        installed: { ok: true, detail: null },
        generation: { ok: true, detail: null },
        wiring: { ok: true, detail: null },
        readiness: { ok: true, detail: null },
        hookCommandForm: { ok: true, detail: null },
        skillPointers: { ok: false, detail: "AGENTS.md does not target runtime" },
        schemaCurrency: { ok: true, detail: null },
      },
      hookProbe: null,
      info: { launcherPresent: null, newerReleaseAvailable: null, nodeBestEffortNote: null },
      exitCode: 1,
    };
    const text = formatDoctorReport(diag);
    expect(text).toMatch(/directive doctor: not in sync/);
    expect(text).not.toMatch(/^directive doctor: in sync$/m);
    expect(text).toMatch(/skill pointers: FAIL/);
  });

  it("ignores stale .deft/core prose outside the managed section after convert", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    pinRuntime(root, installed.runtimeVersion);
    writeLockfileNpm(root, installed.runtimeVersion);
    writeDataSchema(root, CURRENT_DATA_SCHEMA_VERSION);
    // Managed section is package-relative; legacy fixture prose remains outside.
    writeFileSync(
      join(root, "AGENTS.md"),
      [
        "# Project",
        "",
        "Follow `.deft/core/main.md` (historical note).",
        "",
        "<!-- deft:managed-section v3 -->",
        `Full guidelines: node_modules/@deftai/directive-runtime/main.md`,
        `Skills: node_modules/@deftai/directive-runtime/skills/`,
        "<!-- /deft:managed-section -->",
        "",
      ].join("\n"),
    );

    const diag = runDoctorDiagnosis(root, { probeHooks: false });
    expect(diag.surfaces.skillPointers.ok).toBe(true);
    expect(diag.exitCode).toBe(0);
    const text = formatDoctorReport(diag);
    expect(text).toMatch(/directive doctor: in sync/);
    expect(text).toMatch(/skill pointers: ok/);
  });
});

describe("AC12.7 dual remedy exclusion", () => {
  it("never emits Next:upgrade together with Recovery repair for the same report", () => {
    const samples = [
      runDoctorDiagnosis("/tmp/definitely-not-a-directive-project-2o", { probeHooks: false }),
      (() => {
        const root = tempRoot();
        pinRuntime(root, "1.2.3");
        writeLockfileNpm(root, "1.2.3");
        writeDataSchema(root, 0); // schema behind
        rmSync(join(root, "node_modules"), { recursive: true, force: true }); // install broken
        return runDoctorDiagnosis(root, { probeHooks: false });
      })(),
    ];
    for (const diag of samples) {
      const text = formatDoctorReport(diag);
      const hasUpgrade = /Next:\s*directive upgrade/i.test(text);
      const hasRepair =
        text.includes(INSTALLATION_RECOVERY_GUIDANCE) || /install --repair/i.test(text);
      expect(hasUpgrade && hasRepair, text).toBe(false);
      if (diag.remedy) expect(diag.schemaRemedy).toBeNull();
      if (diag.schemaRemedy) expect(diag.remedy).toBeNull();
    }
  });
});
