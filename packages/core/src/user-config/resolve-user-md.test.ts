import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NO_USER_MD_DIAGNOSTIC,
  platformUserConfigDir,
  type ResolveUserMdOptions,
  resolveUserMdPath,
  USER_MD_FILENAME,
  WORKSPACE_LOCAL_CONFIG_DIR,
} from "./resolve-user-md.js";

const HOME = "/home/tester";
const PROJECT = "/work/project";

/** Base options that resolve nothing (no env override, empty filesystem). */
function baseOptions(overrides: Partial<ResolveUserMdOptions> = {}): ResolveUserMdOptions {
  return {
    projectRoot: PROJECT,
    env: {},
    platform: "linux",
    homeDir: HOME,
    fileExists: () => false,
    ...overrides,
  };
}

describe("platformUserConfigDir", () => {
  it("uses APPDATA/deft on win32 when APPDATA is set", () => {
    expect(
      platformUserConfigDir("win32", { APPDATA: "C:\\Users\\t\\AppData\\Roaming" }, HOME),
    ).toBe(join("C:\\Users\\t\\AppData\\Roaming", "deft"));
  });

  it("falls back to homedir AppData/Roaming/deft on win32 without APPDATA", () => {
    expect(platformUserConfigDir("win32", {}, HOME)).toBe(join(HOME, "AppData", "Roaming", "deft"));
  });

  it("uses ~/.config/deft on unix", () => {
    expect(platformUserConfigDir("linux", {}, HOME)).toBe(join(HOME, ".config", "deft"));
    expect(platformUserConfigDir("darwin", {}, HOME)).toBe(join(HOME, ".config", "deft"));
  });
});

describe("resolveUserMdPath — search order", () => {
  it("rung 1: DEFT_USER_PATH override wins over every other candidate", () => {
    const override = "/custom/place/USER.md";
    const result = resolveUserMdPath(
      baseOptions({
        env: { DEFT_USER_PATH: override },
        // Even if workspace-local and platform files exist, the override wins.
        fileExists: () => true,
      }),
    );
    expect(result.rung).toBe("env-override");
    expect(result.path).toBe(resolve(override));
    expect(result.found).toBe(true);
    expect(result.diagnostic).toContain("DEFT_USER_PATH");
  });

  it("rung 1: override wins as resolved path even when the file does not exist", () => {
    const override = "/custom/place/USER.md";
    const result = resolveUserMdPath(
      baseOptions({ env: { DEFT_USER_PATH: override }, fileExists: () => false }),
    );
    expect(result.rung).toBe("env-override");
    expect(result.path).toBe(resolve(override));
    expect(result.found).toBe(false);
    expect(result.diagnostic).toContain("does not exist yet");
  });

  it("rung 2: workspace-local .deft/USER.md resolves without DEFT_USER_PATH", () => {
    const workspacePath = resolve(join(PROJECT, WORKSPACE_LOCAL_CONFIG_DIR, USER_MD_FILENAME));
    const result = resolveUserMdPath(baseOptions({ fileExists: (p) => p === workspacePath }));
    expect(result.rung).toBe("workspace-local");
    expect(result.path).toBe(workspacePath);
    expect(result.found).toBe(true);
    expect(result.diagnostic).toContain("workspace-local");
  });

  it("rung 3: platform config dir resolves when workspace-local is absent", () => {
    const platformPath = join(HOME, ".config", "deft", USER_MD_FILENAME);
    const result = resolveUserMdPath(baseOptions({ fileExists: (p) => p === platformPath }));
    expect(result.rung).toBe("platform-config");
    expect(result.path).toBe(platformPath);
    expect(result.found).toBe(true);
    expect(result.diagnostic).toContain("platform config dir");
  });

  it("rung 3: honors APPDATA on win32", () => {
    const configDir = join("D:\\AppData", "deft");
    const platformPath = join(configDir, USER_MD_FILENAME);
    const result = resolveUserMdPath(
      baseOptions({
        platform: "win32",
        env: { APPDATA: "D:\\AppData" },
        fileExists: (p) => p === platformPath,
      }),
    );
    expect(result.rung).toBe("platform-config");
    expect(result.path).toBe(platformPath);
    expect(result.found).toBe(true);
  });

  it("rung 4: absent everywhere degrades to defaults with a clear diagnostic and never throws", () => {
    const platformPath = join(HOME, ".config", "deft", USER_MD_FILENAME);
    const result = resolveUserMdPath(baseOptions());
    expect(result.rung).toBe("default");
    expect(result.path).toBe(platformPath);
    expect(result.found).toBe(false);
    expect(result.diagnostic).toContain(NO_USER_MD_DIAGNOSTIC);
    // The diagnostic lists what was searched so the boundary is visible.
    expect(result.searched.length).toBe(2);
    expect(result.searched).toContain(
      resolve(join(PROJECT, WORKSPACE_LOCAL_CONFIG_DIR, USER_MD_FILENAME)),
    );
    expect(result.searched).toContain(platformPath);
  });

  it("first-hit-wins: workspace-local beats platform config when both exist", () => {
    const workspacePath = resolve(join(PROJECT, WORKSPACE_LOCAL_CONFIG_DIR, USER_MD_FILENAME));
    const result = resolveUserMdPath(baseOptions({ fileExists: () => true }));
    expect(result.rung).toBe("workspace-local");
    expect(result.path).toBe(workspacePath);
  });

  it("does not throw with default options (real process env/platform/home)", () => {
    expect(() => resolveUserMdPath()).not.toThrow();
  });
});
