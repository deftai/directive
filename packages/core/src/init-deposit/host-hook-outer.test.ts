import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE,
  hostHookOuterCommand,
  hostHookOuterRelPath,
  hostHookOuterSha8,
  hostHookOuterSource,
  isHostHookOuterCommand,
} from "./host-hook-outer.js";

describe("host-hook-outer (#5994)", () => {
  it("hashes to stable sha8 and builds per-host paths", () => {
    const source = hostHookOuterSource();
    const sha8 = hostHookOuterSha8(source);
    expect(sha8).toMatch(/^[a-f0-9]{8}$/);
    expect(hostHookOuterRelPath("grok", sha8)).toBe(`.grok/hooks/deft-hook-${sha8}.mjs`);
    expect(hostHookOuterCommand("cursor", sha8)).toBe(
      `node .cursor/hooks/deft-hook-${sha8}.mjs`,
    );
    expect(isHostHookOuterCommand(hostHookOuterCommand("claude", sha8))).toBe(true);
    expect(isHostHookOuterCommand("node node_modules/@deftai/directive-runtime/dist/hook-bin.js")).toBe(
      false,
    );
  });

  it("F1: disable quiet-allows without pin present", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-disable-"));
    try {
      mkdirSync(join(root, ".grok", "hooks"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      const sha8 = hostHookOuterSha8();
      const rel = hostHookOuterRelPath("grok", sha8);
      const abs = join(root, rel);
      writeFileSync(abs, hostHookOuterSource());
      const r = spawnSync(process.execPath, [abs, "--host", "grok", "--event", "tool.before"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout ?? "").toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("F1: missing pin fail-closed with project PM guidance (not AC9.7)", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-misspin-"));
    try {
      mkdirSync(join(root, ".grok", "hooks"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}\n");
      const sha8 = hostHookOuterSha8();
      const abs = join(root, hostHookOuterRelPath("grok", sha8));
      writeFileSync(abs, hostHookOuterSource());
      const r = spawnSync(process.execPath, [abs, "--host", "grok", "--event", "tool.before"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
      expect(r.stdout).not.toContain("npm i -g @deftai/directive");
      expect(r.stdout).not.toContain("directive install --repair");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("source mentions pin hook-bin and disable flag", () => {
    const source = hostHookOuterSource();
    expect(source).toContain("node_modules/@deftai/directive-runtime/dist/hook-bin.js");
    expect(source).toContain(".deft-directive-disable");
    expect(source).toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
  });
});
