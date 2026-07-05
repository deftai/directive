import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACKAGE_MANAGER,
  detectPackageManager,
  ENGINE_PACKAGE,
  PACKAGE_MANAGERS,
  renderEphemeral,
  renderGlobalInstall,
  renderPackageManagerCommands,
  renderProjectInstall,
} from "./package-manager.js";

describe("resolution/package-manager detectPackageManager (#2197)", () => {
  it("defaults to npm with no signals", () => {
    expect(detectPackageManager()).toBe("npm");
    expect(detectPackageManager({ env: {} })).toBe(DEFAULT_PACKAGE_MANAGER);
  });

  it("honors the DEFT_PACKAGE_MANAGER env override first", () => {
    expect(detectPackageManager({ env: { DEFT_PACKAGE_MANAGER: "pnpm" } })).toBe("pnpm");
    expect(detectPackageManager({ env: { DEFT_PACKAGE_MANAGER: "npm" } })).toBe("npm");
    // Override beats every lower-precedence signal.
    expect(
      detectPackageManager({
        env: { DEFT_PACKAGE_MANAGER: "npm", npm_config_user_agent: "pnpm/9.0.0" },
        pnpmLockPresent: true,
        packageManagerField: "pnpm@9.0.0",
      }),
    ).toBe("npm");
  });

  it("reads the packageManager / corepack field before the lockfile", () => {
    expect(detectPackageManager({ packageManagerField: "pnpm@9.1.0" })).toBe("pnpm");
    expect(detectPackageManager({ packageManagerField: "npm@10.0.0" })).toBe("npm");
  });

  it("falls back to pnpm-lock.yaml presence", () => {
    expect(detectPackageManager({ pnpmLockPresent: true })).toBe("pnpm");
  });

  it("falls back to npm_config_user_agent", () => {
    expect(
      detectPackageManager({ env: { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v20" } }),
    ).toBe("pnpm");
    expect(detectPackageManager({ env: { npm_config_user_agent: "npm/10.0.0 node/v20" } })).toBe(
      "npm",
    );
  });

  it("ignores blank / unrecognized override values", () => {
    expect(detectPackageManager({ env: { DEFT_PACKAGE_MANAGER: "   " } })).toBe("npm");
    expect(detectPackageManager({ env: { DEFT_PACKAGE_MANAGER: "yarn" } })).toBe("npm");
  });
});

describe("resolution/package-manager renderers (#2197)", () => {
  it("renders npm global install", () => {
    expect(renderGlobalInstall("npm")).toBe(`npm i -g ${ENGINE_PACKAGE}`);
    expect(renderGlobalInstall("npm", `${ENGINE_PACKAGE}@0.65.0`)).toBe(
      "npm i -g @deftai/directive@0.65.0",
    );
  });

  it("renders pnpm global install", () => {
    expect(renderGlobalInstall("pnpm")).toBe(`pnpm add -g ${ENGINE_PACKAGE}`);
    expect(renderGlobalInstall("pnpm", `${ENGINE_PACKAGE}@0.65.0`)).toBe(
      "pnpm add -g @deftai/directive@0.65.0",
    );
  });

  it("renders project-local install per manager", () => {
    expect(renderProjectInstall("npm")).toBe(`npm install --save-dev ${ENGINE_PACKAGE}`);
    expect(renderProjectInstall("pnpm")).toBe(`pnpm add -D ${ENGINE_PACKAGE}`);
  });

  it("renders ephemeral invocations per manager", () => {
    expect(renderEphemeral("npm", "update")).toBe(`npx ${ENGINE_PACKAGE} update`);
    expect(renderEphemeral("pnpm", "update")).toBe(`pnpm dlx ${ENGINE_PACKAGE} update`);
    expect(renderEphemeral("npm", "")).toBe(`npx ${ENGINE_PACKAGE}`);
  });

  it("renders the full command matrix", () => {
    for (const pm of PACKAGE_MANAGERS) {
      const cmds = renderPackageManagerCommands(pm);
      expect(cmds.packageManager).toBe(pm);
      expect(cmds.upgradeOneLiner).toContain(`${ENGINE_PACKAGE}@latest`);
      expect(cmds.globalInstall).toContain(ENGINE_PACKAGE);
      expect(cmds.projectInstall).toContain(ENGINE_PACKAGE);
      expect(cmds.ephemeralUpdate).toContain("update");
    }
    expect(renderPackageManagerCommands("pnpm").upgradeOneLiner).toBe(
      "pnpm add -g @deftai/directive@latest",
    );
    expect(renderPackageManagerCommands("npm").upgradeOneLiner).toBe(
      "npm i -g @deftai/directive@latest",
    );
  });

  it("never emits a custom --registry flag (locked decision: same npm registry)", () => {
    for (const pm of PACKAGE_MANAGERS) {
      const cmds = renderPackageManagerCommands(pm);
      for (const cmd of [
        cmds.globalInstall,
        cmds.projectInstall,
        cmds.ephemeralUpdate,
        cmds.upgradeOneLiner,
      ]) {
        expect(cmd).not.toContain("--registry");
        expect(cmd).not.toContain("registry=");
      }
    }
  });
});
