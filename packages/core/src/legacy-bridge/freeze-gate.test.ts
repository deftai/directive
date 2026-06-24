import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  compareInstallerVersions,
  evaluateGoFreeze,
  parseInstallerVersion,
  readInstallerVersion,
} from "./freeze-gate.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

/** Build a tmp repo with a cmd/deft-install/main.go carrying `var version`. */
function repoWithInstaller(version: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "deft-freeze-"));
  temps.push(root);
  mkdirSync(join(root, "cmd", "deft-install"), { recursive: true });
  const body =
    version === null
      ? "package main\n\nfunc main() {}\n"
      : `package main\n\nvar version = "${version}"\n\nfunc main() {}\n`;
  writeFileSync(join(root, "cmd", "deft-install", "main.go"), body);
  return root;
}

describe("parseInstallerVersion", () => {
  it("extracts the version literal", () => {
    expect(parseInstallerVersion('var version = "1.2.3"')).toBe("1.2.3");
    expect(parseInstallerVersion('  var   version  =  "v0.32.5"  ')).toBe("v0.32.5");
  });
  it("returns null when absent", () => {
    expect(parseInstallerVersion("package main")).toBeNull();
  });
});

describe("compareInstallerVersions", () => {
  it("orders by numeric major.minor.patch core", () => {
    expect(compareInstallerVersions("0.32.5", "0.32.5")).toBe(0);
    expect(compareInstallerVersions("v0.32.6", "v0.32.5")).toBe(1);
    expect(compareInstallerVersions("0.32.4", "0.32.5")).toBe(-1);
    expect(compareInstallerVersions("1.0.0", "0.99.99")).toBe(1);
  });
  it("ignores pre-release / build suffixes for the core comparison", () => {
    expect(compareInstallerVersions("0.32.5-rc1", "0.32.5")).toBe(0);
    expect(compareInstallerVersions("0.32.6-rc1", "0.32.5")).toBe(1);
  });
  it("throws on an unparseable input", () => {
    expect(() => compareInstallerVersions("not-a-version", "0.1.0")).toThrow();
  });
});

describe("readInstallerVersion", () => {
  it("reads the version from cmd/deft-install/main.go", () => {
    const root = repoWithInstaller("0.32.5");
    expect(readInstallerVersion(root)).toBe("0.32.5");
  });
  it("throws when the source is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-freeze-empty-"));
    temps.push(root);
    expect(() => readInstallerVersion(root)).toThrow();
  });
  it("throws when the version constant is unparseable", () => {
    const root = repoWithInstaller(null);
    expect(() => readInstallerVersion(root)).toThrow();
  });
});

describe("evaluateGoFreeze (three-state)", () => {
  it("passes advisory when the SoT is null (unfrozen) and never reads the installer", () => {
    // No installer source at all -- proves the null path short-circuits.
    const root = mkdtempSync(join(tmpdir(), "deft-freeze-null-"));
    temps.push(root);
    const res = evaluateGoFreeze(root, { pinned: null });
    expect(res.code).toBe(0);
    expect(res.stream).toBe("stdout");
    expect(res.message).toMatch(/advisory/i);
  });

  it("passes when frozen and the installer is at or below the pinned tag", () => {
    const root = repoWithInstaller("0.32.5");
    expect(evaluateGoFreeze(root, { pinned: "0.32.5" }).code).toBe(0);
    expect(evaluateGoFreeze(root, { pinned: "0.40.0" }).code).toBe(0);
  });

  it("fails (exit 1) when frozen and the installer is bumped above the pinned tag", () => {
    const root = repoWithInstaller("0.32.6");
    const res = evaluateGoFreeze(root, { pinned: "0.32.5" });
    expect(res.code).toBe(1);
    expect(res.stream).toBe("stderr");
    expect(res.message).toMatch(/ABOVE the frozen/i);
  });

  it("honors the bypass to downgrade a violation to advisory", () => {
    const res = evaluateGoFreeze(".", {
      pinned: "0.32.5",
      installerVersion: "0.40.0",
      allowBump: true,
    });
    expect(res.code).toBe(0);
    expect(res.message).toMatch(/bypass/i);
  });

  it("returns config error (exit 2) when frozen but the installer source is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-freeze-noinstaller-"));
    temps.push(root);
    expect(evaluateGoFreeze(root, { pinned: "0.32.5" }).code).toBe(2);
  });

  it("returns config error (exit 2) when the SoT value is unparseable", () => {
    const res = evaluateGoFreeze(".", { pinned: "garbage", installerVersion: "0.1.0" });
    expect(res.code).toBe(2);
    expect(res.stream).toBe("stderr");
  });
});
