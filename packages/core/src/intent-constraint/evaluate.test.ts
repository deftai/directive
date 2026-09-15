import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateIntentConstraint } from "./evaluate.js";
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
    delete process.env.DEFT_ACTIVE_SCOPE;
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
    delete process.env.DEFT_ACTIVE_SCOPE;
    try {
      const result = evaluateIntentConstraint({
        ...files(POSTED),
        projectRoot: root,
        planId: undefined,
      });
      expect(result.code).toBe(2);
      expect(result.message).toMatch(/multiple running stories/);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
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
