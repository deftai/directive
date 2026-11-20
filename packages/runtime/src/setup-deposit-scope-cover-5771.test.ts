/**
 * #5771 gate-admission proof: real setup output, staged in a real git
 * repository, passes prospective scope-cover with the real git readers and no
 * running scope. This is admission by the commit gate, not proof that a local
 * `git commit` succeeds (the git pre-commit checks are unchanged).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateProspectiveScopeCover } from "@deftai/directive-core/dist/hooks/dispatcher.js";
import {
  listStagedIndexEntries,
  stagedRelPathsFromEntries,
} from "@deftai/directive-core/dist/hooks/planning-publication.js";
import { MANAGED_SECTION_CLOSE } from "@deftai/directive-core/dist/install-health/ownership.js";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

/** Stage everything and run the commit gate's scope-cover as the hook does, with no scope. */
function stagedScopeCover(root: string) {
  git(root, "add", "-A");
  const listed = listStagedIndexEntries(root);
  if (!listed.ok) return { ok: false, message: listed.message, uncovered: [], staged: [] };
  const result = evaluateProspectiveScopeCover({
    projectRoot: root,
    stagedRelPaths: stagedRelPathsFromEntries(listed.entries),
    stagedEntries: listed.entries,
    inspectScope: () => ({ ready: false, path: null, message: "no running scope" }),
    resolveStoryBinding: () => ({ kind: "none" }),
    env: {},
  });
  return { ...result, staged: listed.entries.map((e) => e.path) };
}

function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-deposit-5771-"));
  TEMPS.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "checkout", "-q", "-b", "feature/first");
  return root;
}

describe("setup deposit passes the commit gate's scope-cover with no scope (#5771)", () => {
  it("admits the staged install deposit, then a staged repair rewrite", () => {
    const root = freshRepo();
    const installed = runSetup({ operation: "install", from: "none", root });
    expect(installed.conflicts).toEqual([]);
    // The package manager writes the pin; setup's own package.json scaffold form.
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          devDependencies: { "@deftai/directive-runtime": installed.runtimeVersion },
        },
        null,
        2,
      )}\n`,
    );

    const install = stagedScopeCover(root);
    expect(install.staged).toEqual(
      expect.arrayContaining(["AGENTS.md", "Taskfile.yml", "package.json"]),
    );
    expect(install.message, install.message).toMatch(/Directive-only staged set/);
    expect(install.ok, install.message).toBe(true);
    git(root, "commit", "-q", "--no-verify", "-m", "deposit");

    // Edit the managed section, commit it, then let repair rewrite it.
    const agentsPath = join(root, "AGENTS.md");
    const agents = readFileSync(agentsPath, "utf8");
    const close = agents.indexOf(MANAGED_SECTION_CLOSE);
    expect(close).toBeGreaterThan(0);
    writeFileSync(
      agentsPath,
      `${agents.slice(0, close)}A stale managed line.\n${agents.slice(close)}`,
    );
    git(root, "commit", "-q", "--no-verify", "-am", "stale managed section");

    const repaired = runSetup({ operation: "repair", from: installed.runtimeVersion, root });
    expect(repaired.conflicts).toEqual([]);
    const repair = stagedScopeCover(root);
    expect(repair.staged).toContain("AGENTS.md");
    expect(repair.ok, repair.message).toBe(true);
  }, 120_000);

  it("keeps a user change beside the deposit uncovered", () => {
    const root = freshRepo();
    runSetup({ operation: "install", from: "none", root });
    writeFileSync(join(root, "app.ts"), "export const x = 1;\n");
    const mixed = stagedScopeCover(root);
    expect(mixed.ok).toBe(false);
    expect(mixed.uncovered).toEqual(["app.ts"]);
    expect(mixed.message).toContain("app.ts (not-owned)");
    expect(mixed.message).not.toMatch(/scope:promote|scope:activate/);
  }, 120_000);
});
