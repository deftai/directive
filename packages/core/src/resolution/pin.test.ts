import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareSemver,
  isExactPin,
  PIN_DEPENDENCY_NAME,
  parseSemver,
  readPin,
  reconcileVersions,
  semverGte,
} from "./pin.js";

function seams(files: Record<string, string>) {
  return {
    isFile: (p: string) => p in files,
    readText: (p: string) => (p in files ? (files[p] ?? null) : null),
  };
}

describe("resolution/pin semver helpers", () => {
  it("parses exact semver and rejects ranges", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("v0.65.0")).toEqual([0, 65, 0]);
    expect(parseSemver("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseSemver("^1.2.3")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
  });

  it("identifies exact pins vs ranges", () => {
    expect(isExactPin("0.65.0")).toBe(true);
    expect(isExactPin("v0.65.0")).toBe(true);
    expect(isExactPin("^0.65.0")).toBe(false);
    expect(isExactPin("~0.65.0")).toBe(false);
    expect(isExactPin("*")).toBe(false);
    expect(isExactPin(null)).toBe(false);
  });

  it("compares versions across all orderings", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.1.0", "1.0.9")).toBe(1);
    expect(compareSemver("0.64.0", "0.65.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
    expect(compareSemver("bad", "1.0.0")).toBeNull();
  });

  it("semverGte handles equal, greater, lesser, and unparseable", () => {
    expect(semverGte("1.0.0", "1.0.0")).toBe(true);
    expect(semverGte("1.0.1", "1.0.0")).toBe(true);
    expect(semverGte("0.9.0", "1.0.0")).toBe(false);
    expect(semverGte("bad", "1.0.0")).toBe(false);
  });
});

describe("resolution/pin readPin", () => {
  it("reads an exact devDependency pin and private flag", () => {
    const files = {
      "/proj/package.json": JSON.stringify({
        private: true,
        devDependencies: { [PIN_DEPENDENCY_NAME]: "0.65.0" },
      }),
    };
    const result = readPin("/proj", seams(files));
    expect(result.pinVersion).toBe("0.65.0");
    expect(result.isPrivate).toBe(true);
    expect(result.nonExact).toBe(false);
    expect(result.rawSpec).toBe("0.65.0");
  });

  it("falls back to dependencies block", () => {
    const files = {
      "/proj/package.json": JSON.stringify({
        dependencies: { [PIN_DEPENDENCY_NAME]: "v1.2.3" },
      }),
    };
    const result = readPin("/proj", seams(files));
    expect(result.pinVersion).toBe("1.2.3");
    expect(result.isPrivate).toBe(false);
  });

  it("reports a non-exact range spec without a pinVersion", () => {
    const files = {
      "/proj/package.json": JSON.stringify({
        devDependencies: { [PIN_DEPENDENCY_NAME]: "^0.65.0" },
      }),
    };
    const result = readPin("/proj", seams(files));
    expect(result.pinVersion).toBeNull();
    expect(result.nonExact).toBe(true);
    expect(result.rawSpec).toBe("^0.65.0");
  });

  it("returns absent when package.json is missing", () => {
    const result = readPin("/proj", seams({}));
    expect(result).toEqual({ pinVersion: null, rawSpec: null, isPrivate: false, nonExact: false });
  });

  it("returns absent when the dependency is not present", () => {
    const files = { "/proj/package.json": JSON.stringify({ private: true, dependencies: {} }) };
    const result = readPin("/proj", seams(files));
    expect(result.pinVersion).toBeNull();
    expect(result.isPrivate).toBe(true);
  });

  it("returns absent on malformed / non-object package.json", () => {
    expect(readPin("/proj", seams({ "/proj/package.json": "not json" })).pinVersion).toBeNull();
    expect(readPin("/proj", seams({ "/proj/package.json": "[1,2]" })).pinVersion).toBeNull();
  });

  it("returns absent when readText yields null despite isFile true", () => {
    const result = readPin("/proj", {
      isFile: () => true,
      readText: () => null,
    });
    expect(result.pinVersion).toBeNull();
  });

  describe("default (real filesystem) seams", () => {
    const created: string[] = [];
    afterEach(() => {
      for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("reads a real committed package.json with no injected seams", () => {
      const root = mkdtempSync(join(tmpdir(), "pin-real-"));
      created.push(root);
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ private: true, devDependencies: { [PIN_DEPENDENCY_NAME]: "0.65.0" } }),
        "utf8",
      );
      const result = readPin(root);
      expect(result.pinVersion).toBe("0.65.0");
      expect(result.isPrivate).toBe(true);
    });

    it("returns absent for a real directory with no package.json", () => {
      const root = mkdtempSync(join(tmpdir(), "pin-empty-"));
      created.push(root);
      expect(readPin(root).pinVersion).toBeNull();
    });
  });
});

describe("resolution/pin reconcileVersions", () => {
  it("is consistent when everything matches", () => {
    const r = reconcileVersions({
      pinVersion: "0.65.0",
      engineVersion: "0.65.0",
      contentVersion: "0.65.0",
      managedSectionSha: "abc",
      expectedManagedSectionSha: "abc",
    });
    expect(r.consistent).toBe(true);
    expect(r.mismatches).toHaveLength(0);
    expect(r.contentBehindPin).toBe(false);
  });

  it("flags content behind the pin", () => {
    const r = reconcileVersions({
      pinVersion: "0.65.0",
      engineVersion: "0.65.0",
      contentVersion: "0.63.0",
      managedSectionSha: null,
    });
    expect(r.contentBehindPin).toBe(true);
    expect(r.consistent).toBe(false);
    expect(r.mismatches.join(" ")).toContain("behind the package.json pin");
  });

  it("flags content ahead of the pin", () => {
    const r = reconcileVersions({
      pinVersion: "0.65.0",
      engineVersion: null,
      contentVersion: "0.66.0",
      managedSectionSha: null,
    });
    expect(r.contentBehindPin).toBe(false);
    expect(r.mismatches.join(" ")).toContain("ahead of the package.json pin");
  });

  it("flags engine behind the pin", () => {
    const r = reconcileVersions({
      pinVersion: "0.65.0",
      engineVersion: "0.64.0",
      contentVersion: "0.65.0",
      managedSectionSha: null,
    });
    expect(r.mismatches.join(" ")).toContain("engine (0.64.0) is behind");
  });

  it("flags a managed-section sha mismatch and absence", () => {
    const mismatch = reconcileVersions({
      pinVersion: "0.65.0",
      engineVersion: "0.65.0",
      contentVersion: "0.65.0",
      managedSectionSha: "old",
      expectedManagedSectionSha: "new",
    });
    expect(mismatch.managedShaMismatch).toBe(true);
    expect(mismatch.mismatches.join(" ")).toContain("does not match expected");

    const absent = reconcileVersions({
      pinVersion: "0.65.0",
      engineVersion: "0.65.0",
      contentVersion: "0.65.0",
      managedSectionSha: null,
      expectedManagedSectionSha: "new",
    });
    expect(absent.managedShaMismatch).toBe(true);
    expect(absent.mismatches.join(" ")).toContain("sha is absent");
  });
});
