import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTINUE_CHECKPOINT_REL_PATHS,
  continueCheckpointRefusalNote,
  isContinueCheckpointPath,
  isEligibleContinueCheckpointTarget,
} from "./continue-checkpoint-path.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "6914-checkpoint-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

/** Symlinks need privileges on some Windows hosts; skip the case there. */
function trySymlink(target: string, path: string, type?: "dir" | "file" | "junction"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

describe("isContinueCheckpointPath (#6914)", () => {
  it("is true for exactly the two checkpoint paths", () => {
    expect(CONTINUE_CHECKPOINT_REL_PATHS).toEqual([
      "xbrief/continue.xbrief.json",
      "vbrief/continue.vbrief.json",
    ]);
    expect(isContinueCheckpointPath("xbrief/continue.xbrief.json")).toBe(true);
    expect(isContinueCheckpointPath("vbrief/continue.vbrief.json")).toBe(true);
  });

  it("rejects case variants, other lifecycle files and near names", () => {
    for (const rel of [
      "XBRIEF/continue.xbrief.json",
      "xbrief/Continue.xbrief.json",
      "xbrief/continue.vbrief.json",
      "vbrief/continue.xbrief.json",
      "xbrief/plan.xbrief.json",
      "xbrief/active/continue.xbrief.json",
      "xbrief/continue-01H.json",
      "./xbrief/continue.xbrief.json",
      "a/xbrief/continue.xbrief.json",
      "",
    ]) {
      expect(isContinueCheckpointPath(rel), rel).toBe(false);
    }
  });
});

describe("isEligibleContinueCheckpointTarget (#6914)", () => {
  it("admits a new or existing single-link checkpoint, relative or absolute", () => {
    const root = tempRoot();
    expect(isEligibleContinueCheckpointTarget(root, "xbrief/continue.xbrief.json")).toBe(true);
    expect(isEligibleContinueCheckpointTarget(root, "vbrief/continue.vbrief.json")).toBe(true);
    writeFileSync(join(root, "xbrief", "continue.xbrief.json"), "{}", "utf8");
    expect(isEligibleContinueCheckpointTarget(root, "xbrief/continue.xbrief.json")).toBe(true);
    expect(
      isEligibleContinueCheckpointTarget(root, join(root, "xbrief", "continue.xbrief.json")),
    ).toBe(true);
  });

  it("declines a `..` component even when it collapses to the checkpoint", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "hop"), { recursive: true });
    expect(isEligibleContinueCheckpointTarget(root, "xbrief/hop/../continue.xbrief.json")).toBe(
      false,
    );
    expect(isEligibleContinueCheckpointTarget(root, "xbrief\\hop\\..\\continue.xbrief.json")).toBe(
      false,
    );
  });

  it("declines a case variant and any other file under xbrief/ or vbrief/", () => {
    const root = tempRoot();
    expect(isEligibleContinueCheckpointTarget(root, "xbrief/Continue.xbrief.json")).toBe(false);
    expect(isEligibleContinueCheckpointTarget(root, "xbrief/plan.xbrief.json")).toBe(false);
    expect(isEligibleContinueCheckpointTarget(root, "vbrief/active/x.vbrief.json")).toBe(false);
    expect(isEligibleContinueCheckpointTarget(root, "src/continue.xbrief.json")).toBe(false);
  });

  it("declines an existing checkpoint with more than one hard link", () => {
    const root = tempRoot();
    writeFileSync(join(root, "src", "product.ts"), "x", "utf8");
    linkSync(join(root, "src", "product.ts"), join(root, "xbrief", "continue.xbrief.json"));
    expect(isEligibleContinueCheckpointTarget(root, "xbrief/continue.xbrief.json")).toBe(false);
  });

  it("declines a checkpoint path that is a directory", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "continue.xbrief.json"));
    expect(isEligibleContinueCheckpointTarget(root, "xbrief/continue.xbrief.json")).toBe(false);
  });

  it("declines a leaf link and a dangling leaf link", (ctx) => {
    const root = tempRoot();
    writeFileSync(join(root, "src", "product.ts"), "x", "utf8");
    const leaf = trySymlink(
      join(root, "src", "product.ts"),
      join(root, "xbrief", "continue.xbrief.json"),
      "file",
    );
    if (!leaf) ctx.skip();
    expect(isEligibleContinueCheckpointTarget(root, "xbrief/continue.xbrief.json")).toBe(false);

    const dangling = tempRoot();
    trySymlink(
      join(dangling, "src", "missing.ts"),
      join(dangling, "xbrief", "continue.xbrief.json"),
      "file",
    );
    expect(isEligibleContinueCheckpointTarget(dangling, "xbrief/continue.xbrief.json")).toBe(false);
  });

  it("declines a link on a parent component", (ctx) => {
    const parent = tempRoot();
    rmSync(join(parent, "xbrief"), { recursive: true, force: true });
    if (!trySymlink(join(parent, "src"), join(parent, "xbrief"), "junction")) ctx.skip();
    expect(isEligibleContinueCheckpointTarget(parent, "xbrief/continue.xbrief.json")).toBe(false);
  });

  it("declines when the project root cannot be inspected", () => {
    const missing = join(tmpdir(), "6914-checkpoint-missing-root-does-not-exist");
    expect(isEligibleContinueCheckpointTarget(missing, "xbrief/continue.xbrief.json")).toBe(false);
  });
});

describe("continueCheckpointRefusalNote (#6914)", () => {
  it("names the checkpoint and gives no split or widen remedy", () => {
    const note = continueCheckpointRefusalNote(["xbrief/continue.xbrief.json"]);
    expect(note).toContain("`xbrief/continue.xbrief.json` is the continue checkpoint");
    expect(note).toContain("path safety");
    expect(note).toContain("project checks pass");
    expect(note).toContain("Write the checkpoint separately");
    expect(note).not.toMatch(/split|widen/i);
  });
});
