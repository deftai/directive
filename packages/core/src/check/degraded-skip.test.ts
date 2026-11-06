import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCachedTaskCheck } from "./cached-orchestrator.js";
import {
  countCitationShapedSanctionedSkips,
  evaluateSanctionedSkipCountBaseline,
  evaluateSanctionedSkipCountBaselineFromInventory,
  inventoryCitedSkipsInTree,
  isSanctionedSkipCountBaselinePath,
  mapCitedSkipSitesToSanctionedRows,
  parseSanctionedSkipCountBaselineJson,
  runSanctionedSkipCountBaselineGate,
  SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID,
  SANCTIONED_SKIP_COUNT_BASELINE_REL,
  SANCTIONED_SKIP_COUNT_BASELINE_SCHEMA,
  type SanctionedSkipInventoryRow,
  SHAPE_B_ALLOWED_BASELINE_PATHS,
} from "./context.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function writeConsumerFramework(): { framework: string; project: string } {
  const framework = mkdtempSync(join(tmpdir(), "deft-3335-fw-"));
  const project = mkdtempSync(join(tmpdir(), "deft-3335-project-"));
  tempDirs.push(framework);
  tempDirs.push(project);
  mkdirSync(join(framework, "tasks"), { recursive: true });
  writeFileSync(
    join(framework, "Taskfile.yml"),
    `version: '3'
includes:
  verify:
    taskfile: ./tasks/verify.yml
  toolchain:
    taskfile: ./tasks/toolchain.yml
  vbrief:
    taskfile: ./tasks/vbrief.yml
tasks:
  doctor:
    cmds: [echo doctor]
  verify-strategy-output:
    cmds: [echo strategy]
`,
    "utf8",
  );
  writeFileSync(
    join(framework, "tasks", "verify.yml"),
    `version: '3'
tasks:
  ac:
    cmds: [echo ok]
  branch:
    cmds: [echo ok]
  cache-fresh:
    cmds: [echo ok]
  wip-cap:
    cmds: [echo ok]
  orphan-active:
    cmds: [echo ok]
  completed-write-guard:
    cmds: [echo ok]
  test-boundary:
    cmds: [echo ok]
  class-checks:
    cmds: [echo ok]
  scope-provenance:
    cmds: [echo ok]
  consumer-check-contract:
    cmds: [echo ok]
  evaluator-surface:
    cmds: [echo ok]
  observable-scope:
    cmds: [echo ok]
  intent-constraint:
    cmds: [echo ok]
  presentation-ceiling:
    cmds: [echo ok]
  durable-effect-acquisition:
    cmds: [echo ok]
  presentation-coverage:
    cmds: [echo ok]
  consumer-test-lane:
    cmds: [echo ok]
`,
    "utf8",
  );
  writeFileSync(
    join(framework, "tasks", "toolchain.yml"),
    "version: '3'\ntasks:\n  check-consumer:\n    cmds: [echo ok]\n",
    "utf8",
  );
  writeFileSync(
    join(framework, "tasks", "vbrief.yml"),
    "version: '3'\ntasks:\n  validate:\n    cmds: [echo ok]\n",
    "utf8",
  );
  return { framework, project };
}

describe("degraded skip report in check (#3282)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 2 (config) with skip report when task is missing — never green", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const started: string[] = [];
    const code = dispatchCachedTaskCheck("/fw", "/fw", {
      skipSanctionedSkipBaseline: true,
      noCache: true,
      emitRunSummary: false,
      preflight: {
        status: "degraded",
        ok: false,
        degraded: true,
        findings: [
          {
            tool: "task",
            present: false,
            cause: "go-task binary not found on PATH",
            remedy: "Install go-task",
          },
        ],
        lines: ["[deft preflight] toolchain status: degraded"],
        // Sentinel expands to the live gate composition (#3282).
        skipGateIds: ["*"],
      },
      onGateStart: (id) => started.push(id),
      gateSpawnFn: () => {
        throw new Error("gates must not run when fully degraded");
      },
    });
    expect(code).toBe(2);
    expect(started).toEqual([]);
    const msg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toMatch(/degraded mode/);
    expect(msg).toMatch(/skipped \d+ gate/);
    expect(msg).toMatch(/go-task binary not found/);
    expect(msg).toMatch(/exit 2/);
    expect(msg).not.toMatch(/exit 0 \(degraded\)/);
  });

  it("runs CLI-native gates via global CLI when go-task is absent (#3335)", () => {
    const { framework, project } = writeConsumerFramework();
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawned: Array<{ gateId: string; bin: string; args: readonly string[] }> = [];
    const code = dispatchCachedTaskCheck(framework, project, {
      skipSanctionedSkipBaseline: true,
      noCache: true,
      emitRunSummary: false,
      cliBin: "deft",
      preflight: {
        status: "ok",
        ok: true,
        degraded: false,
        findings: [
          {
            tool: "task",
            present: false,
            cause: "go-task absent; CLI-native gates dispatch via global deft/directive (#3335)",
            remedy: null,
            impact: "none",
          },
        ],
        lines: ["[deft preflight] task: absent (impact: none)"],
        skipGateIds: [],
      },
      gateSpawnFn: (gateId, bin, args) => {
        spawned.push({ gateId, bin, args });
        return {
          exitCode: 0,
          stdout:
            gateId === "verify:presentation-coverage"
              ? JSON.stringify({ code: 0, armed: false, coverage: [] })
              : "",
          stderr: "",
        };
      },
    });
    expect(code).toBe(0);
    expect(spawned.length).toBeGreaterThan(0);
    const ac = spawned.find((s) => s.gateId === "verify:ac");
    expect(ac?.bin).toBe("deft");
    expect(ac?.args).toEqual(["verify:ac", "--soft-missing-xbrief"]);
    expect(ac?.args).not.toContain("--taskfile");
    expect(spawned.every((s) => s.bin === "deft")).toBe(true);
    const msg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).not.toMatch(/Install go-task|taskfile\.dev/i);
    expect(msg).not.toMatch(/skipping gate verify:ac/);
  });

  it("attributes a missing selected manager ahead of non-impacting go-task", () => {
    const { framework, project } = writeConsumerFramework();
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = dispatchCachedTaskCheck(framework, project, {
      skipSanctionedSkipBaseline: true,
      noCache: true,
      emitRunSummary: false,
      cliBin: "deft",
      preflight: {
        status: "degraded",
        ok: false,
        degraded: true,
        findings: [
          {
            tool: "task",
            present: false,
            cause: "go-task absent; CLI-native gates dispatch via global deft/directive (#3335)",
            remedy: null,
            impact: "none",
          },
          {
            tool: "npm",
            present: false,
            cause: "npm binary not found on PATH",
            remedy: "Install or repair Node 20+ (npm is bundled)",
          },
        ],
        lines: ["[deft preflight] toolchain status: degraded"],
        skipGateIds: ["toolchain:check-consumer"],
        packageManager: "npm",
        packageManagerSource: "package-manager-field",
      },
      gateSpawnFn: (gateId) => ({
        exitCode: 0,
        stdout:
          gateId === "verify:presentation-coverage"
            ? JSON.stringify({ code: 0, armed: false, coverage: [] })
            : "",
        stderr: "",
      }),
    });
    expect(code).toBe(2);
    const msg = errWrite.mock.calls.map((call) => String(call[0])).join("");
    expect(msg).toMatch(/skipping gate toolchain:check-consumer.*npm binary not found/s);
    expect(msg).not.toMatch(/skipping gate toolchain:check-consumer.*go-task/s);
  });

  it("attributes an all-gate skip to the missing CLI instead of advisory Git", () => {
    const { framework, project } = writeConsumerFramework();
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = dispatchCachedTaskCheck(framework, project, {
      skipSanctionedSkipBaseline: true,
      noCache: true,
      emitRunSummary: false,
      preflight: {
        status: "degraded",
        ok: false,
        degraded: true,
        findings: [
          {
            tool: "task",
            present: false,
            cause: "go-task absent and no global deft/directive CLI",
            remedy: "Install the global Directive CLI",
            impact: "none",
          },
          {
            tool: "git",
            present: false,
            cause: "git binary not found on PATH",
            remedy: "Install Git",
          },
          {
            tool: "cli_dist",
            present: false,
            cause: "no global deft/directive on PATH",
            remedy: "Install: npm i -g @deftai/directive@latest",
          },
        ],
        lines: ["[deft preflight] toolchain status: degraded"],
        skipGateIds: ["*"],
        packageManager: "npm",
        packageManagerSource: "package-manager-field",
      },
      gateSpawnFn: () => {
        throw new Error("gates must not run when fully degraded");
      },
    });
    expect(code).toBe(2);
    const msg = errWrite.mock.calls.map((call) => String(call[0])).join("");
    expect(msg).toMatch(/no global deft\/directive on PATH/);
    expect(msg).not.toMatch(/skipping gate.*git binary not found/s);
  });

  it("rejects a conflicting package-manager override in live preflight", () => {
    const { framework, project } = writeConsumerFramework();
    writeFileSync(
      join(project, "package.json"),
      `${JSON.stringify({ packageManager: "pnpm@11.8.0" })}\n`,
      "utf8",
    );
    const probed: string[] = [];
    const code = dispatchCachedTaskCheck(framework, project, {
      skipSanctionedSkipBaseline: true,
      noCache: true,
      emitRunSummary: false,
      env: { DEFT_PACKAGE_MANAGER: "npm" },
      which: (name) => {
        probed.push(name);
        return `/bin/${name}`;
      },
      gateSpawnFn: (gateId) => ({
        exitCode: 0,
        stdout:
          gateId === "verify:presentation-coverage"
            ? JSON.stringify({ code: 0, armed: false, coverage: [] })
            : "",
        stderr: "",
      }),
    });
    expect(code).toBe(2);
    expect(probed).not.toContain("npm");
    expect(probed).not.toContain("pnpm");
  });

  it("prints named cause when a gate fails", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = dispatchCachedTaskCheck("/fw-named", "/fw-named", {
      skipSanctionedSkipBaseline: true,
      noCache: true,
      emitRunSummary: false,
      preflight: null,
      gateSpawnFn: (gateId) => {
        if (gateId === "verify:branch") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "branch protection refused default branch\n",
          };
        }
        return {
          exitCode: 0,
          stdout:
            gateId === "verify:presentation-coverage"
              ? JSON.stringify({ code: 0, armed: false, coverage: [] })
              : "",
          stderr: "",
        };
      },
    });
    expect(code).toBe(1);
    const msg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toMatch(/gate verify:branch failed/);
    expect(msg).toMatch(/cause:/);
    expect(msg).toMatch(/remedy:/);
  });
});

const citedRow = (
  title: string,
  issueNumber: number | null,
  citationShape: SanctionedSkipInventoryRow["citationShape"] = "cited",
): SanctionedSkipInventoryRow => ({
  path: "packages/core/src/example.test.ts",
  title,
  issueNumber,
  citationShape,
});

describe("sanctioned-skip-count-baseline (#6072)", () => {
  it("lists sanctioned skip count and compares to baseline on every run", () => {
    const rows = [citedRow("a", 1), citedRow("b", 2), citedRow("c", 3, "uncited")];
    expect(countCitationShapedSanctionedSkips(rows)).toBe(2);
    const result = evaluateSanctionedSkipCountBaseline({
      candidateTreeSyntaxCount: 2,
      targetBaselineCount: 2,
      candidateBaselineCount: 2,
      shapeB: { admitted: false, authorizedNetNew: 0 },
      phase: "pre-pr",
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("pass");
    expect(result.message).toContain(SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID);
    expect(result.invokedTaskCheck).toBe(false);
  });

  it("refuses PR that raises skip count above baseline without shape-B hotfix marker", () => {
    const result = evaluateSanctionedSkipCountBaseline({
      candidateTreeSyntaxCount: 3,
      targetBaselineCount: 2,
      candidateBaselineCount: 3,
      shapeB: { admitted: false, authorizedNetNew: 0 },
      phase: "merge-readiness",
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("raise-refused");
    expect(result.code).toBe(1);
  });

  it("allows shape-B hotfix PR that raises skip count when baseline file is updated in the same PR", () => {
    const result = evaluateSanctionedSkipCountBaseline({
      candidateTreeSyntaxCount: 4,
      targetBaselineCount: 2,
      candidateBaselineCount: 4,
      shapeB: { admitted: true, authorizedNetNew: 2 },
      phase: "merge-readiness",
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("pass");
    expect(result.message).toContain("shape-(B) raise admitted");
  });

  it("allows PR that only removes skips and ratchets baseline down", () => {
    const result = evaluateSanctionedSkipCountBaseline({
      candidateTreeSyntaxCount: 1,
      targetBaselineCount: 3,
      candidateBaselineCount: 1,
      shapeB: { admitted: false, authorizedNetNew: 0 },
      phase: "pre-pr",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("down-ratchet ok");
  });

  it("refuses baseline bump without a matching net increase explained by new shape-B skips", () => {
    const result = evaluateSanctionedSkipCountBaseline({
      candidateTreeSyntaxCount: 5,
      targetBaselineCount: 2,
      candidateBaselineCount: 5,
      shapeB: { admitted: true, authorizedNetNew: 1 },
      phase: "merge-readiness",
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("baseline-bump-mismatch");
  });

  it("does not invoke task check or re-run Merge gate (task check) for this ratchet", () => {
    const result = evaluateSanctionedSkipCountBaseline({
      candidateTreeSyntaxCount: 0,
      targetBaselineCount: 0,
      candidateBaselineCount: 0,
      shapeB: { admitted: false, authorizedNetNew: 0 },
    });
    expect(result.invokedTaskCheck).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("refuses missing or invalid baseline evidence instead of seeding zero", () => {
    const missing = evaluateSanctionedSkipCountBaseline({
      candidateTreeSyntaxCount: 0,
      targetBaselineCount: 0,
      candidateBaselineCount: null,
      shapeB: { admitted: false, authorizedNetNew: 0 },
    });
    expect(missing.ok).toBe(false);
    expect(missing.outcome).toBe("baseline-missing");

    const mismatch = evaluateSanctionedSkipCountBaseline({
      candidateTreeSyntaxCount: 2,
      targetBaselineCount: 2,
      candidateBaselineCount: 1,
      shapeB: { admitted: false, authorizedNetNew: 0 },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.outcome).toBe("baseline-mismatch");
  });

  it("ignores issue-state and counts only citation-shaped rows for the ratchet", () => {
    const rows: SanctionedSkipInventoryRow[] = [
      citedRow("open-cited", 1),
      citedRow("closed-but-cited-shape", 2),
      citedRow("uncited", null, "uncited"),
    ];
    expect(countCitationShapedSanctionedSkips(rows)).toBe(2);
    const result = evaluateSanctionedSkipCountBaselineFromInventory({
      candidateRows: rows,
      candidateRoot: "/unused",
      targetBaselineCount: 2,
      shapeB: { admitted: false, authorizedNetNew: 0 },
      seams: {
        exists: () => true,
        readText: () => JSON.stringify({ schema: SANCTIONED_SKIP_COUNT_BASELINE_SCHEMA, count: 2 }),
      },
    });
    expect(result.ok).toBe(true);
    expect(result.candidateTreeSyntaxCount).toBe(2);
  });

  it("admits the baseline count file in the shape-(B) allowed touch set", () => {
    expect(SHAPE_B_ALLOWED_BASELINE_PATHS).toContain(SANCTIONED_SKIP_COUNT_BASELINE_REL);
    expect(isSanctionedSkipCountBaselinePath(SANCTIONED_SKIP_COUNT_BASELINE_REL)).toBe(true);
    expect(isSanctionedSkipCountBaselinePath("packages/core/src/check/other.json")).toBe(false);
  });

  it("parses the committed baseline schema strictly", () => {
    const ok = parseSanctionedSkipCountBaselineJson(
      JSON.stringify({ schema: SANCTIONED_SKIP_COUNT_BASELINE_SCHEMA, count: 0 }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.count).toBe(0);
    expect(parseSanctionedSkipCountBaselineJson("{}").ok).toBe(false);
    expect(parseSanctionedSkipCountBaselineJson("not-json").ok).toBe(false);
  });
});

describe("sanctioned-skip baseline production wire (#6072 P3)", () => {
  it("runs baseline gate on inventory rows for merge-readiness phase", () => {
    const sites = inventoryCitedSkipsInTree(process.cwd());
    const rows = mapCitedSkipSitesToSanctionedRows(sites);
    const result = runSanctionedSkipCountBaselineGate({
      projectRoot: process.cwd(),
      phase: "merge-readiness",
      candidateRows: rows,
      shapeB: { admitted: false, authorizedNetNew: 0 },
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
  });

  it("runs baseline gate for pre-pr phase with explicit target baseline", () => {
    const result = runSanctionedSkipCountBaselineGate({
      projectRoot: process.cwd(),
      phase: "pre-pr",
      targetBaselineCount: 0,
      candidateRows: [],
      shapeB: { admitted: false, authorizedNetNew: 0 },
    });
    expect(result.ok).toBe(true);
  });
});
