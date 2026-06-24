import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachePut } from "../../cache/operations.js";
import { createCandidatesLog, resolveAuditLogPath, rollbackAuditEntry } from "./candidates-log.js";
import { CandidatesLogError } from "./errors.js";
import {
  accept,
  createDefaultDeps,
  deferAction,
  history,
  markDuplicate,
  needsAc,
  reject,
  reset,
  status,
  TriageError,
  UpstreamCloseError,
} from "./index.js";
import { parseResumeOn } from "./resume-on.js";
import type { AuditEntry, TriageActionsDeps } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-actions-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  return root;
}

function fakeDeps(
  root: string,
  overrides: Partial<TriageActionsDeps> & {
    latest?: AuditEntry | null;
    ghFail?: boolean;
    ingestFail?: boolean;
  } = {},
): TriageActionsDeps {
  const appended: AuditEntry[] = [];
  let latest = overrides.latest ?? null;
  const logPath = resolveAuditLogPath(root);

  const candidatesLog = createCandidatesLog(root);
  const wrappedLog = {
    append(entry: AuditEntry, options?: { path?: string }) {
      const id = candidatesLog.append(entry, { path: options?.path ?? logPath });
      appended.push(entry);
      latest = entry;
      return id;
    },
    latestDecision(issueNumber: number, repo: string, options?: { path?: string }) {
      if (latest !== null && latest.issue_number === issueNumber && latest.repo === repo) {
        return latest;
      }
      return candidatesLog.latestDecision(issueNumber, repo, { path: options?.path ?? logPath });
    },
    newDecisionId() {
      return "11111111-1111-1111-1111-111111111111";
    },
  };

  const ingestCalls: Array<{ n: number; repo: string; projectRoot?: string }> = [];

  return {
    candidatesLog: wrappedLog,
    issueIngest: {
      ingestSingleForAccept(n, repo, options = {}) {
        ingestCalls.push({ n, repo, projectRoot: options.projectRoot });
        if (overrides.ingestFail) {
          throw new Error("simulated ingest failure");
        }
      },
    },
    scm: {
      call(_source, verb, args, options = {}) {
        if (overrides.ghFail) {
          throw new UpstreamCloseError(`gh ${verb} ${args.join(" ")} failed: not authorized`);
        }
        if (options.check) {
          return { returncode: 0, stdout: "", stderr: "" };
        }
        return { returncode: 0, stdout: "", stderr: "" };
      },
    },
    nowIso: () => "2026-06-18T12:00:00Z",
    stderr: () => {},
    ...overrides,
    // expose for assertions via symbol-like property
    ...({
      _appended: appended,
      _ingestCalls: ingestCalls,
    } as unknown as Partial<TriageActionsDeps>),
  };
}

describe("createDefaultDeps", () => {
  it("wires default production dependencies", () => {
    const root = makeRepo();
    const deps = createDefaultDeps(root);
    expect(deps.candidatesLog.newDecisionId()).toMatch(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    );
  });
});

describe("parseResumeOn", () => {
  it("accepts ref:closed atomic", () => {
    expect(() => parseResumeOn("ref:closed:#42")).not.toThrow();
  });

  it("rejects unknown atomics with Python-aligned message", () => {
    expect(() => parseResumeOn("not-valid")).toThrow(/unrecognised atomic condition/);
  });

  it("rejects multi-operator expressions", () => {
    expect(() => parseResumeOn("ref:closed:#1 AND ref:closed:#2 AND ref:closed:#3")).toThrow(
      /single top-level AND\/OR/,
    );
  });
});

describe("createCandidatesLog", () => {
  it("validates and appends defer entries", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    const path = resolveAuditLogPath(root);
    const id = log.append(
      {
        decision_id: "11111111-1111-1111-1111-111111111111",
        timestamp: "2026-06-18T12:00:00Z",
        repo: "deftai/directive",
        issue_number: 7,
        decision: "defer",
        actor: "agent:test",
        reason: "later",
      },
      { path },
    );
    expect(id).toBe("11111111-1111-1111-1111-111111111111");
    const text = readFileSync(path, "utf8");
    expect(text).toContain('"decision":"defer"');
    expect(log.latestDecision(7, "deftai/directive", { path })?.decision).toBe("defer");
  });

  it("raises CandidatesLogError on invalid entry", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    expect(() =>
      log.append({
        decision_id: "bad",
        timestamp: "2026-06-18T12:00:00Z",
        repo: "deftai/directive",
        issue_number: 1,
        decision: "defer",
        actor: "agent:test",
      }),
    ).toThrow(CandidatesLogError);
  });

  it("rejects linked_to on non-duplicate decisions", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    expect(() =>
      log.append({
        decision_id: "11111111-1111-1111-1111-111111111111",
        timestamp: "2026-06-18T12:00:00Z",
        repo: "deftai/directive",
        issue_number: 1,
        decision: "defer",
        actor: "agent:test",
        linked_to: 2,
      }),
    ).toThrow(/linked_to/);
  });

  it("rejects reset without prior_decision_id", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    expect(() =>
      log.append({
        decision_id: "11111111-1111-1111-1111-111111111111",
        timestamp: "2026-06-18T12:00:00Z",
        repo: "deftai/directive",
        issue_number: 1,
        decision: "reset",
        actor: "agent:test",
      }),
    ).toThrow(/prior_decision_id/);
  });
});

describe("rollbackAuditEntry", () => {
  it("removes a matching decision line", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    const path = resolveAuditLogPath(root);
    const entry: AuditEntry = {
      decision_id: "11111111-1111-1111-1111-111111111111",
      timestamp: "2026-06-18T12:00:00Z",
      repo: "deftai/directive",
      issue_number: 42,
      decision: "accept",
      actor: "agent:test",
    };
    log.append(entry, { path });
    expect(rollbackAuditEntry(entry.decision_id, root, path)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe("");
  });
});

describe("accept", () => {
  it("appends audit entry and delegates ingest", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    const decisionId = accept(123, "deftai/directive", deps, {
      actor: "agent:test",
      projectRoot: root,
    });
    expect(decisionId).toBe("11111111-1111-1111-1111-111111111111");
    const path = resolveAuditLogPath(root);
    const text = readFileSync(path, "utf8");
    expect(text).toContain('"decision":"accept"');
  });

  it("uses explicit actor override", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    accept(1, "deftai/directive", deps, { actor: "human:me", projectRoot: root });
    expect(readFileSync(resolveAuditLogPath(root), "utf8")).toContain('"actor":"human:me"');
  });

  it("rolls back audit entry on ingest failure", () => {
    const root = makeRepo();
    const deps = fakeDeps(root, { ingestFail: true });
    expect(() =>
      accept(42, "deftai/directive", deps, { actor: "agent:test", projectRoot: root }),
    ).toThrow(TriageError);
    expect(readFileSync(resolveAuditLogPath(root), "utf8").trim()).toBe("");
  });

  it("is idempotent when already accepted", () => {
    const root = makeRepo();
    const prior: AuditEntry = {
      decision_id: "prior-id",
      timestamp: "2026-06-18T12:00:00Z",
      repo: "deftai/directive",
      issue_number: 9,
      decision: "accept",
      actor: "agent:test",
    };
    const deps = fakeDeps(root, { latest: prior });
    expect(accept(9, "deftai/directive", deps, { projectRoot: root })).toBe("prior-id");
    const path = resolveAuditLogPath(root);
    expect(existsSync(path)).toBe(false);
  });
});

describe("reject", () => {
  it("rolls back audit entry on gh failure", () => {
    const root = makeRepo();
    const deps = fakeDeps(root, { ghFail: true });
    expect(() => reject(42, "deftai/directive", "obsolete", deps, { projectRoot: root })).toThrow(
      UpstreamCloseError,
    );
    expect(readFileSync(resolveAuditLogPath(root), "utf8").trim()).toBe("");
  });

  it("maps missing gh binary to UpstreamCloseError", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    deps.scm = {
      call() {
        throw new Error("ENOENT spawn gh ENOENT");
      },
    };
    expect(() => reject(42, "deftai/directive", "obsolete", deps, { projectRoot: root })).toThrow(
      /gh CLI not found/,
    );
  });

  it("is idempotent when already rejected", () => {
    const root = makeRepo();
    const prior: AuditEntry = {
      decision_id: "prior-id",
      timestamp: "2026-06-18T12:00:00Z",
      repo: "deftai/directive",
      issue_number: 9,
      decision: "reject",
      actor: "agent:test",
      reason: "no",
    };
    const deps = fakeDeps(root, { latest: prior });
    expect(reject(9, "deftai/directive", "again", deps, { projectRoot: root })).toBe("prior-id");
  });

  it("records reject when gh close succeeds", () => {
    const root = makeRepo();
    const stderrLines: string[] = [];
    const deps = fakeDeps(root);
    deps.stderr = (line) => {
      stderrLines.push(line);
    };
    deps.scm = {
      call(_source, verb, args) {
        if (verb === "issue" && args[0] === "edit") {
          throw new UpstreamCloseError("'triage-rejected' not found");
        }
        return { returncode: 0, stdout: "", stderr: "" };
      },
    };
    const id = reject(42, "deftai/directive", "obsolete", deps, { projectRoot: root });
    expect(id).toBe("11111111-1111-1111-1111-111111111111");
    expect(readFileSync(resolveAuditLogPath(root), "utf8")).toContain('"decision":"reject"');
  });

  it("records reject when label apply succeeds on first try", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    reject(42, "deftai/directive", "obsolete", deps, { actor: "agent:test", projectRoot: root });
    expect(readFileSync(resolveAuditLogPath(root), "utf8")).toContain('"reason":"obsolete"');
  });

  it("heals missing label by creating then re-adding", () => {
    const root = makeRepo();
    let editAttempts = 0;
    const deps = fakeDeps(root);
    deps.scm = {
      call(_source, verb, args) {
        if (verb === "issue" && args[0] === "edit") {
          editAttempts += 1;
          if (editAttempts === 1) {
            throw new UpstreamCloseError("'triage-rejected' not found");
          }
        }
        if (verb === "label" && args[0] === "create") {
          throw new UpstreamCloseError("label already exists");
        }
        return { returncode: 0, stdout: "", stderr: "" };
      },
    };
    reject(42, "deftai/directive", "obsolete", deps, { projectRoot: root });
    expect(editAttempts).toBeGreaterThanOrEqual(2);
  });

  it("warns when label application fails for non-missing-label reasons", () => {
    const root = makeRepo();
    const stderrLines: string[] = [];
    const deps = fakeDeps(root);
    deps.stderr = (line) => stderrLines.push(line);
    deps.scm = {
      call(_source, verb, args) {
        if (verb === "issue" && args[0] === "edit") {
          throw new UpstreamCloseError("gh issue edit failed: forbidden");
        }
        return { returncode: 0, stdout: "", stderr: "" };
      },
    };
    reject(42, "deftai/directive", "obsolete", deps, { projectRoot: root });
    expect(stderrLines.some((line) => line.includes("label could not be applied"))).toBe(true);
  });

  it("warns when auto-create/re-add fails after missing label", () => {
    const root = makeRepo();
    const stderrLines: string[] = [];
    const deps = fakeDeps(root);
    deps.stderr = (line) => stderrLines.push(line);
    deps.scm = {
      call(_source, verb, args) {
        if (verb === "issue" && args[0] === "edit") {
          throw new UpstreamCloseError("'triage-rejected' not found");
        }
        if (verb === "label") {
          throw new UpstreamCloseError("label create failed");
        }
        return { returncode: 0, stdout: "", stderr: "" };
      },
    };
    reject(42, "deftai/directive", "obsolete", deps, { projectRoot: root });
    expect(stderrLines.some((line) => line.includes("auto-create/re-add failed"))).toBe(true);
  });
});

describe("deferAction", () => {
  it("appends defer audit entry", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    deferAction(7, "deftai/directive", "later", deps, { actor: "agent:test", projectRoot: root });
    const text = readFileSync(resolveAuditLogPath(root), "utf8");
    expect(text).toContain('"decision":"defer"');
    expect(text).toContain('"reason":"later"');
  });

  it("rejects invalid resume_on", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    expect(() =>
      deferAction(7, "deftai/directive", "later", deps, {
        resumeOn: "not-valid",
        projectRoot: root,
      }),
    ).toThrow(/invalid --resume-on expression/);
  });

  it("persists resume_on when valid", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    deferAction(7, "deftai/directive", "blocked", deps, {
      resumeOn: "ref:closed:#99",
      projectRoot: root,
    });
    const text = readFileSync(resolveAuditLogPath(root), "utf8");
    expect(text).toContain('"resume_on":"ref:closed:#99"');
  });

  it("allows defer without explicit reason", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    deferAction(7, "deftai/directive", null, deps, { projectRoot: root });
    const text = readFileSync(resolveAuditLogPath(root), "utf8");
    expect(text).toContain('"decision":"defer"');
    expect(text).not.toContain('"reason"');
  });

  it("uses default actor when not specified", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    deferAction(7, "deftai/directive", "later", deps, { projectRoot: root });
    const text = readFileSync(resolveAuditLogPath(root), "utf8");
    expect(text).toMatch(/"actor":"(agent:triage|[^"]+)"/);
  });
});

describe("needsAc", () => {
  it("records needs-ac audit entry and tolerates gh comment failure", () => {
    const root = makeRepo();
    const stderrLines: string[] = [];
    const deps = fakeDeps(root);
    deps.stderr = (line) => stderrLines.push(line);
    deps.scm = {
      call() {
        throw new UpstreamCloseError("gh issue comment failed: forbidden");
      },
    };
    const id = needsAc(10, "deftai/directive", deps, { actor: "agent:test", projectRoot: root });
    expect(id).toBe("11111111-1111-1111-1111-111111111111");
    const text = readFileSync(resolveAuditLogPath(root), "utf8");
    expect(text).toContain('"decision":"needs-ac"');
    expect(stderrLines.some((line) => line.includes("needs-ac comment not posted"))).toBe(true);
  });
});

describe("markDuplicate", () => {
  it("rejects when target equals source", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    expect(() => markDuplicate(5, "deftai/directive", 5, deps, { projectRoot: root })).toThrow(
      /cannot equal source/,
    );
  });

  it("rejects when cache target is missing", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    expect(() => markDuplicate(5, "deftai/directive", 6, deps, { projectRoot: root })).toThrow(
      /not found in cache/,
    );
  });

  it("records mark-duplicate when cache target exists", () => {
    const root = makeRepo();
    cachePut(
      "github-issue",
      "deftai/directive/6",
      { number: 6, title: "dup", body: "body" },
      { cacheRoot: join(root, ".deft-cache") },
    );
    const deps = fakeDeps(root);
    const id = markDuplicate(5, "deftai/directive", 6, deps, { projectRoot: root });
    expect(id).toBe("11111111-1111-1111-1111-111111111111");
    const text = readFileSync(resolveAuditLogPath(root), "utf8");
    expect(text).toContain('"decision":"mark-duplicate"');
    expect(text).toContain('"linked_to":6');
  });

  it("is idempotent for the same duplicate target", () => {
    const root = makeRepo();
    cachePut(
      "github-issue",
      "deftai/directive/6",
      { number: 6, title: "dup", body: "body" },
      { cacheRoot: join(root, ".deft-cache") },
    );
    const prior: AuditEntry = {
      decision_id: "prior-dup",
      timestamp: "2026-06-18T12:00:00Z",
      repo: "deftai/directive",
      issue_number: 5,
      decision: "mark-duplicate",
      actor: "agent:test",
      linked_to: 6,
    };
    const deps = fakeDeps(root, { latest: prior });
    expect(markDuplicate(5, "deftai/directive", 6, deps, { projectRoot: root })).toBe("prior-dup");
  });
});

describe("status", () => {
  it("returns null when no decision exists", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    expect(status(7, "deftai/directive", deps, { projectRoot: root })).toBeNull();
  });

  it("returns the latest decision", () => {
    const root = makeRepo();
    const prior: AuditEntry = {
      decision_id: "prior-id",
      timestamp: "2026-06-18T12:00:00Z",
      repo: "deftai/directive",
      issue_number: 7,
      decision: "defer",
      actor: "agent:test",
      reason: "later",
    };
    const deps = fakeDeps(root, { latest: prior });
    expect(status(7, "deftai/directive", deps, { projectRoot: root })?.decision).toBe("defer");
  });
});

describe("reset", () => {
  it("rejects when no prior decision exists", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    expect(() => reset(7, "deftai/directive", deps, { projectRoot: root })).toThrow(
      /no prior decision/,
    );
  });

  it("records reset referencing prior decision_id", () => {
    const root = makeRepo();
    const prior: AuditEntry = {
      decision_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      timestamp: "2026-06-18T12:00:00Z",
      repo: "deftai/directive",
      issue_number: 7,
      decision: "defer",
      actor: "agent:test",
    };
    const deps = fakeDeps(root, { latest: prior });
    const id = reset(7, "deftai/directive", deps, { projectRoot: root });
    expect(id).toBe("11111111-1111-1111-1111-111111111111");
    const text = readFileSync(resolveAuditLogPath(root), "utf8");
    expect(text).toContain('"decision":"reset"');
    expect(text).toContain('"prior_decision_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"');
  });

  it("is idempotent when already reset", () => {
    const root = makeRepo();
    const prior: AuditEntry = {
      decision_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      timestamp: "2026-06-18T12:00:00Z",
      repo: "deftai/directive",
      issue_number: 7,
      decision: "reset",
      actor: "agent:test",
      prior_decision_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    };
    const deps = fakeDeps(root, { latest: prior });
    expect(reset(7, "deftai/directive", deps, { projectRoot: root })).toBe(
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
  });
});

describe("history", () => {
  it("returns entries ordered by timestamp", () => {
    const root = makeRepo();
    const log = createCandidatesLog(root);
    const path = resolveAuditLogPath(root);
    log.append(
      {
        decision_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        timestamp: "2026-06-18T10:00:00Z",
        repo: "deftai/directive",
        issue_number: 7,
        decision: "defer",
        actor: "agent:test",
        reason: "first",
      },
      { path },
    );
    log.append(
      {
        decision_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        timestamp: "2026-06-18T11:00:00Z",
        repo: "deftai/directive",
        issue_number: 7,
        decision: "needs-ac",
        actor: "agent:test",
        reason: "needs criteria",
      },
      { path },
    );
    const deps = fakeDeps(root);
    const entries = history(7, "deftai/directive", deps, { projectRoot: root });
    expect(entries.map((e) => e.decision)).toEqual(["defer", "needs-ac"]);
  });
});
