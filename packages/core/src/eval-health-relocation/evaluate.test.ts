import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthReport } from "../eval/health.js";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import {
  classifyRuleRelocationPaths,
  detectHealthRegression,
  evaluate,
  isRuleRelocationPath,
  parseHealthBaseline,
  readHealthBaseline,
  writeHealthBaseline,
} from "./evaluate.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-eval-health-relocation-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", ".eval", "results"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [] },
    }),
    "utf8",
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
    "utf8",
  );
  return root;
}

const baselineReport: HealthReport = {
  schemaVersion: 1,
  version: "0.0.0-test",
  recordedAt: "2026-07-12T00:00:00Z",
  score: 85,
  gates: [
    { id: "encoding", title: "verify:encoding", pass: true, exitCode: 0 },
    { id: "links", title: "verify:links", pass: true, exitCode: 0 },
    {
      id: "agents-md-freshness",
      title: "AGENTS.md managed-section freshness",
      pass: true,
      exitCode: 0,
    },
  ],
  contradictions: [
    {
      id: "wipCap-unsatisfiable-nudge",
      kind: "unsatisfiable-nudge",
      summary: "fixture",
      signals: [],
    },
  ],
};

describe("isRuleRelocationPath", () => {
  it("matches AGENTS.md and skill/pack homes", () => {
    expect(isRuleRelocationPath("AGENTS.md")).toBe(true);
    expect(isRuleRelocationPath("content/templates/agents-entry.md")).toBe(true);
    expect(isRuleRelocationPath("content/skills/deft-directive-sync/SKILL.md")).toBe(true);
    expect(isRuleRelocationPath("content/packs/rules/rules-pack-0.1.json")).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(isRuleRelocationPath("packages/core/src/eval/health.ts")).toBe(false);
    expect(isRuleRelocationPath("README.md")).toBe(false);
  });
});

describe("classifyRuleRelocationPaths", () => {
  it("returns matched relocation paths", () => {
    const result = classifyRuleRelocationPaths([
      "README.md",
      "AGENTS.md",
      "content/packs/foo.json",
    ]);
    expect(result.isRelocation).toBe(true);
    expect(result.matchedPaths).toEqual(["AGENTS.md", "content/packs/foo.json"]);
  });
});

describe("detectHealthRegression", () => {
  it("passes when score and gate states are unchanged", () => {
    const current: HealthReport = { ...baselineReport };
    expect(detectHealthRegression(current, baselineReport).pass).toBe(true);
  });

  it("fails on score drop", () => {
    const current: HealthReport = { ...baselineReport, score: 60 };
    const result = detectHealthRegression(current, baselineReport);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("score dropped"))).toBe(true);
  });

  it("fails when a baseline-pass gate regresses", () => {
    const current: HealthReport = {
      ...baselineReport,
      gates: baselineReport.gates.map((gate) =>
        gate.id === "links" ? { ...gate, pass: false, exitCode: 1 } : gate,
      ),
    };
    const result = detectHealthRegression(current, baselineReport);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("links"))).toBe(true);
  });

  it("fails on new contradictory gates", () => {
    const current: HealthReport = {
      ...baselineReport,
      contradictions: [
        ...baselineReport.contradictions,
        { id: "new-contradiction", kind: "unsatisfiable-nudge", summary: "x", signals: [] },
      ],
    };
    const result = detectHealthRegression(current, baselineReport);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("new-contradiction"))).toBe(true);
  });
});

describe("parseHealthBaseline", () => {
  it("rejects objects missing required arrays", () => {
    expect(parseHealthBaseline({ score: 85 })).toBeNull();
    expect(parseHealthBaseline({ score: 85, gates: [] })).toBeNull();
  });

  it("accepts a well-formed baseline snapshot", () => {
    expect(parseHealthBaseline(baselineReport)).toMatchObject({ score: 85 });
  });
});

describe("evaluate", () => {
  it("skips when no relocation paths are present", () => {
    const root = seedRepo();
    const result = evaluate({ projectRoot: root, paths: ["README.md"] });
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it("exits 2 when baseline is missing on a relocation diff", () => {
    const root = seedRepo();
    const result = evaluate({ projectRoot: root, paths: ["AGENTS.md"] });
    expect(result.code).toBe(2);
    expect(result.message).toContain("missing committed baseline");
  });

  it("seeds baseline without requiring relocation paths", () => {
    const root = seedRepo();
    const result = evaluate({ projectRoot: root, seedBaseline: true });
    expect(result.code).toBe(0);
    expect(result.message).toContain("seeded baseline");
    expect(readHealthBaseline(root)).not.toBeNull();
  });

  it("seeds and reads the committed baseline", () => {
    const root = seedRepo();
    writeHealthBaseline(root, baselineReport);
    expect(readHealthBaseline(root)).toMatchObject({ score: 85 });
    expect(existsSync(join(root, "xbrief", ".eval", "results", "eval-health-baseline.json"))).toBe(
      true,
    );
    const text = readFileSync(
      join(root, "xbrief", ".eval", "results", "eval-health-baseline.json"),
      "utf8",
    );
    expect(JSON.parse(text)).toMatchObject({ score: 85 });
  });

  it("fails closed when health regresses against the baseline", () => {
    const root = seedRepo();
    writeHealthBaseline(root, {
      ...baselineReport,
      score: 100,
    });

    const result = evaluate({
      projectRoot: root,
      paths: ["content/templates/agents-entry.md"],
      healthEvaluator: () => ({
        ...baselineReport,
        score: 60,
        gates: baselineReport.gates.map((gate) =>
          gate.id === "links" ? { ...gate, pass: false, exitCode: 1 } : gate,
        ),
      }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("regression");
  });
});

const itSymlink = it.skipIf(process.platform === "win32");

describe("eval-health baseline symlink containment (#2807)", () => {
  itSymlink("writeHealthBaseline refuses a symlink at the baseline leaf path", () => {
    const root = seedRepo();
    const escapeDir = mkdtempSync(join(tmpdir(), "deft-eval-health-victim-"));
    const victim = join(escapeDir, "eval-health-baseline.json");
    writeFileSync(victim, "victim\n", "utf8");
    const baselinePath = join(root, "xbrief", ".eval", "results", "eval-health-baseline.json");
    symlinkSync(victim, baselinePath);
    expect(() => writeHealthBaseline(root, baselineReport)).toThrow(ProjectionContainmentError);
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
    rmSync(escapeDir, { recursive: true, force: true });
  });

  itSymlink("seed-baseline returns exit 2 when baseline path is a symlink", () => {
    const root = seedRepo();
    const escapeDir = mkdtempSync(join(tmpdir(), "deft-eval-health-seed-victim-"));
    const victim = join(escapeDir, "eval-health-baseline.json");
    writeFileSync(victim, "victim\n", "utf8");
    const baselinePath = join(root, "xbrief", ".eval", "results", "eval-health-baseline.json");
    symlinkSync(victim, baselinePath);
    const result = evaluate({
      projectRoot: root,
      seedBaseline: true,
      healthEvaluator: () => baselineReport,
    });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/projection write refused|symlink/);
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
    rmSync(escapeDir, { recursive: true, force: true });
  });
});
