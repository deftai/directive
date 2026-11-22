/**
 * #6902: `pre-pr:run --project-root <dir>` reads and writes the private store
 * under `<dir>` from any cwd, with no injected test store.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDefaultPrePrStore,
  computeControllerObservedHash,
  FileBackedPrePrStore,
  PRE_PR_PHASES,
} from "@deftai/directive-core/pre-pr-controller";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./pre-pr-run.js";

const START = [
  "--repo",
  "deftai/directive",
  "--base-sha",
  "aaa",
  "--head-sha",
  "bbb",
  "--tree-hash",
  "ccc",
  "--pr-body-hash",
  "ddd",
  "--approved-revision",
  "aaa",
  "--scope",
  "a.ts",
  "--acceptance",
  "ac",
  "--pr-node-id",
  "PR_6902",
] as const;

const SEMANTIC_PHASE = PRE_PR_PHASES.find((p) => p.kind === "semantic")?.id ?? "read";

function captureStderr(): string[] {
  const err: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return err;
}

describe("deft pre-pr:run --project-root (#6902)", () => {
  let dirA: string;
  let dirB: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    dirA = mkdtempSync(join(tmpdir(), "pre-pr-6902-a-"));
    dirB = mkdtempSync(join(tmpdir(), "pre-pr-6902-b-"));
    // Same relative name, different contents: the hash must be of A's file.
    writeFileSync(join(dirA, "reviewed.ts"), "contents in A\n");
    writeFileSync(join(dirB, "reviewed.ts"), "contents in B\n");
    clearDefaultPrePrStore();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    clearDefaultPrePrStore();
    vi.restoreAllMocks();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("records a command phase and a semantic phase from another cwd", () => {
    process.chdir(dirA);
    expect(run([...START, "--run-id", "ppr_6902_x", "--json"])).toBe(0);

    process.chdir(dirB);
    expect(
      run([
        "--observe-command",
        "--run-id",
        "ppr_6902_x",
        "--phase",
        "branch_policy",
        "--exit-code",
        "0",
        "--project-root",
        dirA,
        "--json",
      ]),
    ).toBe(0);

    const hashA = computeControllerObservedHash({ reviewedFiles: ["reviewed.ts"], cwd: dirA });
    const hashB = computeControllerObservedHash({ reviewedFiles: ["reviewed.ts"], cwd: dirB });
    expect(hashA).not.toBeNull();
    expect(hashA).not.toBe(hashB);
    expect(
      run([
        "--observe-semantic",
        "--run-id",
        "ppr_6902_x",
        "--phase",
        SEMANTIC_PHASE,
        "--supplied-contents-hash",
        hashA ?? "",
        "--reviewed-file",
        "reviewed.ts",
        "--project-root",
        dirA,
        "--json",
      ]),
    ).toBe(0);

    const rec = new FileBackedPrePrStore(dirA).getById("ppr_6902_x");
    expect(rec?.phaseEvidence.commands.some((c) => c.phaseId === "branch_policy")).toBe(true);
    const sem = rec?.phaseEvidence.semantic.find((s) => s.phaseId === SEMANTIC_PHASE);
    expect(sem?.controllerObservedHash).toBe(hashA);
    expect(new FileBackedPrePrStore(dirB).getById("ppr_6902_x")).toBeNull();
  });

  it("starts, evaluates and completes against the root store from another cwd", () => {
    process.chdir(dirB);
    expect(run([...START, "--run-id", "ppr_6902_s", "--project-root", dirA, "--json"])).toBe(0);
    expect(new FileBackedPrePrStore(dirA).getById("ppr_6902_s")).not.toBeNull();
    expect(new FileBackedPrePrStore(dirB).getById("ppr_6902_s")).toBeNull();

    const evaluate = [
      "--evaluate",
      "--run-id",
      "ppr_6902_s",
      "--repo",
      "deftai/directive",
      "--base-sha",
      "aaa",
      "--head-sha",
      "bbb",
      "--pr-body-hash",
      "ddd",
      "--pr-node-id",
      "PR_6902",
      "--scope",
      "a.ts",
      "--acceptance",
      "ac",
      "--json",
    ];
    let err = captureStderr();
    expect(run(evaluate)).toBe(1);
    // From B alone, the presented id finds no record (lookup hint only).
    expect(err.join("")).toContain('"code":"deny-not-bearer"');
    vi.restoreAllMocks();
    err = captureStderr();
    expect(run([...evaluate, "--project-root", dirA])).toBe(1);
    // With the root, the record is found; it is denied only because it is not a pass.
    expect(err.join("")).not.toContain("deny-not-bearer");
    expect(err.join("")).not.toContain("deny-missing-record");
    vi.restoreAllMocks();

    const opts = {
      skipNamedMergeGate: true,
      verifyAc: () => ({ kind: "evaluated-pass" as const, output: "" }),
    };
    err = captureStderr();
    expect(run(["--complete", "--run-id", "ppr_6902_s", "--project-root", dirA], opts)).toBe(1);
    expect(err.join("")).not.toContain("is not in the private store");
    expect(err.join("")).toMatch(/required phase|omitted|incomplete/i);
  });

  it("without --project-root, another cwd reports the run missing", () => {
    process.chdir(dirA);
    expect(run([...START, "--run-id", "ppr_6902_m", "--json"])).toBe(0);
    process.chdir(dirB);
    const err = captureStderr();
    expect(
      run([
        "--observe-command",
        "--run-id",
        "ppr_6902_m",
        "--phase",
        "branch_policy",
        "--exit-code",
        "0",
      ]),
    ).toBe(1);
    expect(err.join("")).toContain("pre-PR run ppr_6902_m is not in the private store");
  });
});
