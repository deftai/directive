import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveJudgmentGates,
  validateJudgmentGates,
  validateJudgmentGatesDisabled,
} from "./judgment-policy.js";
import { matchAny, matchPath } from "./pathspec.js";
import {
  cmdProbeSession,
  formatTimestamp,
  guardPlanProbeRegistration,
  markComplete,
  ProbeHandoffBlockedError,
  parseProbeSessionArgs,
  readSession,
  recordDecision,
  STATE_COMPLETE,
  STATE_INTERROGATE,
  setCurrentBranch,
  startSession,
  writeSession,
} from "./probe-session.js";
import {
  CANONICAL_PHASES,
  cmdSubagentMonitor,
  EXIT_EXTERNAL_ERROR,
  EXIT_OK,
  EXIT_STALE,
  parseHeartbeatFile,
  parseIso8601Utc,
  parseSubagentMonitorArgs,
  recordOk,
  renderText,
  sweepScratchDirs,
} from "./subagent-monitor.js";
import {
  cmdVerifyInvestigation,
  LedgerConfigError,
  loadLedger,
  parseVerifyInvestigationArgs,
  validateLedger,
  validationOk,
} from "./verify-investigation.js";
import {
  buildReport,
  type Candidate,
  cmdVerifyJudgmentGates,
  evaluate,
  fingerprintScope,
  matchEvidence,
  readClearances,
  recordClearance,
  renderReport,
  reportBlocking,
  reportFired,
} from "./verify-judgment-gates.js";

const stdout: string[] = [];
const stderr: string[] = [];

beforeEach(() => {
  stdout.length = 0;
  stderr.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pathspec", () => {
  it("matches segment and double-star patterns", () => {
    expect(matchPath(".env", ".env")).toBe(true);
    expect(matchPath("secrets/**", "secrets/prod.env")).toBe(true);
    expect(matchPath("api/**", "api/users.py")).toBe(true);
    expect(matchPath("**/AGENTS.md", "skills/foo/AGENTS.md")).toBe(true);
    expect(matchAny(["**/*.pem"], "certs/tls.pem")).toBe(true);
    expect(matchPath("", "x")).toBe(false);
    expect(matchAny(null, "x")).toBe(false);
  });
});

describe("subagent-monitor", () => {
  it("parses UTC timestamps and rejects non-UTC", () => {
    expect(parseIso8601Utc("2026-06-19T12:00:00Z")).not.toBeNull();
    expect(parseIso8601Utc("2026-06-19T12:00:00+00:00")).not.toBeNull();
    expect(parseIso8601Utc("2026-06-19T12:00:00+05:00")).toBeNull();
    expect(parseIso8601Utc("")).toBeNull();
  });

  it("flags stale, malformed, and terminal records", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-"));
    const scratch = join(root, "status");
    mkdirSync(scratch, { recursive: true });
    const now = new Date("2026-06-19T14:00:00Z");

    writeFileSync(
      join(scratch, "agent1.json"),
      JSON.stringify({
        agent_id: "agent1",
        parent_id: "p",
        last_heartbeat_at: "2026-06-19T12:00:00Z",
        last_message: "ok",
        phase: "polling",
        terminal_state: null,
      }),
      "utf8",
    );
    const rec = parseHeartbeatFile(join(scratch, "agent1.json"), {
      now,
      thresholdSeconds: 30 * 60,
    });
    expect(rec.is_stale).toBe(true);
    expect(CANONICAL_PHASES.has("polling")).toBe(true);

    writeFileSync(join(scratch, "bad.json"), "{not json", "utf8");
    expect(
      parseHeartbeatFile(join(scratch, "bad.json"), { now, thresholdSeconds: 60 }).failures.length,
    ).toBeGreaterThan(0);

    writeFileSync(
      join(scratch, "wrong-id.json"),
      JSON.stringify({
        agent_id: "other",
        parent_id: "p",
        last_heartbeat_at: "2026-06-19T13:59:00Z",
        last_message: "ok",
        phase: "bad-phase",
        terminal_state: null,
      }),
      "utf8",
    );
    const malformed = parseHeartbeatFile(join(scratch, "wrong-id.json"), {
      now,
      thresholdSeconds: 3600,
    });
    expect(malformed.failures.length).toBeGreaterThan(1);

    writeFileSync(
      join(scratch, "done.json"),
      JSON.stringify({
        agent_id: "done",
        parent_id: "p",
        last_heartbeat_at: "2026-06-01T12:00:00Z",
        last_message: "done",
        phase: "terminal",
        terminal_state: "succeeded",
      }),
      "utf8",
    );
    expect(
      recordOk(parseHeartbeatFile(join(scratch, "done.json"), { now, thresholdSeconds: 60 })),
    ).toBe(true);

    const sweep = sweepScratchDirs([{ readPath: scratch, label: scratch }], {
      thresholdMinutes: 30,
      now,
    });
    expect(renderText(sweep)).toContain("ATTENTION");
    rmSync(root, { recursive: true, force: true });
  });

  it("runs CLI with config and success paths", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-cli-"));
    const scratch = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(scratch, { recursive: true });

    expect(parseSubagentMonitorArgs(["--threshold-minutes", "0"]).error).toBeUndefined();
    expect(cmdSubagentMonitor(["--scratch-dir", scratch, "--json"], root)).toBe(EXIT_OK);
    expect(cmdSubagentMonitor(["--scratch-dir", scratch], root)).toBe(EXIT_OK);

    writeFileSync(
      join(scratch, "stale.json"),
      JSON.stringify({
        agent_id: "stale",
        parent_id: "p",
        last_heartbeat_at: "2020-01-01T12:00:00Z",
        last_message: "old",
        phase: "polling",
      }),
      "utf8",
    );
    expect(cmdSubagentMonitor(["--scratch-dir", scratch], root)).toBe(EXIT_STALE);
    expect(cmdSubagentMonitor(["--threshold-minutes", "-1"])).toBe(EXIT_EXTERNAL_ERROR);
    expect(cmdSubagentMonitor(["--scratch-dir", join(root, "missing")], root)).toBe(
      EXIT_EXTERNAL_ERROR,
    );
    expect(cmdSubagentMonitor(["--unknown-flag"], root)).toBe(EXIT_EXTERNAL_ERROR);
    expect(parseSubagentMonitorArgs(["--help"]).scratchDirs).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("probe-session", () => {
  it("blocks artifact handoff until complete", () => {
    const root = mkdtempSync(join(tmpdir(), "probe-"));
    startSession(root, {
      target: "auth-probe",
      currentBranch: "main",
      now: new Date("2026-06-19T12:00:00Z"),
    });
    expect(readSession(root)?.state).toBe(STATE_INTERROGATE);
    expect(() => guardPlanProbeRegistration(root)).toThrow(ProbeHandoffBlockedError);
    recordDecision(root, { question: "Q?", answer: "A.", status: "locked" });
    setCurrentBranch(root, "tokens");
    markComplete(root, new Date("2026-06-19T13:00:00Z"));
    expect(guardPlanProbeRegistration(root).state).toBe(STATE_COMPLETE);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs CLI commands", () => {
    const root = mkdtempSync(join(tmpdir(), "probe-cli-"));
    expect(cmdProbeSession(["start", "--target", "x", "--project-root", root])).toBe(0);
    expect(
      cmdProbeSession([
        "record",
        "--question",
        "q",
        "--answer",
        "a",
        "--status",
        "locked",
        "--project-root",
        root,
      ]),
    ).toBe(0);
    expect(cmdProbeSession(["set-branch", "--branch", "other", "--project-root", root])).toBe(0);
    expect(cmdProbeSession(["status", "--project-root", root])).toBe(0);
    expect(cmdProbeSession(["status", "--json", "--project-root", root])).toBe(0);
    expect(cmdProbeSession(["guard-artifact", "--path", "p", "--project-root", root])).toBe(1);
    cmdProbeSession(["complete", "--project-root", root]);
    expect(cmdProbeSession(["guard-plan-registration", "--project-root", root])).toBe(0);
    expect(cmdProbeSession(["guard-artifact", "--path", "ok.json", "--project-root", root])).toBe(
      0,
    );
    expect(parseProbeSessionArgs([]).error).toBeDefined();
    expect(parseProbeSessionArgs(["--project-root", root, "nope"]).command).toBe("nope");
    expect(cmdProbeSession(["nope", "--project-root", root])).toBe(2);
    expect(cmdProbeSession(["start", "--project-root", root])).toBe(2);
    expect(formatTimestamp(new Date("2026-06-19T12:00:00Z"))).toBe("2026-06-19T12:00:00Z");

    const session = readSession(root);
    if (session) writeSession(root, session);
    expect(cmdProbeSession(["status", "--project-root", "/nonexistent-empty-dir"])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("readSession rejects invalid payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "probe-read-"));
    mkdirSync(join(root, ".deft"), { recursive: true });
    const base = {
      schemaVersion: 1,
      state: STATE_INTERROGATE,
      target: "t",
      currentBranch: "b",
      resolvedDecisions: [],
      startedAt: "2026-06-19T12:00:00Z",
    };
    writeFileSync(
      join(root, ".deft", "probe-session.json"),
      JSON.stringify({ ...base, target: "" }),
      "utf8",
    );
    expect(readSession(root)).toBeNull();
    writeFileSync(
      join(root, ".deft", "probe-session.json"),
      JSON.stringify({ ...base, currentBranch: 1 }),
      "utf8",
    );
    expect(readSession(root)).toBeNull();
    writeFileSync(
      join(root, ".deft", "probe-session.json"),
      JSON.stringify({ ...base, state: STATE_INTERROGATE, completedAt: "2026-06-19T13:00:00Z" }),
      "utf8",
    );
    expect(readSession(root)).toBeNull();
    writeFileSync(
      join(root, ".deft", "probe-session.json"),
      JSON.stringify({ ...base, state: STATE_COMPLETE }),
      "utf8",
    );
    expect(readSession(root)).toBeNull();
    writeFileSync(
      join(root, ".deft", "probe-session.json"),
      JSON.stringify({ ...base, resolvedDecisions: [{}] }),
      "utf8",
    );
    expect(readSession(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

function closeReadyLedger(): Record<string, unknown> {
  return {
    vBRIEFInfo: { version: "0.6" },
    plan: {
      status: "completed",
      items: [
        {
          id: "branch.a",
          status: "completed",
          items: [
            {
              id: "claim.a1",
              status: "completed",
              metadata: { "x-claim": { evidenceRefs: ["EV-001"] } },
            },
            {
              id: "claim.blocked",
              status: "blocked",
              metadata: { "x-claim": {} },
            },
          ],
        },
        {
          id: "branch.b",
          status: "failed",
          items: [
            {
              id: "claim.b1",
              status: "failed",
              metadata: { "x-claim": { ruledOutReason: "nope", evidenceRefs: ["EV-002"] } },
            },
          ],
        },
        {
          id: "branch.c",
          status: "completed",
          items: [
            {
              id: "claim.c1",
              status: "completed",
              metadata: { "x-claim": { evidenceRefs: ["EV-001"] } },
            },
          ],
        },
      ],
      edges: [{ from: "claim.b1", to: "branch.b", type: "invalidates" }],
      references: [{ id: "EV-001" }, { id: "EV-002" }],
      metadata: {
        "x-investigation": {
          profile: "forensic-research-v1",
          wavesCompleted: { "1": true, "2": true, "3": true, "4": true },
        },
      },
    },
  };
}

describe("verify-investigation", () => {
  it("validates ledgers and CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "inv-"));
    const path = join(root, "ledger.json");
    writeFileSync(path, JSON.stringify(closeReadyLedger()), "utf8");
    expect(validationOk(validateLedger(loadLedger(path)))).toBe(true);
    expect(cmdVerifyInvestigation(["--ledger", path])).toBe(0);
    expect(cmdVerifyInvestigation(["--ledger", path, "--json"])).toBe(0);

    const blocked = closeReadyLedger();
    (blocked.plan as Record<string, unknown>).status = "running";
    writeFileSync(join(root, "bad.json"), JSON.stringify(blocked), "utf8");
    expect(cmdVerifyInvestigation(["--ledger", join(root, "bad.json")])).toBe(1);

    const warnOnly = closeReadyLedger();
    const items = (warnOnly.plan as Record<string, unknown>).items as Record<string, unknown>[];
    const branchA = items[0] as Record<string, unknown>;
    const claims = branchA.items as Record<string, unknown>[];
    claims.push({
      id: "claim.blocked2",
      status: "blocked",
      metadata: { "x-claim": {} },
    });
    writeFileSync(join(root, "warn.json"), JSON.stringify(warnOnly), "utf8");
    expect(cmdVerifyInvestigation(["--ledger", join(root, "warn.json")])).toBe(0);

    expect(() => loadLedger(join(root, "nope.json"))).toThrow(LedgerConfigError);
    expect(cmdVerifyInvestigation([])).toBe(2);
    expect(parseVerifyInvestigationArgs(["ledger.json"]).ledger).toBe("ledger.json");
    expect(parseVerifyInvestigationArgs(["--help"]).emitJson).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("verify-judgment-gates", () => {
  function makeProject(gates?: unknown[], disabled?: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "jg-"));
    for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "vbrief", f), { recursive: true });
    }
    const policy: Record<string, unknown> = {};
    if (gates) policy.judgmentGates = gates;
    if (disabled) policy.judgmentGatesDisabled = disabled;
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { items: [], policy } }),
      "utf8",
    );
    return root;
  }

  it("evaluates enforce and advise postures", () => {
    const root = makeProject();
    const candidate: Candidate = {
      paths: ["secrets/prod.env"],
      labels: [],
      body: "",
      state: "open",
      updated_at: null,
    };
    expect(evaluate(root, candidate, { posture: "enforce" })[0]).toBe(1);
    expect(evaluate(root, candidate)[0]).toBe(0);
    expect(evaluate("/nonexistent/path", candidate)[0]).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("handles clearances and declared gates", () => {
    const root = makeProject([
      {
        id: "api-contract",
        class: "declared",
        tier: "block",
        reason: "API contract change needs human sign-off",
        match: { paths: { "any-of": ["api/**"] } },
      },
    ]);
    const candidate: Candidate = {
      paths: ["api/users.py"],
      labels: [],
      body: "",
      state: "open",
      updated_at: null,
    };
    const scope = fingerprintScope({ paths: ["api/users.py"] });
    recordClearance(root, { gate_id: "api-contract", cleared_scope: scope, reviewers: ["alice"] });
    expect(readClearances(root).length).toBe(1);
    expect(evaluate(root, candidate, { posture: "enforce" })[0]).toBe(0);

    const report = buildReport(root, {
      paths: ["api/users.py", "api/admin.py"],
      labels: [],
      body: "",
      state: "open",
      updated_at: null,
    });
    expect(reportFired(report).length).toBeGreaterThan(0);
    expect(renderReport(report)).toContain("STALE-CLEARANCE");
    rmSync(root, { recursive: true, force: true });
  });

  it("runs CLI evaluate and clear", () => {
    const root = makeProject();
    expect(cmdVerifyJudgmentGates(["--path", "secrets/x", "--project-root", root])).toBe(0);
    expect(
      cmdVerifyJudgmentGates([
        "--enforce",
        "--quiet",
        "--path",
        "secrets/x",
        "--project-root",
        root,
      ]),
    ).toBe(1);
    expect(cmdVerifyJudgmentGates(["--json", "--path", "AGENTS.md", "--project-root", root])).toBe(
      0,
    );
    expect(cmdVerifyJudgmentGates(["--unknown", "--project-root", root])).toBe(2);
    expect(
      cmdVerifyJudgmentGates([
        "clear",
        "--gate-id",
        "secrets-and-credentials",
        "--path",
        "secrets/x",
        "--project-root",
        root,
      ]),
    ).toBe(0);
    expect(cmdVerifyJudgmentGates(["--project-root", "/nonexistent"])).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("matches body-text and labels evidence", () => {
    const root = makeProject([
      {
        id: "breaking-change",
        class: "declared",
        tier: "block",
        reason: "Body declares a breaking change",
        match: { "body-text": { "any-of": ["BREAKING CHANGE"] } },
      },
    ]);
    const cand: Candidate = {
      paths: [],
      labels: ["security"],
      body: "BREAKING CHANGE ahead",
      state: "open",
      updated_at: "2020-01-01T00:00:00Z",
    };
    const ev = matchEvidence({ "body-text": { "any-of": ["BREAKING CHANGE"] } }, cand, []);
    expect(ev["body-text"]).toContain("BREAKING");
    const report = buildReport(root, cand);
    expect(reportBlocking(report).length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("judgment-policy", () => {
  it("validates and resolves policy", () => {
    expect(validateJudgmentGates(null)).toEqual([]);
    expect(validateJudgmentGates("bad").length).toBeGreaterThan(0);
    expect(validateJudgmentGatesDisabled(["id"]).length).toBe(0);

    const root = mkdtempSync(join(tmpdir(), "pol-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          policy: {
            judgmentGates: [
              {
                id: "g1",
                class: "mechanical",
                tier: "block",
                reason: "r",
                match: { paths: { "any-of": ["x/**"] } },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const policy = resolveJudgmentGates(root);
    expect(policy.source).toBe("typed");
    expect(policy.gates.length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});
