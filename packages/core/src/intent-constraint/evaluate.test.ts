import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  base64urlEncode,
  buildRecordApprovalPayload,
  canonicalBytes,
} from "../approvers/canonical.js";
import type { RecordApprovalEntry } from "../approvers/types.js";
import { FLAG_UP, FLAG_UV, spkiOf } from "../approvers/webauthn.js";
import type { SignedLevel } from "../scope-provenance/record-stamp.js";
import {
  CANDIDATE_COMMITTED_ONLY,
  CANDIDATE_WORKING_TREE,
  evaluateIntentConstraint,
  resolveIntentConstraintOrigin,
} from "./evaluate.js";
import { buildIntentConstraintRecord } from "./mint.js";
import { INTENT_CONSTRAINT_REMEDIATION } from "./types.js";

const POSTED = `
const MAX_ITEM_BYTES = 1024;
export function publish(input: { size: number }[]): void {
  for (const item of input) {
    if (item.size > MAX_ITEM_BYTES) {
      throw new Error("item exceeds limit");
    }
  }
}
`;

const BASE = `export function publish(input: { size: number }[]): void {
  for (const item of input) {
    void item;
  }
}
`;

const human = {
  kind: "operator" as const,
  actor: "scott",
  mintedAt: "2026-09-15T00:00:00Z",
  mintedVia: "scope:record-intent-constraint",
};

function record() {
  const rec = buildIntentConstraintRecord({
    planId: "story-1",
    xbriefRelPath: "xbrief/active/story.xbrief.json",
    constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
    humanApproval: human,
  });
  if ("error" in rec) {
    return { schema: "err" };
  }
  return rec;
}

function withTypescript(root: string): string {
  writeFileSync(join(root, "package.json"), "{}" + "\n");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(
    join(process.cwd(), "node_modules", "typescript"),
    join(root, "node_modules", "typescript"),
    "junction",
  );
  return root;
}

describe("verify:intent-constraint lists every fact (#6336 item 6)", () => {
  /** Twelve new numeric consts, one per line from line 2. */
  const TWELVE = `\n${Array.from({ length: 12 }, (_, i) => `const LIMIT_${i} = ${100 + i};`).join("\n")}\nexport function publish(): void {}\n`;
  const base = {
    projectRoot: process.cwd(),
    mergeBase: "base",
    changedFiles: ["src/ingest.ts"],
    readAtBase: (rel: string) => (rel === "src/ingest.ts" ? BASE : null),
    readAtHead: (rel: string) => (rel === "src/ingest.ts" ? TWELVE : null),
  };

  function expectAllTwelve(message: string): void {
    for (let i = 0; i < 12; i += 1) {
      expect(message).toContain(`src/ingest.ts:${i + 2} numeric-const ${100 + i}`);
    }
    expect(message).toContain("12 ");
  }

  it("lists all twelve with path, line, kind and value when no mint exists", () => {
    const result = evaluateIntentConstraint({ ...base, recordTextsAtBase: new Map() });
    expect(result.code).toBe(1);
    expectAllTwelve(result.message);
  });

  it("lists all twelve when the plan has no mint", () => {
    const result = evaluateIntentConstraint({
      ...base,
      planId: "other-story",
      recordTextsAtBase: new Map([
        [".deft/intent-constraint/story-1.json", `${JSON.stringify(record(), null, 2)}\n`],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/no merge-base mint record for planId other-story/);
    expectAllTwelve(result.message);
  });

  it("lists every uncovered fact when a mint covers only some", () => {
    const result = evaluateIntentConstraint({
      ...base,
      planId: "story-1",
      recordTextsAtBase: new Map([
        [".deft/intent-constraint/story-1.json", `${JSON.stringify(record(), null, 2)}\n`],
      ]),
    });
    expect(result.code).toBe(1);
    expectAllTwelve(result.message);
  });

  it("names a throw site by its source and line", () => {
    const result = evaluateIntentConstraint({
      ...files(POSTED),
      planId: undefined,
      recordTextsAtBase: new Map(),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain(
      'src/ingest.ts:6 throw-site throw new Error("item exceeds limit");',
    );
    expect(result.message).toContain("src/ingest.ts:2 numeric-const 1024");
  });
});

function files(head: string, extras?: { changedFiles?: string[] }) {
  return {
    projectRoot: process.cwd(),
    mergeBase: "base",
    planId: "story-1",
    changedFiles: extras?.changedFiles ?? ["src/ingest.ts"],
    recordTextsAtBase: new Map([
      [".deft/intent-constraint/story-1.json", `${JSON.stringify(record(), null, 2)}\n`],
    ]),
    readAtBase: (rel: string) => (rel === "src/ingest.ts" ? BASE : null),
    readAtHead: (rel: string) => (rel === "src/ingest.ts" ? head : null),
  };
}

describe("evaluateIntentConstraint (#4541)", () => {
  it("skips when no production .ts/.js changed", () => {
    const result = evaluateIntentConstraint({
      projectRoot: process.cwd(),
      mergeBase: "base",
      changedFiles: ["tests/ingest.test.ts", "README.md"],
    });
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.analyzedPaths ?? []).toEqual([]);
  });

  it("fails posted fixture without merge-base mint", () => {
    const result = evaluateIntentConstraint({
      projectRoot: process.cwd(),
      mergeBase: "base",
      changedFiles: ["src/ingest.ts"],
      recordTextsAtBase: new Map(),
      readAtBase: (rel: string) => (rel === "src/ingest.ts" ? BASE : null),
      readAtHead: (rel: string) => (rel === "src/ingest.ts" ? POSTED : null),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain(INTENT_CONSTRAINT_REMEDIATION);
    expect(result.message).toMatch(/src\/ingest\.ts/);
    expect(result.message).not.toMatch(/test provides authority|tests are authority/i);
  });

  it("passes posted fixture when merge-base mint has value/unit/rejectionScope", () => {
    const result = evaluateIntentConstraint(files(POSTED));
    expect(result.code).toBe(0);
    expect(result.skipped).not.toBe(true);
  });

  it("fails same-PR mint rewrite", () => {
    const result = evaluateIntentConstraint(
      files(POSTED, { changedFiles: ["src/ingest.ts", ".deft/intent-constraint/story-1.json"] }),
    );
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/same-PR rewrite/);
  });

  it("does not treat tests or in-scope paths as authority", () => {
    const result = evaluateIntentConstraint({
      projectRoot: process.cwd(),
      mergeBase: "base",
      changedFiles: ["src/ingest.ts", "tests/ingest.test.ts"],
      recordTextsAtBase: new Map(),
      readAtBase: (rel: string) => (rel === "src/ingest.ts" ? BASE : null),
      readAtHead: (rel: string) =>
        rel === "src/ingest.ts"
          ? POSTED
          : rel === "tests/ingest.test.ts"
            ? "throw new Error('x')"
            : null,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain(INTENT_CONSTRAINT_REMEDIATION);
  });

  it("treats skip+new-const as a numeric-const, not leftover", () => {
    const head = `
const MAX = 1024;
export function publish(input: { size: number }[]): void {
  for (const item of input) {
    if (item.size > MAX) continue;
  }
}
`;
    const result = evaluateIntentConstraint({
      projectRoot: process.cwd(),
      mergeBase: "base",
      changedFiles: ["src/ingest.ts"],
      recordTextsAtBase: new Map(),
      readAtBase: (rel: string) => (rel === "src/ingest.ts" ? BASE : null),
      readAtHead: (rel: string) => (rel === "src/ingest.ts" ? head : null),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/numeric-const/);
  });

  it("config-fails invalid merge-base mint JSON", () => {
    const result = evaluateIntentConstraint({
      projectRoot: process.cwd(),
      mergeBase: "base",
      changedFiles: ["src/ingest.ts"],
      recordTextsAtBase: new Map([[".deft/intent-constraint/story-1.json", "{not json"]]),
      readAtBase: (rel: string) => (rel === "src/ingest.ts" ? BASE : null),
      readAtHead: (rel: string) => (rel === "src/ingest.ts" ? POSTED : null),
    });
    expect(result.code).toBe(2);
  });

  it("fails when --plan-id does not match merge-base mint", () => {
    const result = evaluateIntentConstraint({
      ...files(POSTED),
      planId: "other-story",
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/no merge-base mint record/);
  });

  it("uses the matching plan mint, not record order", () => {
    const other = buildIntentConstraintRecord({
      planId: "other-story",
      xbriefRelPath: "xbrief/active/other.xbrief.json",
      constraints: [{ value: "1", unit: "bytes", rejectionScope: "item" }],
      humanApproval: human,
    });
    if ("error" in other) throw new Error(other.error);
    const result = evaluateIntentConstraint({
      ...files(POSTED),
      planId: "story-1",
      recordTextsAtBase: new Map([
        [".deft/intent-constraint/other-story.json", `${JSON.stringify(other, null, 2)}\n`],
        [".deft/intent-constraint/story-1.json", `${JSON.stringify(record(), null, 2)}\n`],
      ]),
    });
    expect(result.code).toBe(0);
  });

  it("config-fails when DEFT_ACTIVE_SCOPE pin is not a running xBRIEF", () => {
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    process.env.DEFT_ACTIVE_SCOPE = "xbrief/active/missing-pin.xbrief.json";
    try {
      const result = evaluateIntentConstraint({
        ...files(POSTED),
        planId: undefined,
      });
      expect(result.code).toBe(2);
      expect(result.message).toMatch(/DEFT_ACTIVE_SCOPE/);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
    }
  });

  it("config-fails multiple merge-base mints without a plan id", () => {
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    const prevPr = process.env.GITHUB_PR_NUMBER;
    delete process.env.DEFT_ACTIVE_SCOPE;
    delete process.env.GITHUB_PR_NUMBER;
    const root = withTypescript(mkdtempSync(join(tmpdir(), "intent-multi-mint-")));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    try {
      const other = buildIntentConstraintRecord({
        planId: "other-story",
        xbriefRelPath: "xbrief/active/other.xbrief.json",
        constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
        humanApproval: human,
      });
      if ("error" in other) throw new Error(other.error);
      const result = evaluateIntentConstraint({
        ...files(POSTED),
        projectRoot: root,
        planId: undefined,
        pr: "",
        recordTextsAtBase: new Map([
          [".deft/intent-constraint/other-story.json", `${JSON.stringify(other, null, 2)}\n`],
          [".deft/intent-constraint/story-1.json", `${JSON.stringify(record(), null, 2)}\n`],
        ]),
      });
      expect(result.code).toBe(2);
      expect(result.message).toMatch(/multiple running stories or merge-base mint records/);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
      if (prevPr === undefined) delete process.env.GITHUB_PR_NUMBER;
      else process.env.GITHUB_PR_NUMBER = prevPr;
    }
  });

  it("uses dest unique running pin, not mint record order, when --plan-id is omitted", () => {
    const root = withTypescript(mkdtempSync(join(tmpdir(), "intent-dest-unique-")));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({ plan: { id: "story-1", status: "running" } }),
    );
    const other = buildIntentConstraintRecord({
      planId: "other-story",
      xbriefRelPath: "xbrief/active/other.xbrief.json",
      constraints: [{ value: "1", unit: "bytes", rejectionScope: "item" }],
      humanApproval: human,
    });
    if ("error" in other) throw new Error(other.error);
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    delete process.env.DEFT_ACTIVE_SCOPE;
    try {
      const result = evaluateIntentConstraint({
        ...files(POSTED),
        projectRoot: root,
        planId: undefined,
        recordTextsAtBase: new Map([
          [".deft/intent-constraint/other-story.json", `${JSON.stringify(other, null, 2)}\n`],
          [".deft/intent-constraint/story-1.json", `${JSON.stringify(record(), null, 2)}\n`],
        ]),
      });
      expect(result.code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
    }
  });

  it("config-fails multiple dest running stories even with one mint", () => {
    const root = withTypescript(mkdtempSync(join(tmpdir(), "intent-multi-running-")));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "a.xbrief.json"),
      JSON.stringify({ plan: { id: "story-1", status: "running" } }),
    );
    writeFileSync(
      join(root, "xbrief", "active", "b.xbrief.json"),
      JSON.stringify({ plan: { id: "story-2", status: "running" } }),
    );
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    const prevPr = process.env.GITHUB_PR_NUMBER;
    delete process.env.DEFT_ACTIVE_SCOPE;
    delete process.env.GITHUB_PR_NUMBER;
    try {
      const result = evaluateIntentConstraint({
        ...files(POSTED),
        projectRoot: root,
        planId: undefined,
        pr: "",
      });
      expect(result.code).toBe(2);
      expect(result.message).toMatch(/multiple running stories/);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
      if (prevPr === undefined) delete process.env.GITHUB_PR_NUMBER;
      else process.env.GITHUB_PR_NUMBER = prevPr;
    }
  });

  it("passes quiet with no new facts", () => {
    const result = evaluateIntentConstraint({
      projectRoot: process.cwd(),
      mergeBase: "base",
      changedFiles: ["src/ingest.ts"],
      quiet: true,
      recordTextsAtBase: new Map(),
      readAtBase: (rel: string) => (rel === "src/ingest.ts" ? BASE : null),
      readAtHead: (rel: string) => (rel === "src/ingest.ts" ? BASE : null),
    });
    expect(result.code).toBe(0);
    expect(result.message).toBe("");
  });
  it("leaves skip/filter/return-error without new const or throw as leftover pass", () => {
    const head = `
export function publish(input: { size: number }[]): void {
  for (const item of input) {
    if (item.size > 1024) continue;
  }
}
`;
    const result = evaluateIntentConstraint({
      projectRoot: process.cwd(),
      mergeBase: "base",
      changedFiles: ["src/ingest.ts"],
      recordTextsAtBase: new Map(),
      readAtBase: (rel: string) => (rel === "src/ingest.ts" ? BASE : null),
      readAtHead: (rel: string) => (rel === "src/ingest.ts" ? head : null),
    });
    expect(result.code).toBe(0);
  });
});

describe("intent-constraint origin recut (#4813)", () => {
  const roots: string[] = [];

  afterEach(() => {
    delete process.env.GITHUB_BASE_REF;
    delete process.env.DEFT_BASE_REF;
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  function writeTracked(root: string, rel: string, body: string): void {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
    git(root, ["add", "--", rel]);
  }

  function writeProject(root: string, policy: Record<string, unknown>): void {
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "P",
          status: "running",
          policy,
        },
      }),
      "utf8",
    );
  }

  function makeMainDevelopConsumer(): string {
    const root = mkdtempSync(join(tmpdir(), "ic-4813-"));
    const bare = mkdtempSync(join(tmpdir(), "ic-4813-bare-"));
    roots.push(root, bare);
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "test"]);
    writeTracked(root, ".gitignore", "node_modules\n");
    writeTracked(
      root,
      "src/history.ts",
      'export function old(): void { throw new Error("hist"); }\n',
    );
    git(root, ["commit", "-q", "-m", "main"]);
    git(root, ["checkout", "-q", "-b", "develop"]);
    writeTracked(
      root,
      "src/history.ts",
      'export function old(): void { throw new Error("hist"); }\nexport function later(): void { throw new Error("dev"); }\n',
    );
    writeProject(root, { deliveryBranch: "develop" });
    git(root, ["add", "--", "xbrief/PROJECT-DEFINITION.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "develop"]);
    git(bare, ["init", "-q", "--bare", "-b", "main"]);
    git(root, ["remote", "add", "origin", bare]);
    git(root, ["push", "-q", "origin", "main"]);
    git(root, ["push", "-q", "origin", "develop"]);
    git(root, ["remote", "set-head", "origin", "main"]);
    git(root, ["checkout", "-q", "-b", "feat"]);
    return withTypescript(root);
  }

  it("uses typed dest origin/develop, not origin/HEAD main", () => {
    delete process.env.GITHUB_BASE_REF;
    delete process.env.DEFT_BASE_REF;
    const root = makeMainDevelopConsumer();
    const resolved = resolveIntentConstraintOrigin(root);
    expect(resolved).toEqual({ origin: "origin/develop", mode: "dest" });
  });

  it("keeps standalone --origin-ref as an explicit diagnostic", () => {
    delete process.env.GITHUB_BASE_REF;
    delete process.env.DEFT_BASE_REF;
    const root = makeMainDevelopConsumer();
    const resolved = resolveIntentConstraintOrigin(root, "origin/main");
    expect(resolved).toEqual({ origin: "origin/main", mode: "explicit" });
  });

  it("uses GITHUB_BASE_REF as the PR-target channel over typed dest", () => {
    const root = makeMainDevelopConsumer();
    process.env.GITHUB_BASE_REF = "main";
    const resolved = resolveIntentConstraintOrigin(root);
    expect(resolved).toEqual({ origin: "origin/main", mode: "pr-target" });
  });

  it("falls back to forge default when dest is not typed", () => {
    delete process.env.GITHUB_BASE_REF;
    delete process.env.DEFT_BASE_REF;
    const root = makeMainDevelopConsumer();
    writeProject(root, { wipCap: 5 });
    git(root, ["add", "--", "xbrief/PROJECT-DEFINITION.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "untyped dest"]);
    const resolved = resolveIntentConstraintOrigin(root);
    expect(resolved).toEqual({ origin: "origin/main", mode: "forge-default" });
  });

  it("includes unstaged production when HEAD equals dest and reports working-tree", () => {
    delete process.env.GITHUB_BASE_REF;
    delete process.env.DEFT_BASE_REF;
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    delete process.env.DEFT_ACTIVE_SCOPE;
    const root = makeMainDevelopConsumer();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "naming.ts"),
      'export const NAME_MAX = 200;\nexport function check(name: unknown): void { if (typeof name !== "string") throw new Error("n"); }\n',
      "utf8",
    );
    try {
      const result = evaluateIntentConstraint({ projectRoot: root });
      expect(result.origin).toBe("origin/develop");
      expect(result.originMode).toBe("dest");
      expect(result.candidateMode).toBe(CANDIDATE_WORKING_TREE);
      expect(result.skipped).not.toBe(true);
      expect(result.code).toBe(1);
      expect(result.message).toMatch(/src\/naming\.ts/);
      expect(result.message).not.toMatch(/src\/history\.ts/);
      expect(result.message).toContain("origin=origin/develop");
      expect(result.message).toContain("origin-mode=dest");
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
    }
  });

  it("N/A when HEAD equals dest names committed-only and does not assess unstaged absence as a pass", () => {
    delete process.env.GITHUB_BASE_REF;
    delete process.env.DEFT_BASE_REF;
    const root = makeMainDevelopConsumer();
    const result = evaluateIntentConstraint({ projectRoot: root });
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.origin).toBe("origin/develop");
    expect(result.originMode).toBe("dest");
    expect(result.candidateMode).toBe(CANDIDATE_COMMITTED_ONLY);
    expect(result.message).toMatch(/unstaged not assessed/);
    expect(result.message).toContain("origin=origin/develop");
  });

  it("keeps mint authority at merge-base when assessing working-tree bytes", () => {
    delete process.env.GITHUB_BASE_REF;
    delete process.env.DEFT_BASE_REF;
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    delete process.env.DEFT_ACTIVE_SCOPE;
    const root = makeMainDevelopConsumer();
    mkdirSync(join(root, ".deft", "intent-constraint"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "intent-constraint", "story-1.json"),
      `${JSON.stringify(record(), null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(root, "src", "naming.ts"), "export const NAME_MAX = 1024;\n", "utf8");
    try {
      const result = evaluateIntentConstraint({ projectRoot: root });
      expect(result.code).toBe(1);
      expect(result.candidateMode).toBe(CANDIDATE_WORKING_TREE);
      expect(result.message).toMatch(/src\/naming\.ts/);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
    }
  });

  it("reports origin and candidate mode on injected N/A", () => {
    const result = evaluateIntentConstraint({
      projectRoot: process.cwd(),
      mergeBase: "base",
      changedFiles: ["tests/ingest.test.ts", "README.md"],
    });
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.message).toContain("origin=N/A");
    expect(result.message).toContain("origin-mode=N/A");
    expect(result.message).toContain("candidates=injected");
  });

  it("adopts plan-id from sole PR deft-story under multi-running (#5782)", () => {
    const root = withTypescript(mkdtempSync(join(tmpdir(), "intent-pr-adopt-")));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "a.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "story-1",
          status: "running",
          narratives: {
            Origin: "Ingested from https://github.com/deftai/directive/issues/5782",
          },
        },
      }),
    );
    writeFileSync(
      join(root, "xbrief", "active", "b.xbrief.json"),
      JSON.stringify({ plan: { id: "story-2", status: "running" } }),
    );
    const other = buildIntentConstraintRecord({
      planId: "story-2",
      xbriefRelPath: "xbrief/active/b.xbrief.json",
      constraints: [{ value: "1", unit: "bytes", rejectionScope: "item" }],
      humanApproval: human,
    });
    if ("error" in other) throw new Error(other.error);
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    delete process.env.DEFT_ACTIVE_SCOPE;
    try {
      const result = evaluateIntentConstraint({
        ...files(POSTED),
        projectRoot: root,
        planId: undefined,
        pr: "99",
        repo: "deftai/directive",
        runGh: () => ({
          returncode: 0,
          stdout: JSON.stringify({ body: "Tracking #5782\n\ndeft-story: 5782\n" }),
          stderr: "",
        }),
        recordTextsAtBase: new Map([
          [".deft/intent-constraint/story-2.json", `${JSON.stringify(other, null, 2)}\n`],
          [".deft/intent-constraint/story-1.json", `${JSON.stringify(record(), null, 2)}\n`],
        ]),
      });
      expect(result.code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
    }
  });

  it("keeps no-PR multi refuse when GITHUB_PR_NUMBER empty (#5782)", () => {
    const root = withTypescript(mkdtempSync(join(tmpdir(), "intent-empty-pr-")));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "a.xbrief.json"),
      JSON.stringify({ plan: { id: "story-1", status: "running" } }),
    );
    writeFileSync(
      join(root, "xbrief", "active", "b.xbrief.json"),
      JSON.stringify({ plan: { id: "story-2", status: "running" } }),
    );
    const prevScope = process.env.DEFT_ACTIVE_SCOPE;
    const prevPr = process.env.GITHUB_PR_NUMBER;
    delete process.env.DEFT_ACTIVE_SCOPE;
    process.env.GITHUB_PR_NUMBER = "";
    try {
      const result = evaluateIntentConstraint({
        ...files(POSTED),
        projectRoot: root,
        planId: undefined,
      });
      expect(result.code).toBe(2);
      expect(result.message).toMatch(/multiple running stories/);
    } finally {
      if (prevScope === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prevScope;
      if (prevPr === undefined) delete process.env.GITHUB_PR_NUMBER;
      else process.env.GITHUB_PR_NUMBER = prevPr;
    }
  });

  it("lets --plan-id override PR deft-story adoption (#5782)", () => {
    const root = withTypescript(mkdtempSync(join(tmpdir(), "intent-override-")));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "a.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "story-2",
          status: "running",
          narratives: {
            Origin: "Ingested from https://github.com/deftai/directive/issues/5782",
          },
        },
      }),
    );
    writeFileSync(
      join(root, "xbrief", "active", "b.xbrief.json"),
      JSON.stringify({ plan: { id: "story-1", status: "running" } }),
    );
    const result = evaluateIntentConstraint({
      ...files(POSTED),
      projectRoot: root,
      planId: "story-1",
      pr: "99",
      repo: "deftai/directive",
      runGh: () => ({
        returncode: 0,
        stdout: JSON.stringify({ body: "deft-story: 5782\n" }),
        stderr: "",
      }),
    });
    expect(result.code).toBe(0);
  });
});

const SIGNED_REPO = "deftai/directive";
const SIGNED_RP = { id: "approve.example.com", origins: ["https://approve.example.com"] };
const signedKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const signedApprover = {
  name: "yubikey",
  credentialId: "Y3JlZC0x",
  publicKey: base64urlEncode(spkiOf(signedKey.publicKey)),
  alg: -7 as const,
  aaguid: "cb69481e-8ff7-4039-93ec-0a2729a154a8",
  backupEligible: false,
};
const signedLevel: SignedLevel = {
  level: "signed",
  ok: true,
  repo: SIGNED_REPO,
  trust: {
    body: { repo: SIGNED_REPO, rp: SIGNED_RP, approvers: [signedApprover] },
    rootKind: "packed",
    epochStart: "0123456789abcdef",
    attested: [signedApprover.credentialId],
  },
};

function approveIntent(
  rec: ReturnType<typeof record>,
  privateKey: KeyObject = signedKey.privateKey,
) {
  if (!("contractDigest" in rec)) throw new Error("record failed");
  const entry: RecordApprovalEntry = {
    kind: "intent-constraint",
    planId: rec.planId,
    xbriefRelPath: rec.xbriefRelPath,
    recordRel: `.deft/intent-constraint/${rec.planId}.json`,
    changeKind: null,
    contractDigest: rec.contractDigest,
  };
  const payload = buildRecordApprovalPayload(SIGNED_REPO, [entry]);
  const auth = Buffer.concat([
    createHash("sha256").update(Buffer.from(SIGNED_RP.id)).digest(),
    Buffer.from([FLAG_UP | FLAG_UV, 0, 0, 0, 1]),
  ]);
  const client = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: base64urlEncode(createHash("sha256").update(canonicalBytes(payload)).digest()),
      origin: SIGNED_RP.origins[0],
    }),
  );
  return {
    payload,
    credentialId: signedApprover.credentialId,
    authenticatorData: base64urlEncode(auth),
    clientDataJSON: base64urlEncode(client),
    signature: base64urlEncode(
      sign("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), {
        key: privateKey,
        dsaEncoding: "der",
      }),
    ),
  };
}

describe("evaluateIntentConstraint signed level (#6945)", () => {
  it("passes a signed record and refuses one with no approval", () => {
    const rec = record();
    if (!("planId" in rec)) throw new Error("record failed");
    const unsigned = evaluateIntentConstraint({ ...files(POSTED), approvalLevel: signedLevel });
    expect(unsigned.code).toBe(1);
    expect(unsigned.message).toMatch(/not approved at the signed level/);
    expect(unsigned.message).toMatch(/user-verified gesture/);
    const signed = evaluateIntentConstraint({
      ...files(POSTED),
      approvalLevel: signedLevel,
      recordTextsAtBase: new Map([
        [
          ".deft/intent-constraint/story-1.json",
          `${JSON.stringify({ ...rec, approval: approveIntent(rec) }, null, 2)}\n`,
        ],
      ]),
    });
    expect(signed.code).toBe(0);
    expect(signed.message).toMatch(/approved by yubikey/);
  });

  it("does not let a stale plan A record fail a valid plan B", () => {
    const a = record();
    const bRec = buildIntentConstraintRecord({
      planId: "story-b",
      xbriefRelPath: "xbrief/active/b.xbrief.json",
      constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
      humanApproval: human,
    });
    if (!("planId" in a) || "error" in bRec) throw new Error("records failed");
    const result = evaluateIntentConstraint({
      ...files(POSTED),
      planId: "story-b",
      approvalLevel: signedLevel,
      recordTextsAtBase: new Map([
        [".deft/intent-constraint/story-1.json", `${JSON.stringify(a)}\n`],
        [
          ".deft/intent-constraint/story-b.json",
          `${JSON.stringify({ ...bRec, approval: approveIntent(bRec) }, null, 2)}\n`,
        ],
      ]),
    });
    expect(result.code).toBe(0);
  });
});
