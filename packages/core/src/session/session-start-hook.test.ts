import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runSessionStartHookWrite } from "./session-start-hook.js";

describe("session start hook", () => {
  it("returns 2 when branch missing", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const result = runSessionStartHookWrite(root, {
      detectBranchFn: () => null,
    });
    expect(result.code).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("writes sentinel when preconditions satisfied", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-ok-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", "a.xbrief.json"), "{}\n", "utf8");
    const result = runSessionStartHookWrite(root, {
      detectBranchFn: () => "feat/x",
      detectLatestActiveVbriefFn: () => "xbrief/active/a.xbrief.json",
      resolveVersionFn: () => "0.9.0",
      writeSentinelFn: (projectRoot, input) => {
        expect(input.deftVersion).toBe("0.9.0");
        return join(projectRoot, ".deft", "last-session.json");
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("last-session.json");
    rmSync(root, { recursive: true, force: true });
  });

  it("skips sentinel write when .no-deft-directive is present (#2926)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-opt-out-"));
    writeFileSync(join(root, ".no-deft-directive"), "", "utf8");
    const writeSentinelFn = vi.fn(() => {
      throw new Error("sentinel must not run under opt-out");
    });
    const result = runSessionStartHookWrite(root, {
      detectBranchFn: () => "feat/x",
      detectLatestActiveVbriefFn: () => "xbrief/active/a.xbrief.json",
      resolveVersionFn: () => "0.9.0",
      writeSentinelFn,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Directive disabled via `.no-deft-directive`");
    expect(writeSentinelFn).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
  });

  it("skips sentinel write when .deft-directive-disable is present (#3039)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-kill-switch-"));
    writeFileSync(join(root, ".deft-directive-disable"), "", "utf8");
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    const writeSentinelFn = vi.fn(() => {
      throw new Error("sentinel must not run under kill-switch");
    });
    const result = runSessionStartHookWrite(root, {
      detectBranchFn: () => "feat/x",
      detectLatestActiveVbriefFn: () => "xbrief/active/a.xbrief.json",
      resolveVersionFn: () => "0.9.0",
      writeSentinelFn,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(".deft-directive-disable");
    expect(result.stdout).toContain("NEW agent session");
    expect(writeSentinelFn).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns exit 1 and skips write when opt-out is inconsistent with deposit (#2926)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-opt-out-inc-"));
    writeFileSync(join(root, ".no-deft-directive"), "", "utf8");
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    const writeSentinelFn = vi.fn(() => {
      throw new Error("sentinel must not run under inconsistent opt-out");
    });
    const result = runSessionStartHookWrite(root, {
      detectBranchFn: () => "feat/x",
      detectLatestActiveVbriefFn: () => "xbrief/active/a.xbrief.json",
      resolveVersionFn: () => "0.9.0",
      writeSentinelFn,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Inconsistent state");
    expect(writeSentinelFn).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
  });
});
