import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  formatMissingRepoError,
  formatMissingRootError,
  normaliseRepoSlug,
  resolveProjectRepo,
  resolveProjectRoot,
  resolveRootAndRepo,
} from "./project-context.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-slice-ctx-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"));
  return root;
}

describe("project-context", () => {
  it("resolveProjectRoot prefers explicit and env values", () => {
    const root = makeRoot();
    expect(resolveProjectRoot(root)).toBe(root);
    const prev = process.env.DEFT_PROJECT_ROOT;
    process.env.DEFT_PROJECT_ROOT = root;
    expect(resolveProjectRoot(undefined)).toBe(root);
    process.env.DEFT_PROJECT_ROOT = prev;
    expect(resolveProjectRoot("/missing/path/xyz")).toBeNull();
  });

  it("normaliseRepoSlug accepts slug and github URLs", () => {
    expect(normaliseRepoSlug("owner/repo")).toBe("owner/repo");
    expect(normaliseRepoSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(normaliseRepoSlug("bad")).toBeNull();
  });

  it("resolveProjectRepo honours explicit repo and env", () => {
    const root = makeRoot();
    expect(resolveProjectRepo("owner/repo", root)).toBe("owner/repo");
    const prev = process.env.DEFT_PROJECT_REPO;
    process.env.DEFT_PROJECT_REPO = "env/o";
    expect(resolveProjectRepo(undefined, root)).toBe("env/o");
    process.env.DEFT_PROJECT_REPO = "not-a-slug";
    expect(resolveProjectRepo(undefined, root)).toBeNull();
    process.env.DEFT_PROJECT_REPO = prev;
  });

  it("resolveRootAndRepo distinguishes missing root vs repo", () => {
    const root = makeRoot();
    expect(resolveRootAndRepo(root, "owner/repo", true)).toMatchObject({
      exitCode: 0,
      repo: "owner/repo",
    });
    expect(resolveRootAndRepo("/nope", null, false).exitCode).toBe(2);
    expect(resolveRootAndRepo(root, null, true).exitCode).toBe(2);
  });

  it("formats actionable errors", () => {
    expect(formatMissingRootError()).toContain("project root");
    expect(formatMissingRepoError()).toContain("repo slug");
  });

  it("normaliseRepoSlug handles ssh github URLs and empty input", () => {
    expect(normaliseRepoSlug("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(normaliseRepoSlug("   ")).toBeNull();
  });

  it("resolveProjectRepo returns null for malformed explicit slugs", () => {
    expect(resolveProjectRepo("not-a-valid-slug", makeRoot())).toBeNull();
  });
});
