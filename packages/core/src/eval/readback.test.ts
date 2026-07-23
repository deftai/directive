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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFT_METRICS_HOME_ENV } from "../metrics/resolve-metrics-home.js";
import type { HealthReport } from "./health.js";
import {
  EVAL_READBACK_SUPPRESSION_HOURS,
  emitSessionEvalReadback,
  evalReadbackNudgeKey,
  formatEvalHealthSessionLine,
  renderSessionEvalReadback,
  shouldNudgeEvalHealth,
  shouldSuppressEvalReadback,
} from "./readback.js";

const temps: string[] = [];
const metricsHomes: string[] = [];

beforeEach(() => {
  const metricsHome = mkdtempSync(join(tmpdir(), "eval-readback-metrics-"));
  metricsHomes.push(metricsHome);
  process.env[DEFT_METRICS_HOME_ENV] = metricsHome;
});

afterEach(() => {
  delete process.env[DEFT_METRICS_HOME_ENV];
  for (const dir of metricsHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "eval-readback-"));
  temps.push(root);
  return root;
}

function sampleReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    schemaVersion: 1,
    version: "0.99.0",
    recordedAt: "2026-07-05T12:00:00Z",
    score: 80,
    gates: [
      { id: "encoding", title: "verify:encoding", pass: true, exitCode: 0 },
      { id: "links", title: "verify:links", pass: false, exitCode: 1, detail: "broken" },
    ],
    contradictions: [],
    ...overrides,
  };
}

describe("shouldNudgeEvalHealth", () => {
  it("nudges on contradictory gates", () => {
    const report = sampleReport({
      contradictions: [
        {
          id: "wipCap-unsatisfiable-nudge",
          kind: "unsatisfiable-nudge",
          summary: "unsatisfiable",
          signals: [],
        },
      ],
    });
    expect(shouldNudgeEvalHealth(report, null)).toBe(true);
  });

  it("nudges when score drops", () => {
    const previous = sampleReport({ score: 100 });
    const current = sampleReport({ score: 85 });
    expect(shouldNudgeEvalHealth(current, previous)).toBe(true);
  });

  it("nudges on first degraded run with failing gates", () => {
    expect(shouldNudgeEvalHealth(sampleReport({ score: 80 }), null)).toBe(true);
  });

  it("stays silent when healthy with no prior history", () => {
    const healthy = sampleReport({
      score: 100,
      gates: [{ id: "encoding", title: "verify:encoding", pass: true, exitCode: 0 }],
    });
    expect(shouldNudgeEvalHealth(healthy, null)).toBe(false);
  });
});

describe("formatEvalHealthSessionLine", () => {
  it("mentions contradictory gate id", () => {
    const line = formatEvalHealthSessionLine(
      sampleReport({
        contradictions: [
          {
            id: "wipCap-unsatisfiable-nudge",
            kind: "unsatisfiable-nudge",
            summary: "Onboarding vs omit-by-design",
            signals: [],
          },
        ],
      }),
      null,
    );
    expect(line).toContain("wipCap-unsatisfiable-nudge");
    expect(line).toContain("task eval:health");
  });

  it("mentions score drop", () => {
    const line = formatEvalHealthSessionLine(
      sampleReport({ score: 70 }),
      sampleReport({ score: 90 }),
    );
    expect(line).toContain("90->70");
  });
});

describe("shouldSuppressEvalReadback", () => {
  it("suppresses repeated nudge within four hours", () => {
    const root = tempRoot();
    const hist = join(root, ".deft-cache", "eval-readback-history.jsonl");
    const key = evalReadbackNudgeKey(sampleReport());
    const now = new Date("2026-07-05T12:00:00Z");
    renderSessionEvalReadback(root, {
      writeHistory: true,
      now,
      evaluate: () => ({ report: sampleReport() }),
    });
    expect(existsSync(hist)).toBe(true);
    expect(shouldSuppressEvalReadback(key, hist, { now: new Date("2026-07-05T13:00:00Z") })).toBe(
      true,
    );
    expect(shouldSuppressEvalReadback(key, hist, { now: new Date("2026-07-05T17:00:00Z") })).toBe(
      false,
    );
  });
});

describe("emitSessionEvalReadback", () => {
  it("writes nothing when report is healthy", () => {
    const root = tempRoot();
    const lines: string[] = [];
    expect(
      emitSessionEvalReadback(root, {
        output: (l) => lines.push(l),
        writeHistory: false,
        evaluate: () => ({
          report: sampleReport({
            score: 100,
            gates: [{ id: "encoding", title: "verify:encoding", pass: true, exitCode: 0 }],
          }),
        }),
      }),
    ).toBeNull();
    expect(lines).toEqual([]);
  });

  it("emits advisory line when score drops", () => {
    const root = tempRoot();
    const lines: string[] = [];
    const line = emitSessionEvalReadback(root, {
      output: (l) => lines.push(l),
      writeHistory: false,
      evaluate: () => ({ report: sampleReport({ score: 60 }) }),
    });
    expect(line).toContain("[eval]");
    expect(lines).toHaveLength(1);
  });
});

describe("EVAL_READBACK_SUPPRESSION_HOURS", () => {
  it("matches value-readback debounce parity", () => {
    expect(EVAL_READBACK_SUPPRESSION_HOURS).toBe(4);
  });
});

const itSymlink = it.skipIf(process.platform === "win32");

describe("eval readback history symlink containment (#2781)", () => {
  itSymlink("does not append when history path is a symlink to an external victim file", () => {
    const root = tempRoot();
    const escapeDir = mkdtempSync(join(tmpdir(), "eval-readback-victim-"));
    const victim = join(escapeDir, "eval-readback-history.jsonl");
    writeFileSync(victim, "victim\n", "utf8");
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    symlinkSync(victim, join(root, ".deft-cache", "eval-readback-history.jsonl"));
    renderSessionEvalReadback(root, {
      now: new Date("2026-07-05T12:00:00Z"),
      evaluate: () => ({ report: sampleReport() }),
    });
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
    rmSync(escapeDir, { recursive: true, force: true });
  });
});
