import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveJudgmentGates,
  validateJudgmentGates,
  validateJudgmentGatesDisabled,
} from "./judgment-policy.js";
import { matchAny, matchPath, normalizePath } from "./pathspec.js";
import {
  cmdProbeSession,
  detectGitBranch,
  guardProbeArtifact,
  markComplete,
  ProbeHandoffBlockedError,
  parseProbeSessionArgs,
  readSession,
  recordDecision,
  requireHandoffAllowed,
  resolvedDecisionFromDict,
  STATE_COMPLETE,
  sessionToDict,
  setCurrentBranch,
  startSession,
} from "./probe-session.js";
import {
  defaultScratchDir,
  parseHeartbeatFile,
  recordToDict,
  renderText,
  sweepAllOk,
  sweepScratchDirs,
  sweepToDict,
  sweepToJson,
} from "./subagent-monitor.js";
import {
  cmdVerifyInvestigation,
  loadLedger,
  parseVerifyInvestigationArgs,
  validateLedger,
} from "./verify-investigation.js";
import {
  buildReport,
  clearanceLogPath,
  cmdVerifyJudgmentGates,
  effectiveGates,
  evaluate,
  fingerprintScope,
  matchEvidence,
  outcomeBlocking,
  outcomeCleared,
  outcomeFired,
  readClearances,
  recordClearance,
  renderReport,
  reportFired,
} from "./verify-judgment-gates.js";

describe("orchestration coverage boost", () => {
  it("judgment-policy validation branches", () => {
    expect(
      validateJudgmentGates([
        { id: "", class: "mechanical", tier: "block", reason: "r", match: {} },
      ]),
    ).not.toEqual([]);
    expect(
      validateJudgmentGates([
        {
          id: "a",
          class: "mechanical",
          tier: "block",
          reason: "r",
          match: { paths: { "any-of": ["x"] } },
        },
        {
          id: "a",
          class: "mechanical",
          tier: "block",
          reason: "r",
          match: { paths: { "any-of": ["y"] } },
        },
      ]).some((e) => e.includes("duplicates")),
    ).toBe(true);
    expect(validateJudgmentGatesDisabled([""]).length).toBeGreaterThan(0);
    expect(validateJudgmentGatesDisabled("x").length).toBeGreaterThan(0);
    expect(resolveJudgmentGates("/nonexistent-root-xyz")).toMatchObject({ source: "default" });
    expect(
      validateJudgmentGates([
        {
          id: "g",
          class: "nope",
          tier: "nope",
          reason: "",
          match: { typo: true },
          requiredHumanReviewers: -1,
        },
      ]).length,
    ).toBeGreaterThan(3);
    const badRoot = mkdtempSync(join(tmpdir(), "pol-bad-"));
    mkdirSync(join(badRoot, "vbrief"), { recursive: true });
    writeFileSync(
      join(badRoot, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        plan: {
          policy: {
            judgmentGates: [
              { id: "g", class: "mechanical", tier: "block", reason: "r", match: {} },
            ],
          },
        },
      }),
      "utf8",
    );
    expect(resolveJudgmentGates(badRoot).source).toBe("default-on-error");
    rmSync(badRoot, { recursive: true, force: true });
  });

  it("probe-session read/write edge cases", () => {
    const root = mkdtempSync(join(tmpdir(), "probe-edge-"));
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "probe-session.json"), "not-json", "utf8");
    expect(readSession(root)).toBeNull();

    writeFileSync(
      join(root, ".deft", "probe-session.json"),
      JSON.stringify({ schemaVersion: 2 }),
      "utf8",
    );
    expect(readSession(root)).toBeNull();

    startSession(root, { target: "t", currentBranch: "b", now: new Date("2026-06-19T12:00:00Z") });
    expect(() => recordDecision(root, { question: "", answer: "a", status: "locked" })).toThrow();
    expect(() => recordDecision(root, { question: "q", answer: "a", status: "bad" })).toThrow();
    expect(detectGitBranch(root, () => ({ status: 1, stdout: "" }))).toBe("");
    expect(detectGitBranch(root, () => ({ status: 0, stdout: "main\n" }))).toBe("main");
    let call = 0;
    expect(
      detectGitBranch(root, () => {
        call += 1;
        return call === 1 ? { status: 0, stdout: "" } : { status: 0, stdout: "abc\n" };
      }),
    ).toBe("detached:abc");

    expect(resolvedDecisionFromDict(null)).toBeNull();
    expect(resolvedDecisionFromDict({ question: "q", answer: "a", status: "nope" })).toBeNull();
    const s = readSession(root);
    expect(s && sessionToDict(s).schemaVersion).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("subagent-monitor render and sweep edge cases", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-edge-"));
    const scratch = join(root, "s");
    mkdirSync(scratch, { recursive: true });
    const now = new Date("2026-06-19T14:00:00Z");
    writeFileSync(
      join(scratch, "a.json"),
      JSON.stringify({
        agent_id: "a",
        parent_id: "p",
        last_heartbeat_at: "2026-06-19T13:59:00Z",
        last_message: "m",
        phase: "polling",
      }),
      "utf8",
    );
    const sweep = sweepScratchDirs([{ readPath: scratch, label: scratch }], {
      thresholdMinutes: 30,
      now,
    });
    expect(sweepAllOk(sweep)).toBe(true);
    expect(renderText(sweep)).toContain("ALL AGENTS ALIVE");

    writeFileSync(join(scratch, "bad.json"), JSON.stringify([]), "utf8");
    const bad = parseHeartbeatFile(join(scratch, "bad.json"), { now, thresholdSeconds: 60 });
    expect(bad.failures.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("verify-investigation hard-failure branches", () => {
    const data = {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        status: "completed",
        items: [
          {
            id: "b",
            status: "completed",
            items: [{ id: "c", status: "completed", metadata: { "x-claim": {} } }],
          },
          { id: "bf", status: "failed", items: [] },
        ],
        edges: [],
        references: [],
        metadata: {
          "x-investigation": { profile: "forensic-research-v1", wavesCompleted: { "1": true } },
        },
      },
    };
    const result = validateLedger(data);
    expect(result.hard_failures.some((f) => f.code === "HF-WAVES")).toBe(true);
    expect(result.hard_failures.some((f) => f.code === "HF-COMPLETED-CLAIM")).toBe(true);
    expect(result.hard_failures.some((f) => f.code === "HF-BRANCH-NO-EDGE")).toBe(true);

    const root = mkdtempSync(join(tmpdir(), "inv-edge-"));
    writeFileSync(join(root, "x.json"), '{"plan":{}}', "utf8");
    expect(() => loadLedger(join(root, "x.json"))).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it("verify-judgment-gates matching branches", () => {
    const root = mkdtempSync(join(tmpdir(), "jg-edge-"));
    for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "vbrief", f), { recursive: true });
    }
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          policy: {
            judgmentGates: [
              {
                id: "lbl",
                class: "declared",
                tier: "review",
                reason: "label gate",
                match: { labels: { "all-of": ["a", "b"] } },
              },
            ],
            judgmentGatesDisabled: ["production-infrastructure"],
          },
        },
      }),
      "utf8",
    );
    expect(effectiveGates(root).some((g) => g.id === "lbl")).toBe(true);
    const cand = {
      paths: [] as string[],
      labels: ["a", "b"],
      body: "",
      state: "open" as const,
      updated_at: "2010-01-01T00:00:00Z",
    };
    const report = buildReport(root, cand, { now: new Date("2026-06-19T12:00:00Z") });
    expect(report.outcomes.length).toBeGreaterThan(0);
    expect(
      readClearances(join(root, "nope", "log.jsonl"), join(root, "nope", "log.jsonl")),
    ).toEqual([]);

    const ev = matchEvidence(
      { paths: ["a"], labels: { "any-of": ["x"] }, state: "open", "age-days": { gt: 1 } },
      { paths: ["a"], labels: ["x"], body: "b", state: "open", updated_at: "2010-01-01T00:00:00Z" },
      ["a"],
    );
    expect(ev.paths).toEqual(["a"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("verify-judgment-gates CLI and mechanical clearance", () => {
    const root = mkdtempSync(join(tmpdir(), "jg-cli-"));
    for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "vbrief", f), { recursive: true });
    }
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { items: [], policy: {} } }),
      "utf8",
    );
    expect(cmdVerifyJudgmentGates(["--bad", "--project-root", root])).toBe(2);
    const scope = fingerprintScope({ paths: ["secrets/x"] });
    recordClearance(root, { gate_id: "secrets-and-credentials", cleared_scope: scope });
    expect(
      evaluate(
        root,
        { paths: ["secrets/x"], labels: [], body: "", state: "open", updated_at: null },
        { posture: "enforce" },
      )[0],
    ).toBe(0);
    expect(
      cmdVerifyJudgmentGates([
        "clear",
        "--gate-id",
        "secrets-and-credentials",
        "--path",
        "secrets/y",
        "--label",
        "sec",
        "--body",
        "text",
        "--state",
        "open",
        "--updated-at",
        "",
        "--reviewer",
        "alice",
        "--actor",
        "bot",
        "--reason",
        "ok",
        "--project-root",
        root,
      ]),
    ).toBe(0);
    const report = buildReport(root, {
      paths: ["AGENTS.md"],
      labels: [],
      body: "",
      state: "closed",
      updated_at: null,
    });
    expect(renderReport(report)).toContain("agents-md-and-skills");
    rmSync(root, { recursive: true, force: true });
  });

  it("pathspec edge cases", () => {
    expect(normalizePath("a\\b\\c")).toBe("a/b/c");
    expect(matchPath("src/*.ts", "src/index.ts")).toBe(true);
    expect(matchPath("src/?.ts", "src/x.ts")).toBe(true);
    expect(matchPath("src/?.ts", "src/xy.ts")).toBe(false);
    expect(matchPath("**/foo", "a/b/foo")).toBe(true);
    expect(matchPath("foo**bar", "foobar")).toBe(false);
    expect(matchAny(["**/*.pem"], "")).toBe(false);
    expect(matchPath("x", "")).toBe(false);
    expect(matchPath("", "x")).toBe(false);
  });

  it("judgment-policy full validation surface", () => {
    expect(
      validateJudgmentGates([
        {
          id: "ok",
          class: "declared",
          tier: "review",
          reason: "r",
          match: {
            labels: { "all-of": ["a", "b"] },
            state: "open",
            "age-days": { gt: 3 },
          },
        },
      ]),
    ).toEqual([]);
    expect(
      validateJudgmentGates([
        {
          id: "bad-labels",
          class: "mechanical",
          tier: "block",
          reason: "r",
          match: { labels: { "any-of": ["x"], "all-of": ["y"] } },
        },
      ]).some((e) => e.includes("mutually exclusive")),
    ).toBe(true);
    expect(
      validateJudgmentGates([
        {
          id: "bad-paths",
          class: "mechanical",
          tier: "block",
          reason: "r",
          match: { paths: {} },
        },
      ]).some((e) => e.includes("any-of")),
    ).toBe(true);
    expect(
      validateJudgmentGates([
        {
          id: "bad-state",
          class: "mechanical",
          tier: "block",
          reason: "r",
          match: { state: "draft" },
        },
      ]).some((e) => e.includes("state must be")),
    ).toBe(true);
    expect(
      validateJudgmentGates([
        {
          id: "bad-age",
          class: "mechanical",
          tier: "block",
          reason: "r",
          match: { "age-days": { gt: -1 } },
        },
      ]).some((e) => e.includes("age-days")),
    ).toBe(true);
    expect(validateJudgmentGates([42]).some((e) => e.includes("must be an object"))).toBe(true);

    const disabledRoot = mkdtempSync(join(tmpdir(), "pol-dis-"));
    mkdirSync(join(disabledRoot, "vbrief"), { recursive: true });
    writeFileSync(
      join(disabledRoot, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        plan: { policy: { judgmentGatesDisabled: ["production-infrastructure"] } },
      }),
      "utf8",
    );
    const disabledPolicy = resolveJudgmentGates(disabledRoot);
    expect(disabledPolicy.source).toBe("typed");
    expect(disabledPolicy.disabled).toContain("production-infrastructure");
    rmSync(disabledRoot, { recursive: true, force: true });
  });

  it("probe-session blocked and idempotent paths", () => {
    const root = mkdtempSync(join(tmpdir(), "probe-block-"));
    startSession(root, { target: "t", currentBranch: "b", now: new Date("2026-06-19T12:00:00Z") });
    markComplete(root, new Date("2026-06-19T13:00:00Z"));
    expect(() => recordDecision(root, { question: "q", answer: "a", status: "locked" })).toThrow(
      ProbeHandoffBlockedError,
    );
    expect(() => setCurrentBranch(root, "x")).toThrow(ProbeHandoffBlockedError);
    expect(markComplete(root).state).toBe(STATE_COMPLETE);
    expect(() => requireHandoffAllowed(root, "test")).not.toThrow();
    expect(() => guardProbeArtifact(root, "out.json")).not.toThrow();
    expect(() => startSession(root, { target: "" })).toThrow();
    expect(parseProbeSessionArgs(["--project-root=.", "start", "--target=foo"]).target).toBe("foo");
    expect(parseProbeSessionArgs(["--project-root=.", "set-branch", "--branch=dev"]).branch).toBe(
      "dev",
    );
    const noSession = mkdtempSync(join(tmpdir(), "probe-nosess-"));
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
        noSession,
      ]),
    ).toBe(1);
    rmSync(noSession, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });

    const empty = mkdtempSync(join(tmpdir(), "probe-empty-"));
    expect(() => requireHandoffAllowed(empty, "act")).toThrow(ProbeHandoffBlockedError);
    rmSync(empty, { recursive: true, force: true });
  });

  it("verify-investigation ledger branches", () => {
    const root = mkdtempSync(join(tmpdir(), "inv-br-"));
    writeFileSync(join(root, "bad.json"), "not json", "utf8");
    expect(() => loadLedger(join(root, "bad.json"))).toThrow();

    const ledger = {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        status: "completed",
        items: [
          {
            id: "b1",
            status: "completed",
            items: [
              {
                id: "c1",
                status: "failed",
                metadata: { "x-claim": {} },
              },
            ],
          },
          { id: "b2", status: "completed", items: [] },
          { id: "b3", status: "completed", items: [] },
        ],
        edges: [],
        references: [],
        metadata: {
          "x-investigation": {
            profile: "forensic-research-v1",
            wavesCompleted: { "1": true, "2": true, "3": true, "4": true },
          },
        },
      },
    };
    const path = join(root, "ledger.json");
    writeFileSync(path, JSON.stringify(ledger), "utf8");
    const result = validateLedger(ledger);
    expect(result.hard_failures.some((f) => f.code === "HF-FAILED-CLAIM")).toBe(true);
    expect(result.soft_warnings.some((f) => f.code === "SW-MULTI-SURVIVOR")).toBe(true);
    expect(cmdVerifyInvestigation(["--ledger", path])).toBe(1);
    expect(parseVerifyInvestigationArgs(["--bad"]).error).toBeDefined();
    expect(cmdVerifyInvestigation(["--ledger", join(root, "nope.json"), "--json"])).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("verify-judgment-gates outcome helpers and clearances", () => {
    const root = mkdtempSync(join(tmpdir(), "jg-out-"));
    for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "vbrief", f), { recursive: true });
    }
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { items: [], policy: {} } }),
      "utf8",
    );
    mkdirSync(join(root, "vbrief", ".audit"), { recursive: true });
    writeFileSync(
      clearanceLogPath(root),
      '{"gate_id":"g","cleared_scope":"abc"}\n{broken\n',
      "utf8",
    );
    expect(readClearances(root).length).toBe(1);

    const report = buildReport(root, {
      paths: ["AGENTS.md"],
      labels: [],
      body: "",
      state: "open",
      updated_at: null,
    });
    const fired = reportFired(report);
    expect(fired.length).toBeGreaterThan(0);
    const first = fired[0];
    expect(first).toBeDefined();
    if (first) {
      expect(outcomeFired(first)).toBe(true);
      expect(outcomeCleared(first)).toBe(false);
      expect(outcomeBlocking(first)).toBe(true);
    }

    recordClearance(root, { gate_id: "g", cleared_scope: fingerprintScope({ paths: ["x"] }) });
    const clearedReport = buildReport(root, {
      paths: ["secrets/x"],
      labels: [],
      body: "",
      state: "open",
      updated_at: null,
    });
    const cleared = clearedReport.outcomes.find((o) => o.gate_id === "secrets-and-credentials");
    if (cleared) {
      expect(outcomeCleared(cleared)).toBe(false);
    }

    expect(
      matchEvidence(
        { labels: { "all-of": ["a", "b"] }, state: "closed" },
        { paths: [], labels: ["a"], body: "", state: "closed", updated_at: null },
        [],
      ).labels,
    ).toEqual(["a"]);

    expect(effectiveGates(root).some((g) => g.id === "secrets-and-credentials")).toBe(true);
    expect(cmdVerifyJudgmentGates(["--json", "--project-root", root])).toBe(0);
    expect(cmdVerifyJudgmentGates(["clear", "--project-root", "/nonexistent-clear"])).toBe(2);

    const policyErrRoot = mkdtempSync(join(tmpdir(), "jg-pol-"));
    mkdirSync(join(policyErrRoot, "vbrief"), { recursive: true });
    writeFileSync(
      join(policyErrRoot, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        plan: {
          policy: {
            judgmentGates: [{ id: "", class: "nope", tier: "nope", reason: "", match: {} }],
          },
        },
      }),
      "utf8",
    );
    const errReport = buildReport(policyErrRoot, {
      paths: [],
      labels: [],
      body: "",
      state: "open",
      updated_at: null,
    });
    expect(errReport.policy_error).not.toBeNull();
    expect(renderReport(errReport)).toContain("policy self-healed");

    const gateRoot = mkdtempSync(join(tmpdir(), "jg-all-"));
    for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(gateRoot, "vbrief", f), { recursive: true });
    }
    writeFileSync(
      join(gateRoot, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          items: [],
          policy: {
            judgmentGates: [
              {
                id: "label-gate",
                class: "declared",
                tier: "review",
                reason: "needs both labels",
                match: { labels: { "all-of": ["sec", "urgent"] } },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    expect(
      evaluate(
        gateRoot,
        {
          paths: [],
          labels: ["sec", "urgent"],
          body: "",
          state: "open",
          updated_at: "2010-01-01T00:00:00Z",
        },
        { posture: "enforce" },
      )[0],
    ).toBe(0);
    rmSync(policyErrRoot, { recursive: true, force: true });
    rmSync(gateRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("subagent-monitor sweep serialization", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-ser-"));
    const scratch = join(root, "s");
    mkdirSync(scratch, { recursive: true });
    const now = new Date("2026-06-19T14:00:00Z");
    writeFileSync(
      join(scratch, "ok.json"),
      JSON.stringify({
        agent_id: "ok",
        parent_id: "p",
        last_heartbeat_at: "2026-06-19T13:59:30Z",
        last_message: "m",
        phase: "polling",
      }),
      "utf8",
    );
    const rec = parseHeartbeatFile(join(scratch, "ok.json"), { now, thresholdSeconds: 60 });
    expect(recordToDict(rec).agent_id).toBe("ok");
    const sweep = sweepScratchDirs([{ readPath: scratch, label: "scratch-a" }], {
      thresholdMinutes: 30,
      now,
    });
    expect(sweepAllOk(sweep)).toBe(true);
    expect(sweepToJson(sweep)).toContain("threshold_minutes");
    expect(sweepToDict(sweep).scratch_dirs).toBeDefined();
    expect(defaultScratchDir(root)).toContain(".deft-scratch");
    expect(renderText(sweep)).toContain("ALL AGENTS ALIVE");
    rmSync(root, { recursive: true, force: true });
  });
});
