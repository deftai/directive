import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunGhFn } from "../docs/docs-impact.js";
import {
  BAD_PIN_PR_SUPPRESS_MESSAGE,
  evaluateBadPinPrSuppress,
  findUnparseableDeftStoryMarks,
  resolveDigitPrContext,
  resolveRepoSlug,
  tryAdoptPlanIdFromPrStory,
} from "./plan-id-adopter.js";

function ownedRunningBrief(issue: number, planId: string): string {
  return JSON.stringify({
    plan: {
      id: planId,
      status: "running",
      narratives: {
        Origin: `Ingested from https://github.com/deftai/directive/issues/${issue}`,
      },
    },
  });
}

function ghBody(body: string): RunGhFn {
  return () => ({
    returncode: 0,
    stdout: JSON.stringify({ body, base: { ref: "master" } }),
    stderr: "",
  });
}

function ghNull(): RunGhFn {
  return () => ({ returncode: 1, stdout: "", stderr: "not found" });
}

describe("resolveDigitPrContext (#5782)", () => {
  it("treats empty env as no-PR-context", () => {
    expect(resolveDigitPrContext(undefined, {})).toEqual({ kind: "none" });
    expect(resolveDigitPrContext(undefined, { GITHUB_PR_NUMBER: "" })).toEqual({ kind: "none" });
    expect(resolveDigitPrContext(undefined, { GITHUB_PR_NUMBER: "  " })).toEqual({ kind: "none" });
  });

  it("treats non-digit env as no-PR-context", () => {
    expect(resolveDigitPrContext(undefined, { GITHUB_PR_NUMBER: "abc" })).toEqual({
      kind: "none",
    });
  });

  it("accepts digit env and --pr", () => {
    expect(resolveDigitPrContext(undefined, { GITHUB_PR_NUMBER: "5782" })).toEqual({
      kind: "pr",
      pr: 5782,
    });
    expect(resolveDigitPrContext("99", { GITHUB_PR_NUMBER: "5782" })).toEqual({
      kind: "pr",
      pr: 99,
    });
  });

  it("malforms only explicit non-digit --pr", () => {
    expect(resolveDigitPrContext("not-a-pr", {})).toEqual({
      kind: "malformed-pr",
      raw: "not-a-pr",
    });
  });
});

describe("findUnparseableDeftStoryMarks (#5782)", () => {
  it("flags plan-id shaped and empty values", () => {
    expect(findUnparseableDeftStoryMarks("deft-story: github.issue.5782\n")).toEqual([
      "github.issue.5782",
    ]);
    expect(findUnparseableDeftStoryMarks("deft-story:\n")).toEqual(["(empty)"]);
  });

  it("ignores positive decimal marks", () => {
    expect(findUnparseableDeftStoryMarks("deft-story: 5782\n")).toEqual([]);
  });
});

describe("evaluateBadPinPrSuppress (#5782)", () => {
  it("suppresses only when bad-pin and PR context", () => {
    expect(evaluateBadPinPrSuppress({ badPin: true, hasPrContext: true })?.message).toBe(
      BAD_PIN_PR_SUPPRESS_MESSAGE,
    );
    expect(evaluateBadPinPrSuppress({ badPin: true, hasPrContext: false })).toBeNull();
    expect(evaluateBadPinPrSuppress({ badPin: false, hasPrContext: true })).toBeNull();
  });
});

describe("tryAdoptPlanIdFromPrStory (#5782)", () => {
  it("returns no-pr-context on empty env", () => {
    const result = tryAdoptPlanIdFromPrStory({
      projectRoot: process.cwd(),
      env: {},
      runGh: ghBody("deft-story: 1\n"),
    });
    expect(result).toEqual({ kind: "no-pr-context" });
  });

  it("config-fails on REST null", () => {
    const result = tryAdoptPlanIdFromPrStory({
      projectRoot: process.cwd(),
      pr: "12",
      repo: "deftai/directive",
      env: {},
      runGh: ghNull(),
    });
    expect(result.kind).toBe("config");
    if (result.kind === "config") expect(result.message).toMatch(/REST null/);
  });

  it("config-fails missing slug under PR context", () => {
    const result = tryAdoptPlanIdFromPrStory({
      projectRoot: process.cwd(),
      pr: "12",
      env: {},
      runGh: ghBody("deft-story: 1\n"),
    });
    expect(result.kind).toBe("config");
    if (result.kind === "config") expect(result.message).toMatch(/GITHUB_REPOSITORY|--repo/);
  });

  it("refuses multiple distinct marks; duplicate identical lines are sole", () => {
    const multi = tryAdoptPlanIdFromPrStory({
      projectRoot: process.cwd(),
      pr: "12",
      repo: "deftai/directive",
      env: {},
      runGh: ghBody("deft-story: 10\ndeft-story: 20\n"),
    });
    expect(multi.kind).toBe("config");
    if (multi.kind === "config") expect(multi.message).toMatch(/multiple distinct/);

    const root = mkdtempSync(join(tmpdir(), "adopter-dup-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "a.xbrief.json"),
      ownedRunningBrief(10, "story-10"),
    );
    const dup = tryAdoptPlanIdFromPrStory({
      projectRoot: root,
      pr: "12",
      repo: "deftai/directive",
      env: {},
      runGh: ghBody("deft-story: 10\ndeft-story: 10\n"),
    });
    expect(dup).toEqual({ kind: "id", id: "story-10" });
  });

  it("refuses unparseable deft-story mark values", () => {
    const result = tryAdoptPlanIdFromPrStory({
      projectRoot: process.cwd(),
      pr: "12",
      repo: "deftai/directive",
      env: {},
      runGh: ghBody("deft-story: github.issue.5782\n"),
    });
    expect(result.kind).toBe("config");
    if (result.kind === "config") {
      expect(result.message).toMatch(/unparseable/);
      expect(result.message).toMatch(/plan-id shaped/);
    }
  });

  it("adopts unique running nonempty plan.id for sole mark", () => {
    const root = mkdtempSync(join(tmpdir(), "adopter-sole-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "a.xbrief.json"),
      ownedRunningBrief(5782, "github.issue.5931637634"),
    );
    writeFileSync(
      join(root, "xbrief", "active", "b.xbrief.json"),
      JSON.stringify({ plan: { id: "other", status: "running" } }),
    );
    const result = tryAdoptPlanIdFromPrStory({
      projectRoot: root,
      pr: "99",
      repo: "deftai/directive",
      env: {},
      runGh: ghBody("Tracking #5782\n\ndeft-story: 5782\n"),
    });
    expect(result).toEqual({ kind: "id", id: "github.issue.5931637634" });
  });

  it("suppresses adoption on bad-pin + PR", () => {
    const result = tryAdoptPlanIdFromPrStory({
      projectRoot: process.cwd(),
      pr: "12",
      repo: "deftai/directive",
      env: {},
      runGh: ghBody("deft-story: 1\n"),
      suppressOnBadPin: true,
      badPin: true,
    });
    expect(result).toEqual({
      kind: "bad-pin-suppressed",
      message: BAD_PIN_PR_SUPPRESS_MESSAGE,
    });
  });

  it("resolveRepoSlug prefers --repo over env", () => {
    expect(resolveRepoSlug("a/b", { GITHUB_REPOSITORY: "c/d" })).toBe("a/b");
    expect(resolveRepoSlug(undefined, { GITHUB_REPOSITORY: "c/d" })).toBe("c/d");
    expect(resolveRepoSlug(undefined, {})).toBeNull();
  });
});
