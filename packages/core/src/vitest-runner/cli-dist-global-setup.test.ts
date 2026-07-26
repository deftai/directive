import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireVitestCliDistBuildLock,
  isStaleVitestCliDistLock,
  releaseVitestCliDistBuildLock,
} from "./cli-dist-global-setup.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    releaseVitestCliDistBuildLock(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-dist-lock-"));
  temps.push(root);
  mkdirSync(join(root, ".deft-scratch"), { recursive: true });
  return root;
}

describe("cli-dist-global-setup lock", () => {
  it("treats missing lock metadata as stale", () => {
    const root = fakeRepoRoot();
    mkdirSync(join(root, ".deft-scratch/vitest-cli-dist-build.lock"), { recursive: true });
    expect(isStaleVitestCliDistLock(root)).toBe(true);
  });

  it("serializes concurrent acquirers in-process", () => {
    const root = fakeRepoRoot();
    acquireVitestCliDistBuildLock(root);
    expect(existsSync(join(root, ".deft-scratch/vitest-cli-dist-build.lock/meta.json"))).toBe(true);
    releaseVitestCliDistBuildLock(root);
    expect(isStaleVitestCliDistLock(root)).toBe(true);
  });
});
