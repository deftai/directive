import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import {
  createDeftDirectiveDisableFlag,
  DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
  DEFT_DIRECTIVE_DISABLE_GITIGNORE_LINE,
  DEFT_DIRECTIVE_DISABLE_ONE_LINE,
  DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE,
  DEFT_DIRECTIVE_DISABLE_STATUS,
  DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING,
  deftDirectiveDisableFlagPath,
  detectDeftDirectiveDisable,
  formatDeftDirectiveDisableMessage,
  isDeftDirectiveDisablePresent,
  removeDeftDirectiveDisableFlag,
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
    expect(state.depositPresent).toBe(false);
    expect(state.trackedByGit).toBe(false);
    expect(state.flagPath).toBe(deftDirectiveDisableFlagPath(root));
    expect(isDeftDirectiveDisablePresent(root)).toBe(false);
  });

  it("detects an empty root flag file as present", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    const state = detectDeftDirectiveDisable(root);
    expect(state.present).toBe(true);
    expect(isDeftDirectiveDisablePresent(root)).toBe(true);
  });

  it("detects a short-comment flag file as present", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "# A/B arm\n", "utf8");
    expect(detectDeftDirectiveDisable(root).present).toBe(true);
  });

  it("does not treat a same-named directory as the flag", () => {
    const root = tempRoot();
    mkdirSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME));
    expect(detectDeftDirectiveDisable(root).present).toBe(false);
  });

  it("reports deposit present without treating it as inconsistent", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const state = detectDeftDirectiveDisable(root);
    expect(state.present).toBe(true);
    expect(state.depositPresent).toBe(true);
    // No inconsistent field — deposit OK under kill-switch.
  });

  it("honors injectable seams without touching the filesystem", () => {
    const root = "/virtual/project";
    const files = new Set([resolve(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME)]);
    const dirs = new Set([join(root, CANONICAL_INSTALL_ROOT)]);
    const state = detectDeftDirectiveDisable(root, {
      isFile: (p) => files.has(p),
      isDir: (p) => dirs.has(p),
      isGitTracked: () => true,
    });
    expect(state.present).toBe(true);
    expect(state.depositPresent).toBe(true);
    expect(state.trackedByGit).toBe(true);
  });

  it("documents recovery wording and gitignore constant", () => {
    expect(DEFT_DIRECTIVE_DISABLE_FLAG_NAME).toBe(".deft-directive-disable");
    expect(DEFT_DIRECTIVE_DISABLE_GITIGNORE_LINE).toBe(".deft-directive-disable");
    expect(DEFT_DIRECTIVE_DISABLE_STATUS).toBe("disabled-test-kill-switch");
    expect(DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE).toContain("rm .deft-directive-disable");
    expect(DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE).toContain("NEW agent session");
    expect(DEFT_DIRECTIVE_DISABLE_ONE_LINE).toContain("test/local kill-switch");
    expect(DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING).toContain("gitignored");
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

describe("create/removeDeftDirectiveDisableFlag (#3039)", () => {
  it("creates an empty flag and removes it", () => {
    const root = tempRoot();
    const path = createDeftDirectiveDisableFlag(root);
    expect(path).toBe(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(removeDeftDirectiveDisableFlag(root)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(removeDeftDirectiveDisableFlag(root)).toBe(false);
  });

  it("writes an optional short rationale as a comment", () => {
    const root = tempRoot();
    const path = createDeftDirectiveDisableFlag(root, { rationale: "DevHammer A arm" });
    expect(readFileSync(path, "utf8")).toBe("# DevHammer A arm\n");
  });
});
