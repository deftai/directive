import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLexicalOutsideProjectRoot, isOutsideProjectRootWrite } from "./outside-project-root.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tryDirLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

describe("isLexicalOutsideProjectRoot", () => {
  it("treats parent traversal as outside and ..secret as inside", () => {
    expect(isLexicalOutsideProjectRoot("..")).toBe(true);
    expect(isLexicalOutsideProjectRoot("../tmp/x")).toBe(true);
    expect(isLexicalOutsideProjectRoot("..secret")).toBe(false);
    expect(isLexicalOutsideProjectRoot("src/foo.ts")).toBe(false);
  });
});

describe("isOutsideProjectRootWrite re-entry (#3997)", () => {
  it("treats a temp junction or dir link into the project as not outside", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "out-root-proj-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "out-root-out-"));
    temps.push(projectDir, outsideDir);
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "inside.ts"), "inside", "utf8");
    const alias = join(outsideDir, "alias");
    if (!tryDirLink(join(projectDir, "src"), alias)) {
      throw new Error("could not create directory junction or dir symlink");
    }
    const aliasedTarget = join(alias, "inside.ts");
    expect(isOutsideProjectRootWrite(projectDir, aliasedTarget)).toBe(false);
  });

  it("treats a true OS-temp dest as outside", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "out-root-true-"));
    temps.push(projectDir);
    const dest = join(tmpdir(), "body.md");
    expect(isOutsideProjectRootWrite(projectDir, dest)).toBe(true);
  });
});
