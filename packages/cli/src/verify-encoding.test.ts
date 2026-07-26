import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-encoding.js";

const itSymlink = it.skipIf(process.platform === "win32");

function ensureCliDistBuilt(): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const tscBin = join(repoRoot, "node_modules/typescript/bin/tsc");
  execFileSync(process.execPath, [tscBin, "-b", "packages/cli"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
}

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function repo(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-test-"));
  temps.push(root);
  writeFileSync(join(root, "f.txt"), content);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("parseArgs", () => {
  it("defaults to mode=all, root='.', no allow-list", () => {
    expect(parseArgs([])).toMatchObject({
      mode: "all",
      projectRoot: ".",
      allowList: null,
      quiet: false,
    });
  });
  it("parses --staged and --quiet", () => {
    expect(parseArgs(["--staged", "--quiet"])).toMatchObject({ mode: "staged", quiet: true });
  });
  it("rejects --all with --staged", () => {
    expect(parseArgs(["--all", "--staged"]).error).toBeDefined();
  });
  it("parses --project-root and --allow-list in space and = forms", () => {
    expect(parseArgs(["--project-root", "/x"]).projectRoot).toBe("/x");
    expect(parseArgs(["--project-root=/y"]).projectRoot).toBe("/y");
    expect(parseArgs(["--allow-list", "/a"]).allowList).toBe("/a");
    expect(parseArgs(["--allow-list=/b"]).allowList).toBe("/b");
  });
  it("errors on missing values and unknown flags", () => {
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--allow-list"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns 0 for a clean repo", () => {
    expect(silentRun(["--all", "--project-root", repo("clean ascii\n")])).toBe(0);
  });
  it("returns 0 with --quiet for a clean repo", () => {
    expect(silentRun(["--quiet", "--project-root", repo("clean ascii\n")])).toBe(0);
  });
  it("returns 1 for corruption", () => {
    expect(silentRun(["--all", "--project-root", repo("broken \ufffd\n")])).toBe(1);
  });
  it("returns 2 for a bad argument", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });
});

describe("verify-encoding bin symlink entrypoint (#2846)", () => {
  const verifyEncodingPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../dist/verify-encoding.js",
  );
  const linkTemps: string[] = [];
  beforeAll(() => {
    ensureCliDistBuilt();
  });
  afterEach(() => {
    for (const dir of linkTemps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  itSymlink("runs main through an npm-style bin symlink", () => {
    const root = repo("clean ascii\n");
    const dir = mkdtempSync(join(tmpdir(), "deft-verify-encoding-link-"));
    linkTemps.push(dir);
    const linkPath = join(dir, "deft-verify-encoding");
    symlinkSync(verifyEncodingPath, linkPath);

    const result = spawnSync(process.execPath, [linkPath, "--all", "--project-root", root], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no mojibake");
  });
});
