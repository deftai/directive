import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../content-contracts/standards/_helpers.js";

const helper = join(repoRoot(), "tasks", "ts-build-fresh.cjs");

function runFresh(
  root: string,
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [helper, root], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  return {
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

describe("ts-build-fresh.cjs (#2563)", () => {
  it("exits 1 when dist/bin.js is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-build-fresh-"));
    try {
      mkdirSync(join(root, "packages", "cli", "src"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}");
      expect(runFresh(root).status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 0 when the post-build stamp is newer than sources", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-build-fresh-"));
    try {
      const src = join(root, "packages", "cli", "src");
      const dist = join(root, "packages", "cli", "dist");
      const pkgJson = join(root, "package.json");
      mkdirSync(src, { recursive: true });
      mkdirSync(dist, { recursive: true });
      writeFileSync(pkgJson, "{}");
      writeFileSync(join(src, "index.ts"), "export {};\n");
      writeFileSync(join(dist, "bin.js"), "console.log(1);\n");
      writeFileSync(join(dist, ".deft-ts-build-stamp"), "2026-01-01T00:00:00.000Z\n");
      const old = new Date("2020-01-01T00:00:00Z");
      const neu = new Date("2026-01-01T00:00:00Z");
      utimesSync(pkgJson, old, old);
      utimesSync(join(src, "index.ts"), old, old);
      // Stale bin mtime must not force rebuild when stamp is warm.
      utimesSync(join(dist, "bin.js"), old, old);
      utimesSync(join(dist, ".deft-ts-build-stamp"), neu, neu);
      expect(runFresh(root).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 1 when a source file is newer than dist", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-build-fresh-"));
    try {
      const src = join(root, "packages", "cli", "src");
      const dist = join(root, "packages", "cli", "dist");
      mkdirSync(src, { recursive: true });
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(src, "index.ts"), "export {};\n");
      writeFileSync(join(dist, "bin.js"), "console.log(1);\n");
      const old = new Date("2020-01-01T00:00:00Z");
      const neu = new Date("2026-01-01T00:00:00Z");
      utimesSync(join(dist, "bin.js"), old, old);
      utimesSync(join(src, "index.ts"), neu, neu);
      expect(runFresh(root).status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors DEFT_SKIP_TS_BUILD and DEFT_FORCE_TS_BUILD", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-build-fresh-"));
    try {
      expect(runFresh(root, { DEFT_SKIP_TS_BUILD: "1" }).status).toBe(0);
      expect(runFresh(root, { DEFT_FORCE_TS_BUILD: "1" }).status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
