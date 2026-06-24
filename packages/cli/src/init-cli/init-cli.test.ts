import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("cliPackageRoot", () => {
  it("resolves two levels above init-cli dist modules", () => {
    const root = cliPackageRoot(new URL("./resolve-binary.ts", import.meta.url).href);
    expect(root.endsWith("/packages/cli")).toBe(true);
  });
});
