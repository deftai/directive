import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readSmallChangeLaneMarker,
  SMALL_CHANGE_LANE_MARKER_KEY,
  type SmallChangeLaneGitRunner,
} from "../policy/small-change-lane.js";
import { evaluateVerifyAcFromPlan } from "../product-first-done-gate/evaluate.js";
import { isCodeBearingScope, resolvePlanGithubIssueRef } from "../scope/delivery-evidence.js";
import { readDeclaredArtifactScope } from "../verify-ac/clauses.js";
import {
  checkCommandBackedAcceptance,
  emitThinBrief,
  emitThinBriefFromFull,
  escalateThinBriefToFullShape,
} from "./thin-brief.js";

const STATED = {
  commands: [{ command: "npx vitest run packages/core/src/a.test.ts" }],
  none_stated: false,
  source_rung: "stated",
};

const INPUT = {
  title: "fix: off-by-one in a",
  issue: { repository: "deftai/directive", issueNumber: 42 },
  fileScope: ["packages/core/src/a.ts", "packages/core/src/a.test.ts"],
  acceptance: STATED,
  admitBase: "a".repeat(40),
};

function emitted(): Record<string, unknown> {
  const r = emitThinBrief(INPUT);
  if (!r.ok) throw new Error(r.reason);
  return r.brief;
}

function planOf(brief: Record<string, unknown>): Record<string, unknown> {
  return brief.plan as Record<string, unknown>;
}

/** Fake git for the lane measurement: one production file with the given line count. */
function laneGit(lines: number): SmallChangeLaneGitRunner {
  return (args) => {
    const joined = args.join(" ");
    if (joined.startsWith("rev-parse --show-toplevel")) return { status: 0, stdout: "/repo\n" };
    if (joined.startsWith("rev-parse --verify"))
      return { status: 0, stdout: `${"a".repeat(40)}\n` };
    if (joined.startsWith("diff --numstat")) {
      return { status: 0, stdout: `${lines}\t0\tpackages/core/src/a.ts\0` };
    }
    if (joined.startsWith("ls-files")) return { status: 0, stdout: "" };
    if (joined.includes("diff -U0")) {
      return {
        status: 0,
        stdout: "diff --git a/packages/core/src/a.ts b/packages/core/src/a.ts\n+const x = 1;\n",
      };
    }
    return { status: 1, stdout: "" };
  };
}

const LANE = { depth: "rapid" as const, bound: { maxProductionFiles: 1, maxChangedLines: 5 } };

describe("emitThinBrief (#6204 thin shape)", () => {
  it("writes only title, issue ref, file_scope and acceptance commands inside xBRIEF 0.8", () => {
    const brief = emitted();
    expect(brief.xBRIEFInfo).toEqual({ version: "0.8" });
    const plan = planOf(brief);
    expect(Object.keys(plan).sort()).toEqual(
      ["acceptance", "items", "metadata", "references", "status", "title"].sort(),
    );
    expect(plan.items).toEqual([]);
    expect(plan.narratives).toBeUndefined();
    expect(plan.acceptance).toEqual(STATED);
    const metadata = plan.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([SMALL_CHANGE_LANE_MARKER_KEY, "swarm"].sort());
    expect(metadata.swarm).toEqual({ file_scope: INPUT.fileScope });
    expect(readSmallChangeLaneMarker(plan)).toMatchObject({
      present: true,
      ok: true,
      marker: { state: "admitted", admitBase: INPUT.admitBase },
    });
  });

  it("keeps delivery identity in the native locations (#3041 / #3675)", () => {
    const plan = planOf(emitted());
    expect(resolvePlanGithubIssueRef(plan)).toEqual({
      repository: "deftai/directive",
      issueNumber: 42,
    });
    expect(isCodeBearingScope(plan)).toBe(true);
    expect(readDeclaredArtifactScope(plan)).toEqual(INPUT.fileScope);
  });

  it("keeps an existing plan.id as scope identity", () => {
    const r = emitThinBrief({ ...INPUT, planId: "github.issue.42" });
    expect(r.ok && planOf(r.brief).id).toBe("github.issue.42");
  });

  it("keeps the full shape when acceptance is not command-backed", () => {
    const cases: unknown[] = [
      undefined,
      { commands: [], none_stated: true, source_rung: "derived" },
      { ...STATED, source_rung: "derived" },
      { ...STATED, none_stated: true },
      { ...STATED, commands: [{ command: " " }] },
      { ...STATED, clauses: [{ id: 1, text: "x" }] },
    ];
    for (const acceptance of cases) {
      const r = emitThinBrief({ ...INPUT, acceptance });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.keep).toBe("full-shape");
    }
    expect(checkCommandBackedAcceptance(STATED).ok).toBe(true);
  });

  it("keeps the full shape on missing identity inputs", () => {
    expect(emitThinBrief({ ...INPUT, title: " " }).ok).toBe(false);
    expect(emitThinBrief({ ...INPUT, issue: { repository: "bad", issueNumber: 1 } }).ok).toBe(
      false,
    );
    expect(emitThinBrief({ ...INPUT, issue: { repository: "o/r", issueNumber: 0 } }).ok).toBe(
      false,
    );
    expect(emitThinBrief({ ...INPUT, fileScope: [] }).ok).toBe(false);
    expect(emitThinBrief({ ...INPUT, admitBase: "" }).ok).toBe(false);
  });
});

describe("emitThinBriefFromFull", () => {
  const full = {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: "github.issue.42",
      title: INPUT.title,
      status: "running",
      narratives: { Description: "long" },
      items: [{ title: "clause", status: "proposed" }],
      references: [
        { uri: "https://github.com/deftai/directive/issues/42", type: "x-xbrief/github-issue" },
      ],
      acceptance: STATED,
      metadata: { swarm: { file_scope: INPUT.fileScope } },
    },
  };

  it("emits a thin brief from a command-backed full brief", () => {
    const r = emitThinBriefFromFull(full, { admitBase: INPUT.admitBase });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(planOf(r.brief).id).toBe("github.issue.42");
    expect(planOf(r.brief).narratives).toBeUndefined();
  });

  it("leaves a derived-acceptance brief untouched and keeps the full shape", () => {
    const derived = structuredClone(full);
    derived.plan.acceptance = {
      commands: [],
      none_stated: true,
      source_rung: "derived",
      clauses: [{ id: 1, text: "behaviour" }],
    } as never;
    const before = structuredClone(derived);
    const r = emitThinBriefFromFull(derived, { admitBase: INPUT.admitBase });
    expect(r.ok).toBe(false);
    expect(derived).toEqual(before);
    expect(emitThinBriefFromFull({}, { admitBase: "x" }).ok).toBe(false);
    expect(emitThinBriefFromFull({ plan: { title: "x" } }, { admitBase: "x" }).ok).toBe(false);
  });
});

describe("escalateThinBriefToFullShape (#6204 lane exit)", () => {
  it("converts in place, keeping scope identity and acceptance evidence", () => {
    const thin = emitThinBrief({ ...INPUT, planId: "github.issue.42" });
    if (!thin.ok) throw new Error(thin.reason);
    const r = escalateThinBriefToFullShape(thin.brief);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = planOf(thin.brief);
    const after = planOf(r.brief);
    expect(after.id).toBe(before.id);
    expect(after.status).toBe(before.status);
    expect(after.references).toEqual(before.references);
    expect(after.acceptance).toEqual(before.acceptance);
    expect(readDeclaredArtifactScope(after)).toEqual(INPUT.fileScope);
    expect((after.narratives as Record<string, string>).Description).toBe(INPUT.title);
    expect((after.items as unknown[]).length).toBe(1);
    expect(readSmallChangeLaneMarker(after)).toMatchObject({
      ok: true,
      marker: { state: "escalated", admitBase: INPUT.admitBase },
    });
  });

  it("refuses a brief outside the lane or without commands", () => {
    expect(escalateThinBriefToFullShape({ plan: { title: "x" } }).ok).toBe(false);
    expect(escalateThinBriefToFullShape(null).ok).toBe(false);
    const thin = emitted();
    const noCommands = structuredClone(thin);
    (planOf(noCommands).acceptance as Record<string, unknown>).commands = [];
    expect(escalateThinBriefToFullShape(noCommands).ok).toBe(false);
    const badMarker = structuredClone(thin);
    (planOf(badMarker).metadata as Record<string, unknown>)[SMALL_CHANGE_LANE_MARKER_KEY] = {};
    expect(escalateThinBriefToFullShape(badMarker).ok).toBe(false);
  });
});

describe("verify:ac admit surface for the thin shape (#6204)", () => {
  it("admits the thin shape and runs its acceptance commands", () => {
    const runner = vi.fn(() => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    const r = evaluateVerifyAcFromPlan(planOf(emitted()), {
      projectRoot: mkdtempSync(join(tmpdir(), "thin-brief-ac-")),
      runner,
      applyOracleIntegrity: false,
      reuseMode: "never",
      bankOnPass: false,
      skipAcceptanceEmit: true,
      smallChangeLane: { ...LANE, runGit: laneGit(3) },
    });
    expect(r.ok).toBe(true);
    expect(r.runs.length).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("refuses past the bound before running any command, on every retry", () => {
    const runner = vi.fn(() => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const r = evaluateVerifyAcFromPlan(planOf(emitted()), {
        projectRoot: mkdtempSync(join(tmpdir(), "thin-brief-ac-")),
        runner,
        applyOracleIntegrity: false,
        reuseMode: "never",
        bankOnPass: false,
        skipAcceptanceEmit: true,
        smallChangeLane: { ...LANE, runGit: laneGit(50) },
      });
      expect(r.ok).toBe(false);
      expect(r.message).toContain("verify:ac refused (#6204)");
      expect(r.message).toContain("escalate-to-full-shape");
    }
    expect(runner).not.toHaveBeenCalled();
  });
});
