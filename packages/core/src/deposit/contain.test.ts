import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInitDeposit } from "../init-deposit/init-deposit.js";
import { runRefreshDeposit } from "../init-deposit/refresh.js";
import { assertDepositContained, DepositContainmentError } from "./contain.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * Build a project whose `.deft` (or `.deft/core`) is a symlink escaping the
 * project tree. Returns the project dir + the escape target so callers can
 * verify nothing was written through the symlink.
 */
function escapingSymlinkProject(which: ".deft" | ".deft/core"): {
  projectDir: string;
  escapeTarget: string;
} {
  const projectDir = freshDir("deft-contain-project-");
  const escapeTarget = freshDir("deft-contain-escape-");
  if (which === ".deft") {
    symlinkSync(escapeTarget, join(projectDir, ".deft"), "dir");
  } else {
    mkdirSync(join(projectDir, ".deft"), { recursive: true });
    symlinkSync(escapeTarget, join(projectDir, ".deft", "core"), "dir");
  }
  return { projectDir, escapeTarget };
}

describe("assertDepositContained (#2305)", () => {
  it("passes (no-op) when the project directory does not exist yet", () => {
    // `directive init <new-path>` -- nothing exists, so nothing can escape.
    const missing = join(freshDir("deft-contain-missing-"), "does-not-exist");
    expect(() => assertDepositContained(missing, join(missing, ".deft", "core"))).not.toThrow();
  });

  it("passes for a greenfield project with no .deft symlink", () => {
    const projectDir = freshDir("deft-contain-clean-");
    expect(() =>
      assertDepositContained(projectDir, join(projectDir, ".deft", "core")),
    ).not.toThrow();
  });

  it("passes when .deft/core is a real nested directory", () => {
    const projectDir = freshDir("deft-contain-real-");
    mkdirSync(join(projectDir, ".deft", "core"), { recursive: true });
    expect(() =>
      assertDepositContained(projectDir, join(projectDir, ".deft", "core")),
    ).not.toThrow();
  });

  it("throws when .deft is a symlink escaping the tree", () => {
    const { projectDir } = escapingSymlinkProject(".deft");
    expect(() => assertDepositContained(projectDir, join(projectDir, ".deft", "core"))).toThrow(
      DepositContainmentError,
    );
  });

  it("throws when .deft/core is a symlink escaping the tree", () => {
    const { projectDir } = escapingSymlinkProject(".deft/core");
    expect(() => assertDepositContained(projectDir, join(projectDir, ".deft", "core"))).toThrow(
      /symlink escaping the project tree/,
    );
  });

  it("throws when .deft is a broken/dangling symlink on the deposit path", () => {
    const projectDir = freshDir("deft-contain-dangling-");
    // Point .deft at a target that does not exist -> realpath fails.
    symlinkSync(join(projectDir, "nonexistent-target"), join(projectDir, ".deft"), "dir");
    expect(() => assertDepositContained(projectDir, join(projectDir, ".deft", "core"))).toThrow(
      /broken\/dangling symlink/,
    );
  });

  it("allows a .deft symlink that stays within the project tree", () => {
    const projectDir = freshDir("deft-contain-intree-");
    const inTree = join(projectDir, "actual-deft");
    mkdirSync(inTree, { recursive: true });
    symlinkSync(inTree, join(projectDir, ".deft"), "dir");
    expect(() =>
      assertDepositContained(projectDir, join(projectDir, ".deft", "core")),
    ).not.toThrow();
  });
});

// Single shared driver: exercises both `directive init` and `directive update`
// core paths against the same crafted escaping-symlink fixture (#2305 AC).
type DepositRunner = (projectDir: string, copyContent: () => Promise<void>) => Promise<unknown>;

const runners: Record<"init" | "update", DepositRunner> = {
  init: (projectDir, copyContent) =>
    runInitDeposit(
      { projectDir, jsonOut: false, nonInteractive: true },
      { printf: () => {} },
      {
        detectLegacy: () => ({ legacy: false, kind: null, detail: "", evidence: [] }),
        resolveContentRoot: async () => freshDir("deft-contain-content-"),
        copyContent,
      },
    ),
  update: (projectDir, copyContent) =>
    runRefreshDeposit(
      { projectDir, jsonOut: false, nonInteractive: true, upgrade: false },
      { printf: () => {} },
      {
        detectLegacy: () => ({ legacy: false, kind: null, detail: "", evidence: [] }),
        resolveContentRoot: async () => freshDir("deft-contain-content-"),
        copyContent,
      },
    ),
};

describe.each([
  "init",
  "update",
] as const)("deposit refuses a symlink-escaping boundary (%s, #2305)", (verb) => {
  it("throws and copies nothing when .deft escapes the tree", async () => {
    const { projectDir } = escapingSymlinkProject(".deft");
    const copyContent = vi.fn(async () => {});
    await expect(runners[verb](projectDir, copyContent)).rejects.toThrow(DepositContainmentError);
    expect(copyContent).not.toHaveBeenCalled();
  });

  it("throws and copies nothing when .deft/core escapes the tree", async () => {
    const { projectDir, escapeTarget } = escapingSymlinkProject(".deft/core");
    const copyContent = vi.fn(async () => {
      // If the guard failed, the deposit would write through the symlink.
      writeFileSync(join(escapeTarget, "SHOULD-NOT-EXIST"), "x", "utf8");
    });
    await expect(runners[verb](projectDir, copyContent)).rejects.toThrow(DepositContainmentError);
    expect(copyContent).not.toHaveBeenCalled();
  });
});
