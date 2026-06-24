import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendHistory,
  computeSummary,
  countFilesystemInFlight,
  DEFAULT_WIP_CAP,
  EMPTY_CACHE_LINE,
  formatOneLiner,
  formatReconcileHintLine,
  formatScopeDiscrepancyLine,
  formatSummary,
  isPosIntDirName,
  isTriageScopeExplicitlyConfigured,
  iterCachedIssues,
  latestDecisions,
  pythonStyleStringify,
  readAuditLog,
  resolveWipCapInt,
  type SummaryResult,
  summaryResultToRecord,
  WIP_WARN_GLYPH,
} from "./index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-summary-test-"));
  temps.push(root);
  return root;
}

function makeCachedIssue(cacheRoot: string, repo: string, number: number): void {
  const [owner, name] = repo.split("/", 2);
  const entry = join(cacheRoot, "github-issue", owner ?? "", name ?? "", String(number));
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, "meta.json"), "{}", "utf8");
}

function writeAuditLog(root: string, entries: Record<string, unknown>[]): void {
  const dir = join(root, "vbrief", ".eval");
  mkdirSync(dir, { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(dir, "candidates.jsonl"), body.length > 0 ? `${body}\n` : "", "utf8");
}

function auditEntry(
  repo: string,
  issueNumber: number,
  decision: string,
  decisionId: string,
): Record<string, unknown> {
  return {
    actor: "agent:test",
    decision,
    decision_id: decisionId,
    issue_number: issueNumber,
    repo,
    timestamp: "2026-05-17T20:00:00Z",
  };
}

function setWipCap(root: string, cap: number): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { policy: { wipCap: cap } } }),
    "utf8",
  );
}

function writeActiveVbrief(root: string, name: string, status: string): void {
  const dir = join(root, "vbrief", "active");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.vbrief.json`),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { status, title: name } }),
    "utf8",
  );
}

function writePendingVbriefs(root: string, count: number): void {
  const dir = join(root, "vbrief", "pending");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(dir, `test-${i}.vbrief.json`), "{}", "utf8");
  }
}

function baseResult(overrides: Partial<SummaryResult> = {}): SummaryResult {
  return {
    cacheEmpty: false,
    untriaged: 0,
    staleDefer: 0,
    inFlight: 0,
    wipCount: 0,
    wipCap: 10,
    repos: [],
    scopeDrift: 0,
    inFlightFilesystem: 0,
    inFlightCacheScoped: 0,
    triageScopeConfigured: false,
    reconcilable: 0,
    ...overrides,
  };
}

describe("empty cache", () => {
  it("emits empty-cache prompt", () => {
    const root = mkRoot();
    const result = computeSummary(root);
    expect(result.cacheEmpty).toBe(true);
    const line = formatOneLiner(result);
    expect(line).toBe(EMPTY_CACHE_LINE);
    expect(line).not.toContain("untriaged");
    expect(line).not.toContain("WIP");
    expect(line).not.toContain(WIP_WARN_GLYPH);
  });
});

describe("populated cache", () => {
  it("classifies untriaged and filesystem in-flight", () => {
    const root = mkRoot();
    const cacheRoot = join(root, ".deft-cache");
    makeCachedIssue(cacheRoot, "deftai/directive", 100);
    makeCachedIssue(cacheRoot, "deftai/directive", 101);
    makeCachedIssue(cacheRoot, "deftai/directive", 102);
    writeAuditLog(root, [
      auditEntry("deftai/directive", 100, "accept", "11111111-1111-1111-1111-111111111101"),
      auditEntry("deftai/directive", 101, "accept", "11111111-1111-1111-1111-111111111102"),
    ]);

    const result = computeSummary(root);
    expect(result.cacheEmpty).toBe(false);
    expect(result.untriaged).toBe(1);
    expect(result.inFlight).toBe(0);
    expect(result.inFlightFilesystem).toBe(0);
    expect(result.inFlightCacheScoped).toBe(2);
    expect(result.wipCap).toBe(DEFAULT_WIP_CAP);

    const line = formatOneLiner(result);
    expect(line.startsWith("[triage] 1 untriaged")).toBe(true);
    expect(line).toContain("0 in-flight");
    expect(line).toContain(`WIP 0/${DEFAULT_WIP_CAP}`);
    expect(line).not.toContain("stale-defer");
    expect(line).not.toContain(WIP_WARN_GLYPH);
  });

  it("prints zero untriaged", () => {
    const root = mkRoot();
    makeCachedIssue(join(root, ".deft-cache"), "deftai/directive", 200);
    writeAuditLog(root, [
      auditEntry("deftai/directive", 200, "accept", "22222222-2222-2222-2222-222222222200"),
    ]);
    const result = computeSummary(root);
    expect(result.untriaged).toBe(0);
    expect(formatOneLiner(result)).toContain("0 untriaged");
  });

  it("counts backfilled accept toward in-flight cache scope (#1698)", () => {
    const root = mkRoot();
    makeCachedIssue(join(root, ".deft-cache"), "deftai/directive", 42);
    writeAuditLog(root, [
      {
        actor: "agent:reconcile",
        decision: "accept",
        decision_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        issue_number: 42,
        repo: "deftai/directive",
        reason: "reconcile backfill (#1468): vBRIEF present in vbrief/proposed/",
        timestamp: "2026-06-18T12:00:00Z",
      },
    ]);
    const result = computeSummary(root);
    expect(result.inFlightCacheScoped).toBe(1);
    expect(result.untriaged).toBe(0);
  });
});

describe("WIP warning glyph", () => {
  it("appears at cap", () => {
    const root = mkRoot();
    makeCachedIssue(join(root, ".deft-cache"), "deftai/directive", 500);
    setWipCap(root, 12);
    writePendingVbriefs(root, 12);
    const result = computeSummary(root);
    const line = formatOneLiner(result);
    expect(line).toContain("WIP 12/12");
    expect(line).toContain(WIP_WARN_GLYPH);
  });

  it("suppressed just under cap", () => {
    const root = mkRoot();
    makeCachedIssue(join(root, ".deft-cache"), "deftai/directive", 502);
    setWipCap(root, 12);
    writePendingVbriefs(root, 11);
    const line = formatOneLiner(computeSummary(root));
    expect(line).toContain("WIP 11/12");
    expect(line).not.toContain(WIP_WARN_GLYPH);
  });
});

describe("formatting contracts", () => {
  it("shows stale-defer when count >= 1", () => {
    const line = formatOneLiner(
      baseResult({ untriaged: 12, staleDefer: 5, inFlight: 8, wipCount: 10, wipCap: 12 }),
    );
    expect(line).toContain("5 stale-defer (resume condition met)");
    expect(line).not.toContain(WIP_WARN_GLYPH);
  });

  it("suppresses stale-defer at zero", () => {
    const line = formatOneLiner(baseResult({ untriaged: 3, inFlight: 2, wipCount: 1, wipCap: 12 }));
    expect(line).not.toContain("stale-defer");
  });

  it("truncates at max chars", () => {
    const line = formatOneLiner(
      baseResult({
        untriaged: 9999999,
        staleDefer: 9999999,
        inFlight: 9999999,
        wipCount: 999999,
        wipCap: 12,
      }),
      { maxChars: 60 },
    );
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line.startsWith("[triage]")).toBe(true);
  });

  it("drops warning glyph before hard truncate", () => {
    const result = baseResult({
      untriaged: 10,
      inFlight: 8,
      wipCount: 12,
      wipCap: 12,
    });
    const withGlyph = formatOneLiner(result);
    expect(withGlyph).toContain(WIP_WARN_GLYPH);
    const trimmed = formatOneLiner(result, { maxChars: withGlyph.length - 1 });
    expect(trimmed).not.toContain(WIP_WARN_GLYPH);
    expect(trimmed).toContain("WIP 12/12");
  });

  it("scope drift segment appears when positive", () => {
    const line = formatOneLiner(
      baseResult({ untriaged: 4, inFlight: 2, wipCount: 3, scopeDrift: 12 }),
    );
    expect(line).toContain("[scope-drift] 12");
  });

  it("scope drift suppressed at zero", () => {
    const line = formatOneLiner(baseResult({ untriaged: 4, inFlight: 2, wipCount: 3 }));
    expect(line).not.toContain("scope-drift");
  });
});

describe("scope discrepancy line", () => {
  it("returns null when aligned", () => {
    expect(
      formatScopeDiscrepancyLine(
        baseResult({
          inFlight: 3,
          inFlightFilesystem: 3,
          inFlightCacheScoped: 3,
          triageScopeConfigured: true,
        }),
      ),
    ).toBeNull();
  });

  it("configured wording", () => {
    const line = formatScopeDiscrepancyLine(
      baseResult({
        inFlight: 3,
        inFlightFilesystem: 3,
        inFlightCacheScoped: 2,
        triageScopeConfigured: true,
      }),
    );
    expect(line).toContain("outside plan.policy.triageScope[]");
  });

  it("not configured wording", () => {
    const line = formatScopeDiscrepancyLine(
      baseResult({
        untriaged: 359,
        inFlight: 3,
        inFlightFilesystem: 3,
        inFlightCacheScoped: 38,
      }),
    );
    expect(line).toBe(
      "[triage:scope] 35 in-flight; plan.policy.triageScope[] not configured (uncounted in queue ranking)",
    );
  });
});

describe("formatSummary multi-line", () => {
  it("appends discrepancy line when diverged", () => {
    const full = formatSummary(
      baseResult({
        untriaged: 359,
        inFlight: 3,
        wipCount: 3,
        inFlightFilesystem: 3,
        inFlightCacheScoped: 38,
      }),
    );
    const lines = full.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith("[triage] 359 untriaged")).toBe(true);
    expect(lines[1]?.startsWith("[triage:scope] 35 in-flight")).toBe(true);
  });

  it("single line when aligned", () => {
    const full = formatSummary(
      baseResult({
        untriaged: 4,
        inFlight: 2,
        wipCount: 1,
        inFlightFilesystem: 2,
        inFlightCacheScoped: 2,
        triageScopeConfigured: true,
      }),
    );
    expect(full).not.toContain("\n");
    expect(full).not.toContain("[triage:scope]");
  });
});

describe("reconcile hint line", () => {
  it("surfaces when reconcilable > 0", () => {
    const line = formatReconcileHintLine(baseResult({ reconcilable: 2 }));
    expect(line).toContain("[triage:reconcile] 2");
    expect(line).toContain("task triage:reconcile");
  });

  it("suppressed at zero", () => {
    expect(formatReconcileHintLine(baseResult())).toBeNull();
  });
});

describe("filesystem in-flight counter", () => {
  it("counts only running status", () => {
    const root = mkRoot();
    writeActiveVbrief(root, "a-running", "running");
    writeActiveVbrief(root, "b-running", "running");
    writeActiveVbrief(root, "c-done", "done");
    expect(countFilesystemInFlight(root)).toBe(2);
  });

  it("tolerates malformed vbriefs", () => {
    const root = mkRoot();
    const dir = join(root, "vbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "torn.vbrief.json"), '{"plan": {"status":', "utf8");
    writeActiveVbrief(root, "good", "running");
    expect(countFilesystemInFlight(root)).toBe(1);
  });
});

describe("helpers", () => {
  it("isPosIntDirName rejects unicode digits", () => {
    expect(isPosIntDirName("7")).toBe(true);
    expect(isPosIntDirName("\u00b2")).toBe(false);
  });

  it("iterCachedIssues skips unicode digit dirs", () => {
    const root = mkRoot();
    const cacheRoot = join(root, ".deft-cache");
    makeCachedIssue(cacheRoot, "deftai/directive", 200);
    mkdirSync(join(cacheRoot, "github-issue", "deftai", "directive", "\u00b2"), {
      recursive: true,
    });
    expect(iterCachedIssues(cacheRoot)).toEqual([["deftai/directive", 200]]);
  });

  it("latestDecisions picks chronologically latest", () => {
    const decisions = latestDecisions([
      { ...auditEntry("deftai/directive", 50, "defer", "b1"), timestamp: "2026-05-17T18:00:00Z" },
      { ...auditEntry("deftai/directive", 50, "accept", "b2"), timestamp: "2026-05-17T19:00:00Z" },
    ]);
    expect(decisions.get(`deftai/directive\0${50}`)).toBe("accept");
  });

  it("readAuditLog tolerates malformed lines", () => {
    const root = mkRoot();
    const log = join(root, "vbrief", ".eval", "candidates.jsonl");
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(
      log,
      `{bad json\n${JSON.stringify(auditEntry("deftai/directive", 1, "accept", "a"))}\n`,
      "utf8",
    );
    expect(readAuditLog(log)).toHaveLength(1);
  });

  it("resolveWipCapInt honours typed field", () => {
    const root = mkRoot();
    setWipCap(root, 6);
    expect(resolveWipCapInt(root)).toBe(6);
  });

  it("isTriageScopeExplicitlyConfigured false for absent scope", () => {
    expect(isTriageScopeExplicitlyConfigured(mkRoot())).toBe(false);
  });

  it("appendHistory writes jsonl", () => {
    const root = mkRoot();
    const history = join(root, "vbrief", ".eval", "summary-history.jsonl");
    appendHistory(
      history,
      baseResult({ untriaged: 4, inFlight: 2, wipCount: 3 }),
      "[triage] test",
      {
        emittedAt: "2026-05-17T21:00:00Z",
      },
    );
    const record = JSON.parse(readFileSync(history, "utf8").trim()) as Record<string, unknown>;
    expect(record.schema).toBe("deft.triage.summary.v1");
    expect(record.untriaged).toBe(4);
  });

  it("toRecord includes #1270 fields", () => {
    const rec = summaryResultToRecord(
      baseResult({
        untriaged: 10,
        inFlight: 3,
        inFlightFilesystem: 3,
        inFlightCacheScoped: 38,
        triageScopeConfigured: true,
      }),
      { emittedAt: "2026-05-21T12:00:00Z", line: "[triage] ..." },
    );
    expect(rec.in_flight_filesystem).toBe(3);
    expect(rec.in_flight_cache_scoped).toBe(38);
    expect(rec.triage_scope_configured).toBe(true);
  });

  it("hard truncates via formatOneLiner tiny cap", () => {
    const line = formatOneLiner(baseResult({ untriaged: 99999, inFlight: 1, wipCount: 1 }), {
      maxChars: 3,
    });
    expect(line).toBe("[tr");
  });

  it("formatSummary includes reconcile hint when present", () => {
    const full = formatSummary(
      baseResult({ untriaged: 2, reconcilable: 3, inFlight: 1, wipCount: 1 }),
    );
    expect(full.split("\n")).toHaveLength(2);
    expect(full).toContain("[triage:reconcile]");
  });

  it("pythonStyleStringify matches Python spacing", () => {
    const text = pythonStyleStringify({ cache_empty: false, untriaged: 1 });
    expect(text).toBe('{"cache_empty": false, "untriaged": 1}');
  });
});

describe("compute filesystem-truth end-to-end", () => {
  it("reports filesystem in-flight with divergence line", () => {
    const root = mkRoot();
    makeCachedIssue(join(root, ".deft-cache"), "deftai/directive", 600);
    makeCachedIssue(join(root, ".deft-cache"), "deftai/directive", 601);
    makeCachedIssue(join(root, ".deft-cache"), "deftai/directive", 602);
    writeAuditLog(root, [
      auditEntry("deftai/directive", 600, "accept", "66666666-6666-6666-6666-666666666600"),
      auditEntry("deftai/directive", 601, "accept", "66666666-6666-6666-6666-666666666601"),
    ]);
    writeActiveVbrief(root, "only-running", "running");

    const result = computeSummary(root);
    expect(result.inFlight).toBe(1);
    expect(result.inFlightFilesystem).toBe(1);
    expect(result.inFlightCacheScoped).toBe(2);
    const full = formatSummary(result);
    expect(full).toContain("1 in-flight");
    expect(full).toContain("[triage:scope]");
  });
});
