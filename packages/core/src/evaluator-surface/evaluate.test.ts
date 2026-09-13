import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyEvaluatorSurfacePaths,
  DISPOSITION_KIND_DISCLOSURE,
  DISPOSITION_REL,
  DISPOSITION_SCHEMA,
  dispositionCovers,
  EVALUATOR_SURFACE_PATH_PATTERNS,
  evaluate,
  isEvaluatorSurfacePath,
  parseDisposition,
  resolveDefaultBaseRef,
} from "./evaluate.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-evaluator-surface-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  return root;
}

const disclosure = {
  schema: DISPOSITION_SCHEMA,
  kind: DISPOSITION_KIND_DISCLOSURE,
  issue: 4386,
  surfaces: ["Taskfile.yml", "packages/core/src/evaluator-surface/**", DISPOSITION_REL],
  note: "Disclosure only.",
};

describe("declared evaluator surfaces (#4386)", () => {
  it("matches Taskfile, verify.yml, gate-lists, and the detector itself", () => {
    expect(isEvaluatorSurfacePath("Taskfile.yml")).toBe(true);
    expect(isEvaluatorSurfacePath("tasks/verify.yml")).toBe(true);
    expect(isEvaluatorSurfacePath("packages/core/src/check/gate-lists.ts")).toBe(true);
    expect(isEvaluatorSurfacePath("packages/core/src/evaluator-surface/evaluate.ts")).toBe(true);
    expect(isEvaluatorSurfacePath("packages/core/src/consumer-test-lane/evaluate.ts")).toBe(true);
    expect(isEvaluatorSurfacePath("packages/cli/src/verify-consumer-test-lane.ts")).toBe(true);
    expect(isEvaluatorSurfacePath(DISPOSITION_REL)).toBe(true);
    expect(isEvaluatorSurfacePath("packages/core/src/foo.ts")).toBe(false);
    expect(EVALUATOR_SURFACE_PATH_PATTERNS.length).toBeGreaterThan(0);
  });

  it("classifies mixed diffs", () => {
    const classified = classifyEvaluatorSurfacePaths([
      "README.md",
      "Taskfile.yml",
      "packages/core/src/session/foo.ts",
    ]);
    expect(classified.isEvaluatorSurface).toBe(true);
    expect(classified.matchedPaths).toEqual(["Taskfile.yml"]);
  });
});

describe("parseDisposition", () => {
  it("accepts disclosure records", () => {
    const parsed = parseDisposition(disclosure);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.kind).toBe("disclosure");
    expect(parsed.issue).toBe(4386);
  });

  it("refuses authorization kinds so a pasteable URL cannot claim #3164", () => {
    const parsed = parseDisposition({
      ...disclosure,
      kind: "authorization",
    });
    expect("error" in parsed).toBe(true);
    if (!("error" in parsed)) return;
    expect(parsed.error).toMatch(/disclosure/i);
    expect(parsed.error).toMatch(/#3164/);
  });
});

describe("evaluate (#4386)", () => {
  it("skips when no declared surfaces are in the path list", () => {
    const result = evaluate({
      projectRoot: seedRoot(),
      paths: ["README.md"],
    });
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.message).toMatch(/unobserved/);
    expect(result.message).toMatch(/never-red/);
  });

  it("fails when surfaces change and no disposition exists", () => {
    const result = evaluate({
      projectRoot: seedRoot(),
      paths: ["Taskfile.yml"],
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(DISPOSITION_REL);
    expect(result.message).toMatch(/regardless of prior color/);
    expect(result.message).toMatch(/commit-body/);
  });

  it("fails when disposition does not cover the changed surface", () => {
    const result = evaluate({
      projectRoot: seedRoot(),
      paths: ["tasks/verify.yml"],
      dispositionText: JSON.stringify(disclosure),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/does not cover: tasks\/verify.yml/);
  });

  it("passes when a disclosure disposition covers the surface", () => {
    const result = evaluate({
      projectRoot: seedRoot(),
      paths: ["Taskfile.yml", "packages/core/src/evaluator-surface/evaluate.ts"],
      dispositionText: JSON.stringify(disclosure),
    });
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/disclosure recorded/);
    expect(result.message).toMatch(/not reviewed authorization/);
    expect(result.message).toMatch(/#3164/);
  });

  it("fails closed on an authorization-kind record", () => {
    const result = evaluate({
      projectRoot: seedRoot(),
      paths: ["Taskfile.yml"],
      dispositionText: JSON.stringify({ ...disclosure, kind: "reviewed" }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/disclosure/);
  });

  it("reads the committed disposition file when it is renewed in the diff", () => {
    const root = seedRoot();
    writeFileSync(join(root, DISPOSITION_REL), `${JSON.stringify(disclosure)}\n`, "utf8");
    const result = evaluate({
      projectRoot: root,
      paths: ["Taskfile.yml", DISPOSITION_REL],
    });
    expect(result.code).toBe(0);
  });

  it("fails when a leftover disposition is not renewed in the current diff", () => {
    const root = seedRoot();
    writeFileSync(join(root, DISPOSITION_REL), `${JSON.stringify(disclosure)}\n`, "utf8");
    const result = evaluate({
      projectRoot: root,
      paths: ["Taskfile.yml"],
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/renewed in this diff/);
  });

  it("prefers origin/main over origin/master when origin/HEAD is missing", () => {
    const resolved = resolveDefaultBaseRef("/tmp/consumer", (args) => {
      const joined = args.join(" ");
      if (joined.includes("origin/HEAD")) return null;
      if (joined.includes("origin/main^{commit}")) return "abc";
      return null;
    });
    expect(resolved).toBe("origin/main");
  });

  it("covers globbed detector paths", () => {
    expect(
      dispositionCovers(
        {
          schema: DISPOSITION_SCHEMA,
          kind: DISPOSITION_KIND_DISCLOSURE,
          surfaces: ["packages/core/src/evaluator-surface/**"],
        },
        "packages/core/src/evaluator-surface/evaluate.ts",
      ),
    ).toBe(true);
  });
});

describe("gate-integrity.md Bound-remedy contract (#4386)", () => {
  it("withdraws the absolute no-detector claim and inventories #3322", () => {
    const text = readFileSync(join(process.cwd(), "content/docs/gate-integrity.md"), "utf8");
    expect(text).toMatch(/#3322/);
    expect(text).toMatch(/verify:evaluator-surface/);
    expect(text).toMatch(/flagPassAfterFailWithMethodChange/);
    expect(text).not.toMatch(/ships \*\*no mechanism that can detect a violation\*\*/);
    expect(text).toMatch(/disclosure, not reviewed authorization/);
    expect(text).toMatch(/unobserved evaluator-definition/);
    expect(text).toMatch(/Do not invent a universal shipped-library default/);
    expect(text).toMatch(/coverage-population exclusion/);
    expect(text).toMatch(/Falsifiable oracles for derived clauses stay a separate/);
    expect(text).toMatch(/Do not implement a parallel history detector/);
  });
});
