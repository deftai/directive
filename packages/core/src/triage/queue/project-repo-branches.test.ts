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

    const path = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    writeFileSync(path, "not-json", "utf8");
    expect(loadProjectDefinition(root)).toBeNull();

    writeFileSync(path, `"string"`, "utf8");
    expect(loadProjectDefinition(root)).toBeNull();
  });

  it("returns parsed object for valid project definition", () => {
    const root = mkdtempSync(join(tmpdir(), "queue-project-ok-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: {} } }),
      "utf8",
    );
    expect(loadProjectDefinition(root)?.plan).toEqual({ policy: {} });
  });

  // #2207: after the vbrief->xbrief migration the loader MUST resolve the
  // xbrief/ PROJECT-DEFINITION so ranking labels don't silently fall back to
  // the framework default.
  it("resolves PROJECT-DEFINITION from a migrated xbrief tree", () => {
    const root = mkdtempSync(join(tmpdir(), "queue-project-xbrief-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "seed.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "s", status: "running" } }),
      "utf8",
    );
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { triageRankingLabels: ["urgent"] } } }),
      "utf8",
    );
    expect(loadProjectDefinition(root)?.plan).toEqual({
      policy: { triageRankingLabels: ["urgent"] },
    });
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
