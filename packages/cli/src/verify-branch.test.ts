import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildScenarioRepo,
  diffParity,
  normaliseMessage,
  PARITY_SCENARIOS,
  renderReport,
} from "./branch-parity.js";
import { parseArgs, run } from "./verify-branch.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function gitCommit(cwd: string, message: string): void {
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "deft-test",
      GIT_AUTHOR_EMAIL: "test@test.local",
      GIT_COMMITTER_NAME: "deft-test",
      GIT_COMMITTER_EMAIL: "test@test.local",
    },
  });
}

function writeProjectDef(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "T", status: "running", items: [], ...plan },
    }),
    { encoding: "utf8" },
  );
}

function initRepo(branch = "master"): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-branch-"));
  temps.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["branch", "-M", branch], { cwd: root });
  writeFileSync(join(root, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root });
  gitCommit(root, "init");
  return { root };
}

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("parseArgs", () => {
  it("parses defaults", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      allowMissingProjectDefinition: false,
      quiet: false,
      defaultBranches: null,
    });
  });

  it("parses all flags", () => {
    expect(
      parseArgs([
        "--project-root",
        "/root",
        "--allow-missing-project-definition",
        "--default-branch",
        "trunk",
        "--quiet",
      ]),
    ).toMatchObject({
      projectRoot: "/root",
      allowMissingProjectDefinition: true,
      quiet: true,
      defaultBranches: ["trunk"],
    });
  });

  it("parses = forms and repeated default-branch", () => {
    expect(parseArgs(["--project-root=/a", "--default-branch=main"]).projectRoot).toBe("/a");
    expect(parseArgs(["--default-branch=master", "--default-branch=main"]).defaultBranches).toEqual(
      ["master", "main"],
    );
  });

  it("errors on unknown flags and missing values", () => {
    expect(parseArgs(["--bogus"]).error).toBeDefined();
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--default-branch"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns 0 on a feature branch", () => {
    const { root } = initRepo();
    execFileSync("git", ["checkout", "-q", "-b", "feat/test"], { cwd: root });
    writeProjectDef(root, { policy: { allowDirectCommitsToMaster: false } });
    expect(silentRun(["--project-root", root])).toBe(0);
  });

  it("returns 1 when blocked on default branch", () => {
    const { root } = initRepo("master");
    writeProjectDef(root, { policy: { allowDirectCommitsToMaster: false } });
    expect(silentRun(["--project-root", root])).toBe(1);
  });

  it("returns 0 with setup exemption", () => {
    const { root } = initRepo("master");
    const prev = process.env.DEFT_SETUP_INTERVIEW;
    process.env.DEFT_SETUP_INTERVIEW = "1";
    try {
      expect(silentRun(["--project-root", root])).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DEFT_SETUP_INTERVIEW;
      else process.env.DEFT_SETUP_INTERVIEW = prev;
    }
  });

  it("returns 2 for bad args", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });

  it("returns 0 with --quiet on success", () => {
    const { root } = initRepo();
    execFileSync("git", ["checkout", "-q", "-b", "feat/q"], { cwd: root });
    writeProjectDef(root, { policy: { allowDirectCommitsToMaster: false } });
    expect(silentRun(["--project-root", root, "--quiet"])).toBe(0);
  });
});

describe("branch-parity helpers", () => {
  it("normaliseMessage uses stdout on exit 0 and stderr otherwise", () => {
    expect(normaliseMessage("  OK  ", "", 0)).toBe("OK");
    expect(normaliseMessage("", "  blocked  ", 1)).toBe("blocked");
  });

  it("diffParity flags exit and message mismatches", () => {
    const py = { name: "x", exitCode: 1, stdout: "", stderr: "blocked" };
    const ts = { name: "x", exitCode: 1, stdout: "", stderr: "blocked" };
    expect(diffParity(py, ts).exitMismatch).toBe(false);
    expect(diffParity(py, ts).messageMismatch).toBe(false);

    const ts2 = { ...ts, exitCode: 0, stdout: "OK", stderr: "" };
    const d = diffParity(py, ts2);
    expect(d.exitMismatch).toBe(true);
    expect(d.messageMismatch).toBe(true);
  });

  it("renderReport describes clean and divergent parity results", () => {
    expect(renderReport({ ok: true, scenarios: [] })).toContain("CLEAN");
    expect(
      renderReport({
        ok: false,
        scenarios: [
          {
            name: "master-blocked",
            exitMismatch: true,
            pythonExit: 1,
            tsExit: 0,
            messageMismatch: true,
            pythonMessage: "blocked",
            tsMessage: "OK",
          },
        ],
      }),
    ).toContain("DIVERGENCE");
  });

  it.each(
    PARITY_SCENARIOS.map((s) => [s.name, s] as const),
  )("buildScenarioRepo handles scenario %s", (_name, scenario) => {
    const { root } = buildScenarioRepo(scenario);
    temps.push(root);
    expect(root.length).toBeGreaterThan(0);
  });
});
