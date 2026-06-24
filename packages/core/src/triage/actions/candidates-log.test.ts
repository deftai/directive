import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCandidatesLog,
  findByIssue,
  latestDecisionForIssue,
  latestDecisions,
  readAuditLog,
  resolveAuditLogPath,
  rollbackAuditEntry,
} from "./candidates-log.js";
import { CandidatesLogError } from "./errors.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-candidates-log-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  return root;
}

describe("rollbackAuditEntry", () => {
  it("returns false when audit log is absent", () => {
    const root = makeRepo();
    expect(rollbackAuditEntry("11111111-1111-1111-1111-111111111111", root)).toBe(false);
  });

  it("preserves malformed lines while removing target", () => {
    const root = makeRepo();
    const path = resolveAuditLogPath(root);
    writeFileSync(
      path,
      "not-json\n" +
        `${JSON.stringify({
          decision_id: "11111111-1111-1111-1111-111111111111",
          timestamp: "2026-06-18T12:00:00Z",
          repo: "deftai/directive",
          issue_number: 1,
          decision: "defer",
          actor: "agent:test",
        })}\n`,
      "utf8",
    );
    expect(rollbackAuditEntry("11111111-1111-1111-1111-111111111111", root)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("not-json");
  });
});

describe("createCandidatesLog validation", () => {
  it("rejects non-object entries", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    expect(() => log.append("bad" as unknown as never)).toThrow(CandidatesLogError);
  });

  it("rejects invalid repo strings", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    expect(() =>
      log.append({
        decision_id: "11111111-1111-1111-1111-111111111111",
        timestamp: "2026-06-18T12:00:00Z",
        repo: "invalid",
        issue_number: 1,
        decision: "defer",
        actor: "agent:test",
      }),
    ).toThrow(CandidatesLogError);
  });

  it("rejects unknown decision values", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    expect(() =>
      log.append({
        decision_id: "11111111-1111-1111-1111-111111111111",
        timestamp: "2026-06-18T12:00:00Z",
        repo: "deftai/directive",
        issue_number: 1,
        decision: "unknown",
        actor: "agent:test",
      }),
    ).toThrow(CandidatesLogError);
  });

  it("requires linked_to for mark-duplicate", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    expect(() =>
      log.append({
        decision_id: "11111111-1111-1111-1111-111111111111",
        timestamp: "2026-06-18T12:00:00Z",
        repo: "deftai/directive",
        issue_number: 1,
        decision: "mark-duplicate",
        actor: "agent:test",
      }),
    ).toThrow(/linked_to/);
  });

  it("rejects invalid timestamp suffix", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    expect(() =>
      log.append({
        decision_id: "11111111-1111-1111-1111-111111111111",
        timestamp: "2026-06-18T12:00:00+00:00",
        repo: "deftai/directive",
        issue_number: 1,
        decision: "defer",
        actor: "agent:test",
      }),
    ).toThrow(CandidatesLogError);
  });

  it("rejects empty actor", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    expect(() =>
      log.append({
        decision_id: "11111111-1111-1111-1111-111111111111",
        timestamp: "2026-06-18T12:00:00Z",
        repo: "deftai/directive",
        issue_number: 1,
        decision: "defer",
        actor: "",
      }),
    ).toThrow(CandidatesLogError);
  });
});

describe("createCandidatesLog latestDecision", () => {
  it("returns null when no entries exist", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    expect(log.latestDecision(1, "deftai/directive")).toBeNull();
  });

  it("filters by repo when reading history", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    const path = resolveAuditLogPath(root);
    log.append(
      {
        decision_id: "11111111-1111-1111-1111-111111111111",
        timestamp: "2026-06-18T11:00:00Z",
        repo: "deftai/directive",
        issue_number: 5,
        decision: "defer",
        actor: "agent:test",
      },
      { path },
    );
    log.append(
      {
        decision_id: "22222222-2222-2222-2222-222222222222",
        timestamp: "2026-06-18T12:00:00Z",
        repo: "deftai/directive",
        issue_number: 5,
        decision: "accept",
        actor: "agent:test",
      },
      { path },
    );
    expect(log.latestDecision(5, "deftai/directive", { path })?.decision).toBe("accept");
    expect(log.latestDecision(5, "other/repo", { path })).toBeNull();
  });
});

describe("shared decision reader (#1698)", () => {
  function backfillAccept(
    actor: "agent:bootstrap" | "agent:reconcile",
    reason: string,
  ): Record<string, unknown> {
    return {
      decision_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      timestamp: "2026-06-18T12:00:00Z",
      repo: "deftai/directive",
      issue_number: 42,
      decision: "accept",
      actor,
      reason,
    };
  }

  it.each([
    "agent:bootstrap",
    "agent:reconcile",
  ] as const)("latestDecisionForIssue sees backfilled accept from %s", (actor) => {
    const root = makeRepo();
    const path = resolveAuditLogPath(root);
    writeFileSync(path, `${JSON.stringify(backfillAccept(actor, `${actor} backfill`))}\n`, "utf8");
    const latest = latestDecisionForIssue(42, "deftai/directive", path);
    expect(latest?.decision).toBe("accept");
    expect(latest?.actor).toBe(actor);
  });

  it("findByIssue and readAuditLog include backfill entries without actor filter", () => {
    const root = makeRepo();
    const path = resolveAuditLogPath(root);
    const entry = backfillAccept("agent:reconcile", "reconcile backfill (#1468)");
    writeFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    expect(readAuditLog(path)).toHaveLength(1);
    expect(findByIssue(42, "deftai/directive", path)).toHaveLength(1);
    expect(latestDecisions(readAuditLog(path)).get(`deftai/directive\0${42}`)).toBe("accept");
  });
});
