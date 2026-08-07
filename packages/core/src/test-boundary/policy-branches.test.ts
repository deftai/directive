/**
 * Branch coverage for test-boundary policy load/parse (#3185 coverage-debt hairline).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultTestBoundaryPolicy,
  FRAMEWORK_SELF_ALLOW,
  loadTestBoundaryPolicy,
} from "./policy.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tb-policy-br-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("loadTestBoundaryPolicy branches (#3185)", () => {
  it("throws when explicit policyPath is missing", () => {
    const root = tempRoot();
    expect(() =>
      loadTestBoundaryPolicy(root, { policyPath: join(root, "missing-policy.json") }),
    ).toThrow(/policy file not found/i);
  });

  it("throws when explicit policyPath is not a JSON object", () => {
    const root = tempRoot();
    const path = join(root, "bad.json");
    writeFileSync(path, JSON.stringify(["not", "object"]), "utf8");
    expect(() => loadTestBoundaryPolicy(root, { policyPath: path })).toThrow(
      /must be a JSON object/i,
    );
  });

  it("parses explicit policy file with partial fields and allow shapes", () => {
    const root = tempRoot();
    const path = join(root, "policy.json");
    writeFileSync(
      path,
      JSON.stringify({
        sourceRoots: ["app/**", "  ", 42, "lib/**"],
        testRoots: [],
        fixtureRoots: ["fixtures/**"],
        testFilePatterns: ["**/*_spec.rb"],
        productionMayReferenceTestRoots: true,
        enforcementMode: "warn",
        allow: [
          "string-allow/**",
          "  ",
          99,
          null,
          { path: "  live/health.ts  ", kind: "production-liveness", reason: "probe" },
          { path: "bad-kind/**", kind: "nope" },
          { path: "", kind: "exception" },
          { noPath: true },
          { path: "plain/**" },
        ],
      }),
      "utf8",
    );
    const p = loadTestBoundaryPolicy(root, { policyPath: path });
    expect(p.source).toBe("file");
    expect(p.sourceRoots).toEqual(["app/**", "lib/**"]);
    expect(p.testRoots.length).toBeGreaterThan(0); // defaults when empty
    expect(p.fixtureRoots).toEqual(["fixtures/**"]);
    expect(p.testFilePatterns).toEqual(["**/*_spec.rb"]);
    expect(p.productionMayReferenceTestRoots).toBe(true);
    expect(p.enforcementMode).toBe("warn");
    expect(p.allow).toEqual(
      expect.arrayContaining([
        { path: "string-allow/**", kind: "exception" },
        { path: "live/health.ts", kind: "production-liveness", reason: "probe" },
        { path: "bad-kind/**", kind: "exception" },
        { path: "plain/**", kind: "exception" },
      ]),
    );
    expect(p.allow.every((a) => a.path.length > 0)).toBe(true);
  });

  it("loads .deft/test-boundary.policy.json with enforce default", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "test-boundary.policy.json"),
      JSON.stringify({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        enforcementMode: "enforce",
      }),
      "utf8",
    );
    const p = loadTestBoundaryPolicy(root);
    expect(p.source).toBe("file");
    expect(p.enforcementMode).toBe("enforce");
    expect(p.sourceRoots).toEqual(["src/**"]);
  });

  it("throws when .deft policy is not an object", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "test-boundary.policy.json"), "null", "utf8");
    expect(() => loadTestBoundaryPolicy(root)).toThrow(/must be a JSON object/i);
  });

  it("reads plan.policy.testBoundary from PROJECT-DEFINITION", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: {
          policy: {
            testBoundary: {
              sourceRoots: ["packages/**"],
              testRoots: ["**/*.test.ts"],
              productionMayReferenceTestRoots: false,
              enforcementMode: "enforce",
              allow: [{ path: "packages/**/*.test.ts", kind: "exception" }],
            },
          },
        },
      }),
      "utf8",
    );
    const p = loadTestBoundaryPolicy(root);
    expect(p.source).toBe("project-definition");
    expect(p.sourceRoots).toEqual(["packages/**"]);
    expect(p.enforcementMode).toBe("enforce");
  });

  it("falls through to defaults when PROJECT-DEFINITION is unreadable JSON", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{not-json", "utf8");
    const p = loadTestBoundaryPolicy(root);
    expect(p.source).toBe("defaults");
    expect(p.enforcementMode).toBe("warn");
  });

  it("falls through when PROJECT-DEFINITION has no testBoundary object", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { testBoundary: null } } }),
      "utf8",
    );
    expect(loadTestBoundaryPolicy(root).source).toBe("defaults");
  });

  it("ignores invalid enforcementMode and non-boolean production flag", () => {
    const root = tempRoot();
    const path = join(root, "p.json");
    writeFileSync(
      path,
      JSON.stringify({
        enforcementMode: "maybe",
        productionMayReferenceTestRoots: "yes",
        allow: "not-array",
        sourceRoots: "not-array",
      }),
      "utf8",
    );
    const p = loadTestBoundaryPolicy(root, { policyPath: path });
    expect(p.enforcementMode).toBe("enforce"); // file defaultMode
    expect(p.productionMayReferenceTestRoots).toBe(false);
    expect(p.allow).toEqual([]);
    expect(p.sourceRoots.length).toBeGreaterThan(0);
  });

  it("defaultTestBoundaryPolicy copies framework self-allow", () => {
    const p = defaultTestBoundaryPolicy("enforce");
    expect(p.enforcementMode).toBe("enforce");
    expect(p.allow.length).toBe(FRAMEWORK_SELF_ALLOW.length);
    expect(p.allow[0]?.path).toContain("packages");
  });
});
