import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

function loadVersionReader() {
  return import("./engine-version.js");
}

describe("readCorePackageVersion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock("node:fs");
    vi.resetModules();
  });

  it("returns the version from the adjacent package.json", async () => {
    const raw = readFileSync(pkgPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    const version = (parsed as { version: string }).version;
    const { readCorePackageVersion } = await loadVersionReader();
    expect(readCorePackageVersion()).toBe(version);
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
    const { readCorePackageVersion } = await loadVersionReader();
    expect(readCorePackageVersion()).toBe("0.0.0");
  });

  it("falls back when version field is missing or empty", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync: () => JSON.stringify({ name: "@deftai/directive-core" }),
      };
    });
    const { readCorePackageVersion } = await loadVersionReader();
    expect(readCorePackageVersion()).toBe("0.0.0");
  });

  it("falls back when package.json parses to null", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync: () => "null",
      };
    });
    const { readCorePackageVersion } = await loadVersionReader();
    expect(readCorePackageVersion()).toBe("0.0.0");
  });
});
