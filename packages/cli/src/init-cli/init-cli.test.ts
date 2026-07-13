import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as initDeposit from "@deftai/directive-core/init-deposit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatchIo } from "../dispatch.js";
import {
  CANONICAL_INIT_ARGV,
  CANONICAL_UPDATE_ARGV,
  INIT_DRY_RUN_FLAGS,
  UPDATE_DRY_RUN_FLAGS,
} from "./constants.js";
import { isInitHeadless, parseInitOutputPath, runInit } from "./init.js";
import {
  bundledBinaryCandidates,
  cliPackageRoot,
  releaseArtifactName,
  resolveBundledDeftInstallBinary,
} from "./resolve-binary.js";
import { runDeftInstall } from "./run-deft-install.js";
import { runUpdate } from "./update.js";

// `JSON.parse` returns top-level `null` (not a throw) for the literal `null`,
// so a guarded parse keeps property reads from blowing up with a TypeError
// outside the parse boundary.
function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") {
    throw new Error(
      `expected a JSON object payload, received ${value === null ? "null" : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function captureIo(): { io: DispatchIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: (text) => {
        err.push(text);
      },
    },
  };
}

describe("resolveBundledDeftInstallBinary", () => {
  it("maps linux x64 to install-linux-amd64 under vendor/deft-install", () => {
    expect(releaseArtifactName("linux", "x64")).toBe("install-linux-amd64");
    const root = "/tmp/pkg";
    expect(bundledBinaryCandidates(root, "linux", "x64")[0]).toBe(
      join(root, "vendor", "deft-install", "install-linux-amd64"),
    );
  });

  it("honors DEFT_INSTALL_BINARY when the path is readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-install-"));
    const binary = join(dir, "deft-install");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(binary, 0o755);
    expect(resolveBundledDeftInstallBinary({ env: { DEFT_INSTALL_BINARY: binary } })).toBe(binary);
  });

  it("returns null when bundled candidates are absent", () => {
    expect(
      resolveBundledDeftInstallBinary({
        packageRoot: "/nonexistent/package",
        platform: "linux",
        arch: "x64",
      }),
    ).toBeNull();
  });
});

describe("runDeftInstall delegation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("update invokes bundled binary with canonical upgrade argv", () => {
    const { io } = captureIo();
    const runBinary = vi.fn((): { status: number; stdout: string; stderr: string } => ({
      status: 0,
      stdout: '{"ok":true,"action":"upgrade"}\n',
      stderr: "",
    }));

    const code = runDeftInstall({
      verb: "update",
      canonicalArgv: CANONICAL_UPDATE_ARGV,
      io,
      resolveBinaryDetailed: () => ({ ok: true, path: "/bundled/deft-install" }),
      runBinary,
    });

    expect(code).toBe(0);
    expect(runBinary.mock.calls[0]?.[1]).toEqual([...CANONICAL_UPDATE_ARGV]);
  });

  it("update maps non-zero binary exit to non-zero CLI exit", () => {
    const { io, err } = captureIo();
    const runBinary = vi.fn(() => ({
      status: 3,
      stdout: "",
      stderr: "upgrade refused\n",
    }));

    const code = runDeftInstall({
      verb: "update",
      canonicalArgv: CANONICAL_UPDATE_ARGV,
      io,
      resolveBinaryDetailed: () => ({ ok: true, path: "/bundled/deft-install" }),
      runBinary,
    });

    expect(code).toBe(3);
    expect(err.join("")).toContain("upgrade refused");
  });
});

describe("runInit universal adoption dispatcher (#2265)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Classify seams that make ANY directory look empty/greenfield -> scaffold.
  const emptyDirClassify = {
    isDir: () => false,
    isFile: () => false,
    readText: () => null,
    engineProbe: () => ({ reachable: false, version: null }),
    preCutoverProbe: () => false,
  };

  function recordingSeams(classifySeams: typeof emptyDirClassify) {
    const calls = { scaffold: 0, refresh: 0, migrate: 0 };
    const scaffoldArgs: unknown[] = [];
    return {
      calls,
      scaffoldArgs,
      seams: {
        classifySeams,
        runScaffold: async (options: unknown) => {
          calls.scaffold += 1;
          scaffoldArgs.push(options);
          return 0;
        },
        runRefresh: async () => {
          calls.refresh += 1;
          return 0;
        },
        runMigrate: () => {
          calls.migrate += 1;
          return 0;
        },
      },
    };
  }

  it("dispatches an empty dir to the scaffold deposit without spawning bundled deft-install", async () => {
    const spawnSpy = vi.spyOn(spawnSync as never, "apply" as never);
    const { io } = captureIo();
    const { calls, seams } = recordingSeams(emptyDirClassify);

    const code = await runInit([], io, seams);

    expect(code).toBe(0);
    expect(calls).toEqual({ scaffold: 1, refresh: 0, migrate: 0 });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("threads the canonical init argv (repo-root, --json, --yes) to the scaffold delegate", async () => {
    const { io } = captureIo();
    const { scaffoldArgs, seams } = recordingSeams(emptyDirClassify);

    await runInit(["--repo-root", "/tmp/custom"], io, seams);

    expect(scaffoldArgs[0]).toMatchObject({
      projectDir: resolve("/tmp/custom"),
      jsonOut: true,
      nonInteractive: true,
    });
    expect(CANONICAL_INIT_ARGV).toContain("--yes");
  });

  it("--dry-run classifies and prints without executing any delegate", async () => {
    const { io, out } = captureIo();
    const { calls, seams } = recordingSeams(emptyDirClassify);

    // --json keeps stdout a single JSON object; the human summary goes to stderr.
    const code = await runInit(["--dry-run"], io, seams);

    expect(code).toBe(0);
    expect(calls).toEqual({ scaffold: 0, refresh: 0, migrate: 0 });
    const parsed = parseJsonObject(out.join(""));
    expect(parsed.action).toBe("init");
    expect(parsed.dry_run).toBe(true);
    expect(parsed.dispatch).toBe("scaffold");
  });

  it("keeps the existing runInitDepositCli barrel export wired as the default scaffold delegate", () => {
    // Guards the single-sourcing contract: init delegates to the existing verb.
    expect(typeof initDeposit.runInitDepositCli).toBe("function");
    expect(typeof initDeposit.runRefreshDepositCli).toBe("function");
    expect(typeof initDeposit.runMigrateCli).toBe("function");
  });

  it("keeps the init and update dry-run flag sets in lockstep", () => {
    // The two verbs intentionally own separate constants for semantic clarity;
    // this guard fails loudly if the tuples ever silently diverge.
    expect([...INIT_DRY_RUN_FLAGS]).toEqual([...UPDATE_DRY_RUN_FLAGS]);
  });
});

describe("runInit --headless routing (#2268)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects the --headless flag and parses --output in both forms", () => {
    expect(isInitHeadless(["--headless"])).toBe(true);
    expect(isInitHeadless(["--yes"])).toBe(false);
    expect(parseInitOutputPath(["--headless", "--output=manifest.json"])).toBe("manifest.json");
    expect(parseInitOutputPath(["--headless", "--output", "out.json"])).toBe("out.json");
    expect(parseInitOutputPath(["--headless"])).toBeNull();
    // An adjacent flag is NOT consumed as the output path (space-separated form).
    expect(parseInitOutputPath(["--output", "--headless"])).toBeNull();
    expect(parseInitOutputPath(["--output", "-x"])).toBeNull();
    // Absolute POSIX paths (leading `/`, not `-`) are still accepted.
    expect(parseInitOutputPath(["--output", "/tmp/manifest.json"])).toBe("/tmp/manifest.json");
  });

  it("short-circuits headless past the dispatch delegates and emits a JSON error gracefully", async () => {
    const { io, out } = captureIo();
    const calls = { scaffold: 0, refresh: 0, migrate: 0 };
    const dispatchSeams = {
      classifySeams: {
        engineProbe: () => ({ reachable: false, version: null }),
        preCutoverProbe: () => false,
      },
      runScaffold: async () => {
        calls.scaffold += 1;
        return 0;
      },
      runRefresh: async () => {
        calls.refresh += 1;
        return 0;
      },
      runMigrate: () => {
        calls.migrate += 1;
        return 0;
      },
    };

    const code = await runInit(["--headless"], io, dispatchSeams, {
      // A fake root (no files on disk) so the manifest build fails during
      // content collection -> the graceful JSON-error path, no real package needed.
      resolveContentRoot: () => Promise.resolve(join(tmpdir(), "headless-missing-root")),
      readVersion: () => "1.2.3",
    });

    // Routing MUST have bypassed every executing dispatch delegate.
    expect(calls).toEqual({ scaffold: 0, refresh: 0, migrate: 0 });
    expect(code).toBe(1);
    const parsed = parseJsonObject(out.join(""));
    expect(parsed.success).toBe(false);
    expect(typeof parsed.error_code).toBe("string");
  });
});

describe("runUpdate TS-native refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not spawn bundled deft-install on the happy path", async () => {
    const spawnSpy = vi.spyOn(spawnSync as never, "apply" as never);
    const refreshSpy = vi.spyOn(initDeposit, "runRefreshDepositCli").mockResolvedValue(0);
    const { io } = captureIo();

    const code = await runUpdate([], io);

    expect(code).toBe(0);
    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("passes canonical update argv through parseUpdateArgv", async () => {
    const refreshSpy = vi.spyOn(initDeposit, "runRefreshDepositCli").mockResolvedValue(0);
    const { io } = captureIo();

    await runUpdate(["--repo-root", "/tmp/custom"], io);

    expect(refreshSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: resolve("/tmp/custom"),
        jsonOut: true,
        nonInteractive: true,
        upgrade: true,
      }),
    );
    expect(CANONICAL_UPDATE_ARGV).toContain("--upgrade");
  });
});

describe("legacy-layout refusal (end-to-end via the CLI, #1912)", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function legacyProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "legacy-cli-"));
    created.push(dir);
    mkdirSync(join(dir, ".deft"), { recursive: true });
    writeFileSync(join(dir, ".deft", "VERSION"), "tag: 'v0.26.0'\n", "utf8");
    return dir;
  }

  it("runInit refuses an orphan .deft/VERSION layout with exit 2", async () => {
    const { io, out } = captureIo();
    // Deterministic classify seams so the test never shells out and never
    // depends on the real detectPreCutover: an orphan .deft/VERSION layout
    // classifies as init-mode, and the scaffold deposit refuses it with exit 2.
    const code = await runInit(["--repo-root", legacyProject()], io, {
      classifySeams: {
        engineProbe: () => ({ reachable: false, version: null }),
        preCutoverProbe: () => false,
      },
    });
    expect(code).toBe(2);
    const parsed = parseJsonObject(out.join(""));
    expect(parsed.action).toBe("refuse");
    expect(parsed.legacy_layout).toBe(true);
    expect(parsed.upgrading_doc_url).toContain("UPGRADING.md");
  });

  it("runUpdate refuses an orphan .deft/VERSION layout with exit 2", async () => {
    const { io, out } = captureIo();
    const code = await runUpdate(["--repo-root", legacyProject()], io);
    expect(code).toBe(2);
    const parsed = parseJsonObject(out.join(""));
    expect(parsed.action).toBe("refuse");
    expect(parsed.command).toBe("update");
  });
});

describe("cliPackageRoot", () => {
  it("resolves two levels above init-cli dist modules", () => {
    const root = cliPackageRoot(new URL("./resolve-binary.ts", import.meta.url).href);
    // Normalize separators for cross-platform check.
    expect(root.replace(/\\/g, "/").endsWith("/packages/cli")).toBe(true);
  });
});
