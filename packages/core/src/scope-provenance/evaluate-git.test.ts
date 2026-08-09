/**
 * Real-Git regressions for base-approval authority (#3205).
 *
 * Hermetic git fixtures: pending→active with base-visible human approval must
 * pass; missing/mismatched/agent/same-PR rewrite must fail closed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildApprovedScopeRecord,
  computeFileScopeDigest,
  writeApprovedScopeRecord,
} from "./digest.js";
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

function humanApproval(actor = "scott") {
  return {
    kind: "operator" as const,
    actor,
    mintedAt: "2026-08-01T00:00:00Z",
    mintedVia: "scope:record-approved-scope",
  };
}

function approvalJson(
  planId: string,
  fileScope: string[],
  xbriefRelPath = "xbrief/active/story.xbrief.json",
  stamp:
    | ReturnType<typeof humanApproval>
    | { kind: string; actor: string; mintedAt: string } = humanApproval(),
): string {
  const payload = xbrief(planId, fileScope);
  const rec = buildApprovedScopeRecord({
    xbriefRelPath,
    payload,
    approvedAt: "2026-08-01T00:00:00Z",
    humanApproval: stamp,
  });
  return `${JSON.stringify(rec, null, 2)}\n`;
}

describe("evaluateScopeProvenance real-Git base approval (#3205)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("AC1: base pending + human approval + activation-only → enforce exit 0", () => {
    root = initRepo();
    const planId = "story-1";
    const scope = ["src/foo.ts"];
    writeTracked(
      root,
      "xbrief/pending/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope, "pending"), null, 2)}\n`,
    );
    writeTracked(root, `.deft/approved-scope/${planId}.json`, approvalJson(planId, scope));
    // seed empty so main exists as base
    commit(root, "base: pending + approval");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "activate"]);
    git(root, ["rm", "-q", "xbrief/pending/story.xbrief.json"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope, "running"), null, 2)}\n`,
    );
    commit(root, "activate only");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/clean/i);
  });

  it("fails when base approval is absent", () => {
    root = initRepo();
    const planId = "story-1";
    const scope = ["src/foo.ts"];
    writeTracked(
      root,
      "xbrief/pending/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope, "pending"), null, 2)}\n`,
    );
    commit(root, "base: pending only");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "activate"]);
    git(root, ["rm", "-q", "xbrief/pending/story.xbrief.json"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope, "running"), null, 2)}\n`,
    );
    // matching approval only on branch (same-PR)
    writeTracked(root, `.deft/approved-scope/${planId}.json`, approvalJson(planId, scope));
    commit(root, "activate + new approval");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("self-authorizing-scope-expansion");
  });

  it("fails when base approval is agent-stamped", () => {
    root = initRepo();
    const planId = "story-1";
    const scope = ["src/foo.ts"];
    writeTracked(
      root,
      "xbrief/pending/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope, "pending"), null, 2)}\n`,
    );
    writeTracked(
      root,
      `.deft/approved-scope/${planId}.json`,
      approvalJson(planId, scope, "xbrief/active/story.xbrief.json", {
        kind: "agent",
        actor: "agent:worker",
        mintedAt: "2026-08-01T00:00:00Z",
      }),
    );
    commit(root, "base: agent approval");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "activate"]);
    git(root, ["rm", "-q", "xbrief/pending/story.xbrief.json"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope, "running"), null, 2)}\n`,
    );
    commit(root, "activate");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(1);
  });

  it("fails when base approval scope mismatches current", () => {
    root = initRepo();
    const planId = "story-1";
    writeTracked(
      root,
      "xbrief/pending/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, ["src/foo.ts"], "pending"), null, 2)}\n`,
    );
    writeTracked(root, `.deft/approved-scope/${planId}.json`, approvalJson(planId, ["src/foo.ts"]));
    commit(root, "base");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "expand"]);
    git(root, ["rm", "-q", "xbrief/pending/story.xbrief.json"]);
    // Expand beyond base-approved scope without renewing approval
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, ["src/foo.ts", "src/bar.ts"], "running"), null, 2)}\n`,
    );
    commit(root, "activate with expansion");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toMatch(/self-authorizing|without-digest/);
  });

  it("fails when approval is rewritten in the same change set", () => {
    root = initRepo();
    const planId = "story-1";
    writeTracked(
      root,
      "xbrief/pending/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, ["src/foo.ts"], "pending"), null, 2)}\n`,
    );
    writeTracked(root, `.deft/approved-scope/${planId}.json`, approvalJson(planId, ["src/foo.ts"]));
    commit(root, "base");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "rewrite"]);
    git(root, ["rm", "-q", "xbrief/pending/story.xbrief.json"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, ["src/foo.ts", "src/bar.ts"], "running"), null, 2)}\n`,
    );
    // Same-PR rewrite of approval to match expanded scope
    writeTracked(
      root,
      `.deft/approved-scope/${planId}.json`,
      approvalJson(planId, ["src/foo.ts", "src/bar.ts"]),
    );
    commit(root, "activate + rewrite approval");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("self-authorizing-scope-expansion");
    expect(result.findings[0]?.detail).toMatch(/rewritten|same change/i);
  });

  it("passes when base has separately committed expanded approval then xBRIEF updates", () => {
    root = initRepo();
    const planId = "story-1";
    // Base already active with narrow scope + narrow approval
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, ["src/foo.ts"], "running"), null, 2)}\n`,
    );
    writeTracked(root, `.deft/approved-scope/${planId}.json`, approvalJson(planId, ["src/foo.ts"]));
    commit(root, "narrow");
    // Operator commits expanded approval first (still on base line)
    writeTracked(
      root,
      `.deft/approved-scope/${planId}.json`,
      approvalJson(planId, ["src/foo.ts", "src/bar.ts"]),
    );
    commit(root, "expanded human approval");
    git(root, ["branch", "base"]);

    // Later PR only updates active xBRIEF to the already-approved expanded scope
    git(root, ["checkout", "-q", "-b", "apply-scope"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, ["src/foo.ts", "src/bar.ts"], "running"), null, 2)}\n`,
    );
    commit(root, "apply approved expansion");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(0);
  });

  it("still accepts independent renewedApprovals injection", () => {
    root = initRepo();
    const planId = "story-1";
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, ["src/foo.ts"], "running"), null, 2)}\n`,
    );
    writeTracked(root, `.deft/approved-scope/${planId}.json`, approvalJson(planId, ["src/foo.ts"]));
    commit(root, "base");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "expand"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, ["src/foo.ts", "src/new.ts"], "running"), null, 2)}\n`,
    );
    commit(root, "expand without approval rewrite");

    const renewed = new Map([
      [
        planId,
        {
          kind: "renewed-approval",
          actor: "scott",
          mintedAt: "2026-08-08T00:00:00Z",
        },
      ],
    ]);
    const result = evaluateScopeProvenance(root, {
      baseRef: "base",
      enforce: true,
      renewedApprovals: renewed,
    });
    expect(result.exitCode).toBe(0);
  });

  it("fails on malformed base approval JSON", () => {
    root = initRepo();
    const planId = "story-1";
    const scope = ["src/foo.ts"];
    writeTracked(
      root,
      "xbrief/pending/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope, "pending"), null, 2)}\n`,
    );
    writeTracked(root, `.deft/approved-scope/${planId}.json`, "{not-json\n");
    commit(root, "malformed approval");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "activate"]);
    git(root, ["rm", "-q", "xbrief/pending/story.xbrief.json"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope, "running"), null, 2)}\n`,
    );
    // Fix disk approval so existsSync path is valid matching current (but base is bad)
    writeApprovedScopeRecord(
      root,
      buildApprovedScopeRecord({
        xbriefRelPath: "xbrief/active/story.xbrief.json",
        payload: xbrief(planId, scope),
        humanApproval: humanApproval(),
      }),
    );
    git(root, ["add", "--", `.deft/approved-scope/${planId}.json`]);
    commit(root, "activate + fixed disk approval");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    // Fixed approval is in the change set → same-PR rewrite fail, OR base malformed → disk-only
    expect(result.exitCode).toBe(1);
  });

  it("documents digest helper still computes stable digests for fixture scopes", () => {
    expect(computeFileScopeDigest(["src/foo.ts"])).toHaveLength(64);
  });
});
