import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-content-manifest.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function manifestJson(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    version: 2,
    buckets: [
      { id: "content", label: "Content", description: "ships" },
      { id: "engine", label: "Engine", description: "runtime" },
    ],
    entries,
  });
}

/**
 * Build a tmp git repo with a content/ tree (skills + conventions) and a root
 * engine dir, with the manifest at the post-#1875 default location
 * content/conventions/content-manifest.json.
 */
function repo(entries: Array<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cm-cli-"));
  temps.push(root);
  mkdirSync(join(root, "content", "skills"), { recursive: true });
  writeFileSync(join(root, "content", "skills", "a.md"), "skill\n");
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "packages", "b.ts"), "export {};\n");
  mkdirSync(join(root, "content", "conventions"), { recursive: true });
  writeFileSync(
    join(root, "content", "conventions", "content-manifest.json"),
    manifestJson(entries),
  );
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
  it("defaults to null manifest + project root", () => {
    expect(parseArgs([])).toMatchObject({ manifestPath: null, projectRoot: null });
  });
  it("parses --manifest and --project-root in space and = forms", () => {
    expect(parseArgs(["--manifest", "/m"]).manifestPath).toBe("/m");
    expect(parseArgs(["--manifest=/m2"]).manifestPath).toBe("/m2");
    expect(parseArgs(["--project-root", "/r"]).projectRoot).toBe("/r");
    expect(parseArgs(["--project-root=/r2"]).projectRoot).toBe("/r2");
  });
  it("errors on missing values and unknown flags", () => {
    expect(parseArgs(["--manifest"]).error).toBeDefined();
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns 0 when the location invariant holds (every content/ child classified)", () => {
    const root = repo([
      { path: "content/skills", bucket: "content", note: "skills" },
      { path: "content/conventions", bucket: "content", note: "conventions" },
      { path: "packages", bucket: "engine", note: "engine" },
    ]);
    expect(silentRun(["--project-root", root])).toBe(0);
  });
  it("returns 1 when a content/ child is unclassified", () => {
    const root = repo([{ path: "content/skills", bucket: "content", note: "skills" }]);
    expect(silentRun(["--project-root", root])).toBe(1);
  });
  it("returns 2 when the manifest is missing", () => {
    const root = repo([{ path: "content/skills", bucket: "content", note: "skills" }]);
    expect(silentRun(["--project-root", root, "--manifest", join(root, "nope.json")])).toBe(2);
  });
  it("returns 2 for a bad argument", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });
  it("writes the clean message to stdout and drift to stderr", () => {
    const cleanRoot = repo([
      { path: "content/skills", bucket: "content", note: "skills" },
      { path: "content/conventions", bucket: "content", note: "conventions" },
      { path: "packages", bucket: "engine", note: "engine" },
    ]);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", cleanRoot])).toBe(0);
      expect(out).toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }

    const driftRoot = repo([{ path: "content/skills", bucket: "content", note: "skills" }]);
    const out2 = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err2 = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", driftRoot])).toBe(1);
      expect(err2).toHaveBeenCalled();
      expect(out2).not.toHaveBeenCalled();
    } finally {
      out2.mockRestore();
      err2.mockRestore();
    }
  });
});
