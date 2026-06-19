import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  defaultFetchTimeoutFromEnv,
  formatJson,
  formatSummary,
  normaliseLabelFilter,
  PROGRESS_DEFAULT,
  runBootstrap,
} from "../../core/src/triage/bootstrap/index.js";
import { parseArgs, runWithModule } from "./triage-bootstrap.js";
import {
  buildFixtureRepo,
  diffCase,
  normalizeOutput,
  normalizeStdout,
  PARITY_CASES,
  renderReport,
} from "./triage-bootstrap-parity.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function fakeModule() {
  return {
    runBootstrap,
    formatJson,
    formatSummary,
    normaliseLabelFilter,
    defaultFetchTimeoutFromEnv,
    PROGRESS_DEFAULT,
  };
}

describe("parseArgs", () => {
  it("parses defaults from env fallbacks", () => {
    expect(parseArgs([])).toMatchObject({
      quiet: false,
      emitJson: false,
      labels: [],
    });
  });

  it("parses bootstrap flags", () => {
    expect(
      parseArgs([
        "--project-root",
        "/tmp/p",
        "--repo",
        "deftai/directive",
        "--limit",
        "5",
        "--state",
        "open",
        "--label",
        "bug,p0",
        "--author",
        "octocat",
        "--batch-size",
        "10",
        "--delay-ms",
        "0",
        "--fetch-timeout-s",
        "30",
        "--quiet",
        "--json",
      ]),
    ).toMatchObject({
      projectRoot: "/tmp/p",
      repo: "deftai/directive",
      limit: 5,
      state: "open",
      labels: ["bug,p0"],
      author: "octocat",
      batchSize: 10,
      delayMs: 0,
      fetchTimeoutS: 30,
      quiet: true,
      emitJson: true,
    });
  });

  it("rejects invalid --state", () => {
    expect(parseArgs(["--state", "maybe"]).error).toContain("invalid choice");
  });

  it("rejects unknown args", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
  });

  it("errors when flag values are missing", () => {
    expect(parseArgs(["--repo"]).error).toContain("expected one argument");
    expect(parseArgs(["--limit"]).error).toContain("expected one argument");
  });

  it("parses equals forms", () => {
    expect(parseArgs(["--project-root=/tmp/x", "--repo=deftai/directive"]).projectRoot).toBe(
      "/tmp/x",
    );
    expect(parseArgs(["--project-root=/tmp/x", "--repo=deftai/directive"]).repo).toBe(
      "deftai/directive",
    );
  });
});

describe("runWithModule", () => {
  it("returns 2 for parse errors", async () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runWithModule(fakeModule(), ["--nope"])).toBe(2);
    err.mockRestore();
  });

  it("returns 2 for missing project root", async () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await runWithModule(fakeModule(), [
      "--project-root",
      "/nonexistent-deft-bootstrap-cli-root",
      "--quiet",
    ]);
    expect(code).toBe(2);
    err.mockRestore();
  });

  it("emits json on success", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const mod = {
      ...fakeModule(),
      runBootstrap: (projectRoot: string, repo: string | null, options: Record<string, unknown>) =>
        runBootstrap(projectRoot, repo, {
          ...options,
          cacheModule: { cacheFetchAll: () => ({ succeeded: 1, failed: 0, skipped: 0 }) },
          progress: null,
        }),
    };
    const code = await runWithModule(mod, ["--repo", "deftai/directive", "--json", "--quiet"]);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalled();
    out.mockRestore();
  });

  it("emits recap on success", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const mod = {
      ...fakeModule(),
      runBootstrap: (projectRoot: string, repo: string | null, options: Record<string, unknown>) =>
        runBootstrap(projectRoot, repo, {
          ...options,
          cacheModule: { cacheFetchAll: () => ({ succeeded: 0, failed: 0, skipped: 0 }) },
          progress: null,
        }),
    };
    const code = await runWithModule(mod, ["--quiet"]);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalled();
    out.mockRestore();
  });
});

describe("triage-bootstrap-parity helpers", () => {
  it("normalizeStdout canonicalizes json project_root", () => {
    const normalized = normalizeStdout('{"project_root":"/tmp/x","exit_code":0}');
    expect(normalized).toContain('"project_root":"<ROOT>"');
  });

  it("normalizeOutput strips volatile paths in prose", () => {
    expect(normalizeOutput("under /tmp/foo/bar")).toContain("<ROOT>");
  });

  it("diffCase detects stdout mismatch", () => {
    const same = diffCase(
      { exitCode: 0, stdout: '{"a":1}', stderr: "" },
      { exitCode: 0, stdout: '{"a":1}', stderr: "" },
      "x",
    );
    expect(same.stdoutMismatch).toBe(false);
    const diff = diffCase(
      { exitCode: 0, stdout: '{"a":1}', stderr: "" },
      { exitCode: 0, stdout: '{"a":2}', stderr: "" },
      "x",
    );
    expect(diff.stdoutMismatch).toBe(true);
  });

  it("buildFixtureRepo creates vbrief tree", () => {
    const root = buildFixtureRepo({
      scopeVbriefs: [{ folder: "proposed", slug: "s", issue: 1 }],
    });
    temps.push(root);
    expect(root).toContain("deft-triage-bootstrap-parity-");
  });

  it("renderReport prints CLEAN", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
  });

  it("parity corpus is non-empty", () => {
    expect(PARITY_CASES.length).toBeGreaterThan(0);
  });
});
