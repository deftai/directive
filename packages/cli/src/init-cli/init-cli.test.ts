import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_INIT_ARGV, CANONICAL_UPDATE_ARGV } from "./constants.js";
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

  it("init invokes bundled binary with canonical install argv and passthrough JSON", () => {
    const { io, out } = captureIo();
    const runBinary = vi.fn((): { status: number; stdout: string; stderr: string } => ({
      status: 0,
      stdout: '{"ok":true,"action":"install"}\n',
      stderr: "",
    }));

    const code = runDeftInstall({
      verb: "init",
      canonicalArgv: CANONICAL_INIT_ARGV,
      io,
      resolveBinaryDetailed: () => ({ ok: true, path: "/bundled/deft-install" }),
      runBinary,
    });

    expect(code).toBe(0);
    expect(runBinary).toHaveBeenCalledOnce();
    expect(runBinary.mock.calls[0]?.[0]).toBe("/bundled/deft-install");
    expect(runBinary.mock.calls[0]?.[1]).toEqual([...CANONICAL_INIT_ARGV]);
    expect(out.join("")).toContain('"action":"install"');
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
    expect(runBinary.mock.calls[0]?.[1]).toEqual([...CANONICAL_UPDATE_ARGV]);
    expect(err.join("")).toContain("upgrade refused");
  });

  it("emits remediation when bundled binary cannot be located", () => {
    const { io, err } = captureIo();
    const code = runDeftInstall({
      verb: "init",
      canonicalArgv: CANONICAL_INIT_ARGV,
      io,
      resolveBinaryDetailed: () => ({
        ok: false,
        reason: "not-found",
        packageRoot: "/pkg/root",
        platform: "linux",
        arch: "x64",
      }),
    });

    expect(code).toBe(2);
    const message = err.join("");
    expect(message).toContain("directive init:");
    expect(message).toContain("bundled deft-install binary not found");
    expect(message).toContain("/pkg/root/vendor/deft-install/install-linux-amd64");
    expect(message).toContain("DEFT_INSTALL_BINARY");
    expect(message).not.toContain("ENOENT");
  });

  it("reports unreadable DEFT_INSTALL_BINARY override distinctly", () => {
    const { io, err } = captureIo();
    const code = runDeftInstall({
      verb: "update",
      canonicalArgv: CANONICAL_UPDATE_ARGV,
      io,
      resolveBinaryDetailed: () => ({
        ok: false,
        reason: "override-unreadable",
        path: "/bad/deft-install",
      }),
    });

    expect(code).toBe(2);
    expect(err.join("")).toContain("DEFT_INSTALL_BINARY is set to /bad/deft-install");
  });
});

describe("cliPackageRoot", () => {
  it("resolves two levels above init-cli dist modules", () => {
    const root = cliPackageRoot(new URL("./resolve-binary.ts", import.meta.url).href);
    expect(root.endsWith("/packages/cli")).toBe(true);
  });
});
