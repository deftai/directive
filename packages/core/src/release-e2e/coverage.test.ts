import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ENTRYPOINT_TIMEOUT_EXIT_CODE,
  EXIT_CONFIG_ERROR,
  EXIT_OK,
  EXIT_VIOLATION,
} from "./constants.js";
import {
  callReleaseEntrypoint,
  callReleaseEntrypointTimed,
  dispatchTaskRelease,
  dispatchTaskReleaseRollback,
  restoreProcessStateForTest,
  runEntrypointWorker,
} from "./entrypoint.js";
import { runWorkerEntrypoint } from "./entrypoint-worker.js";
import { generateRepoSlug, parseE2EFlags } from "./flags.js";
import * as ghOps from "./gh-ops.js";
import * as gitOps from "./git-ops.js";
import { pushMirror, setOriginToTempRepo } from "./git-ops.js";
import * as mainModule from "./main.js";
import { cmdReleaseE2e, runE2e } from "./main.js";
import * as rehearsalModule from "./rehearsal.js";
import { rollbackMain } from "./rollback-bridge.js";

describe("release-e2e branch coverage boost", () => {
  it("setOriginToTempRepo happy path", () => {
    const [ok, reason] = setOriginToTempRepo("/clone", "deftai", "slug", {
      runGit: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    expect(ok).toBe(true);
    expect(reason).toContain("https://github.com/deftai/slug.git");
  });

  it("pushMirror happy path", () => {
    const [ok] = pushMirror("/clone", {
      runGit: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    expect(ok).toBe(true);
  });

  it("generateRepoSlug seam override", () => {
    expect(generateRepoSlug({ generateRepoSlug: () => "custom-slug" })).toBe("custom-slug");
  });

  it("cmdReleaseE2e rejects empty owner", () => {
    expect(cmdReleaseE2e(["--owner", ""])).toBe(EXIT_CONFIG_ERROR);
  });

  it("cmdReleaseE2e resolves project root and delegates", () => {
    const tmp = mkdtempSync(join(tmpdir(), "deft-root-"));
    const spy = vi.spyOn(mainModule, "runE2e").mockReturnValue(EXIT_OK);
    expect(cmdReleaseE2e(["--dry-run", "--project-root", tmp])).toBe(EXIT_OK);
    spy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parseE2EFlags unknown positional and missing values", () => {
    const flags = parseE2EFlags(["--owner", "--dry-run", "positional", "--project-root"]);
    expect(flags.unknown).toContain("--owner");
    expect(flags.unknown).toContain("positional");
    expect(flags.unknown).toContain("--project-root");
  });

  it("dispatch without seams uses worker-backed entrypoint path", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-dispatch-"));
    const seams = {
      releaseEntrypoint: () => 0,
      rollbackEntrypoint: () => 0,
    };
    expect(dispatchTaskRelease(cloneDir, "0.0.1", "deftai/x", seams)[0]).toBe(true);
    expect(dispatchTaskReleaseRollback(cloneDir, "0.0.1", "deftai/x", seams)[0]).toBe(true);
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("dispatch without seams surfaces non-zero exit via worker path", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-dispatch-"));
    const [ok, reason] = dispatchTaskRelease(cloneDir, "0.0.1", "deftai/x", {
      releaseEntrypoint: () => 2,
    });
    expect(ok).toBe(false);
    expect(reason).toContain("release.py failed (exit 2)");
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("runE2e emits rehearsal OK path", () => {
    vi.spyOn(ghOps, "provisionTempRepo").mockReturnValue([true, "created"]);
    vi.spyOn(rehearsalModule, "runRehearsal").mockReturnValue([true, "all good"]);
    vi.spyOn(ghOps, "destroyTempRepo").mockReturnValue([true, "deleted"]);
    expect(
      runE2e({
        owner: "deftai",
        projectRoot: ".",
        dryRun: false,
        keepRepo: false,
        skipNpm: false,
        repoSlug: "fixed-slug",
      }),
    ).toBe(EXIT_OK);
    vi.restoreAllMocks();
  });

  it("dispatch rollback without seams surfaces non-zero exit", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-dispatch-"));
    const [ok, reason] = dispatchTaskReleaseRollback(cloneDir, "0.0.1", "deftai/x", {
      rollbackEntrypoint: () => 3,
    });
    expect(ok).toBe(false);
    expect(reason).toContain("release_rollback.py failed (exit 3)");
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("callReleaseEntrypoint captures stdout and non-Error throws", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-cap-"));
    const [code1, out1] = callReleaseEntrypoint(
      () => {
        process.stdout.write("stdout payload");
        return 0;
      },
      [],
      cloneDir,
    );
    expect(code1).toBe(0);
    expect(out1).toContain("stdout payload");

    const [code2, out2] = callReleaseEntrypoint(
      () => {
        throw "string throw";
      },
      [],
      cloneDir,
    );
    expect(code2).toBe(EXIT_VIOLATION);
    expect(out2).toContain("string throw");
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("callReleaseEntrypointTimed uses worker success path when built", async () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-worker-"));
    const [code] = await callReleaseEntrypointTimed("test", ["0.0.1"], cloneDir, 2, "throw");
    expect(code).toBeGreaterThan(0);
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("restoreProcessState ignores stale restore owner", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-cap-"));
    callReleaseEntrypoint(() => 0, [], cloneDir);
    expect(() =>
      restoreProcessStateForTest(Symbol("stale"), process.cwd(), process.env.DEFT_PROJECT_ROOT),
    ).not.toThrow();
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("runWorkerEntrypoint covers hang branch", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-worker-"));
    vi.spyOn(Atomics, "wait").mockReturnValue("ok");
    const result = runWorkerEntrypoint({
      kind: "test",
      argv: [],
      cloneDir,
      testBehavior: "hang",
    });
    expect(result.code).toBe(0);
    vi.restoreAllMocks();
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("runWorkerEntrypoint merges stderr before error message", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-worker-"));
    const result = runWorkerEntrypoint({
      kind: "test",
      argv: [],
      cloneDir,
      testBehavior: "throw",
    });
    expect(result.stderr).toContain("Error: boom");
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("runEntrypointWorker worker timeout branch", async () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-worker-"));
    const result = await runEntrypointWorker("test", ["0.0.1"], cloneDir, 50, "hang");
    expect(result.code).toBe(ENTRYPOINT_TIMEOUT_EXIT_CODE);
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("rollbackMain surfaces spawn failure", async () => {
    vi.spyOn(await import("../release/spawn.js"), "spawnText").mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "uv missing",
    });
    expect(rollbackMain(["0.0.1", "--repo", "deftai/x"])).toBe(1);
    vi.restoreAllMocks();
  });

  it("seam release entrypoint non-zero branch", () => {
    expect(dispatchTaskRelease("/x", "0.0.1", "deftai/x", { releaseEntrypoint: () => 3 })[0]).toBe(
      false,
    );
  });

  it("seam rollback entrypoint non-zero branch", () => {
    expect(
      dispatchTaskReleaseRollback("/x", "0.0.1", "deftai/x", { rollbackEntrypoint: () => 3 })[0],
    ).toBe(false);
  });

  it("rollbackMain success path", async () => {
    vi.spyOn(await import("../release/spawn.js"), "spawnText").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(rollbackMain(["0.0.1", "--repo", "deftai/x"])).toBe(0);
    vi.restoreAllMocks();
  });

  it("rollbackMain treats missing status as failure", async () => {
    vi.spyOn(await import("../release/spawn.js"), "spawnText").mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
    });
    expect(rollbackMain(["0.0.1", "--repo", "deftai/x"])).toBe(1);
    vi.restoreAllMocks();
  });

  it("gh ops default spawnText path", async () => {
    vi.spyOn(await import("../release/gh.js"), "resolveGh").mockReturnValue("/usr/bin/gh");
    vi.spyOn(await import("../release/spawn.js"), "spawnText").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });
    const [ok] = ghOps.provisionTempRepo("deftai", "slug");
    expect(ok).toBe(true);
    vi.restoreAllMocks();
  });

  it("git ops defaultRunGit path without runGit seam", async () => {
    vi.spyOn(await import("../release/git.js"), "runGit").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });
    const [ok] = setOriginToTempRepo("/clone", "deftai", "slug");
    expect(ok).toBe(true);
    vi.restoreAllMocks();
  });

  it("callReleaseEntrypoint restores prior DEFT_PROJECT_ROOT", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-cap-"));
    process.env.DEFT_PROJECT_ROOT = "/prior-root";
    callReleaseEntrypoint(() => 0, [], cloneDir);
    expect(process.env.DEFT_PROJECT_ROOT).toBe("/prior-root");
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("callReleaseEntrypoint clears DEFT_PROJECT_ROOT when unset before", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-cap-"));
    delete process.env.DEFT_PROJECT_ROOT;
    callReleaseEntrypoint(() => 0, [], cloneDir);
    expect(process.env.DEFT_PROJECT_ROOT).toBeUndefined();
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("runRehearsal uses default mkdtemp and rmTemp seams", () => {
    vi.spyOn(gitOps, "cloneRepoToTemp").mockReturnValue([false, "stop early"]);
    const [ok] = rehearsalModule.runRehearsal("deftai", "x", "/proj");
    expect(ok).toBe(false);
    vi.restoreAllMocks();
  });

  it("runWorkerEntrypoint handles non-Error throw", async () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-worker-"));
    vi.spyOn(await import("../release/main.js"), "cmdRelease").mockImplementation(() => {
      throw "plain failure";
    });
    const result = runWorkerEntrypoint({
      kind: "release",
      argv: [],
      cloneDir,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("plain failure");
    vi.restoreAllMocks();
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("runWorkerEntrypoint merges stderr chunks before Error throw", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-worker-"));
    const prevStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      prevStderr(chunk);
      return true;
    }) as typeof process.stderr.write;
    const result = runWorkerEntrypoint({
      kind: "test",
      argv: [],
      cloneDir,
      testBehavior: "throw",
    });
    process.stderr.write = prevStderr;
    expect(result.stderr).toContain("Error: boom");
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("index re-exports smoke", async () => {
    const mod = await import("./index.js");
    expect(mod.cmdReleaseE2e).toBeTypeOf("function");
    expect(mod.runRehearsal).toBeTypeOf("function");
  });
});
