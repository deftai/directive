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
import {
  DEFT_METRICS_HOME_ENV,
  DEFT_METRICS_PROJECT_LOCAL_ENV,
} from "../metrics/resolve-metrics-home.js";
import {
  computeHealthScore,
  detectWipCapUnsatisfiableNudge,
  evaluateHealth,
  type GateProbeResult,
  type HealthReport,
  healthHistoryPath,
  persistHealthRun,
} from "./health.js";

const itSymlink = it.skipIf(process.platform === "win32");

const temps: string[] = [];
const metricsHomes: string[] = [];
afterEach(() => {
  delete process.env[DEFT_METRICS_HOME_ENV];
  delete process.env[DEFT_METRICS_PROJECT_LOCAL_ENV];
  for (const dir of metricsHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-eval-health-"));
  temps.push(root);
  const metricsHome = mkdtempSync(join(tmpdir(), "deft-health-metrics-"));
  metricsHomes.push(metricsHome);
  process.env[DEFT_METRICS_HOME_ENV] = metricsHome;
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.6" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        "x-directive/policy": {
          triageScope: [{ rule: "all-open" }],
        },
      },
    }),
    "utf8",
  );
  mkdirSync(join(root, "xbrief", ".eval"), { recursive: true });
  writeFileSync(join(root, "xbrief", ".eval", "candidates.jsonl"), '{"issue":1}\n', "utf8");
  return root;
}

describe("computeHealthScore", () => {
  it("returns 100 when all active gates pass and no contradictions", () => {
    const gates: GateProbeResult[] = [
      { id: "a", title: "A", pass: true, exitCode: 0 },
      { id: "b", title: "B", pass: true, exitCode: 0 },
    ];
    expect(computeHealthScore(gates, [])).toBe(100);
  });

  it("penalizes failing gates and contradictions", () => {
    const gates: GateProbeResult[] = [
      { id: "a", title: "A", pass: true, exitCode: 0 },
      { id: "b", title: "B", pass: false, exitCode: 1 },
    ];
    expect(computeHealthScore(gates, [])).toBe(50);
    expect(
      computeHealthScore(gates, [
        { id: "x", kind: "unsatisfiable-nudge", summary: "s", signals: [] },
      ]),
    ).toBe(35);
  });

  it("ignores skipped gates in the denominator", () => {
    const gates: GateProbeResult[] = [
      { id: "a", title: "A", pass: true, exitCode: 0 },
      {
        id: "b",
        title: "B",
        pass: true,
        exitCode: 0,
        skipped: true,
        skipReason: "framework-only",
      },
    ];
    expect(computeHealthScore(gates, [])).toBe(100);
  });
});

describe("detectWipCapUnsatisfiableNudge", () => {
  it("no longer treats omit-by-design absence as an unsatisfiable contradiction (#1694)", () => {
    const root = seedRepo();
    // Greenfield incomplete (no decision marker) is satisfiable via writeWipCapDecision.
    expect(detectWipCapUnsatisfiableNudge(root)).toBeNull();
  });

  it("returns null when decision marker records default-accept without materializing wipCap", () => {
    const root = seedRepo();
    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const raw: unknown = JSON.parse(readFileSync(pdPath, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("fixture PROJECT-DEFINITION must be an object");
    }
    const data = raw as Record<string, unknown>;
    (data.plan as Record<string, unknown>)["x-directive/onboarding"] = {
      wipCapDecided: true,
      acceptedDefault: true,
    };
    writeFileSync(pdPath, JSON.stringify(data), "utf8");
    expect(detectWipCapUnsatisfiableNudge(root)).toBeNull();
  });

  it("returns null when wipCap is materialized", () => {
    const root = seedRepo();
    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const raw: unknown = JSON.parse(readFileSync(pdPath, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("fixture PROJECT-DEFINITION must be an object");
    }
    const data = raw as Record<string, unknown>;
    (data.plan as Record<string, unknown>)["x-directive/policy"] = {
      triageScope: [{ rule: "all-open" }],
      wipCap: 8,
    };
    writeFileSync(pdPath, JSON.stringify(data), "utf8");
    expect(detectWipCapUnsatisfiableNudge(root)).toBeNull();
  });
});

describe("persistHealthRun", () => {
  it("appends versioned records to the resolved metrics home health ledger", () => {
    const root = seedRepo();
    const report: HealthReport = {
      schemaVersion: 1,
      version: "0.70.0-test",
      recordedAt: "2026-07-05T18:00:00Z",
      score: 85,
      gates: [],
      contradictions: [],
    };
    persistHealthRun(root, report);
    const path = healthHistoryPath(root);
    expect(path).not.toBeNull();
    if (path === null) {
      throw new Error("expected health history path");
    }
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ version: "0.70.0-test", score: 85 });
  });

  itSymlink(
    "refuses append when the project-local health ledger is a symlink outside the project (#2521)",
    () => {
      const root = seedRepo();
      delete process.env[DEFT_METRICS_HOME_ENV];
      process.env[DEFT_METRICS_PROJECT_LOCAL_ENV] = "1";
      const escapeDir = mkdtempSync(join(tmpdir(), "deft-health-ledger-escape-"));
      temps.push(escapeDir);
      const escapeLedger = join(escapeDir, "health-history.jsonl");
      writeFileSync(escapeLedger, "victim\n", "utf8");
      mkdirSync(join(root, ".deft", "metrics", "health"), { recursive: true });
      symlinkSync(escapeLedger, healthHistoryPath(root) as string);

      expect(() =>
        persistHealthRun(root, {
          schemaVersion: 1,
          version: "0.70.0-test",
          recordedAt: "2026-07-05T18:00:00Z",
          score: 85,
          gates: [],
          contradictions: [],
        }),
      ).toThrow(
        /contained write refused|projection write refused|symlink escaping|symlink on the write path/,
      );
      expect(readFileSync(escapeLedger, "utf8")).toBe("victim\n");
    },
  );
});

describe("evaluateHealth", () => {
  it("emits a versioned score and persists by default", () => {
    const root = seedRepo();
    writeFileSync(
      join(root, "AGENTS.md"),
      "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    const result = evaluateHealth({
      projectRoot: root,
      frameworkSource: false,
      now: () => new Date("2026-07-05T18:00:00Z"),
    });
    expect(result.report).not.toBeNull();
    expect(result.report?.version.length).toBeGreaterThan(0);
    expect(result.report?.recordedAt).toBe("2026-07-05T18:00:00Z");
    expect(existsSync(healthHistoryPath(root))).toBe(true);
    expect(result.message).toContain("score=");
  });

  it("still returns the computed report when persistence fails", () => {
    const root = seedRepo();
    writeFileSync(
      join(root, "AGENTS.md"),
      "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    const path = healthHistoryPath(root);
    expect(path).not.toBeNull();
    if (path === null) {
      throw new Error("expected health history path");
    }
    rmSync(join(path, ".."), { recursive: true, force: true });
    writeFileSync(join(path, ".."), "not-a-directory", "utf8");
    const result = evaluateHealth({
      projectRoot: root,
      frameworkSource: false,
      now: () => new Date("2026-07-05T18:00:00Z"),
    });
    expect(result.report).not.toBeNull();
    expect(result.message).toContain("score=");
    expect(result.message).toContain("failed to persist health history");
  });
});
