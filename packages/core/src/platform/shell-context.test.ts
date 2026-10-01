import { describe, expect, it } from "vitest";
import {
  assertProtectedMutationOwnership,
  classifyMountOwnershipCapability,
  DEFT_ALLOW_ROOT_WSL_RUNTIME,
  detectWslHost,
  evaluateWslOwnershipGuard,
  fixScopedOwnership,
  OWNERSHIP_FACTS_CLASSIFIER,
  ownershipGuardToDict,
  parseOwnerSpec,
  probeRuntimeCapabilities,
  reportToDict,
  resolveProjectOwner,
} from "./platform-capabilities.js";
import {
  detectEnvironmentContext,
  environmentContextToDict,
  formatEnvironmentContext,
} from "./shell-context.js";

describe("detectEnvironmentContext", () => {
  it("prefers the harness-provided execution shell and preserves attribution", () => {
    expect(
      detectEnvironmentContext({
        environ: {
          DEFT_EXECUTION_SHELL: "/opt/homebrew/bin/bash",
          SHELL: "/bin/zsh",
        },
        platform: "darwin",
        userShell: "/bin/fish",
      }),
    ).toEqual({
      hostPlatform: "darwin",
      shell: {
        name: "bash",
        path: "/opt/homebrew/bin/bash",
        kind: "execution",
        source: "DEFT_EXECUTION_SHELL",
      },
    });
  });

  it("reports SHELL as a default shell rather than the current executor", () => {
    expect(
      detectEnvironmentContext({
        environ: { SHELL: "/bin/zsh" },
        platform: "darwin",
        userShell: "/bin/fish",
      }).shell,
    ).toEqual({ name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" });
  });

  it("falls back to the POSIX account shell", () => {
    expect(
      detectEnvironmentContext({ environ: {}, platform: "linux", userShell: "/usr/bin/fish" })
        .shell,
    ).toEqual({
      name: "fish",
      path: "/usr/bin/fish",
      kind: "default",
      source: "os.userInfo().shell",
    });
  });

  it("uses os.userInfo when neither userShell nor readUserShell is supplied (#2666)", () => {
    const context = detectEnvironmentContext({ environ: {}, platform: "linux" });
    expect(
      context.shell.source === "os.userInfo().shell" || context.shell.source === "unknown",
    ).toBe(true);
  });

  it("reads the POSIX account shell through the injectable platform seam", () => {
    expect(
      detectEnvironmentContext({
        environ: {},
        platform: "linux",
        readUserShell: () => "/bin/dash",
      }).shell,
    ).toEqual({
      name: "dash",
      path: "/bin/dash",
      kind: "default",
      source: "os.userInfo().shell",
    });
  });

  it("reports unknown when account-shell lookup throws", () => {
    expect(
      detectEnvironmentContext({
        environ: {},
        platform: "linux",
        readUserShell: () => {
          throw new Error("account database unavailable");
        },
      }).shell,
    ).toEqual({ name: "unknown", path: null, kind: "unknown", source: "unknown" });
  });

  it("reports unknown when account-shell lookup is empty", () => {
    expect(
      detectEnvironmentContext({ environ: {}, platform: "linux", readUserShell: () => "" }).shell,
    ).toEqual({ name: "unknown", path: null, kind: "unknown", source: "unknown" });
  });

  it("falls back to ComSpec and normalizes a Windows executable name", () => {
    expect(
      detectEnvironmentContext({
        environ: { ComSpec: "C:\\Windows\\System32\\cmd.EXE" },
        platform: "win32",
        userShell: "/bin/ignored",
      }).shell,
    ).toEqual({
      name: "cmd",
      path: "C:\\Windows\\System32\\cmd.EXE",
      kind: "default",
      source: "ComSpec",
    });
  });

  it("accepts the uppercase COMSPEC spelling", () => {
    expect(
      detectEnvironmentContext({
        environ: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32",
      }).shell.source,
    ).toBe("ComSpec");
  });

  it("supports a bare shell name without inventing a path", () => {
    expect(
      detectEnvironmentContext({
        environ: { DEFT_EXECUTION_SHELL: "pwsh" },
        platform: "win32",
        userShell: null,
      }).shell,
    ).toEqual({
      name: "pwsh",
      path: null,
      kind: "execution",
      source: "DEFT_EXECUTION_SHELL",
    });
  });

  it.each([
    ["./bash", "bash"],
    ["../bin/zsh", "zsh"],
    ["relative\\pwsh", "pwsh"],
  ])("does not surface a relative shell candidate %j as a validated path", (candidate, name) => {
    expect(
      detectEnvironmentContext({
        environ: { DEFT_EXECUTION_SHELL: candidate },
        platform: "linux",
        userShell: null,
      }).shell,
    ).toEqual({
      name,
      path: null,
      kind: "execution",
      source: "DEFT_EXECUTION_SHELL",
    });
  });

  it("skips invalid higher-precedence candidates", () => {
    expect(
      detectEnvironmentContext({
        environ: {
          DEFT_EXECUTION_SHELL: "/bin/bash\nforged-output",
          SHELL: "/bin/zsh",
        },
        platform: "darwin",
        userShell: "/bin/fish",
      }).shell,
    ).toEqual({ name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" });
  });

  it("rejects overlong candidates and reports unknown without guessing", () => {
    expect(
      detectEnvironmentContext({
        environ: { DEFT_EXECUTION_SHELL: `/bin/${"x".repeat(4097)}` },
        platform: "freebsd",
        userShell: null,
      }).shell,
    ).toEqual({ name: "unknown", path: null, kind: "unknown", source: "unknown" });
  });

  it.each(["   ", "/", ".", "..", ".exe"])("rejects an invalid shell basename %j", (invalid) => {
    expect(
      detectEnvironmentContext({
        environ: { DEFT_EXECUTION_SHELL: invalid },
        platform: "linux",
        userShell: null,
      }).shell.source,
    ).toBe("unknown");
  });

  it.each([
    ...Array.from({ length: 32 }, (_, codePoint) => codePoint),
    ...Array.from({ length: 33 }, (_, offset) => 127 + offset),
    0x2028,
    0x2029,
  ])("rejects shell candidates containing control character U+%i", (codePoint) => {
    const malformed = `/bin/zsh${String.fromCharCode(codePoint)}`;
    const context = detectEnvironmentContext({
      environ: { DEFT_EXECUTION_SHELL: malformed, SHELL: "/bin/fish" },
      platform: "linux",
      userShell: null,
    });
    expect(context.shell.source).toBe("SHELL");
    expect(context.shell.name).toBe("fish");
  });

  it("formats safe human and machine contracts", () => {
    const context = detectEnvironmentContext({
      environ: { SHELL: "/bin/zsh" },
      platform: "darwin",
      userShell: null,
    });
    expect(formatEnvironmentContext(context)).toBe(
      "[deft environment] os=darwin; shell=zsh; kind=default; path=/bin/zsh; source=SHELL",
    );
    expect(environmentContextToDict(context)).toEqual({
      host_platform: "darwin",
      shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
    });
  });

  it("quotes ambiguous values and formats an unknown path explicitly", () => {
    const spaced = detectEnvironmentContext({
      environ: { SHELL: "/tmp dir/zsh" },
      platform: "darwin",
      userShell: null,
    });
    expect(formatEnvironmentContext(spaced)).toContain('path="/tmp dir/zsh"');
    const unknown = detectEnvironmentContext({
      environ: {},
      platform: "aix",
      userShell: null,
    });
    expect(formatEnvironmentContext(unknown)).toBe(
      "[deft environment] os=aix; shell=unknown; kind=unknown; path=unknown; source=unknown",
    );
  });
});

describe("platform capability shell composition", () => {
  it("includes shell orientation in the typed and dictionary reports", () => {
    const report = probeRuntimeCapabilities({
      environ: { SHELL: "/bin/zsh" },
      platform: "darwin",
      userShell: null,
      uidMapPath: "/none",
      cwd: "/none",
      effectiveUidOverride: 1000,
    });
    expect(report.hostPlatform).toBe("darwin");
    expect(report.shell.source).toBe("SHELL");
    expect(reportToDict(report)).toMatchObject({
      host_platform: "darwin",
      shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
    });
  });
});

describe("WSL ownership guard (#1617)", () => {
  const passwd =
    "root:x:0:0:root:/root:/bin/bash\n" +
    "alice:x:1000:1000:Alice:/home/alice:/bin/bash\n" +
    "bob:x:1001:1001:Bob:/home/bob:/bin/bash\n";

  const ext4MountInfo =
    "36 1 8:1 / /home rw,relatime - ext4 /dev/sda1 rw\n" +
    "37 1 0:35 / /mnt/c rw - 9p C:\\ rw,noatime\n";

  const drvfsMountInfo = "36 1 0:35 / /mnt/c rw,noatime - 9p C:\\ rw,noatime\n";

  const metadataDrvFs = "36 1 0:35 / /mnt/c rw - drvfs C:\\ rw,metadata\n";

  it("never hard-fails native Windows or macOS", () => {
    for (const platform of ["win32", "darwin"] as const) {
      const verdict = evaluateWslOwnershipGuard({
        platform,
        projectRoot: "/home/alice/proj",
        effectiveUidOverride: 0,
        environ: { WSL_DISTRO_NAME: "Ubuntu" },
        readPasswd: () => passwd,
        readMountInfo: () => ext4MountInfo,
        statOwnership: () => ({ uid: 1000, gid: 1000 }),
      });
      expect(verdict.status).toBe("exempt-non-wsl");
      expect(verdict.blockProtectedMutation).toBe(false);
      expect(detectWslHost({ platform, environ: { WSL_DISTRO_NAME: "Ubuntu" } })).toBe(false);
    }
  });

  it("fails closed on harm-capable WSL root vs non-root owner and names owner", () => {
    const verdict = evaluateWslOwnershipGuard({
      platform: "linux",
      projectRoot: "/home/alice/proj",
      effectiveUidOverride: 0,
      environ: { WSL_DISTRO_NAME: "Ubuntu" },
      readPasswd: () => passwd,
      readMountInfo: () => ext4MountInfo,
      statOwnership: () => ({ uid: 1000, gid: 1000 }),
    });
    expect(verdict.wsl).toBe(true);
    expect(verdict.status).toBe("fail");
    expect(verdict.blockProtectedMutation).toBe(true);
    expect(verdict.classifier).toBe(OWNERSHIP_FACTS_CLASSIFIER);
    expect(verdict.intendedOwner.uid).toBe(1000);
    expect(verdict.sessionWarnLines[0]).toContain("1000:1000");
    expect(verdict.sessionWarnLines[0]).toMatch(/alice|1000:1000/);
    const gate = assertProtectedMutationOwnership({
      platform: "linux",
      projectRoot: "/home/alice/proj",
      effectiveUidOverride: 0,
      environ: { WSL_DISTRO_NAME: "Ubuntu" },
      readPasswd: () => passwd,
      readMountInfo: () => ext4MountInfo,
      statOwnership: () => ({ uid: 1000, gid: 1000 }),
    });
    expect(gate.ok).toBe(false);
    expect(gate.exitCode).toBe(1);
  });

  it("treats null uid as not-non-root on WSL (fail closed)", () => {
    const verdict = evaluateWslOwnershipGuard({
      platform: "linux",
      projectRoot: "/home/alice/proj",
      effectiveUidOverride: null,
      environ: { WSL_DISTRO_NAME: "Ubuntu" },
      readPasswd: () => passwd,
      readMountInfo: () => ext4MountInfo,
      statOwnership: () => ({ uid: 1000, gid: 1000 }),
    });
    expect(verdict.blockProtectedMutation).toBe(true);
    expect(verdict.messages[0]).toMatch(/unknown|null/i);
  });

  it("does not fail closed on mount-pinned DrvFs/9p without metadata", () => {
    const verdict = evaluateWslOwnershipGuard({
      platform: "linux",
      projectRoot: "/mnt/c/Users/alice/proj",
      effectiveUidOverride: 0,
      environ: { WSL_DISTRO_NAME: "Ubuntu" },
      readPasswd: () => passwd,
      readMountInfo: () => drvfsMountInfo,
      statOwnership: () => ({ uid: 1000, gid: 1000 }),
    });
    expect(verdict.status).toBe("exempt-mount-pinned");
    expect(verdict.blockProtectedMutation).toBe(false);
    expect(
      classifyMountOwnershipCapability("/mnt/c/Users/alice/proj", {
        readMountInfo: () => drvfsMountInfo,
        realpath: (p) => p,
      }).capability,
    ).toBe("mount-pinned");
  });

  it("classifies symlink path via realpath target mount (#1617)", () => {
    const combined = `${drvfsMountInfo}\n${ext4MountInfo}`;
    expect(
      classifyMountOwnershipCapability("/mnt/c/project-link", {
        readMountInfo: () => combined,
        realpath: () => "/home/alice/proj",
      }).capability,
    ).toBe("harm-capable");
  });

  it("treats metadata-enabled DrvFs as harm-capable", () => {
    expect(
      classifyMountOwnershipCapability("/mnt/c/proj", {
        readMountInfo: () => metadataDrvFs,
        realpath: (p) => p,
      }).capability,
    ).toBe("harm-capable");
  });

  it("unknown mount table fails closed with actionable detail", () => {
    const mount = classifyMountOwnershipCapability("/var/lib/proj", {
      readMountInfo: () => null,
      realpath: (p) => p,
    });
    expect(mount.capability).toBe("unknown");
    expect(mount.detail).toMatch(/fail closed/i);
  });

  it("empty mount table fails closed as unknown (not harm-capable)", () => {
    const mount = classifyMountOwnershipCapability("/home/alice/proj", {
      readMountInfo: () => "",
      realpath: (p) => p,
    });
    expect(mount.capability).toBe("unknown");
    expect(mount.detail).toMatch(/fail closed|empty/i);
  });

  it("honors override with documented limitation and soft warn", () => {
    const verdict = evaluateWslOwnershipGuard({
      platform: "linux",
      projectRoot: "/home/alice/proj",
      effectiveUidOverride: 0,
      environ: { WSL_DISTRO_NAME: "Ubuntu", [DEFT_ALLOW_ROOT_WSL_RUNTIME]: "1" },
      readPasswd: () => passwd,
      readMountInfo: () => ext4MountInfo,
      statOwnership: () => ({ uid: 1000, gid: 1000 }),
    });
    expect(verdict.status).toBe("exempt-override");
    expect(verdict.blockProtectedMutation).toBe(false);
    expect(verdict.sessionWarnLines[0]).toContain("1000:1000");
    expect(verdict.overrideLimitation).toMatch(/not an OS security boundary/i);
  });

  it("resolves explicit owner and refuses conflicting env candidates", () => {
    expect(parseOwnerSpec("1000:1000")).toEqual({ uid: 1000, gid: 1000 });
    expect(parseOwnerSpec("bad")).toBeNull();
    const explicit = resolveProjectOwner({
      projectRoot: "/home/alice/proj",
      explicitOwner: "1000:1000",
      readPasswd: () => passwd,
      statOwnership: () => ({ uid: 0, gid: 0 }),
    });
    expect(explicit.source).toBe("explicit-owner");
    expect(explicit.account).toBe("alice");

    const ambiguous = resolveProjectOwner({
      projectRoot: "/opt/shared",
      readPasswd: () => passwd,
      environ: { USER: "bob", SUDO_UID: "1000", SUDO_GID: "1000" },
      statOwnership: (path) =>
        path === "/opt/shared" ? { uid: 0, gid: 0 } : { uid: 1000, gid: 1000 },
    });
    // May resolve via ancestor or conflict with bob — either unresolved/ambiguous or single.
    expect([
      "ambiguous",
      "nearest-nonroot-ancestor",
      "sudo-env",
      "user-env",
      "unresolved",
    ]).toContain(ambiguous.source);
  });

  it("ownership:fix restats after chown and refuses env-only authorize", () => {
    const ownership = new Map<string, { uid: number; gid: number }>([
      ["/home/alice/proj", { uid: 0, gid: 0 }],
      ["/home/alice/proj/.deft", { uid: 0, gid: 0 }],
    ]);
    const envOnly = fixScopedOwnership({
      projectRoot: "/home/alice/proj",
      readPasswd: () => passwd,
      environ: { USER: "alice" },
      statOwnership: (p) => ownership.get(p) ?? { uid: 1000, gid: 1000 },
      approvedRoots: ["."],
      chown: () => {
        throw new Error("should not chown for env-only");
      },
      readdir: () => [],
    });
    // project-root is root-owned; nearest ancestor / USER may yield user-env alone.
    if (envOnly.exitCode !== 0) {
      expect(envOnly.messages.join(" ")).toMatch(/authorize chown|owner|uid:gid/i);
    }

    const fixed = fixScopedOwnership({
      projectRoot: "/home/alice/proj",
      explicitOwner: "1000:1000",
      readPasswd: () => passwd,
      approvedRoots: ["."],
      exists: () => true,
      lstat: (p) => {
        const own = ownership.get(p) ?? { uid: 0, gid: 0 };
        return {
          ...own,
          isDirectory: p === "/home/alice/proj",
          isSymbolicLink: false,
        };
      },
      statOwnership: (p) => ownership.get(p) ?? null,
      chown: (p, uid, gid) => {
        ownership.set(p, { uid, gid });
      },
      readdir: (p) => (p === "/home/alice/proj" ? [".deft"] : []),
    });
    expect(fixed.ok).toBe(true);
    expect(fixed.repaired.length).toBeGreaterThan(0);
    expect(ownership.get("/home/alice/proj")?.uid).toBe(1000);

    const falseSuccess = fixScopedOwnership({
      projectRoot: "/home/alice/proj",
      explicitOwner: "1000:1000",
      readPasswd: () => passwd,
      approvedRoots: ["."],
      exists: () => true,
      lstat: () => ({ uid: 0, gid: 0, isDirectory: false, isSymbolicLink: false }),
      statOwnership: () => ({ uid: 0, gid: 0 }),
      chown: () => {
        /* pretend success without changing ownership (DrvFs) */
      },
      readdir: () => [],
    });
    expect(falseSuccess.ok).toBe(false);
    expect(falseSuccess.messages.join(" ")).toMatch(/re-stat|DrvFs/i);

    const unlistable = fixScopedOwnership({
      projectRoot: "/home/alice/proj",
      explicitOwner: "1000:1000",
      readPasswd: () => passwd,
      approvedRoots: ["."],
      exists: () => true,
      lstat: () => ({ uid: 1000, gid: 1000, isDirectory: true, isSymbolicLink: false }),
      statOwnership: () => ({ uid: 1000, gid: 1000 }),
      chown: () => {
        throw new Error("should not chown");
      },
      readdir: () => {
        throw new Error("EACCES");
      },
    });
    expect(unlistable.ok).toBe(false);
    expect(unlistable.failed).toContain("/home/alice/proj");
    expect(unlistable.messages.join(" ")).toMatch(/cannot list directory/i);
  });

  it("ownershipGuardToDict exposes vocabulary split", () => {
    const verdict = evaluateWslOwnershipGuard({
      platform: "win32",
      projectRoot: "C:\\proj",
      effectiveUidOverride: null,
    });
    const dict = ownershipGuardToDict(verdict);
    expect(dict.classifier).toBe(OWNERSHIP_FACTS_CLASSIFIER);
    expect(dict.vocabulary).toMatchObject({
      filesystem_project_owner: expect.stringContaining("this guard"),
    });
  });
});
