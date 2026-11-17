/**
 * #6374: a green verify:ac that verified zero clauses and ran no green
 * acceptance command leads with "no acceptance evidence yet", on every branch.
 * `ok`, the exit code and the resolution label do not change.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERIFY_AC_NO_EVIDENCE_LEAD, VERIFY_AC_PASSED_LEAD } from "./acceptance-resolver.js";
import { evaluateVerifyAcFromPath, evaluateVerifyAcFromPlan } from "./evaluate.js";

const greenRunner = () => ({ exitCode: 0, stdout: "", stderr: "" });

const baseOptions = {
  captureFromNarratives: false,
  hasSuiteFloor: true,
  bankOnPass: false,
  reuseMode: "never" as const,
  applyOracleIntegrity: false,
  runner: greenRunner,
};

function noOraclePlan(id: string): Record<string, unknown> {
  return {
    id,
    title: "brief with no evidence yet",
    acceptance: {
      commands: [],
      none_stated: true,
      source_rung: "derived",
      ambiguity_attestation: "none_found",
      clauses: [
        { id: 1, text: "A game can be created from a secret word.", artifact_path: null },
        { id: 2, text: "Guess evaluation returns per-letter states.", artifact_path: null },
      ],
    },
    items: [],
  };
}

function firstLine(message: string): string {
  return (message.split("\n").find((row) => row.trim().length > 0) ?? "").trim();
}

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repoWithBrief(): { root: string; brief: string } {
  const root = mkdtempSync(join(tmpdir(), "ac-6374-lead-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "master");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "seed\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "seed");
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  const brief = join(root, "xbrief", "active", "2026-11-17-1-no-evidence.xbrief.json");
  writeFileSync(
    brief,
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: noOraclePlan("6374-path") }, null, 2)}\n`,
  );
  return { root, brief };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("verify:ac no-evidence lead (#6374)", () => {
  it("keeps ok, the exit code and the resolution label on a zero-verified walk", () => {
    const result = evaluateVerifyAcFromPlan(noOraclePlan("6374-invariants"), {
      ...baseOptions,
      projectRoot: process.cwd(),
    });
    expect(firstLine(result.message)).toBe(
      `${VERIFY_AC_NO_EVIDENCE_LEAD} (0 verified, 2 unverifiable) [rung=derived]`,
    );
    // Same verdict fields as before #6374: green, exit 0, not a verified pass.
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.resolution).not.toBe("verified-pass");
    expect(result.resolution).not.toBe("fail");
    expect(result.message).not.toContain(VERIFY_AC_PASSED_LEAD);
  });

  // One repository, two runs: a fresh branch with no commit, then the delivery
  // branch with the brief committed. Both lead with the new line and both keep
  // the exit code (0) that the old "passed" lead had.
  it("leads with no acceptance evidence yet on a fresh branch and on the delivery branch", () => {
    const { root, brief } = repoWithBrief();
    git(root, "checkout", "-q", "-b", "story/fresh");
    const fresh = evaluateVerifyAcFromPath(brief, { ...baseOptions, projectRoot: root });
    expect(firstLine(fresh.message)).toMatch(/^verify:ac: no acceptance evidence yet \(#3284\)/);

    git(root, "checkout", "-q", "master");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "brief on the delivery branch");
    const delivered = evaluateVerifyAcFromPath(brief, { ...baseOptions, projectRoot: root });
    expect(firstLine(delivered.message)).toMatch(
      /^verify:ac: no acceptance evidence yet \(#3284\)/,
    );

    expect([fresh.code, delivered.code]).toEqual([0, 0]);
    expect([fresh.ok, delivered.ok]).toEqual([true, true]);
  });

  it("prints no lead in quiet mode and keeps the same verdict", () => {
    const loud = evaluateVerifyAcFromPlan(noOraclePlan("6374-loud"), {
      ...baseOptions,
      projectRoot: process.cwd(),
    });
    const quiet = evaluateVerifyAcFromPlan(noOraclePlan("6374-quiet"), {
      ...baseOptions,
      projectRoot: process.cwd(),
      quiet: true,
    });
    expect(quiet.message).not.toContain(VERIFY_AC_PASSED_LEAD);
    expect([quiet.ok, quiet.code, quiet.resolution]).toEqual([loud.ok, loud.code, loud.resolution]);
  });

  it("still says passed when an acceptance command ran green", () => {
    const plan = noOraclePlan("6374-green-command");
    plan.acceptance = {
      ...(plan.acceptance as Record<string, unknown>),
      commands: [{ command: "pnpm exec vitest run packages/core/src/swarm/" }],
      none_stated: false,
    };
    plan.metadata = {
      literal_acceptance_commands: [
        { command: "pnpm exec vitest run packages/core/src/swarm/", source: "explicit" },
      ],
    };
    const result = evaluateVerifyAcFromPlan(plan, { ...baseOptions, projectRoot: process.cwd() });
    expect(result.runs.length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    expect(firstLine(result.message)).toMatch(/^verify:ac passed \(#3284\)/);
    expect(result.message).not.toContain("no acceptance evidence yet");
  });
});
