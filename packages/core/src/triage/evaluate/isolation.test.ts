import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RESERVED_CLEARANCE_RE } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

function read(name: string): string {
  return readFileSync(join(here, name), "utf8");
}

const SOURCE_FILES = [
  "evaluate.ts",
  "github.ts",
  "validity.ts",
  "wip-census.ts",
  "value.ts",
  "worktrees.ts",
  "sink.ts",
  "paths.ts",
  "types.ts",
  "index.ts",
] as const;

describe("issue-eval isolation contract", () => {
  it("does not reuse swarm:launch", () => {
    for (const name of SOURCE_FILES) {
      const text = read(name);
      expect(text, name).not.toContain("swarm/launch");
      expect(text, name).not.toMatch(/swarm:launch/);
    }
  });

  it("github module is GET-only", () => {
    const text = read("github.ts");
    expect(text).not.toContain("restPostComment");
    expect(text).not.toContain("restCreateIssue");
    expect(text).not.toContain("restUpdateIssue");
    expect(text).not.toContain("restCloseIssue");
    expect(text).not.toContain("restCreateLabel");
    expect(text).not.toContain('--method", "POST');
    expect(text).not.toContain('--method", "PATCH');
    expect(text).not.toContain('--method", "PUT');
    expect(text).not.toContain('--method", "DELETE');
    expect(text).toContain('"GET"');
    expect(text).toContain("--method");
  });

  it("does not write candidates.jsonl or xbrief/.eval", () => {
    for (const name of SOURCE_FILES) {
      const text = read(name);
      expect(text, name).not.toContain("candidates-log");
      expect(text, name).not.toContain("append(");
      expect(text, name).not.toMatch(/xbrief\/\.eval/);
    }
  });

  it("does not set an assist posture marker", () => {
    for (const name of SOURCE_FILES) {
      const text = read(name);
      expect(text, name).not.toMatch(/assist.?posture/i);
      expect(text, name).not.toContain("isAssistScratchWrite");
      expect(text, name).not.toContain("DEFT_ASSIST");
    }
  });

  it("value module forbids the reserved clearance grammar", () => {
    const text = read("value.ts");
    expect(text).toContain("critique-recommend");
    expect(text).toMatch(RESERVED_CLEARANCE_RE);
    expect(text).toContain("must not emit the reserved clearance line");
  });

  it("worktrees module owns add and remove", () => {
    const text = read("worktrees.ts");
    expect(text).toContain('"add"');
    expect(text).toContain("--detach");
    expect(text).toContain('"remove"');
    expect(text).not.toContain("session:start");
  });

  it("evaluate starts read-only sessions", () => {
    const text = read("evaluate.ts");
    expect(text).toContain("session:start");
    expect(text).toContain("--read-only");
    expect(text).toContain("collectWipCensus");
    expect(text).toContain("evaluateValidity(worktreePath, issue)");
  });
});
