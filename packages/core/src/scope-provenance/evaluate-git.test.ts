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
import { computeAuthHashV1 } from "./forge-approval.js";
import { mintApprovedScopeArtifacts } from "./mint-artifacts.js";

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

  it("fails closed when product paths land with no merge-base mint (#4774)", () => {
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
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "active-xbrief-modified-without-digest")).toBe(
      true,
    );
  });

  it("empty merge-base mint refuses product paths even when brief lists them (#4774)", () => {
    root = initRepo();
    const planId = "story-1";
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, ["packages/core/src/foo.ts"]), null, 2)}\n`,
    );
    writeTracked(root, `.deft/approved-scope/${planId}.json`, approvalJson(planId, []));
    commit(root, "base with empty mint");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "empty-mint"]);
    writeTracked(root, "packages/core/src/foo.ts", "export const a = 1;\n");
    // Touch the active brief so membership runs (empty mint is authoritative).
    const touched = xbrief(planId, ["packages/core/src/foo.ts"]);
    (touched.plan as Record<string, unknown>).title = "empty-mint-touch";
    writeTracked(root, "xbrief/active/story.xbrief.json", `${JSON.stringify(touched, null, 2)}\n`);
    commit(root, "product under empty mint");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("active-xbrief-modified-without-digest");
    expect(result.findings[0]?.detail).toMatch(/#4774/);
  });

  it("allows in-scope delivery when merge-base mint covers the change set (#4774)", () => {
    root = initRepo();
    const planId = "story-1";
    const scope = ["packages/core/src/foo.ts"];
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope), null, 2)}\n`,
    );
    writeTracked(root, `.deft/approved-scope/${planId}.json`, approvalJson(planId, scope));
    writeTracked(root, "packages/core/src/foo.ts", "export const a = 1;\n");
    commit(root, "base with mint");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "impl"]);
    writeTracked(root, "packages/core/src/foo.ts", "export const a = 2;\n");
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, scope), null, 2)}\n`,
    );
    commit(root, "in-scope edit");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(0);
    expect(result.findings.some((f) => f.kind === "active-xbrief-modified-without-digest")).toBe(
      false,
    );
  });

  it("fails when production extras exceed the base allowance", () => {
    root = initRepo();
    const planId = "story-1";
    const baseScope = ["packages/core/src/a.ts"];
    const wideScope = [
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
      "packages/core/src/c.ts",
      "packages/core/src/d.ts",
    ];
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, baseScope), null, 2)}\n`,
    );
    writeTracked(root, "packages/core/src/a.ts", "export const a = 1;\n");
    // Wide mint on base so #4774 membership does not mask the #4956 fence.
    writeTracked(root, `.deft/approved-scope/${planId}.json`, approvalJson(planId, wideScope));
    commit(root, "base");
    git(root, ["branch", "base"]);

    git(root, ["checkout", "-q", "-b", "expand"]);
    // Head brief widens — must not authorize extras past allowance (floor 2).
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify(xbrief(planId, wideScope), null, 2)}\n`,
    );
    writeTracked(root, "packages/core/src/b.ts", "export const b = 1;\n");
    writeTracked(root, "packages/core/src/c.ts", "export const c = 1;\n");
    writeTracked(root, "packages/core/src/d.ts", "export const d = 1;\n");
    commit(root, "over budget");

    const result = evaluateScopeProvenance(root, { baseRef: "base", enforce: true });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "production-scope-over-budget")).toBe(true);
    const fence = result.findings.find((f) => f.kind === "production-scope-over-budget");
    expect(fence?.remediation).not.toMatch(/--kind renewed-approval/);
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

// ---------------------------------------------------------------------------
// One-PR mint level (#6273)
// ---------------------------------------------------------------------------

const MINT_REL = "xbrief/active/story.xbrief.json";
const MINT_PLAN = "story-6273";
const RECORD_REL = `.deft/approved-scope/${MINT_PLAN}.json`;
const INTENT_REL = `.deft/approved-scope/${MINT_PLAN}.intent.json`;

function projectDefinition(policy: Record<string, unknown> | null): string {
  const plan: Record<string, unknown> = { title: "T", status: "running", items: [] };
  if (policy !== null) plan["x-directive/policy"] = policy;
  return `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`;
}

function mintBrief(fileScope: string[], acceptance = "the feature works"): Record<string, unknown> {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: MINT_PLAN,
      title: "One-PR story",
      status: "running",
      items: [{ id: "a", title: "A", status: "pending", narrative: { Acceptance: acceptance } }],
      metadata: { swarm: { file_scope: fileScope } },
    },
  };
}

function writeBrief(root: string, payload: Record<string, unknown>): string {
  const raw = `${JSON.stringify(payload, null, 2)}\n`;
  writeTracked(root, MINT_REL, raw);
  return raw;
}

/** Human mint of the brief as `scope:record-approved-scope` writes it. */
function mintPair(root: string, payload: Record<string, unknown>, raw: string): void {
  mintApprovedScopeArtifacts({
    xbriefRelPath: MINT_REL,
    payload,
    rawText: raw,
    projectRoot: root,
    humanApproval: {
      kind: "operator",
      actor: "scott",
      mintedAt: "2026-11-13T00:00:00Z",
      mintedVia: "scope:record-approved-scope",
    },
    authHashV1: computeAuthHashV1(payload, MINT_REL) ?? undefined,
    extract: { projectRoot: root },
  });
  git(root, ["add", "--", RECORD_REL, INTENT_REL]);
}

const NEW_SCOPE = [
  "packages/core/src/feature.ts",
  "packages/core/src/feature.test.ts",
  RECORD_REL,
  INTENT_REL,
];

interface MintRepoOptions {
  readonly basePolicy: Record<string, unknown> | null;
  /** Brief + mint already on the merge base (widen case). */
  readonly baseScope?: string[];
}

/** Base branch `base` with PROJECT-DEFINITION; branch `impl` checked out. */
function mintRepo(opts: MintRepoOptions): string {
  const r = initRepo();
  writeTracked(r, "xbrief/PROJECT-DEFINITION.xbrief.json", projectDefinition(opts.basePolicy));
  if (opts.baseScope !== undefined) {
    const basePayload = mintBrief(opts.baseScope);
    const baseRaw = writeBrief(r, basePayload);
    mintPair(r, basePayload, baseRaw);
    writeTracked(r, "packages/core/src/feature.ts", "export const f = 0;\n");
  } else {
    writeTracked(r, "README.md", "seed\n");
  }
  commit(r, "base");
  git(r, ["branch", "base"]);
  git(r, ["checkout", "-q", "-b", "impl"]);
  return r;
}

/** Head brief + its code + same-PR mint pair, committed on `impl`. */
function landOnePr(r: string, scope: string[] = NEW_SCOPE): void {
  const payload = mintBrief(scope);
  const raw = writeBrief(r, payload);
  writeTracked(r, "packages/core/src/feature.ts", "export const f = 1;\n");
  writeTracked(r, "packages/core/src/feature.test.ts", "import './feature.js';\n");
  mintPair(r, payload, raw);
  commit(r, "one PR: brief + mint + code");
}

const MINT_ON = { onePrScopeProof: "mint", requireHumanMerge: true };

describe("evaluateScopeProvenance one-PR mint level (#6273)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("admits a new brief with its same-PR record pair and code", () => {
    root = mintRepo({ basePolicy: MINT_ON });
    landOnePr(root);
    const result = evaluateScopeProvenance(root, { baseRef: "base" });
    expect(result.exitCode, result.message).toBe(0);
    expect(result.mintLevelAdmits).toHaveLength(1);
    const admit = result.mintLevelAdmits?.[0];
    expect(admit?.planId).toBe(MINT_PLAN);
    expect(admit?.xbriefRelPath).toBe(MINT_REL);
    // Both halves of the pair are changed and in the declared scope.
    expect(admit?.fileScope).toContain(RECORD_REL);
    expect(admit?.fileScope).toContain(INTENT_REL);
    expect(admit?.productionFileCount).toBe(1);
  });

  it("admits a brief widened past its merge-base mint", () => {
    root = mintRepo({ basePolicy: MINT_ON, baseScope: ["packages/core/src/feature.ts"] });
    landOnePr(root);
    const result = evaluateScopeProvenance(root, { baseRef: "base" });
    expect(result.exitCode, result.message).toBe(0);
    expect(result.mintLevelAdmits?.[0]?.fileScope).toContain("packages/core/src/feature.test.ts");
  });

  it("keeps the #4956 production fence on the merge-base brief", () => {
    root = mintRepo({ basePolicy: MINT_ON, baseScope: ["packages/core/src/feature.ts"] });
    const extras = ["b", "c", "d"];
    for (const p of extras) {
      writeTracked(root, `packages/core/src/${p}.ts`, `export const ${p} = 1;\n`);
    }
    landOnePr(root, [...NEW_SCOPE, ...extras.map((p) => `packages/core/src/${p}.ts`)]);
    const result = evaluateScopeProvenance(root, { baseRef: "base" });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "production-scope-over-budget")).toBe(true);
    expect(result.findings.some((f) => f.kind === "self-authorizing-scope-expansion")).toBe(false);
  });
});
