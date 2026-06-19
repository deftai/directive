import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveJudgmentGates, validateJudgmentGates } from "./judgment-policy.js";
import { cmdProbeSession, markComplete, startSession } from "./probe-session.js";
import {
  cmdSubagentMonitor,
  EXIT_EXTERNAL_ERROR,
  parseHeartbeatFile,
  parseIso8601Utc,
  parseSubagentMonitorArgs,
  renderText,
  sweepScratchDirs,
} from "./subagent-monitor.js";
import {
  cmdVerifyInvestigation,
  loadLedger,
  parseVerifyInvestigationArgs,
  validateLedger,
} from "./verify-investigation.js";
import {
  buildReport,
  cmdVerifyJudgmentGates,
  evaluate,
  fingerprintScope,
  matchEvidence,
  recordClearance,
  renderReport,
} from "./verify-judgment-gates.js";

function jgProject(gates?: unknown[], disabled?: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "jg-bc-"));
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

describe("subagent-monitor branch coverage", () => {
  it("parse arg error and equals forms", () => {
    expect(parseSubagentMonitorArgs(["--scratch-dir"]).error).toContain("--scratch-dir");
    expect(parseSubagentMonitorArgs(["--threshold-minutes"]).error).toContain(
      "--threshold-minutes",
    );
    expect(parseSubagentMonitorArgs(["--scratch-dir=foo"]).scratchDirs).toEqual(["foo"]);
    expect(parseSubagentMonitorArgs(["--threshold-minutes=15"]).thresholdMinutes).toBe(15);
    expect(parseSubagentMonitorArgs(["-h"]).error).toBeUndefined();
    expect(parseSubagentMonitorArgs(["--json"]).emitJson).toBe(true);
  });

  it("parseIso8601Utc non-string and non-utc offset", () => {
    expect(parseIso8601Utc(123 as unknown as string)).toBeNull();
    expect(parseIso8601Utc("2026-06-19T12:00:00")).toBeNull();
    expect(parseIso8601Utc("not-a-date+00:00")).toBeNull();
  });

  it("render STALE+MALFORMED, TERMINAL, and full field rows", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-bc-"));
    const scratch = join(root, "s");
    mkdirSync(scratch, { recursive: true });
    const now = new Date("2026-06-19T14:00:00Z");

    // Stale + malformed (bad phase) record.
    writeFileSync(
      join(scratch, "stalebad.json"),
      JSON.stringify({
        agent_id: "stalebad",
        parent_id: "p",
        last_heartbeat_at: "2020-01-01T00:00:00Z",
        last_message: "old",
        phase: "not-a-phase",
        pr_number: 42,
        terminal_state: null,
      }),
      "utf8",
    );
    // Terminal record with full fields.
    writeFileSync(
      join(scratch, "term.json"),
      JSON.stringify({
        agent_id: "term",
        parent_id: "p",
        last_heartbeat_at: "2026-06-19T13:59:00Z",
        last_message: "finished",
        phase: "terminal",
        pr_number: 7,
        terminal_state: "succeeded",
      }),
      "utf8",
    );
    const sweep = sweepScratchDirs([{ readPath: scratch, label: "s" }], {
      thresholdMinutes: 30,
      now,
    });
    const text = renderText(sweep);
    expect(text).toContain("STALE+MALFORMED");
    expect(text).toContain("TERMINAL");
    expect(text).toContain("#42");
    expect(text).toContain("Terminal state:");
    rmSync(root, { recursive: true, force: true });
  });

  it("formatAge minute and hour formatting", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-age-"));
    const scratch = join(root, "s");
    mkdirSync(scratch, { recursive: true });
    const now = new Date("2026-06-19T14:00:00Z");
    writeFileSync(
      join(scratch, "mins.json"),
      JSON.stringify({
        agent_id: "mins",
        parent_id: "p",
        last_heartbeat_at: "2026-06-19T13:30:00Z",
        last_message: "m",
        phase: "polling",
      }),
      "utf8",
    );
    const rec = parseHeartbeatFile(join(scratch, "mins.json"), {
      now,
      thresholdSeconds: 3600,
    });
    expect(rec.age_seconds).toBeGreaterThan(60);
    const sweep = sweepScratchDirs([{ readPath: scratch, label: "s" }], {
      thresholdMinutes: 120,
      now,
    });
    expect(renderText(sweep)).toContain("m)");
    rmSync(root, { recursive: true, force: true });
  });

  it("sweep reports file-as-scratch-dir error and empty dir text", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-err-"));
    const filePath = join(root, "afile.txt");
    writeFileSync(filePath, "x", "utf8");
    const sweep = sweepScratchDirs([{ readPath: filePath, label: "afile" }], {
      thresholdMinutes: 30,
    });
    expect(sweep.sweep_errors.some((e) => e.includes("not a directory"))).toBe(true);
    expect(renderText(sweep)).toContain("ATTENTION");

    const emptyDir = join(root, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const emptySweep = sweepScratchDirs([{ readPath: emptyDir, label: "empty" }], {
      thresholdMinutes: 30,
    });
    expect(renderText(emptySweep)).toContain("NO AGENTS TO MONITOR");
    rmSync(root, { recursive: true, force: true });
  });

  it("cmd rejects NaN threshold", () => {
    expect(cmdSubagentMonitor(["--threshold-minutes", "abc"])).toBe(EXIT_EXTERNAL_ERROR);
  });
});

describe("verify-investigation branch coverage", () => {
  function base(): Record<string, unknown> {
    return {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        status: "completed",
        items: [],
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
  }

  it("dangling evidence ref and clean failed claim", () => {
    const data = base();
    (data.plan as Record<string, unknown>).items = [
      {
        id: "b1",
        status: "completed",
        items: [
          {
            id: "c1",
            status: "completed",
            metadata: { "x-claim": { evidenceRefs: ["EV-MISSING"] } },
          },
          {
            id: "c2",
            status: "failed",
            metadata: { "x-claim": { ruledOutReason: "disproved", evidenceRefs: ["EV-1"] } },
          },
        ],
      },
    ];
    (data.plan as Record<string, unknown>).edges = [{ from: "c2", to: "b1", type: "invalidates" }];
    (data.plan as Record<string, unknown>).references = [{ id: "EV-1" }];
    const result = validateLedger(data);
    expect(result.hard_failures.some((f) => f.code === "HF-DANGLING-EV")).toBe(true);
    expect(result.hard_failures.some((f) => f.code === "HF-FAILED-CLAIM")).toBe(false);
  });

  it("blocked claim emits soft warning only", () => {
    const data = base();
    (data.plan as Record<string, unknown>).items = [
      {
        id: "b1",
        status: "completed",
        items: [
          {
            id: "c1",
            status: "completed",
            metadata: { "x-claim": { evidenceRefs: ["EV-1"] } },
          },
          { id: "c2", status: "blocked", metadata: { "x-claim": {} } },
        ],
      },
    ];
    (data.plan as Record<string, unknown>).references = [{ id: "EV-1" }];
    const result = validateLedger(data);
    expect(result.soft_warnings.some((f) => f.code === "SW-BLOCKED")).toBe(true);
    expect(result.hard_failures.length).toBe(0);
  });

  it("loadLedger structural errors", () => {
    const root = mkdtempSync(join(tmpdir(), "inv-bc-"));
    writeFileSync(join(root, "arr.json"), "[1,2]", "utf8");
    expect(() => loadLedger(join(root, "arr.json"))).toThrow(/not an object/);

    writeFileSync(join(root, "noplan.json"), "{}", "utf8");
    expect(() => loadLedger(join(root, "noplan.json"))).toThrow(/missing 'plan'/);

    writeFileSync(join(root, "noitems.json"), JSON.stringify({ plan: {} }), "utf8");
    expect(() => loadLedger(join(root, "noitems.json"))).toThrow(/plan.items/);

    writeFileSync(
      join(root, "wrongprofile.json"),
      JSON.stringify({
        plan: { items: [], metadata: { "x-investigation": { profile: "other" } } },
      }),
      "utf8",
    );
    expect(() => loadLedger(join(root, "wrongprofile.json"))).toThrow(/forensic-research-v1/);
    rmSync(root, { recursive: true, force: true });
  });

  it("parse arg equals and positional forms", () => {
    expect(parseVerifyInvestigationArgs(["--ledger=x.json"]).ledger).toBe("x.json");
    expect(parseVerifyInvestigationArgs(["--project-root=/tmp/foo"]).projectRoot).toBe("/tmp/foo");
    expect(parseVerifyInvestigationArgs(["--project-root", "/tmp/bar"]).projectRoot).toBe(
      "/tmp/bar",
    );
    expect(parseVerifyInvestigationArgs(["pos.json"]).ledger).toBe("pos.json");
    expect(parseVerifyInvestigationArgs(["--json", "--ledger", "y.json"]).emitJson).toBe(true);
  });

  it("cmd json clean path and resolves project-root relative ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "inv-cmd-"));
    const data = base();
    (data.plan as Record<string, unknown>).items = [
      {
        id: "b1",
        status: "completed",
        items: [
          { id: "c1", status: "completed", metadata: { "x-claim": { evidenceRefs: ["EV-1"] } } },
        ],
      },
    ];
    (data.plan as Record<string, unknown>).references = [{ id: "EV-1" }];
    writeFileSync(join(root, "ledger.json"), JSON.stringify(data), "utf8");
    expect(
      cmdVerifyInvestigation(["--ledger", "ledger.json", "--project-root", root, "--json"]),
    ).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("verify-judgment-gates branch coverage", () => {
  it("consumerRuleMatches predicate misses", () => {
    const gate = {
      id: "triage",
      class: "declared",
      tier: "review",
      reason: "triage gate",
      match: {
        state: "open",
        labels: { "any-of": ["x"] },
        "body-text": { "any-of": ["needle"] },
        "age-days": { gt: 5 },
      },
    };
    const root = jgProject([gate]);
    const now = new Date("2026-06-19T12:00:00Z");

    // State mismatch.
    expect(
      buildReport(
        root,
        {
          paths: [],
          labels: ["x"],
          body: "needle",
          state: "closed",
          updated_at: "2010-01-01T00:00:00Z",
        },
        { now },
      ).outcomes.length,
    ).toBe(0);
    // Label miss.
    expect(
      buildReport(
        root,
        {
          paths: [],
          labels: ["y"],
          body: "needle",
          state: "open",
          updated_at: "2010-01-01T00:00:00Z",
        },
        { now },
      ).outcomes.length,
    ).toBe(0);
    // Body-text miss.
    expect(
      buildReport(
        root,
        {
          paths: [],
          labels: ["x"],
          body: "haystack",
          state: "open",
          updated_at: "2010-01-01T00:00:00Z",
        },
        { now },
      ).outcomes.length,
    ).toBe(0);
    // Age within window (not older than gt days) -> miss.
    expect(
      buildReport(
        root,
        { paths: [], labels: ["x"], body: "needle", state: "open", updated_at: now.toISOString() },
        { now },
      ).outcomes.length,
    ).toBe(0);
    // Missing updated_at -> age predicate miss.
    expect(
      buildReport(
        root,
        { paths: [], labels: ["x"], body: "needle", state: "open", updated_at: null },
        { now },
      ).outcomes.length,
    ).toBe(0);
    // Full match.
    expect(
      buildReport(
        root,
        {
          paths: [],
          labels: ["x"],
          body: "NEEDLE here",
          state: "open",
          updated_at: "2010-01-01T00:00:00Z",
        },
        { now },
      ).outcomes.length,
    ).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("matchEvidence age-days with null updated_at yields empty string", () => {
    const ev = matchEvidence(
      { "age-days": { gt: 1 } },
      { paths: [], labels: [], body: "", state: "open", updated_at: null },
      [],
    );
    expect(ev["age-days"]).toBe("");
  });

  it("renderReport stale-clearance status", () => {
    const root = jgProject();
    recordClearance(root, {
      gate_id: "secrets-and-credentials",
      cleared_scope: fingerprintScope({ paths: ["secrets/other.env"] }),
    });
    const report = buildReport(root, {
      paths: ["secrets/prod.env"],
      labels: [],
      body: "",
      state: "open",
      updated_at: null,
    });
    expect(renderReport(report)).toContain("STALE-CLEARANCE");
    rmSync(root, { recursive: true, force: true });
  });

  it("cmd eval with --base-ref stays hermetic on non-git root", () => {
    const root = jgProject();
    // base-ref triggers a git diff which fails (no git repo) and returns []
    expect(cmdVerifyJudgmentGates(["--base-ref", "HEAD", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("cmd json enforce blocking exit 1 and dedup paths", () => {
    const root = jgProject();
    const code = cmdVerifyJudgmentGates([
      "--json",
      "--enforce",
      "--path",
      "secrets/x",
      "--path",
      "secrets/x",
      "--project-root",
      root,
    ]);
    expect(code).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("evaluate advise posture with blocking gate exits 0", () => {
    const root = jgProject();
    const [code] = evaluate(
      root,
      { paths: ["secrets/x"], labels: [], body: "", state: "open", updated_at: null },
      { posture: "advise" },
    );
    expect(code).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("probe-session CLI branch coverage", () => {
  it("set-branch, complete, status json, guard paths", () => {
    const root = mkdtempSync(join(tmpdir(), "probe-bc-"));
    expect(cmdProbeSession(["start", "--target", "scope", "--project-root", root])).toBe(0);
    expect(cmdProbeSession(["set-branch", "--branch", "feat", "--project-root", root])).toBe(0);
    expect(cmdProbeSession(["status", "--project-root", root])).toBe(0);
    expect(cmdProbeSession(["status", "--json", "--project-root", root])).toBe(0);
    expect(cmdProbeSession(["guard-artifact", "--path", "x", "--project-root", root])).toBe(1);
    expect(cmdProbeSession(["guard-plan-registration", "--project-root", root])).toBe(1);
    expect(cmdProbeSession(["complete", "--project-root", root])).toBe(0);
    expect(cmdProbeSession(["guard-plan-registration", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("record bad status returns config error (exit 2)", () => {
    const root = mkdtempSync(join(tmpdir(), "probe-bc2-"));
    startSession(root, { target: "t", currentBranch: "b", now: new Date("2026-06-19T12:00:00Z") });
    expect(
      cmdProbeSession([
        "record",
        "--question",
        "q",
        "--answer",
        "a",
        "--status",
        "bogus",
        "--project-root",
        root,
      ]),
    ).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("markComplete twice is idempotent through CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "probe-bc3-"));
    startSession(root, { target: "t", currentBranch: "b", now: new Date("2026-06-19T12:00:00Z") });
    markComplete(root, new Date("2026-06-19T13:00:00Z"));
    expect(cmdProbeSession(["complete", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("verify-investigation iter/cmd branch coverage", () => {
  function forensic(
    items: unknown[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        status: "completed",
        items,
        edges: [],
        references: [],
        metadata: {
          "x-investigation": {
            profile: "forensic-research-v1",
            wavesCompleted: { "1": true, "2": true, "3": true, "4": true },
          },
        },
        ...extra,
      },
    };
  }

  it("tolerates non-object items, claims, metadata, and edges", () => {
    const data = forensic(
      [
        42,
        null,
        {
          id: "b1",
          status: "completed",
          items: [
            "not-a-claim",
            { status: "completed", metadata: "bad-meta" },
            { id: "c1", status: "completed", metadata: { "x-claim": "not-obj" } },
          ],
        },
      ],
      { edges: [99, { type: "invalidates" }, { type: "other", to: "b1" }] },
    );
    const result = validateLedger(data);
    // claim with no id + non-object metadata -> HF-COMPLETED-CLAIM (no refs)
    expect(result.hard_failures.some((f) => f.code === "HF-COMPLETED-CLAIM")).toBe(true);
  });

  it("validateLedger handles non-object metadata and missing waves", () => {
    const data = forensic([]);
    (data.plan as Record<string, unknown>).metadata = [];
    const result = validateLedger(data);
    expect(result.hard_failures.some((f) => f.code === "HF-WAVES")).toBe(true);
  });

  it("cmd prints soft warnings on clean ledger and json hard-failure exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "inv-cmd2-"));
    // Clean but with a blocked claim -> soft warning surfaces on stdout.
    const warn = forensic([
      {
        id: "b1",
        status: "completed",
        items: [
          { id: "c1", status: "completed", metadata: { "x-claim": { evidenceRefs: ["EV-1"] } } },
          { id: "c2", status: "blocked", metadata: { "x-claim": {} } },
        ],
      },
    ]);
    (warn.plan as Record<string, unknown>).references = [{ id: "EV-1" }];
    writeFileSync(join(root, "warn.json"), JSON.stringify(warn), "utf8");
    expect(cmdVerifyInvestigation(["--ledger", join(root, "warn.json")])).toBe(0);

    const bad = forensic([
      {
        id: "b1",
        status: "completed",
        items: [{ id: "c1", status: "completed", metadata: { "x-claim": {} } }],
      },
    ]);
    writeFileSync(join(root, "bad.json"), JSON.stringify(bad), "utf8");
    expect(cmdVerifyInvestigation(["--ledger", join(root, "bad.json"), "--json"])).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("verify-judgment-gates arg branch coverage", () => {
  it("eval flags label/body/state and project-root= form", () => {
    const root = jgProject([
      {
        id: "state-gate",
        class: "declared",
        tier: "review",
        reason: "state gate",
        match: { state: "closed" },
      },
    ]);
    expect(
      cmdVerifyJudgmentGates([
        `--project-root=${root}`,
        "--label",
        "sec",
        "--body",
        "some text",
        "--state",
        "closed",
      ]),
    ).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("validateJudgmentGates predicate-shape errors", () => {
    function errsFor(match: unknown): string[] {
      return validateJudgmentGates([
        { id: "g", class: "mechanical", tier: "block", reason: "r", match },
      ]);
    }
    // paths predicate variants
    expect(errsFor({ paths: "str" }).some((e) => e.includes("paths"))).toBe(true);
    expect(errsFor({ paths: {} }).some((e) => e.includes("any-of"))).toBe(true);
    expect(errsFor({ paths: { "any-of": "x" } }).some((e) => e.includes("non-empty list"))).toBe(
      true,
    );
    expect(errsFor({ paths: { "any-of": [] } }).some((e) => e.includes("non-empty list"))).toBe(
      true,
    );
    expect(errsFor({ paths: { "any-of": [1] } }).some((e) => e.includes("non-empty string"))).toBe(
      true,
    );
    // labels predicate variants
    expect(errsFor({ labels: "str" }).some((e) => e.includes("must be an object"))).toBe(true);
    expect(errsFor({ labels: {} }).some((e) => e.includes("any-of"))).toBe(true);
    // body-text predicate variants
    expect(errsFor({ "body-text": "str" }).some((e) => e.includes("must be an object"))).toBe(true);
    expect(errsFor({ "body-text": {} }).some((e) => e.includes("any-of"))).toBe(true);
    // age-days predicate variant
    expect(errsFor({ "age-days": "str" }).some((e) => e.includes("must be an object"))).toBe(true);
    // match itself non-object / empty
    expect(errsFor("str").some((e) => e.includes("must be an object"))).toBe(true);
    expect(errsFor({}).some((e) => e.includes("requires at least one"))).toBe(true);
    // extra unrecognised predicate
    expect(
      errsFor({ paths: { "any-of": ["x"] }, bogus: true }).some((e) => e.includes("unrecognised")),
    ).toBe(true);
  });

  it("resolveJudgmentGates with non-object plan/policy blocks", () => {
    const root1 = mkdtempSync(join(tmpdir(), "pol-pl-"));
    mkdirSync(join(root1, "vbrief"), { recursive: true });
    writeFileSync(
      join(root1, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: [1, 2, 3] }),
      "utf8",
    );
    expect(resolveJudgmentGates(root1).source).toBe("default");
    rmSync(root1, { recursive: true, force: true });

    const root2 = mkdtempSync(join(tmpdir(), "pol-po-"));
    mkdirSync(join(root2, "vbrief"), { recursive: true });
    writeFileSync(
      join(root2, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: "not-an-object" } }),
      "utf8",
    );
    expect(resolveJudgmentGates(root2).source).toBe("default");
    rmSync(root2, { recursive: true, force: true });
  });

  it("clear handles trailing flags with default fallbacks", () => {
    const root = jgProject();
    // Trailing flags with no value exercise the `?? ""` / `?? null` defaults.
    expect(
      cmdVerifyJudgmentGates([
        "clear",
        "--project-root",
        root,
        "--gate-id",
        "agents-md-and-skills",
        "--label",
        "x",
        "--reviewer",
        "alice",
        "--actor",
        "bot",
        "--updated-at",
        "2020-01-01T00:00:00Z",
        "--reason",
      ]),
    ).toBe(0);
    // Cover remaining trailing-flag default arms one at a time.
    for (const trailing of ["--gate-id", "--path", "--body", "--state", "--reviewer", "--actor"]) {
      expect(cmdVerifyJudgmentGates(["clear", "--project-root", root, trailing])).toBe(0);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("evaluate rejects file path as project-root and json missing-root exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "jg-file-"));
    const filePath = join(dir, "f.txt");
    writeFileSync(filePath, "x", "utf8");
    const [code] = evaluate(filePath, {
      paths: [],
      labels: [],
      body: "",
      state: "open",
      updated_at: null,
    });
    expect(code).toBe(2);
    expect(cmdVerifyJudgmentGates(["--json", "--project-root", join(dir, "nope")])).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
