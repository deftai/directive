import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRepoMutationAllowed, normalizeRepoSlug } from "./repo-guard.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("repo-guard (#2601)", () => {
  it("normalizes repo slugs case-insensitively", () => {
    expect(normalizeRepoSlug(" DeftAI/Directive ")).toBe("deftai/directive");
  });

  it("allows same-repo mutation when explicit repo matches target", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-same-"));
    roots.push(root);
    const gate = isRepoMutationAllowed("deftai/directive", root, {
      explicitRepo: "deftai/directive",
    });
    expect(gate.allowed).toBe(true);
  });

  it("refuses cross-repo mutation by default", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-cross-"));
    roots.push(root);
    const gate = isRepoMutationAllowed("other/victim", root, {
      explicitRepo: "deftai/directive",
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/refusing cross-repo mutation/);
  });

  it("honors allowCrossRepo opt-in", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-allow-"));
    roots.push(root);
    const gate = isRepoMutationAllowed("other/victim", root, {
      explicitRepo: "deftai/directive",
      allowCrossRepo: true,
    });
    expect(gate.allowed).toBe(true);
  });

  it("infers project repo from git origin when explicit repo is omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-git-"));
    roots.push(root);
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/deftai/directive.git"], {
      cwd: root,
    });
    const gate = isRepoMutationAllowed("deftai/directive", root, {});
    expect(gate.allowed).toBe(true);
  });
});
