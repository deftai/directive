import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { loadProjectDefinition } from "./project.js";
import { inferRepoFromGit, resolveRepo } from "./repo.js";

const roots: string[] = [];
afterEach(() => {
  execFileSyncMock.mockReset();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("loadProjectDefinition branches", () => {
  it("returns null for missing, invalid, and non-object files", () => {
    const root = mkdtempSync(join(tmpdir(), "queue-project-"));
    roots.push(root);
    expect(loadProjectDefinition(root)).toBeNull();

    const path = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(path, "not-json", "utf8");
    expect(loadProjectDefinition(root)).toBeNull();

    writeFileSync(path, `"string"`, "utf8");
    expect(loadProjectDefinition(root)).toBeNull();
  });

  it("returns parsed object for valid project definition", () => {
    const root = mkdtempSync(join(tmpdir(), "queue-project-ok-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: {} } }),
      "utf8",
    );
    expect(loadProjectDefinition(root)?.plan).toEqual({ policy: {} });
  });
});

describe("inferRepoFromGit branches", () => {
  it("parses https and ssh github remotes", () => {
    execFileSyncMock.mockReturnValueOnce("https://github.com/deftai/directive.git\n");
    expect(inferRepoFromGit("/tmp")).toBe("deftai/directive");

    execFileSyncMock.mockReturnValueOnce("git@github.com:deftai/statusreport.git\n");
    expect(inferRepoFromGit("/tmp")).toBe("deftai/statusreport");
  });

  it("returns null for empty, non-github, and malformed remotes", () => {
    execFileSyncMock.mockReturnValueOnce("\n");
    expect(inferRepoFromGit("/tmp")).toBeNull();

    execFileSyncMock.mockReturnValueOnce("git@gitlab.com:org/repo.git\n");
    expect(inferRepoFromGit("/tmp")).toBeNull();

    execFileSyncMock.mockReturnValueOnce("https://github.com/only-owner\n");
    expect(inferRepoFromGit("/tmp")).toBeNull();

    execFileSyncMock.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(inferRepoFromGit("/tmp")).toBeNull();
    expect(inferRepoFromGit(null)).toBeNull();
  });
});

describe("resolveRepo branches", () => {
  it("ignores blank explicit repo values", () => {
    const prev = process.env.DEFT_TRIAGE_REPO;
    process.env.DEFT_TRIAGE_REPO = "env/repo";
    execFileSyncMock.mockReturnValue("https://github.com/git/repo.git\n");
    expect(resolveRepo("   ", "/tmp")).toBe("env/repo");
    process.env.DEFT_TRIAGE_REPO = prev;
  });
});
