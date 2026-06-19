import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCapacityAllocation, validateCapacityAllocation } from "./capacity-policy.js";
import { computeReport, renderReport } from "./capacity-show.js";
import { isDatePrefixedVbriefFilename } from "./filename.js";
import { extractLinkTargets, shouldSkipLinkTarget } from "./link-parser.js";
import { evaluate as evaluateLinks } from "./validate-links.js";
import {
  evaluate as evaluateStrategy,
  validateStrategyOutput,
} from "./validate-strategy-output.js";
import { evaluate as evaluateCapacity } from "./verify-capacity.js";

const NOW = new Date("2026-06-04T12:00:00Z");
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-vc-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("link-parser", () => {
  it("extracts targets linearly", () => {
    expect(extractLinkTargets("See [a](b.md) and [c](d.md)")).toEqual(["b.md", "d.md"]);
  });

  it("skips template and example targets", () => {
    expect(shouldSkipLinkTarget("{var}")).toBe(true);
    expect(shouldSkipLinkTarget("./relative-x")).toBe(true);
    expect(shouldSkipLinkTarget("path")).toBe(true);
    expect(shouldSkipLinkTarget("ok.md")).toBe(false);
  });
});

describe("filename convention", () => {
  it("accepts date-prefixed names", () => {
    expect(isDatePrefixedVbriefFilename("2026-05-26-foo-bar.vbrief.json")).toBe(true);
    expect(isDatePrefixedVbriefFilename("scaffold.vbrief.json")).toBe(false);
  });
});

describe("validate-links", () => {
  it("passes when links resolve", () => {
    const root = tempRoot();
    writeFileSync(join(root, "README.md"), "See [guide](guide.md)\n");
    writeFileSync(join(root, "guide.md"), "#\n");
    const result = evaluateLinks({ cwd: root });
    expect(result.code).toBe(0);
    expect(result.message).toContain("All internal markdown links valid");
  });

  it("warns on broken links by default", () => {
    const root = tempRoot();
    writeFileSync(join(root, "README.md"), "See [missing](nope.md)\n");
    const result = evaluateLinks({ cwd: root, linkCheckStrict: false });
    expect(result.code).toBe(0);
    expect(result.message).toContain("warnings");
  });

  it("errors in strict mode", () => {
    const root = tempRoot();
    writeFileSync(join(root, "doc.md"), "See [nope](nope.md).\n");
    const result = evaluateLinks({ cwd: root, strict: true });
    expect(result.code).toBe(1);
    expect(result.message).toContain("errors");
  });

  it("skips external and anchor links", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "README.md"),
      "See [Google](https://google.com) and [anchor](#section).\n",
    );
    expect(evaluateLinks({ cwd: root }).code).toBe(0);
  });

  it("excludes archive paths", () => {
    const root = tempRoot();
    const archive = join(root, "history", "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "old.md"), "See [gone](deleted.md).\n");
    expect(evaluateLinks({ cwd: root, strict: true }).code).toBe(0);
  });
});

describe("validate-strategy-output", () => {
  it("passes conformant tree", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{}");
    writeFileSync(join(root, "vbrief", "proposed", "2026-05-26-good.vbrief.json"), "{}");
    expect(validateStrategyOutput(root)).toEqual([]);
    const result = evaluateStrategy({ projectRoot: root });
    expect(result.code).toBe(0);
    expect(result.message).toContain("conforms");
  });

  it("flags missing project definition", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeFileSync(join(root, "vbrief", "proposed", "2026-05-26-good.vbrief.json"), "{}");
    const errors = validateStrategyOutput(root);
    expect(errors.some((e) => e.includes("PROJECT-DEFINITION"))).toBe(true);
  });

  it("flags non-date-prefixed filenames", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{}");
    writeFileSync(join(root, "vbrief", "proposed", "scaffold.vbrief.json"), "{}");
    const errors = validateStrategyOutput(root);
    expect(errors.some((e) => e.includes("scaffold.vbrief.json"))).toBe(true);
  });

  it("forbids legacy spec in user projects", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeFileSync(join(root, "vbrief", "specification.vbrief.json"), "{}");
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{}");
    writeFileSync(join(root, "vbrief", "proposed", "2026-05-26-good.vbrief.json"), "{}");
    expect(validateStrategyOutput(root).some((e) => e.includes("Legacy artifact"))).toBe(true);
  });

  it("tolerates framework root heuristic", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "strategies"));
    writeFileSync(join(root, "AGENTS.md"), "#");
    writeFileSync(join(root, "Taskfile.yml"), "version: '3'");
    writeFileSync(join(root, "vbrief", "specification.vbrief.json"), "{}");
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{}");
    writeFileSync(join(root, "vbrief", "proposed", "2026-05-26-good.vbrief.json"), "{}");
    expect(validateStrategyOutput(root)).toEqual([]);
  });

  it("strict mode flags missing vbrief dir", () => {
    const root = tempRoot();
    const result = evaluateStrategy({ projectRoot: root, strict: true });
    expect(result.code).toBe(1);
    expect(result.message).toContain("vbrief/ directory missing entirely");
  });

  it("quiet mode suppresses success output", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{}");
    writeFileSync(join(root, "vbrief", "proposed", "2026-05-26-good.vbrief.json"), "{}");
    const result = evaluateStrategy({ projectRoot: root, quiet: true });
    expect(result.code).toBe(0);
    expect(result.stream).toBe("none");
  });
});

describe("verify-capacity", () => {
  function writeProject(root: string, capacity: Record<string, unknown> | null): void {
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "vbrief", folder), { recursive: true });
    }
    const plan: Record<string, unknown> = { title: "T", status: "running", items: [] };
    if (capacity) plan.policy = { capacityAllocation: capacity };
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan }),
    );
  }

  it("exits 2 for invalid project root", () => {
    const root = tempRoot();
    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    const result = evaluateCapacity({ projectRoot: file });
    expect(result.code).toBe(2);
    expect(result.message).toContain("not a directory");
  });

  it("advise posture always exits 0", () => {
    const root = tempRoot();
    writeProject(root, {
      unit: "vbrief-count",
      window: 30,
      enforcement: "advise",
      minSampleSize: 2,
      defaultBucket: "feature",
      buckets: [
        { id: "debt", target: 0.4 },
        { id: "feature", target: 0.6 },
      ],
    });
    const completedAt = "2026-06-03T12:00:00Z";
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(
        join(root, "vbrief", "completed", `f-${i}.vbrief.json`),
        JSON.stringify({
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: `f-${i}`,
            status: "completed",
            items: [],
            metadata: { capacityBucket: "feature", completedAt },
          },
        }),
      );
    }
    const result = evaluateCapacity({ projectRoot: root, now: NOW });
    expect(result.code).toBe(0);
    expect(result.message).toContain("advisory posture");
  });

  it("enforce posture exits 1 on deficit", () => {
    const root = tempRoot();
    writeProject(root, {
      unit: "vbrief-count",
      window: 30,
      enforcement: "enforce",
      minSampleSize: 2,
      defaultBucket: "feature",
      buckets: [
        { id: "debt", target: 0.4 },
        { id: "feature", target: 0.6 },
      ],
    });
    const completedAt = "2026-06-03T12:00:00Z";
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(
        join(root, "vbrief", "completed", `f-${i}.vbrief.json`),
        JSON.stringify({
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: `f-${i}`,
            status: "completed",
            items: [],
            metadata: { capacityBucket: "feature", completedAt },
          },
        }),
      );
    }
    const result = evaluateCapacity({ projectRoot: root, now: NOW });
    expect(result.code).toBe(1);
    expect(result.message).toContain("DEFICIT");
  });

  it("unconfigured policy exits 0", () => {
    const root = tempRoot();
    writeProject(root, null);
    expect(evaluateCapacity({ projectRoot: root, now: NOW }).code).toBe(0);
  });
});

describe("capacity-policy validation", () => {
  it("rejects malformed allocation blocks", () => {
    expect(validateCapacityAllocation({ window: "bad" }).length).toBeGreaterThan(0);
    expect(validateCapacityAllocation([]).length).toBeGreaterThan(0);
  });

  it("resolves default when missing", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { status: "running" } }),
    );
    const allocation = resolveCapacityAllocation(root);
    expect(allocation.source).toBe("default");
    expect(allocation.configured).toBe(false);
  });
});

describe("capacity-show rendering", () => {
  it("renders advisory banner when unconfigured", () => {
    const root = tempRoot();
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "vbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { status: "running", items: [] } }),
    );
    const report = computeReport(root, { now: NOW });
    const text = renderReport(report);
    expect(text).toContain("Capacity allocation");
    expect(text).toContain("no buckets configured");
  });
});
