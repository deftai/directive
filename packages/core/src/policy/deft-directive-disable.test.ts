import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import {
  DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
  DEFT_DIRECTIVE_DISABLE_GITIGNORE_LINE,
  DEFT_DIRECTIVE_DISABLE_ONE_LINE,
  DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE,
  DEFT_DIRECTIVE_DISABLE_STATUS,
  DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING,
  deftDirectiveDisableFlagPath,
  detectDeftDirectiveDisable,
  formatDeftDirectiveDisableMessage,
  isDeftDirectiveDisableActive,
} from "./deft-directive-disable.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-directive-disable-"));
  temps.push(root);
  return root;
}

describe("detectDeftDirectiveDisable (#3039)", () => {
  it("reports absent when the flag file is missing", () => {
    const root = tempRoot();
    const state = detectDeftDirectiveDisable(root);
    expect(state.present).toBe(false);
    expect(state.active).toBe(false);
    expect(state.depositPresent).toBe(false);
    expect(state.trackedByGit).toBe(false);
    expect(state.flagPath).toBe(deftDirectiveDisableFlagPath(root));
    expect(isDeftDirectiveDisableActive(root)).toBe(false);
  });

  it("activates on an empty untracked root flag file", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    const state = detectDeftDirectiveDisable(root, {
      isGitTracked: () => false,
    });
    expect(state.present).toBe(true);
    expect(state.active).toBe(true);
    expect(isDeftDirectiveDisableActive(root, { isGitTracked: () => false })).toBe(true);
  });

  it("detects a short-comment flag file as present", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "# A/B arm\n", "utf8");
    expect(detectDeftDirectiveDisable(root, { isGitTracked: () => false }).present).toBe(true);
  });

  it("does not treat a same-named directory as the flag", () => {
    const root = tempRoot();
    mkdirSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME));
    expect(detectDeftDirectiveDisable(root).present).toBe(false);
  });

  it("does not activate on a symlink plant of the kill-switch (#3213)", () => {
    const root = tempRoot();
    const target = join(root, "real-hosts-like.txt");
    writeFileSync(target, "x", "utf8");
    const flag = join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME);
    try {
      symlinkSync(target, flag);
    } catch {
      // Windows may require elevated privileges for file symlinks; skip if unsupported.
      return;
    }
    const state = detectDeftDirectiveDisable(root, { isGitTracked: () => false });
    expect(state.present).toBe(false);
    expect(state.active).toBe(false);
    expect(isDeftDirectiveDisableActive(root, { isGitTracked: () => false })).toBe(false);
  });

  it("reports deposit present without treating it as inconsistent", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const state = detectDeftDirectiveDisable(root, { isGitTracked: () => false });
    expect(state.present).toBe(true);
    expect(state.depositPresent).toBe(true);
    expect(state.active).toBe(true);
  });

  it("does not activate when the flag is tracked by git (misconfig)", () => {
    const root = "/virtual/project";
    const files = new Set([resolve(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME)]);
    const state = detectDeftDirectiveDisable(root, {
      isFile: (p) => files.has(p),
      isDir: () => false,
      isGitTracked: () => true,
    });
    expect(state.present).toBe(true);
    expect(state.trackedByGit).toBe(true);
    expect(state.active).toBe(false);
    expect(
      isDeftDirectiveDisableActive(root, {
        isFile: (p) => files.has(p),
        isGitTracked: () => true,
      }),
    ).toBe(false);
  });

  it("honors injectable seams without touching the filesystem", () => {
    const root = "/virtual/project";
    const files = new Set([resolve(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME)]);
    const dirs = new Set([join(root, CANONICAL_INSTALL_ROOT)]);
    const state = detectDeftDirectiveDisable(root, {
      isFile: (p) => files.has(p),
      isDir: (p) => dirs.has(p),
      isGitTracked: () => false,
    });
    expect(state.present).toBe(true);
    expect(state.depositPresent).toBe(true);
    expect(state.active).toBe(true);
  });

  it("documents recovery wording and gitignore constant", () => {
    expect(DEFT_DIRECTIVE_DISABLE_FLAG_NAME).toBe(".deft-directive-disable");
    expect(DEFT_DIRECTIVE_DISABLE_GITIGNORE_LINE).toBe(".deft-directive-disable");
    expect(DEFT_DIRECTIVE_DISABLE_STATUS).toBe("disabled-test-kill-switch");
    expect(DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE).toContain("rm .deft-directive-disable");
    expect(DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE).toContain("NEW agent session");
    expect(DEFT_DIRECTIVE_DISABLE_ONE_LINE).toContain("test/local kill-switch");
    expect(DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING).toContain("gitignored");
    expect(DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING).toContain("NOT disabled");
  });
});

describe("formatDeftDirectiveDisableMessage (#3039)", () => {
  it("includes recovery steps by default", () => {
    const msg = formatDeftDirectiveDisableMessage();
    expect(msg).toContain("Delete the file");
    expect(msg).toContain("NEW agent session");
  });

  it("combines permanent opt-out when both flags present", () => {
    const msg = formatDeftDirectiveDisableMessage({ permanentOptOutAlsoPresent: true });
    expect(msg).toContain(".no-deft-directive");
    expect(msg).toContain("permanent opt-out");
  });

  it("appends tracked-by-git warning", () => {
    const msg = formatDeftDirectiveDisableMessage({ trackedByGit: true });
    expect(msg).toContain(DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING);
  });

  it("supports one-line mode", () => {
    const msg = formatDeftDirectiveDisableMessage({ oneLine: true });
    expect(msg).toBe(DEFT_DIRECTIVE_DISABLE_ONE_LINE);
  });
});
