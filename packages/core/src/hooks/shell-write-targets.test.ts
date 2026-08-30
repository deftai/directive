import { describe, expect, it } from "vitest";
import {
  classifyShellWriteTargets,
  compoundLastCdLooksLikeTemp,
  isInRepoShellWritePath,
} from "./shell-write-targets.js";

describe("classifyShellWriteTargets", () => {
  it("extracts Set-Content dests", () => {
    expect(classifyShellWriteTargets("Set-Content -Path src/app.ts -Value x")).toEqual([
      { kind: "set-content", path: "src/app.ts" },
    ]);
  });
  it("extracts python pathlib dests", () => {
    const DQ = String.fromCharCode(34);
    const AQ = String.fromCharCode(39);
    const cmd =
      "python -c " +
      DQ +
      "from pathlib import Path; Path(" +
      AQ +
      "src/app.ts" +
      AQ +
      ").write_text(" +
      AQ +
      "x" +
      AQ +
      ")" +
      DQ;
    expect(classifyShellWriteTargets(cmd)).toEqual([
      { kind: "python-pathlib", path: "src/app.ts" },
    ]);
  });
  it("returns empty for git status and occupancy:release", () => {
    expect(classifyShellWriteTargets("git status --short")).toEqual([]);
    expect(classifyShellWriteTargets("deft occupancy:release --session-id=owner")).toEqual([]);
  });
  it("treats OS-temp dests as not in-repo", () => {
    expect(isInRepoShellWritePath("/repo", "src/app.ts")).toBe(true);
    expect(isInRepoShellWritePath("/repo", "/tmp/body.md")).toBe(false);
  });
  it("does not classify echo of a Set-Content spelling", () => {
    expect(classifyShellWriteTargets("echo Set-Content -Path src/app.ts")).toEqual([]);
  });
  it("marks compound cd plus Set-Content unprovable", () => {
    const dests = classifyShellWriteTargets("cd src && Set-Content -Path app.ts -Value x");
    expect(dests.length).toBeGreaterThan(0);
    expect(dests.every((d) => d.unprovable === true)).toBe(true);
  });
  it("does not classify a write_text method reference", () => {
    const DQ = String.fromCharCode(34);
    const AQ = String.fromCharCode(39);
    const cmd = "python -c " + DQ + "print(Path(" + AQ + "src/app.ts" + AQ + ").write_text)" + DQ;
    expect(classifyShellWriteTargets(cmd)).toEqual([]);
  });
  it("detects last cd to env TEMP", () => {
    expect(compoundLastCdLooksLikeTemp("cd $env:TEMP; WriteAllText(")).toBe(true);
    expect(compoundLastCdLooksLikeTemp("cd src && Set-Content -Path app.ts")).toBe(false);
  });
});
