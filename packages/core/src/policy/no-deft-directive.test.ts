import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import {
  createNoDeftDirectiveFlag,
  detectNoDeftDirective,
  isNoDeftDirectivePresent,
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_FLAG_NAME,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
  NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY,
  noDeftDirectiveFlagPath,
  removeNoDeftDirectiveFlag,
} from "./no-deft-directive.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "no-deft-directive-"));
  temps.push(root);
  return root;
}

describe("detectNoDeftDirective (#2926)", () => {
  it("reports absent when the flag file is missing", () => {
    const root = tempRoot();
    const state = detectNoDeftDirective(root);
    expect(state.present).toBe(false);
    expect(state.depositPresent).toBe(false);
    expect(state.inconsistent).toBe(false);
    expect(state.flagPath).toBe(noDeftDirectiveFlagPath(root));
    expect(isNoDeftDirectivePresent(root)).toBe(false);
  });

  it("detects an empty root flag file as present", () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
    const state = detectNoDeftDirective(root);
    expect(state.present).toBe(true);
    expect(state.depositPresent).toBe(false);
    expect(state.inconsistent).toBe(false);
    expect(isNoDeftDirectivePresent(root)).toBe(true);
  });

  it("detects a short-comment flag file as present", () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "# not a DD project\n", "utf8");
    expect(detectNoDeftDirective(root).present).toBe(true);
  });

  it("does not treat a same-named directory as the flag", () => {
    const root = tempRoot();
    mkdirSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME));
    expect(detectNoDeftDirective(root).present).toBe(false);
  });

  it("marks inconsistent when flag and deposit both exist", () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const state = detectNoDeftDirective(root);
    expect(state.present).toBe(true);
    expect(state.depositPresent).toBe(true);
    expect(state.inconsistent).toBe(true);
  });

  it("honors injectable seams without touching the filesystem", () => {
    // Flag path uses resolve() (absolute); deposit probe uses join() — match both
    // so the seam sets hit on win32 where join("/virtual/...") !== resolve(...).
    const root = "/virtual/project";
<<<<<<< HEAD
    // Flag path uses path.resolve (absolute); deposit probe uses path.join — match both (#2926 / win32).
=======
>>>>>>> e8dffc22 (docs(strategies): Graduation Now+Later dual-path locks Wave A (#2899))
    const files = new Set([resolve(root, NO_DEFT_DIRECTIVE_FLAG_NAME)]);
    const dirs = new Set([join(root, CANONICAL_INSTALL_ROOT)]);
    const state = detectNoDeftDirective(root, {
      isFile: (p) => files.has(p),
      isDir: (p) => dirs.has(p),
    });
    expect(state.present).toBe(true);
    expect(state.depositPresent).toBe(true);
    expect(state.inconsistent).toBe(true);
  });

  it("documents the inconsistent-state product choice", () => {
    expect(NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY).toBe("warn-and-fail-closed");
    expect(NO_DEFT_DIRECTIVE_DISABLED_MESSAGE).toContain(".no-deft-directive");
    expect(NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE).toContain(".deft/core");
  });
});

describe("create/removeNoDeftDirectiveFlag (#2926)", () => {
  it("creates an empty flag and removes it", () => {
    const root = tempRoot();
    const path = createNoDeftDirectiveFlag(root);
    expect(path).toBe(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(removeNoDeftDirectiveFlag(root)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(removeNoDeftDirectiveFlag(root)).toBe(false);
  });

  it("writes an optional short rationale as a comment", () => {
    const root = tempRoot();
    const path = createNoDeftDirectiveFlag(root, { rationale: "library-only tree" });
    expect(readFileSync(path, "utf8")).toBe("# library-only tree\n");
  });
});
