import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "active", "a.vbrief.json"), "{}\n", "utf8");
    const result = runSessionStartHookWrite(root, {
      detectBranchFn: () => "feat/x",
      detectLatestActiveVbriefFn: () => "vbrief/active/a.vbrief.json",
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
});
