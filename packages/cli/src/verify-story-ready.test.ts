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
} from "./story-ready-fixtures.js";
import { parseArgs, run } from "./verify-story-ready.js";

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

function buildRepo(status = "running"): { root: string; vbriefPath: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-sr-"));
  temps.push(root);
  const dir = join(root, "xbrief", "active");
  mkdirSync(dir, { recursive: true });
  const vbriefPath = join(dir, "story.xbrief.json");
  writeFileSync(
    vbriefPath,
    JSON.stringify({ plan: { status, title: "T", items: [] }, xBRIEFInfo: { version: "0.8" } }),
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  gitCommit(root, "init");
  return { root, vbriefPath };
}

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const args = argv.includes("--skip-routing") ? argv : [...argv, "--skip-routing"];
  try {
    return run(args);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("parseArgs", () => {
  it("requires --vbrief-path", () => {
    expect(parseArgs([]).error).toContain("--vbrief-path");
  });

  it("parses required and optional flags", () => {
    expect(
      parseArgs([
        "--vbrief-path",
        "/x.xbrief.json",
        "--project-root",
        "/root",
        "--allocation-context",
        "/env.md",
        "--allow-dirty",
        "--json",
      ]),
    ).toMatchObject({
      vbriefPath: "/x.xbrief.json",
      projectRoot: "/root",
      allocationContext: "/env.md",
      allowDirty: true,
      emitJson: true,
    });
  });

  it("parses = forms", () => {
    expect(parseArgs(["--vbrief-path=/a", "--project-root=/b"]).vbriefPath).toBe("/a");
    expect(parseArgs(["--vbrief-path=/a", "--project-root=/b"]).projectRoot).toBe("/b");
  });

  it("errors on unknown flags and missing values", () => {
    expect(parseArgs(["--bogus"]).error).toBeDefined();
    expect(parseArgs(["--vbrief-path"]).error).toBeDefined();
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--allocation-context"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns 0 for a clean active running vBRIEF", () => {
    const { root, vbriefPath } = buildRepo();
    expect(silentRun(["--vbrief-path", vbriefPath, "--project-root", root])).toBe(0);
  });

  it("returns 1 for a non-running vBRIEF", () => {
    const { root, vbriefPath } = buildRepo("approved");
    expect(silentRun(["--vbrief-path", vbriefPath, "--project-root", root])).toBe(1);
  });

  it("returns 1 for a dirty working tree", () => {
    const { root, vbriefPath } = buildRepo();
    writeFileSync(join(root, "dirty.txt"), "untracked\n");
    expect(silentRun(["--vbrief-path", vbriefPath, "--project-root", root])).toBe(1);
  });

  it("returns 0 with --allow-dirty on a dirty tree", () => {
    const { root, vbriefPath } = buildRepo();
    writeFileSync(join(root, "dirty.txt"), "untracked\n");
    expect(silentRun(["--vbrief-path", vbriefPath, "--project-root", root, "--allow-dirty"])).toBe(
      0,
    );
  });

  it("returns 0 with satisfied swarm-cohort envelope", () => {
    const { root, vbriefPath } = buildRepo();
    const envelope = join(root, "env.md");
    writeFileSync(
      envelope,
      [
        "## Allocation context",
        "- dispatch_kind: swarm-cohort",
        "- allocation_plan_id: plan-1",
        "- batching_rationale: approved cohort",
      ].join("\n"),
    );
    execFileSync("git", ["add", envelope], { cwd: root });
    gitCommit(root, "add envelope");
    expect(
      silentRun([
        "--vbrief-path",
        vbriefPath,
        "--project-root",
        root,
        "--allocation-context",
        envelope,
      ]),
    ).toBe(0);
  });

  it("returns 2 for a missing allocation-context file", () => {
    const { root, vbriefPath } = buildRepo();
    expect(
      silentRun([
        "--vbrief-path",
        vbriefPath,
        "--project-root",
        root,
        "--allocation-context",
        join(root, "missing.md"),
      ]),
    ).toBe(2);
  });

  it("returns 2 for bad args", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });

  it("returns 0 for --help without --vbrief-path", () => {
    expect(silentRun(["--help"])).toBe(0);
  });

  it("returns 0 and emits json on success", () => {
    const { root, vbriefPath } = buildRepo();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        run(["--vbrief-path", vbriefPath, "--project-root", root, "--json", "--skip-routing"]),
      ).toBe(0);
      const written = out.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain('"ready":true');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("chains verify:routing for cursor provider when routing is undecided (#1877)", () => {
    const saved = process.env.CURSOR_AGENT;
    process.env.CURSOR_AGENT = "1";
    const { root, vbriefPath } = buildRepo();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--vbrief-path", vbriefPath, "--project-root", root])).toBe(1);
    } finally {
      out.mockRestore();
      err.mockRestore();
      if (saved === undefined) {
        delete process.env.CURSOR_AGENT;
      } else {
        process.env.CURSOR_AGENT = saved;
      }
    }
  });

  it("passes routing gate for cursor when leaf-implementation is decided (#1877)", () => {
    const savedAgent = process.env.CURSOR_AGENT;
    const savedRouting = process.env.DEFT_ROUTING_PATH;
    process.env.CURSOR_AGENT = "1";
    const { root, vbriefPath } = buildRepo();
    const routingPath = join(root, ".deft", "routing.local.json");
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      routingPath,
      JSON.stringify({
        cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
      }),
    );
    process.env.DEFT_ROUTING_PATH = routingPath;
    try {
      expect(run(["--vbrief-path", vbriefPath, "--project-root", root, "--allow-dirty"])).toBe(0);
    } finally {
      if (savedAgent === undefined) {
        delete process.env.CURSOR_AGENT;
      } else {
        process.env.CURSOR_AGENT = savedAgent;
      }
      if (savedRouting === undefined) {
        delete process.env.DEFT_ROUTING_PATH;
      } else {
        process.env.DEFT_ROUTING_PATH = savedRouting;
      }
    }
  });
});

describe("story-ready-parity helpers", () => {
  it("normaliseMessage uses stdout on exit 0 and stderr otherwise", () => {
    expect(normaliseMessage("  OK ready  ", "", 0)).toBe("OK ready");
    expect(normaliseMessage("", "  not ready  ", 1)).toBe("not ready");
    expect(normaliseMessage("line one\nline two", "", 0)).toBe("line one line two");
  });

  it("diffParity flags exit and message mismatches", () => {
    const py = { name: "x", exitCode: 1, stdout: "", stderr: "not ready: dirty" };
    const ts = { name: "x", exitCode: 1, stdout: "", stderr: "not ready: dirty" };
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
            name: "dirty-tree",
            exitMismatch: true,
            pythonExit: 1,
            tsExit: 0,
            messageMismatch: true,
            pythonMessage: "not ready",
            tsMessage: "OK",
          },
        ],
      }),
    ).toContain("DIVERGENCE");
  });

  it("buildScenarioRepo creates expected fixture layout", () => {
    const scenario = PARITY_SCENARIOS[0];
    if (scenario === undefined) {
      throw new Error("missing scenario");
    }
    const { root, vbriefPath, envelopePath } = buildScenarioRepo(scenario);
    temps.push(root);
    expect(vbriefPath).toContain("2026-06-01-story.xbrief.json");
    expect(envelopePath).toBeNull();
  });

  it.each(
    PARITY_SCENARIOS.map((s) => [s.name, s] as const),
  )("buildScenarioRepo handles scenario %s", (_name, scenario) => {
    const { root, vbriefPath, envelopePath } = buildScenarioRepo(scenario);
    temps.push(root);
    expect(vbriefPath).toContain(".xbrief.json");
    if (scenario.envelopeRel !== null) {
      expect(envelopePath).toContain(scenario.envelopeRel);
    }
  });
});
