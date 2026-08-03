import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateCleanGate } from "../content-contracts/skills/greptile-detector.js";
import { evaluateGates } from "../pr-merge-readiness/evaluate.js";
import { emptyVerdict } from "../pr-merge-readiness/parse.js";
import { inspectOnePolicy } from "./index.js";
import {
  DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE,
  DOGFOOD_MIN_GREPTILE_CONFIDENCE,
  FIELD_MIN_GREPTILE_CONFIDENCE,
  FIELD_MIN_GREPTILE_CONFIDENCE_CLI_ALIAS,
  formatMinConfidenceRequirement,
  meetsMinGreptileConfidence,
  resolveMinGreptileConfidence,
  validateMinGreptileConfidence,
} from "./min-greptile-confidence.js";

const HEAD = "abc1234deadbeef0000000000000000000000000";

function makeProject(
  policy?: Record<string, unknown>,
  opts: { frameworkMarkers?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "min-greptile-conf-"));
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "P",
        status: "running",
        policy: policy ?? {},
      },
    }),
    "utf8",
  );
  if (opts.frameworkMarkers === true) {
    mkdirSync(join(root, "packages", "cli"), { recursive: true });
    writeFileSync(
      join(root, "packages", "cli", "package.json"),
      '{"name":"@deftai/cli"}\n',
      "utf8",
    );
    writeFileSync(join(root, "biome.json"), "{}\n", "utf8");
    writeFileSync(join(root, "Taskfile.yml"), "version: '3'\n", "utf8");
  }
  return root;
}

describe("resolveMinGreptileConfidence (#3095)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("consumer default is 4 when no policy and not dogfood", () => {
    root = makeProject({ wipCap: 5 });
    const resolved = resolveMinGreptileConfidence(root);
    expect(resolved.min).toBe(DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE);
    expect(resolved.source).toBe("default");
  });

  it("dogfood detection raises floor to 5 without typed policy", () => {
    root = makeProject({}, { frameworkMarkers: true });
    const resolved = resolveMinGreptileConfidence(root);
    expect(resolved.min).toBe(DOGFOOD_MIN_GREPTILE_CONFIDENCE);
    expect(resolved.source).toBe("dogfood");
  });

  it("typed policy wins over dogfood", () => {
    root = makeProject({ review: { minGreptileConfidence: 4 } }, { frameworkMarkers: true });
    const resolved = resolveMinGreptileConfidence(root);
    expect(resolved.min).toBe(4);
    expect(resolved.source).toBe("typed");
  });

  it("typed policy=5 requires 5 on a consumer project", () => {
    root = makeProject({ review: { minGreptileConfidence: 5 } });
    const resolved = resolveMinGreptileConfidence(root);
    expect(resolved.min).toBe(5);
    expect(resolved.source).toBe("typed");
  });

  it("invalid typed value falls through to dogfood/default with error", () => {
    root = makeProject({ review: { minGreptileConfidence: 99 } });
    const resolved = resolveMinGreptileConfidence(root);
    expect(resolved.min).toBe(DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE);
    expect(resolved.source).toBe("default-on-error");
    expect(resolved.error).toMatch(/between 1 and 5/);
  });

  it("no projectRoot returns consumer default", () => {
    const resolved = resolveMinGreptileConfidence();
    expect(resolved.min).toBe(4);
    expect(resolved.source).toBe("default");
  });

  it("meetsMinGreptileConfidence enforces >= min", () => {
    expect(meetsMinGreptileConfidence(4, 4)).toBe(true);
    expect(meetsMinGreptileConfidence(3, 4)).toBe(false);
    expect(meetsMinGreptileConfidence(4, 5)).toBe(false);
    expect(meetsMinGreptileConfidence(5, 5)).toBe(true);
    expect(meetsMinGreptileConfidence(null, 4)).toBe(false);
  });

  it("validateMinGreptileConfidence rejects non-integers", () => {
    expect(validateMinGreptileConfidence("4")).toMatch(/must be an integer/);
    expect(validateMinGreptileConfidence(3.5)).toMatch(/must be an integer/);
    expect(validateMinGreptileConfidence(0)).toMatch(/between/);
    expect(validateMinGreptileConfidence(5)).toBeNull();
  });

  it("formatMinConfidenceRequirement keeps legacy phrasing for min=4", () => {
    expect(formatMinConfidenceRequirement(4)).toContain("> 3");
    expect(formatMinConfidenceRequirement(5)).toContain(">= 5");
  });

  it("policy:show registers CLI alias and canonical path", () => {
    root = makeProject({ review: { minGreptileConfidence: 5 } });
    const byAlias = inspectOnePolicy(FIELD_MIN_GREPTILE_CONFIDENCE_CLI_ALIAS, root);
    const byPath = inspectOnePolicy(FIELD_MIN_GREPTILE_CONFIDENCE, root);
    expect(byAlias?.name).toBe(FIELD_MIN_GREPTILE_CONFIDENCE);
    expect(byAlias?.current).toBe(5);
    expect(byAlias?.source).toBe("typed");
    expect(byPath?.current).toBe(5);
  });
});

describe("gates honor minConfidence (#3095)", () => {
  it("evaluateCleanGate: consumer default accepts conf=4, rejects conf=3", () => {
    expect(
      evaluateCleanGate({
        lastReviewedSha: HEAD,
        headSha: HEAD,
        hasBlocking: false,
        confidence: 4,
        ciFailures: 0,
        errored: false,
      }),
    ).toEqual([true, null]);
    expect(
      evaluateCleanGate({
        lastReviewedSha: HEAD,
        headSha: HEAD,
        hasBlocking: false,
        confidence: 3,
        ciFailures: 0,
        errored: false,
      }),
    ).toEqual([false, "confidence"]);
  });

  it("evaluateCleanGate: dogfood min=5 rejects conf=4, accepts conf=5", () => {
    expect(
      evaluateCleanGate({
        lastReviewedSha: HEAD,
        headSha: HEAD,
        hasBlocking: false,
        confidence: 4,
        ciFailures: 0,
        errored: false,
        minConfidence: 5,
      }),
    ).toEqual([false, "confidence"]);
    expect(
      evaluateCleanGate({
        lastReviewedSha: HEAD,
        headSha: HEAD,
        hasBlocking: false,
        confidence: 5,
        ciFailures: 0,
        errored: false,
        minConfidence: 5,
      }),
    ).toEqual([true, null]);
  });

  it("evaluateGates: consumer default still CLEAN at conf=4", () => {
    const verdict = {
      ...emptyVerdict(),
      found: true,
      lastReviewedSha: HEAD,
      confidence: 4,
    };
    expect(evaluateGates(1, HEAD, verdict)).toEqual([]);
  });

  it("evaluateGates: minConfidence=5 blocks conf=4", () => {
    const verdict = {
      ...emptyVerdict(),
      found: true,
      lastReviewedSha: HEAD,
      confidence: 4,
    };
    const failures = evaluateGates(1, HEAD, verdict, null, { minConfidence: 5 });
    expect(failures.some((f) => f.includes("confidence is 4/5"))).toBe(true);
    expect(failures.some((f) => f.includes("minGreptileConfidence") || f.includes(">= 5"))).toBe(
      true,
    );
  });
});
