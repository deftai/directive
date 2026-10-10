import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isDirectEntrypoint } from "./entrypoint.js";

const itSymlink = it.skipIf(process.platform === "win32");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isDirectEntrypoint", () => {
  it("returns false when process.argv[1] is undefined", () => {
    const original = process.argv[1];
    delete (process.argv as string[])[1];
    try {
      expect(isDirectEntrypoint(import.meta.url)).toBe(false);
    } finally {
      process.argv[1] = original;
    }
  });

  it("returns false when realpath comparison throws", () => {
    expect(isDirectEntrypoint("file:///definitely/not/a/real/path-xyz")).toBe(false);
  });

  it("matches the module path directly", () => {
    const modulePath = fileURLToPath(import.meta.url);
    const originalArgv1 = process.argv[1];
    process.argv[1] = modulePath;
    try {
      expect(isDirectEntrypoint(import.meta.url)).toBe(true);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  itSymlink("matches when argv[1] is a symlink to the module", () => {
    const modulePath = fileURLToPath(import.meta.url);
    const dir = mkdtempSync(join(tmpdir(), "deft-entrypoint-"));
    temps.push(dir);
    const linkPath = join(dir, "entrypoint-link.js");
    symlinkSync(modulePath, linkPath);

    const originalArgv1 = process.argv[1];
    process.argv[1] = linkPath;
    try {
      expect(isDirectEntrypoint(import.meta.url)).toBe(true);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it("returns false when argv[1] points elsewhere", () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = fileURLToPath(new URL("./hook-bin.ts", import.meta.url));
    try {
      expect(isDirectEntrypoint(import.meta.url)).toBe(false);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});
