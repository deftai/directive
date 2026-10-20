/**
 * Named suite for launcher–runtime Contract 1 (UNIFIED R4 / AC4.1, #5490).
 * Spine assertions on documented constants — stubs only, not full install.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACT_NUMBER,
  CONTRACT_PACKAGE_JSON_KEY,
  DATA_STATUS_VALUES,
  DataStatus,
  type DataStatusJson,
  type DoctorArgv,
  ENTRY_POINTS,
  type EntryPointName,
  EXIT_CODES,
  isContractSupportedByLauncher,
  LAUNCHER_MAX_SUPPORTED_CONTRACT,
  type MigrateArgv,
  parseDataStatusJson,
  readRuntimeContractFromPackageJson,
  SETUP_FROM_VALUES,
  SETUP_OPERATIONS,
  type SetupArgv,
  serializeDataStatusJson,
  type UninstallArgv,
} from "./index.js";

describe("launcher-runtime contract v1 (AC4.1 named suite)", () => {
  it("exports Contract 1 number matching package.json directive.contract shape", () => {
    expect(CONTRACT_NUMBER).toBe(1);
    expect(CONTRACT_PACKAGE_JSON_KEY).toBe("directive");
    const sample = { directive: { contract: CONTRACT_NUMBER }, version: "1.2.3" };
    expect(sample.directive.contract).toBe(1);
  });

  it("defines Contract 1 entry points beyond ordinary pass-through (AC4.3)", () => {
    const names = ENTRY_POINTS.map((e) => e.name).sort();
    expect(names).toEqual(["doctor", "migrate", "setup", "uninstall"]);
    for (const ep of ENTRY_POINTS) {
      expect(ep.argv[0]).toBe(ep.name);
    }
  });

  it("documents setup argv shape: --operation install|repair|upgrade --from --root", () => {
    expect(SETUP_OPERATIONS).toEqual(["install", "repair", "upgrade"]);
    expect(SETUP_FROM_VALUES).toContain("none");
    expect(SETUP_FROM_VALUES).toContain("old-style");
    const setup: SetupArgv = {
      entry: "setup",
      operation: "install",
      from: "none",
      root: "/tmp/project",
    };
    expect(setup.entry).toBe("setup");
  });

  it("documents migrate / uninstall / doctor argv shapes", () => {
    const migrate: MigrateArgv = { entry: "migrate", from: "1.2.3", root: "/tmp/p" };
    const uninstall: UninstallArgv = { entry: "uninstall", root: "/tmp/p" };
    const doctor: DoctorArgv = { entry: "doctor", root: "/tmp/p" };
    expect(migrate.entry).toBe("migrate");
    expect(uninstall.entry).toBe("uninstall");
    expect(doctor.entry).toBe("doctor");
  });

  it("defines exit codes 0 / 1 / 2 / 130 (AC4.5)", () => {
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(EXIT_CODES.FAILURE).toBe(1);
    expect(EXIT_CODES.USAGE).toBe(2);
    expect(EXIT_CODES.INTERRUPTED).toBe(130);
  });

  it("defines DataStatus discriminants for equal-version diagnostic (AC4.10)", () => {
    expect(DataStatus.Current).toBe("current");
    expect(DataStatus.MigrationNeeded).toBe("migration_needed");
    expect(DataStatus.DiagnosisFailed).toBe("diagnosis_failed");
    expect([...DATA_STATUS_VALUES].sort()).toEqual([
      "current",
      "diagnosis_failed",
      "migration_needed",
    ]);
  });

  it("serializes and parses data-status as JSON over stdout (AC4.10 choice)", () => {
    for (const status of DATA_STATUS_VALUES) {
      const payload: DataStatusJson = { contract: CONTRACT_NUMBER, dataStatus: status };
      const line = serializeDataStatusJson(payload);
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = parseDataStatusJson(line);
      expect(parsed).toEqual(payload);
    }
  });

  it("rejects malformed data-status JSON as diagnosis_failed discriminant path", () => {
    expect(() => parseDataStatusJson("not-json")).toThrow();
    expect(() => parseDataStatusJson(JSON.stringify({ contract: 1 }))).toThrow();
    expect(() =>
      parseDataStatusJson(JSON.stringify({ contract: 1, dataStatus: "nope" })),
    ).toThrow();
  });

  it("launcher supports contracts 1..max; too-new is unsupported (AC4.6 / AC4.7)", () => {
    expect(LAUNCHER_MAX_SUPPORTED_CONTRACT).toBe(CONTRACT_NUMBER);
    expect(isContractSupportedByLauncher(1, LAUNCHER_MAX_SUPPORTED_CONTRACT)).toBe(true);
    expect(isContractSupportedByLauncher(0, LAUNCHER_MAX_SUPPORTED_CONTRACT)).toBe(false);
    expect(
      isContractSupportedByLauncher(
        LAUNCHER_MAX_SUPPORTED_CONTRACT + 1,
        LAUNCHER_MAX_SUPPORTED_CONTRACT,
      ),
    ).toBe(false);
  });

  it("reads version+contract from package.json only — no runtime code load (A5.5 / AC3.9)", () => {
    const pkg = {
      name: "@deftai/directive-runtime",
      version: "9.9.9",
      directive: { contract: 1 },
    };
    const meta = readRuntimeContractFromPackageJson(pkg);
    expect(meta).toEqual({ version: "9.9.9", contract: 1 });
    expect(() => readRuntimeContractFromPackageJson({ version: "1.0.0" })).toThrow();
    expect(() =>
      readRuntimeContractFromPackageJson({ version: "1.0.0", directive: { contract: "x" } }),
    ).toThrow();
  });

  it("EntryPointName union matches the documented table", () => {
    const all: EntryPointName[] = ["setup", "migrate", "uninstall", "doctor"];
    expect(all).toHaveLength(4);
  });
});
