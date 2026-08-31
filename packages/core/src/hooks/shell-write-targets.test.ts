import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyShellWriteTargets,
  isInRepoShellWritePath,
  SHELL_WRITE_KINDS,
} from "./shell-write-targets.js";

describe("classifyShellWriteTargets", () => {
  it("extracts Set-Content dests", () => {
    expect(classifyShellWriteTargets("Set-Content -Path src/app.ts -Value x")).toEqual([
      { kind: "set-content", path: "src/app.ts" },
    ]);
  });
  it("extracts Set-Content dest when -Value precedes -Path", () => {
    expect(classifyShellWriteTargets("Set-Content -Value x -Path src/app.ts")).toEqual([
      { kind: "set-content", path: "src/app.ts" },
    ]);
  });
  it("yields no dest for Set-Content -Value with no -Path", () => {
    expect(classifyShellWriteTargets("Set-Content -Value x")).toEqual([]);
  });
  it("does not treat a non-path named parameter as the dest", () => {
    expect(classifyShellWriteTargets("Set-Content -Value x -Path src/app.ts")[0]?.path).not.toBe(
      "-Value",
    );
    expect(classifyShellWriteTargets("Add-Content -Value x -LiteralPath src/app.ts")).toEqual([
      { kind: "add-content", path: "src/app.ts" },
    ]);
    expect(classifyShellWriteTargets("Out-File -Encoding utf8 -FilePath src/app.ts")).toEqual([
      { kind: "out-file", path: "src/app.ts" },
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
    expect(isInRepoShellWritePath("/repo", "/tmp/../repo/src/app.ts")).toBe(true);
    expect(isInRepoShellWritePath("/x/repo", "../repo/src/app.ts")).toBe(true);
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
  it("extracts a later pathlib write after a harmless Path()", () => {
    const DQ = String.fromCharCode(34);
    const AQ = String.fromCharCode(39);
    const cmd =
      "python -c " +
      DQ +
      "Path(" +
      AQ +
      "other" +
      AQ +
      "); Path(" +
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

  it("extracts pathlib write_text after resolve()", () => {
    const DQ = String.fromCharCode(34);
    const AQ = String.fromCharCode(39);
    const cmd =
      "python -c " +
      DQ +
      "Path(" +
      AQ +
      "src/app.ts" +
      AQ +
      ").resolve().write_text(" +
      AQ +
      "x" +
      AQ +
      ")" +
      DQ;
    expect(classifyShellWriteTargets(cmd)).toEqual([
      { kind: "python-pathlib", path: "src/app.ts" },
    ]);
  });
});

/**
 * Eligibility is what keeps shell traffic off the write gate's re-stamp path,
 * and therefore why matcher coverage alone buys no lease liveness (#3987,
 * completing seat 5471374558 F2 / F9). These assertions freeze the bounds the
 * arc recorded, so a later widening has to be deliberate.
 */
describe("shell write eligibility bounds (#3987)", () => {
  it("recognizes exactly five write forms", () => {
    expect([...SHELL_WRITE_KINDS]).toEqual([
      "set-content",
      "out-file",
      "add-content",
      "python-pathlib",
      "io-writealltext",
    ]);
    for (const unrecognized of [
      "echo x > src/app.ts",
      "echo x >> src/app.ts",
      "cp other.ts src/app.ts",
      "Copy-Item other.ts src/app.ts",
      "Move-Item other.ts src/app.ts",
      "New-Item -Path src/app.ts -ItemType File",
      "tee src/app.ts",
      "sed -i s/a/b/ src/app.ts",
      "node -e require('fs').writeFileSync('src/app.ts','x')",
      "git apply patch.diff",
      "git checkout -- src/app.ts",
    ]) {
      expect(classifyShellWriteTargets(unrecognized), unrecognized).toEqual([]);
    }
  });

  it("refuses any dest carrying shell expansion", () => {
    for (const dest of ["src/$name.ts", "src/*.ts", "src/app?.ts", "$env:TEMP/body.md"]) {
      expect(isInRepoShellWritePath("/repo", dest), dest).toBe(false);
    }
  });

  it("refuses OS-temp and out-of-root dests", () => {
    expect(isInRepoShellWritePath("/repo", join(tmpdir(), "body.md"))).toBe(false);
    expect(isInRepoShellWritePath("/repo", "../elsewhere/app.ts")).toBe(false);
    expect(isInRepoShellWritePath("/repo", "/etc/passwd")).toBe(false);
    expect(isInRepoShellWritePath("/repo", "")).toBe(false);
  });

  it("marks every dest unprovable once the command is compound", () => {
    for (const separator of [";", "&&", "||", "|", "&", "\n"]) {
      const command = `cd src ${separator} Set-Content -Path app.ts -Value x`;
      const dests = classifyShellWriteTargets(command);
      expect(dests.length, command).toBeGreaterThan(0);
      expect(
        dests.every((dest) => dest.unprovable === true),
        command,
      ).toBe(true);
    }
  });
});
