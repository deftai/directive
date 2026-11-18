/**
 * The runtime's own pin check for ordinary commands (AC2.6, #6620), run
 * through the built entry `dist/bin.js` the way git hooks and the Taskfile
 * start it (`node node_modules/@deftai/directive-runtime/dist/bin.js …`).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isIdentityExempt,
  runtimeCommandProjectRoot,
  runtimeIdentityRefusal,
} from "@deftai/directive-core/dist/install-health/cheap.js";
import { afterEach, describe, expect, it } from "vitest";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(pin: string, installed: string | null, lockfile?: string): string {
  const root = mkdtempSync(join(tmpdir(), "runtime-identity-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { "@deftai/directive-runtime": pin } }),
  );
  if (installed !== null) {
    const dir = join(root, "node_modules", "@deftai", "directive-runtime");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@deftai/directive-runtime", version: installed }),
    );
  }
  if (lockfile !== undefined) writeFileSync(join(root, lockfile), "");
  return root;
}

function runBin(root: string, args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DIRECTIVE_PROJECT_ROOT: root, DEFT_DOCTOR_HOOK_DIAGNOSTIC: "1" },
    timeout: 60_000,
  });
}

const MISMATCH =
  "Directive can't run: the installed @deftai/directive-runtime 1.2.3 is not the pinned 1.2.4. Run `pnpm install --frozen-lockfile` in a terminal in this project.";

describe("runtime pin check (AC2.6)", () => {
  it("installed ≠ pin: an ordinary command exits 1 with the pin-mismatch row", () => {
    const root = project("1.2.4", "1.2.3", "pnpm-lock.yaml");
    const result = runBin(root, ["verify:encoding", "--project-root", root]);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(MISMATCH);
  });

  it("names `npm install` with an npm lockfile", () => {
    const root = project("1.2.4", "1.2.3", "package-lock.json");
    expect(runtimeIdentityRefusal(root, ["verify:branch"])).toContain(
      "Run `npm install` in a terminal in this project.",
    );
  });

  it.each([
    ["--version"],
    ["--help"],
    ["verify:encoding", "--help"],
  ])("%j still runs on a mismatch", (...args) => {
    const root = project("1.2.4", "1.2.3", "pnpm-lock.yaml");
    expect(runBin(root, args).stderr).not.toContain(MISMATCH);
  });

  it("equal versions: no refusal", () => {
    const root = project("1.2.3", "1.2.3");
    expect(runtimeIdentityRefusal(root, ["verify:branch"])).toBeNull();
  });

  it("runtime not installed or no exact pin: no refusal here (other guards own those)", () => {
    expect(runtimeIdentityRefusal(project("1.2.4", null), ["verify:branch"])).toBeNull();
    expect(runtimeIdentityRefusal(project("^1.2.4", "1.2.3"), ["verify:branch"])).toBeNull();
  });

  it("exempts doctor, hook:dispatch, help and version, not ordinary verbs", () => {
    expect(isIdentityExempt(["doctor"])).toBe(true);
    expect(isIdentityExempt(["doctor", "--json"])).toBe(true);
    expect(isIdentityExempt(["hook:dispatch", "--host", "claude"])).toBe(true);
    expect(isIdentityExempt(["--version"])).toBe(true);
    expect(isIdentityExempt(["-h"])).toBe(true);
    expect(isIdentityExempt([])).toBe(true);
    expect(isIdentityExempt(["verify:encoding", "--staged"])).toBe(false);
    expect(isIdentityExempt(["pre-pr:run", "--push-admit"])).toBe(false);
    // A flag value elsewhere never exempts (only the first token, as the router).
    expect(isIdentityExempt(["policy:allow-direct-commits", "--note", "--version"])).toBe(false);
    expect(isIdentityExempt(["policy:allow-direct-commits", "--note", "--help"])).toBe(false);
    // A help flag of its own still exempts, also after an option and its value.
    expect(isIdentityExempt(["verify:story-ready", "--project-root", "/repo", "--help"])).toBe(
      true,
    );
    expect(isIdentityExempt(["verify:story-ready", "--project-root=/repo", "-h"])).toBe(true);
  });

  it("uses the last --project-root, as the command handlers do", () => {
    expect(
      runtimeCommandProjectRoot(
        ["verify:wip-cap", "--project-root", "/a", "--project-root", "/b"],
        "/x",
        "/",
      ),
    ).toBe("/b");
  });

  it("checks the project named by --project-root, not the working directory", () => {
    const root = project("1.2.4", "1.2.3", "pnpm-lock.yaml");
    const sub = join(root, "src");
    mkdirSync(sub);
    const result = spawnSync(process.execPath, [BIN, "verify:encoding", "--project-root", root], {
      cwd: sub,
      encoding: "utf8",
      env: { ...process.env, DIRECTIVE_PROJECT_ROOT: "", DEFT_DOCTOR_HOOK_DIAGNOSTIC: "1" },
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(MISMATCH);
    expect(runtimeCommandProjectRoot([`--project-root=${root}`], sub, sub)).toBe(root);
    expect(runtimeCommandProjectRoot(["verify:branch"], sub, sub)).toBe(sub);
  });

  it("doctor still runs on a mismatch (AC5)", () => {
    const root = project("1.2.4", "1.2.3", "pnpm-lock.yaml");
    expect(runtimeIdentityRefusal(root, ["doctor"])).toBeNull();
  });
});
