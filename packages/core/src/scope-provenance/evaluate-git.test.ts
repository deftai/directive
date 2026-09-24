/**
 * Real-Git regressions for merge-base brief fence (#4956 / #3205 rewrite).
 *
 * Hermetic git fixtures: base brief file_scope is the fence; production extras
 * past allowance fail; same-PR approved-scope rewrite still fails closed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApprovedScopeRecord } from "./digest.js";
import { evaluateScopeProvenance } from "./evaluate.js";

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-prov-git-"));
  git(root, ["init", "-q"]);
  git(root, ["checkout", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  return root;
}

function writeFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

function writeTracked(root: string, rel: string, body: string): void {
  writeFile(root, rel, body);
  git(root, ["add", "--", rel]);
}

function commit(root: string, msg: string): void {
  git(root, ["commit", "-q", "-m", msg, "--allow-empty"]);
}

function xbrief(planId: string, fileScope: string[], status = "running"): Record<string, unknown> {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: planId,
      status,
      metadata: { swarm: { file_scope: fileScope } },
    },
  };
}

function approvalJson(
  planId: string,
  fileScope: string[],
  xbriefRelPath = "xbrief/active/story.xbrief.json",
): string {
  const payload = xbrief(planId, fileScope);
  const rec = buildApprovedScopeRecord({
    xbriefRelPath,
    payload,
    approvedAt: "2026-08-01T00:00:00Z",
    humanApproval: {
      kind: "operator",
      actor: "scott",
      mintedAt: "2026-08-01T00:00:00Z",
      mintedVia: "scope:record-approved-scope",
    },
  });
  return `${JSON.stringify(rec, null, 2)}\n`;
}

describe("evaluateScopeProvenance real-Git base-brief fence (#4956)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("passes when changed production files stay inside the base brief fence", () => {
    root = initRepo();
    const planId = "story-1";
    const scope = ["packages/core/src/foo.ts"];
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope), null, 2)}\n`,
    );
    writeTracked(root, "packages/core/src/foo.ts", "export const a = 1;\n");
    commit(root, "base: brief + source");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "impl"]);
    writeTracked(root, "packages/core/src/foo.ts", "export const a = 2;\n");
    writeTracked(root, "packages/core/src/foo.test.ts", "import { a } from './foo.js';\n");
    writeTracked(root, "CHANGELOG.md", "## Unreleased\n");
    commit(root, "in-fence + free paths");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/clean/i);
  });

  it("passes when the brief is new on the branch (no base fence / no mint)", () => {
    root = initRepo();
    writeTracked(root, "README.md", "seed\n");
    commit(root, "base seed");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "first"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief("story-1", ["packages/core/src/foo.ts"]), null, 2)}\n`,
    );
    writeTracked(root, "packages/core/src/foo.ts", "export const a = 1;\n");
    commit(root, "first PR with brief");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(0);
    expect(result.message).not.toMatch(/record-approved-scope/);
  });

  it("fails when production extras exceed the base allowance", () => {
    root = initRepo();
    const planId = "story-1";
    const baseScope = ["packages/core/src/a.ts"];
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, baseScope), null, 2)}\n`,
    );
    writeTracked(root, "packages/core/src/a.ts", "export const a = 1;\n");
    commit(root, "base");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "expand"]);
    // Head brief widens — must not authorize extras past allowance (floor 2).
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(
        xbrief(planId, [
          "packages/core/src/a.ts",
          "packages/core/src/b.ts",
          "packages/core/src/c.ts",
          "packages/core/src/d.ts",
        ]),
        null,
        2,
      )}\n`,
    );
    writeTracked(root, "packages/core/src/b.ts", "export const b = 1;\n");
    writeTracked(root, "packages/core/src/c.ts", "export const c = 1;\n");
    writeTracked(root, "packages/core/src/d.ts", "export const d = 1;\n");
    commit(root, "over budget");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("production-scope-over-budget");
    expect(result.findings[0]?.remediation).not.toMatch(/--kind renewed-approval/);
  });

  it("fails when approval is rewritten in the same change set", () => {
    root = initRepo();
    const planId = "story-1";
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, ["packages/core/src/foo.ts"]), null, 2)}\n`,
    );
    writeTracked(
      root,
      `.deft/approved-scope/${planId}.json`,
      approvalJson(planId, ["packages/core/src/foo.ts"]),
    );
    commit(root, "base");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "rewrite"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(
        xbrief(planId, ["packages/core/src/foo.ts", "packages/core/src/bar.ts"]),
        null,
        2,
      )}\n`,
    );
    writeTracked(
      root,
      `.deft/approved-scope/${planId}.json`,
      approvalJson(planId, ["packages/core/src/foo.ts", "packages/core/src/bar.ts"]),
    );
    commit(root, "rewrite approval with brief");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("self-authorizing-scope-expansion");
    expect(result.findings[0]?.detail).toMatch(/rewritten|same change/i);
  });
});
