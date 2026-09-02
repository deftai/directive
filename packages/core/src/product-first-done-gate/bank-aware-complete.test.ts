/**
 * Bank-aware scope:complete + same-session verify:ac cache (#3387).
 *
 * Trial: activate → implement → verify:ac green → scope:complete → check.
 * Acceptance commands execute once; events record served_from.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import { evaluateScopeCompleteAcceptanceWalk } from "../scope/acceptance-evidence.js";
import { runTransition } from "../scope/transition.js";
import { acPassBankPath, maybeBankOnAcPass } from "../session/ac-pass-banking.js";
import { hashProductState } from "../session/product-state-hash.js";
import { acceptanceLedgersEqual, readAcceptanceLedger } from "./acceptance-resolver.js";
import { evaluateVerifyAcFromPath, evaluateVerifyAcFromPlan } from "./evaluate.js";

function writeBrief(root: string, plan: Record<string, unknown>): string {
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  const path = join(root, "xbrief", "active", "story.xbrief.json");
  writeFileSync(path, JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2), "utf8");
  return path;
}

function parseJsonl(path: string): { event: string; payload: Record<string, unknown> }[] {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { event: string; payload: Record<string, unknown> });
}

describe("bank-aware complete walk (#3387)", () => {
  it("trial fixture executes acceptance commands once; complete=bank, check=cache", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-trial-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");

    const plan: Record<string, unknown> = {
      id: "3387-trial",
      title: "trial",
      status: "running",
      acceptance: {
        commands: [{ command: "task check" }],
        none_stated: true,
        source_rung: "derived",
      },
      metadata: {},
    };
    const brief = writeBrief(root, plan);
    const summary = join(root, "summary.jsonl");
    let executions = 0;
    const runner = () => {
      executions += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const env = {
      DEFT_SESSION_ID: "sess-3387-trial",
      [ENV_RUN_SUMMARY_PATH]: summary,
    };
    const productPaths = ["src/product.txt"];

    const verified = evaluateVerifyAcFromPath(brief, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      env,
      productPaths,
      hasSuiteFloor: true,
    });
    expect(verified.ok).toBe(true);
    expect(verified.servedFrom).toBe("executed");
    expect(executions).toBe(1);

    const complete = evaluateScopeCompleteAcceptanceWalk(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      env,
      productPaths,
      hasSuiteFloor: true,
    });
    expect(complete.ok).toBe(true);
    expect(complete.servedFrom).toBe("bank");
    expect(executions).toBe(1);

    const check = evaluateVerifyAcFromPlan(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      env,
      productPaths,
      hasSuiteFloor: true,
      reuseMode: "auto",
    });
    expect(check.ok).toBe(true);
    expect(check.servedFrom).toBe("cache");
    expect(executions).toBe(1);

    const acceptance = parseJsonl(summary).filter((line) => line.event === "acceptance");
    const sources = acceptance.map((line) => line.payload.served_from);
    expect(sources).toContain("executed");
    expect(sources).toContain("bank");
    expect(sources).toContain("cache");
  });

  it("product file mutation after the bank forces full re-execution", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-stale-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");
    const plan: Record<string, unknown> = {
      id: "3387-stale",
      title: "stale",
      acceptance: {
        commands: [{ command: "task check" }],
        none_stated: true,
        source_rung: "derived",
      },
      metadata: {},
    };
    const brief = writeBrief(root, plan);
    let executions = 0;
    const runner = () => {
      executions += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const productPaths = ["src/product.txt"];
    const first = evaluateVerifyAcFromPath(brief, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      productPaths,
      hasSuiteFloor: true,
    });
    expect(first.ok).toBe(true);
    expect(executions).toBe(1);

    writeFileSync(join(root, "src", "product.txt"), "v2\n", "utf8");
    const walk = evaluateScopeCompleteAcceptanceWalk(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      productPaths,
      hasSuiteFloor: true,
    });
    expect(walk.ok).toBe(true);
    expect(walk.servedFrom).toBe("executed");
    expect(executions).toBe(2);
  });

  it("missing bank runs the full walk; empty acceptance still refuses", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-empty-"));
    writeFileSync(join(root, "src-product.txt"), "x\n", "utf8");
    const empty = evaluateScopeCompleteAcceptanceWalk(
      {
        id: "3387-empty",
        title: "empty",
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      {
        projectRoot: root,
        captureFromNarratives: false,
        hasSuiteFloor: false,
        productPaths: ["src-product.txt"],
      },
    );
    expect(empty.ok).toBe(false);
    expect(empty.message).toMatch(/soft_empty|#3334|#3357/);

    let executions = 0;
    const missing = evaluateScopeCompleteAcceptanceWalk(
      {
        id: "3387-missing-bank",
        title: "missing",
        acceptance: {
          commands: [{ command: "task check" }],
          none_stated: true,
          source_rung: "derived",
        },
      },
      {
        projectRoot: root,
        captureFromNarratives: false,
        productPaths: ["src-product.txt"],
        hasSuiteFloor: true,
        runner: () => {
          executions += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(missing.ok).toBe(true);
    expect(missing.servedFrom).toBe("executed");
    expect(executions).toBe(1);
  });

  it("file_scope without productPaths still serves cache after a green bank", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-fscope-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export const n = 1;\n", "utf8");
    const plan: Record<string, unknown> = {
      id: "3387-fscope",
      title: "fscope",
      acceptance: {
        commands: [{ command: "task check" }],
        none_stated: true,
        source_rung: "derived",
      },
      metadata: { swarm: { file_scope: ["src"] } },
    };
    const brief = writeBrief(root, plan);
    let executions = 0;
    const runner = () => {
      executions += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const env = { DEFT_SESSION_ID: "sess-3387-fscope" };
    expect(
      evaluateVerifyAcFromPath(brief, {
        projectRoot: root,
        captureFromNarratives: false,
        runner,
        env,
        hasSuiteFloor: true,
      }).ok,
    ).toBe(true);
    expect(executions).toBe(1);
    const again = evaluateVerifyAcFromPlan(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      env,
      hasSuiteFloor: true,
    });
    expect(again.servedFrom).toBe("cache");
    expect(executions).toBe(1);
  });

  it("git-status failure still banks then serves; product edit forces executed (#3558)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3558-gitfail-"));
    // Broken gitdir so `git status` fails without walking a parent checkout.
    writeFileSync(join(root, ".git"), "gitdir: missing-gitdir\n", "utf8");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");

    const plan: Record<string, unknown> = {
      id: "3558-gitfail",
      title: "gitfail",
      status: "running",
      acceptance: {
        commands: [{ command: "task check" }],
        none_stated: true,
        source_rung: "derived",
      },
      metadata: {},
    };
    const brief = writeBrief(root, plan);
    mkdirSync(join(root, ".deft"), { recursive: true });
    const summary = join(root, ".deft", "summary.jsonl");
    let executions = 0;
    const runner = () => {
      executions += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const env = {
      DEFT_SESSION_ID: "sess-3558-gitfail",
      [ENV_RUN_SUMMARY_PATH]: summary,
    };

    const verified = evaluateVerifyAcFromPath(brief, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      env,
      hasSuiteFloor: true,
    });
    expect(verified.ok).toBe(true);
    expect(verified.servedFrom).toBe("executed");
    expect(verified.missReason).toBeTruthy();
    expect(executions).toBe(1);

    const complete = evaluateScopeCompleteAcceptanceWalk(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      env,
      hasSuiteFloor: true,
    });
    expect(complete.ok).toBe(true);
    expect(complete.servedFrom).toBe("bank");
    expect(executions).toBe(1);

    const check = evaluateVerifyAcFromPlan(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      env,
      hasSuiteFloor: true,
      reuseMode: "auto",
    });
    expect(check.ok).toBe(true);
    expect(check.servedFrom).toBe("cache");
    expect(executions).toBe(1);

    const lines = parseJsonl(summary);
    const acceptance = lines.filter((line) => line.event === "acceptance");
    const sources = acceptance.map((line) => line.payload.served_from);
    expect(sources).toContain("executed");
    expect(sources).toContain("bank");
    expect(sources).toContain("cache");
    const executed = acceptance.find((line) => line.payload.served_from === "executed");
    expect(typeof executed?.payload.miss_reason).toBe("string");
    expect(String(executed?.payload.miss_reason).length).toBeGreaterThan(0);
    expect(lines.some((line) => line.event === "ac_pass_bank")).toBe(true);

    writeFileSync(join(root, "src", "product.txt"), "v2\n", "utf8");
    const stale = evaluateScopeCompleteAcceptanceWalk(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      env,
      hasSuiteFloor: true,
    });
    expect(stale.servedFrom).toBe("executed");
    expect(executions).toBe(2);
  });

  it("hashProductState changes when a product file changes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-hash-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "a\n", "utf8");
    const plan = { acceptance: { commands: [{ command: "true" }] } };
    const first = hashProductState({
      projectRoot: root,
      plan,
      productPaths: ["src/product.txt"],
    });
    expect(first.complete).toBe(true);
    writeFileSync(join(root, "src", "product.txt"), "b\n", "utf8");
    const second = hashProductState({
      projectRoot: root,
      plan,
      productPaths: ["src/product.txt"],
    });
    expect(second.digest).not.toBe(first.digest);
  });

  it("complete reuses banked green runs for unquoted behavioural clauses (#3993)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3993-clause-bank-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");
    const clauses = [
      {
        id: 1,
        text: "behavioral contract with no machine check against product.txt",
        artifact_path: "src/product.txt",
        ambiguous: false,
        provenance: "statement",
      },
      {
        id: 2,
        text: "another unquoted behavioral claim against the shipped product",
        artifact_path: "src/product.txt",
        ambiguous: false,
        provenance: "statement",
      },
    ];
    const plan: Record<string, unknown> = {
      id: "3993-clause-bank",
      title: "clause-bank",
      status: "running",
      acceptance: {
        commands: [{ command: "task check" }],
        none_stated: true,
        source_rung: "derived",
        ambiguity_attestation: "none_found",
        clauses,
      },
      metadata: { swarm: { file_scope: ["src"] } },
    };
    const brief = writeBrief(root, plan);
    let executions = 0;
    const runner = () => {
      executions += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const productPaths = ["src/product.txt"];
    const verified = evaluateVerifyAcFromPath(brief, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      productPaths,
      hasSuiteFloor: true,
    });
    expect(verified.ok).toBe(true);
    expect(verified.servedFrom).toBe("executed");
    expect(verified.runs.length).toBeGreaterThan(0);
    expect(executions).toBe(1);

    const complete = evaluateScopeCompleteAcceptanceWalk(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      productPaths,
      hasSuiteFloor: true,
    });
    expect(complete.ok).toBe(true);
    expect(complete.servedFrom).toBe("bank");
    expect(executions).toBe(1);
  });

  it("v1 bank without runs field miss-and-executes rather than inventing a green run (#3993)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3993-v1-bank-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");
    const clauses = [
      {
        id: 1,
        text: "behavioral contract with no machine check against product.txt",
        artifact_path: "src/product.txt",
        ambiguous: false,
        provenance: "statement",
      },
      {
        id: 2,
        text: "another unquoted behavioral claim against the shipped product",
        artifact_path: "src/product.txt",
        ambiguous: false,
        provenance: "statement",
      },
    ];
    const plan: Record<string, unknown> = {
      id: "3993-v1-bank",
      title: "v1-bank",
      status: "running",
      acceptance: {
        commands: [{ command: "task check" }],
        none_stated: true,
        source_rung: "derived",
        ambiguity_attestation: "none_found",
        clauses,
      },
      metadata: { swarm: { file_scope: ["src"] } },
    };
    const productPaths = ["src/product.txt"];
    const hashed = hashProductState({ projectRoot: root, plan, productPaths });
    const bankPath = acPassBankPath(root, "3993-v1-bank");
    mkdirSync(dirname(bankPath), { recursive: true });
    writeFileSync(
      bankPath,
      JSON.stringify({
        schemaVersion: 1,
        scopeId: "3993-v1-bank",
        bankedAt: "2026-09-02T00:00:00Z",
        headSha: null,
        productStateHash: hashed.digest,
        remainingTurns: null,
        remainingBudget: null,
        maxTurns: null,
        maxBudget: null,
        surplusThreshold: 0.2,
        hadSurplus: true,
        nextAction: "finalize_and_ship",
        postBankFindings: [],
      }),
      "utf8",
    );
    let executions = 0;
    const complete = evaluateScopeCompleteAcceptanceWalk(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner: () => {
        executions += 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      productPaths,
      hasSuiteFloor: true,
    });
    expect(complete.servedFrom).toBe("executed");
    expect(executions).toBe(1);
    expect(complete.ok).toBe(true);
  });

  it("zero-run verified-pass bank is not a green executable run (#3558 / #3993)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3993-zero-run-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");
    const clauses = [
      {
        id: 1,
        text: "behavioral contract with no machine check against product.txt",
        artifact_path: "src/product.txt",
        ambiguous: false,
        provenance: "statement",
      },
      {
        id: 2,
        text: "another unquoted behavioral claim against the shipped product",
        artifact_path: "src/product.txt",
        ambiguous: false,
        provenance: "statement",
      },
    ];
    const plan: Record<string, unknown> = {
      id: "3993-zero-run",
      title: "zero-run",
      status: "running",
      acceptance: {
        commands: [{ command: "task check" }],
        none_stated: true,
        source_rung: "derived",
        ambiguity_attestation: "none_found",
        clauses,
      },
      metadata: { swarm: { file_scope: ["src"] } },
    };
    const productPaths = ["src/product.txt"];
    const hashed = hashProductState({ projectRoot: root, plan, productPaths });
    const banked = maybeBankOnAcPass({
      projectRoot: root,
      scopeId: "3993-zero-run",
      executableRuns: 0,
      verifiedPass: true,
      productStateHash: hashed.digest,
    });
    expect(banked.banked).toBe(true);
    expect(banked.bank?.runs).toEqual([]);
    let executions = 0;
    const complete = evaluateScopeCompleteAcceptanceWalk(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner: () => {
        executions += 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      productPaths,
      hasSuiteFloor: true,
    });
    expect(complete.servedFrom).toBe("bank");
    expect(executions).toBe(0);
    expect(complete.ok).toBe(false);
    expect(complete.message).toMatch(/clause-walk-failed/);
    expect(complete.message).toMatch(/0 run\(s\)/);
    expect(complete.message).toMatch(/served_from=bank/);
  });
});

function swarmOnlyPlan(id: string, commands: string[]): Record<string, unknown> {
  return {
    id,
    title: id,
    status: "running",
    acceptance: {
      commands: [],
      none_stated: true,
      source_rung: "derived",
      ambiguity_attestation: "none_found",
      clauses: [
        {
          id: 1,
          text: "behavioral contract with no machine check against product.txt",
          artifact_path: "src/product.txt",
          ambiguous: false,
          provenance: "statement",
        },
        {
          id: 2,
          text: "another unquoted behavioral claim against the shipped product",
          artifact_path: "src/product.txt",
          ambiguous: false,
          provenance: "statement",
        },
      ],
    },
    metadata: { swarm: { verify_commands: commands } },
    items: [
      {
        title: "criterion",
        status: "pending",
        "x-directive/evidence": {
          kind: "test",
          pointer: "vitest",
          recorded_at: "2026-09-02T00:00:00Z",
          recorded_by: "vitest",
        },
      },
    ],
    references: [
      {
        uri: "https://github.com/deftai/directive/issues/4060",
        type: "x-xbrief/github-issue",
      },
    ],
  };
}

describe("one-path complete recut (#4060)", () => {
  it("acceptanceLedgersEqual requires non-empty equal ledgers", () => {
    expect(acceptanceLedgersEqual([], [])).toBe(false);
    expect(acceptanceLedgersEqual([{ command: "task check" }], [{ command: "task check" }])).toBe(
      true,
    );
    expect(acceptanceLedgersEqual([{ command: "task check" }], [{ command: "task doctor" }])).toBe(
      false,
    );
    expect(readAcceptanceLedger(["task check"])).toEqual([
      { command: "task check", cwd: null, expectedExitCode: 0 },
    ]);
  });

  it("matching swarm-only bank serves complete with zero new invocations", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4060-swarm-hit-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");
    const plan = swarmOnlyPlan("4060-swarm-hit", ["task check"]);
    const brief = writeBrief(root, plan);
    let executions = 0;
    const runner = () => {
      executions += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const productPaths = ["src/product.txt"];
    const verified = evaluateVerifyAcFromPath(brief, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      productPaths,
      hasSuiteFloor: true,
    });
    expect(verified.ok).toBe(true);
    expect(verified.servedFrom).toBe("executed");
    expect(executions).toBe(1);
    const complete = evaluateScopeCompleteAcceptanceWalk(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      productPaths,
      hasSuiteFloor: true,
    });
    expect(complete.ok).toBe(true);
    expect(complete.servedFrom).toBe("bank");
    expect(executions).toBe(1);
    expect(complete.message).toMatch(/served_from=bank/);
  });

  it("without a bank, each swarm command runs exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4060-swarm-miss-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");
    const plan = swarmOnlyPlan("4060-swarm-miss", ["task check", "task doctor"]);
    let executions = 0;
    const missing = evaluateScopeCompleteAcceptanceWalk(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      productPaths: ["src/product.txt"],
      hasSuiteFloor: true,
      runner: () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(missing.ok).toBe(true);
    expect(missing.servedFrom).toBe("executed");
    expect(executions).toBe(2);
  });

  it("changed swarm ledger refuses reuse and executes at most once", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4060-swarm-changed-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");
    const plan = swarmOnlyPlan("4060-swarm-changed", ["task check"]);
    const brief = writeBrief(root, plan);
    let executions = 0;
    const runner = () => {
      executions += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const productPaths = ["src/product.txt"];
    expect(
      evaluateVerifyAcFromPath(brief, {
        projectRoot: root,
        captureFromNarratives: false,
        runner,
        productPaths,
        hasSuiteFloor: true,
      }).ok,
    ).toBe(true);
    expect(executions).toBe(1);
    const changed = swarmOnlyPlan("4060-swarm-changed", ["task doctor"]);
    const walk = evaluateScopeCompleteAcceptanceWalk(changed, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      productPaths,
      hasSuiteFloor: true,
    });
    expect(walk.servedFrom).toBe("executed");
    expect(executions).toBe(2);
    expect(walk.ok).toBe(true);
  });

  it("hashProductState changes when swarm.verify_commands change", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4060-hash-swarm-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "a\n", "utf8");
    const productPaths = ["src/product.txt"];
    const first = hashProductState({
      projectRoot: root,
      plan: swarmOnlyPlan("4060-hash", ["task check"]),
      productPaths,
    });
    const second = hashProductState({
      projectRoot: root,
      plan: swarmOnlyPlan("4060-hash", ["task doctor"]),
      productPaths,
    });
    expect(first.complete).toBe(true);
    expect(second.digest).not.toBe(first.digest);
  });

  it("runTransition complete reuses a matching swarm-only bank with zero new invocations", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4060-runtransition-hit-"));
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");
    const plan = swarmOnlyPlan("4060-rt-hit", ["task check"]);
    const brief = writeBrief(root, plan);
    let executions = 0;
    const runner = () => {
      executions += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const productPaths = ["src/product.txt"];
    expect(
      evaluateVerifyAcFromPath(brief, {
        projectRoot: root,
        captureFromNarratives: false,
        runner,
        productPaths,
        hasSuiteFloor: true,
      }).ok,
    ).toBe(true);
    expect(executions).toBe(1);
    const result = runTransition("complete", brief, new Date("2026-09-02T12:00:00.000Z"), {
      deliveryEvidence: {
        mergeCommit: "abc1234deadbeef",
        mergedAt: "2026-09-02T11:00:00Z",
        prNumber: 1,
      },
      assumeEvidenceValidated: true,
      acceptanceRunner: runner,
    });
    expect(result.ok).toBe(true);
    expect(executions).toBe(1);
  });

  it("runTransition complete without a bank runs each swarm command once", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4060-runtransition-miss-"));
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");
    const plan = swarmOnlyPlan("4060-rt-miss", ["task check"]);
    const brief = writeBrief(root, plan);
    let executions = 0;
    const result = runTransition("complete", brief, new Date("2026-09-02T12:00:00.000Z"), {
      deliveryEvidence: {
        mergeCommit: "abc1234deadbeef",
        mergedAt: "2026-09-02T11:00:00Z",
        prNumber: 1,
      },
      assumeEvidenceValidated: true,
      acceptanceRunner: () => {
        executions += 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(result.ok).toBe(true);
    expect(executions).toBe(1);
  });

  it("newly captured command ledger refuses reuse and executes at most once", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4060-captured-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "product.txt"), "v1\n", "utf8");
    const plan = swarmOnlyPlan("4060-captured", ["task check"]);
    const brief = writeBrief(root, plan);
    let executions = 0;
    const runner = () => {
      executions += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const productPaths = ["src/product.txt"];
    expect(
      evaluateVerifyAcFromPath(brief, {
        projectRoot: root,
        captureFromNarratives: false,
        runner,
        productPaths,
        hasSuiteFloor: true,
      }).ok,
    ).toBe(true);
    expect(executions).toBe(1);
    const captured = {
      ...plan,
      metadata: {
        swarm: { verify_commands: ["task check"] },
        literal_acceptance_commands: [{ command: "task doctor", source: "explicit" }],
      },
    };
    const walk = evaluateScopeCompleteAcceptanceWalk(captured, {
      projectRoot: root,
      captureFromNarratives: false,
      runner,
      productPaths,
      hasSuiteFloor: true,
    });
    expect(walk.servedFrom).toBe("executed");
    expect(executions).toBe(3);
  });
});
