import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeControllerObservedHash,
  deny,
  FileBackedPrePrStore,
  MARK_COMPLETE_NOT_AUTHORITY,
  PRE_PR_PHASES,
  resetDefaultPrePrStore,
  SKILL_FILE_OPEN_NOT_COMPLETION,
  setDefaultPrePrStore,
} from "@deftai/directive-core/pre-pr-controller";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./pre-pr-run.js";

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
  "PR_1",
] as const;

function observeAll(runId: string, fixturePath: string, contentsHash: string): void {
  for (const spec of PRE_PR_PHASES) {
    if (spec.kind === "command-observable") {
      expect(
        run([
          "--observe-command",
          "--run-id",
          runId,
          "--phase",
          spec.id,
          "--exit-code",
          "0",
          "--json",
        ]),
      ).toBe(0);
    } else {
      expect(
        run([
          "--observe-semantic",
          "--run-id",
          runId,
          "--phase",
          spec.id,
          "--supplied-contents-hash",
          contentsHash,
          "--reviewed-file",
          fixturePath,
          "--json",
        ]),
      ).toBe(0);
    }
  }
}

describe("deft pre-pr:run", () => {
  let tmpRoot: string;
  let fixturePath: string;
  let contentsHash: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pre-pr-cli-"));
    setDefaultPrePrStore(new FileBackedPrePrStore(tmpRoot));
    fixturePath = join(tmpRoot, "reviewed.ts");
    writeFileSync(fixturePath, "reviewed-contents\n");
    contentsHash = computeControllerObservedHash({ reviewedFiles: [fixturePath] }) ?? "";
  });

  afterEach(() => {
    resetDefaultPrePrStore();
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("starts a run and treats the id as a lookup hint", () => {
    const code = run([...START, "--run-id", "ppr_cli", "--json"]);
    expect(code).toBe(0);
  });

  it("does not print started when store.put denies", () => {
    setDefaultPrePrStore({
      put: () =>
        deny("deny-missing-record", "pre-PR private store HMAC secret could not be created"),
      getById: () => null,
      getByPrNodeId: () => null,
      list: () => [],
    });
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run([...START, "--run-id", "ppr_deny"])).toBe(1);
    expect(out.join("")).not.toMatch(/started/);
    expect(err.join("")).toMatch(/HMAC secret could not be created|deny-missing-record/);
  });

  it("refuses skill-open and mark-complete", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run(["--skill-open"])).toBe(1);
    expect(err.join("")).toContain(SKILL_FILE_OPEN_NOT_COMPLETION);
    err.length = 0;
    expect(run(["--mark-complete", "--run-id", "ppr_x"])).toBe(1);
    expect(err.join("")).toContain(MARK_COMPLETE_NOT_AUTHORITY);
  });

  it("complete without observables does not mint a pass", () => {
    run([...START, "--run-id", "ppr_cli_incomplete"]);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run(["--complete", "--run-id", "ppr_cli_incomplete"])).toBe(1);
    expect(err.join("")).toMatch(/required phase|omitted|incomplete/i);
  });

  it("observes required phases then completes, including across a new store instance", () => {
    expect(run([...START, "--run-id", "ppr_happy", "--json"])).toBe(0);
    observeAll("ppr_happy", fixturePath, contentsHash);
    expect(run(["--complete", "--run-id", "ppr_happy", "--json"])).toBe(0);
    setDefaultPrePrStore(new FileBackedPrePrStore(tmpRoot));
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    expect(
      run([
        "--evaluate",
        "--repo",
        "deftai/directive",
        "--base-sha",
        "aaa",
        "--head-sha",
        "bbb",
        "--pr-body-hash",
        "ddd",
        "--pr-node-id",
        "PR_1",
        "--approved-revision",
        "aaa",
        "--scope",
        "a.ts",
        "--acceptance",
        "ac",
        "--run-id",
        "ppr_happy",
        "--json",
      ]),
    ).toBe(0);
    expect(out.join("")).toMatch(/allow-pass/);
  });

  it("evaluate uses live approved criteria so a different digest denies the old pass", () => {
    expect(run([...START, "--run-id", "ppr_weak", "--json"])).toBe(0);
    observeAll("ppr_weak", fixturePath, contentsHash);
    expect(run(["--complete", "--run-id", "ppr_weak"])).toBe(0);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(
      run([
        "--evaluate",
        "--repo",
        "deftai/directive",
        "--base-sha",
        "aaa",
        "--head-sha",
        "bbb",
        "--pr-body-hash",
        "ddd",
        "--pr-node-id",
        "PR_1",
        "--scope",
        "a.ts",
        "--acceptance",
        "weakened",
        "--run-id",
        "ppr_weak",
        "--json",
      ]),
    ).toBe(1);
    expect(err.join("")).toMatch(/criteria digest|invalidat/i);
  });

  it("omitting --exit-code on --observe-command fails closed", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(
      run(["--observe-command", "--run-id", "ppr_x", "--phase", "branch_policy", "--json"]),
    ).toBe(2);
    expect(err.join("")).toMatch(/requires --exit-code/);
  });

  it("mismatched semantic hashes deny for write, diff, and loop", () => {
    expect(run([...START, "--run-id", "ppr_hash", "--json"])).toBe(0);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    for (const phase of ["write", "diff", "loop"] as const) {
      err.length = 0;
      expect(
        run([
          "--observe-semantic",
          "--run-id",
          "ppr_hash",
          "--phase",
          phase,
          "--supplied-contents-hash",
          "forged-supplied",
          "--reviewed-file",
          fixturePath,
          "--json",
        ]),
      ).toBe(1);
      expect(err.join("")).toMatch(/does not match independently hashed/);
      err.length = 0;
      expect(
        run([
          "--observe-semantic",
          "--run-id",
          "ppr_hash",
          "--phase",
          phase,
          "--supplied-contents-hash",
          contentsHash,
          "--controller-observed-hash",
          "forged-observed",
          "--reviewed-file",
          fixturePath,
          "--json",
        ]),
      ).toBe(1);
      expect(err.join("")).toMatch(/does not match independently hashed/);
    }
  });

  it("parseArgs rejects unknown flags", () => {
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized/);
  });

  it("covers help, equals-form flags, evaluate, and missing required args", () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run(["--help"])).toBe(0);
    expect(out.join("")).toContain("deft pre-pr:run");
    expect(run(["--complete"])).toBe(2);
    expect(run(["--evaluate", "--json"])).toBe(2);
    expect(
      run([
        "--evaluate",
        "--repo=deftai/directive",
        "--base-sha=aaa",
        "--head-sha=bbb",
        "--run-id=missing",
        "--json",
      ]),
    ).toBe(2);
    expect(
      run([
        "--evaluate",
        "--repo=deftai/directive",
        "--base-sha=aaa",
        "--head-sha=bbb",
        "--pr-body-hash=ddd",
        "--run-id=missing",
        "--json",
      ]),
    ).toBe(1);
    expect(run(["--observe-command", "--run-id=ppr_x"])).toBe(2);
    expect(run(["--observe-semantic", "--run-id=ppr_x", "--phase=read"])).toBe(2);
    expect(run([])).toBe(2);
    const parsed = parseArgs([
      "--repo=deftai/directive",
      "--base-sha=aaa",
      "--head-sha=bbb",
      "--tree-hash=ccc",
      "--pr-body-hash=ddd",
      "--pr-node-id=PR_1",
      "--approved-revision=aaa",
      "--scope=a.ts",
      "--acceptance=ac",
      "--generation=2",
      "--skill-version=0.2",
      "--policy-version=2",
      "--run-id=ppr_eq",
      "--observe-command",
      "--phase=branch_policy",
      "--exit-code=0",
      "--command=deft verify:branch",
    ]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.generation).toBe(2);
    expect(parsed.prNodeId).toBe("PR_1");
    expect(parsed.observeCommand).toBe(true);
    expect(parseArgs(["--repo"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--generation", "0"]).error).toMatch(/positive integer/);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--policy-version", "2"]).policyVersion).toBe("2");
    expect(run(["--nope"])).toBe(2);
    expect(err.join("")).toMatch(/unrecognized/);
  });
});
