/**
 * #5603: the npm-publish post-publish job runs only the runner artifact (no checkout, no
 * install). The bundled runner must load in a folder with no node_modules.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODULE_NOT_FOUND_MARKERS } from "./constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, "..", "..");
const BUNDLE_SCRIPT = join(CORE_ROOT, "scripts", "bundle-post-publish-runner.mjs");

const temps: string[] = [];
let bundled = "";

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function hasModuleNotFound(text: string): boolean {
  return MODULE_NOT_FOUND_MARKERS.some((m) => text.includes(m));
}

beforeAll(() => {
  // Vitest runs without a prior build; the bundle entry is the built dist file.
  const tsc = spawnSync("pnpm", ["exec", "tsc", "-b"], {
    cwd: CORE_ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  bundled = join(temp("ppr-out-"), "npm-ops.mjs");
  const r = spawnSync(process.execPath, [BUNDLE_SCRIPT, "--out", bundled], {
    cwd: CORE_ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`runner bundle failed (tsc=${tsc.status}): ${r.stderr || r.stdout}`);
  }
}, 600_000);

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("post-publish runner bundle (#5603)", () => {
  it("loads from a folder with no node_modules (no module-not-found)", () => {
    const empty = temp("ppr-run-");
    const runner = join(empty, "npm-ops.mjs");
    copyFileSync(bundled, runner);
    // Without the flag the runner only loads its modules and exits 0.
    const r = spawnSync(process.execPath, [runner], { cwd: empty, encoding: "utf8" });
    const output = `${r.stdout}\n${r.stderr}`;
    expect(hasModuleNotFound(output), output).toBe(false);
    expect(r.status, output).toBe(0);
  });

  it("the runner exports the two-pass entry point after bundling", () => {
    const empty = temp("ppr-import-");
    const runner = join(empty, "npm-ops.mjs");
    copyFileSync(bundled, runner);
    const probe = `import(${JSON.stringify(pathToFileURL(runner).href)}).then((m) => { process.stdout.write(typeof m.invokePostPublishTwoPassFromReleaseWorkflow); }, (e) => { process.stderr.write(String(e && e.stack)); process.exit(3); });`;
    const r = spawnSync(process.execPath, ["-e", probe], { cwd: empty, encoding: "utf8" });
    expect(hasModuleNotFound(`${r.stdout}\n${r.stderr}`), r.stderr).toBe(false);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("function");
  });
});
