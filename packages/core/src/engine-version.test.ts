import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

describe("readCorePackageVersion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns the version from the adjacent package.json", async () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    const { readCorePackageVersion } = await import("./engine-version.js");
    expect(readCorePackageVersion()).toBe(pkg.version);
  });

  it("falls back when package.json cannot be read", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync: () => {
          throw new Error("ENOENT");
        },
      };
    });
    const { readCorePackageVersion } = await import("./engine-version.js");
    expect(readCorePackageVersion()).toBe("0.0.0");
  });

  it("falls back when version field is missing or empty", async () => {
    const original = readFileSync(pkgPath, "utf8");
    try {
      writeFileSync(pkgPath, JSON.stringify({ name: "@deftai/directive-core" }));
      vi.resetModules();
      const { readCorePackageVersion } = await import("./engine-version.js");
      expect(readCorePackageVersion()).toBe("0.0.0");
    } finally {
      writeFileSync(pkgPath, original);
    }
  });
});
