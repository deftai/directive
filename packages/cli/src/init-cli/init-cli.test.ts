import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as initDeposit from "@deftai/directive-core/init-deposit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_INIT_ARGV, CANONICAL_UPDATE_ARGV } from "./constants.js";
import { runInit } from "./init.js";
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
      "/tmp/pkg/vendor/deft-install/install-linux-amd64",
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

describe("runInit TS-native deposit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not spawn bundled deft-install on the happy path", async () => {
    const spawnSpy = vi.spyOn(spawnSync as never, "apply" as never);
    const depositSpy = vi.spyOn(initDeposit, "runInitDepositCli").mockResolvedValue(0);
    const { io } = captureIo();

    const code = await runInit([], io);

    expect(code).toBe(0);
    expect(depositSpy).toHaveBeenCalledOnce();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("passes canonical init argv through parseInitArgv", async () => {
    const depositSpy = vi.spyOn(initDeposit, "runInitDepositCli").mockResolvedValue(0);
    const { io } = captureIo();

    await runInit(["--repo-root", "/tmp/custom"], io);

    expect(depositSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: "/tmp/custom",
        jsonOut: true,
        nonInteractive: true,
      }),
    );
    expect(CANONICAL_INIT_ARGV).toContain("--yes");
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
        projectDir: "/tmp/custom",
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
    const code = await runInit(["--repo-root", legacyProject()], io);
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
    expect(root.endsWith("/packages/cli")).toBe(true);
  });
});
