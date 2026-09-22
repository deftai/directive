/**
 * Check-walk D7 for completed names (#4844).
 * Landed unchanged names do not fail. Change-set adds and renames stay hard.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesFilenameConvention, validateFilename } from "./filename.js";
import { landedUnchangedCompletedPaths } from "./landed-filename.js";
import { runValidate } from "./main.js";
import { validateAll } from "./validate-all.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temps.push(root);
  return root;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  env.GIT_AUTHOR_NAME = "t";
  env.GIT_AUTHOR_EMAIL = "t@example.com";
  env.GIT_COMMITTER_NAME = "t";
  env.GIT_COMMITTER_EMAIL = "t@example.com";
  return env;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv(), stdio: "ignore" });
}

function gitText(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" }).trim();
}

function withDeftBaseRef(value: string, run: () => void): void {
  const prev = process.env.DEFT_BASE_REF;
  process.env.DEFT_BASE_REF = value;
  try {
    run();
  } finally {
    if (prev === undefined) delete process.env.DEFT_BASE_REF;
    else process.env.DEFT_BASE_REF = prev;
  }
}

function writeBrief(root: string, dir: string, folder: string, name: string, status: string): void {
  const path = join(root, dir, folder, name);
  mkdirSync(join(root, dir, folder), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "T", status, items: [] } })}\n`,
    "utf8",
  );
}

function commit(root: string, message: string): void {
  git(root, ["-c", "core.hooksPath=", "commit", "-m", message]);
}

function initMaster(root: string): void {
  git(root, ["init", "-b", "master"]);
}

function d7Names(errors: readonly string[]): string[] {
  const names: string[] = [];
  for (const error of errors) {
    if (!error.includes("(D7)")) continue;
    const match = /filename '([^']+)'/.exec(error);
    names.push(match?.[1] ?? error);
  }
  return names.sort();
}

const LANDED_BAD = [
  "2026-09-11-M0-01-monorepo-scaffold.xbrief.json",
  "2026-09-12-M0.5-01-discovery-blocking.xbrief.json",
  "directive-adoption.xbrief.json",
] as const;

describe("landed completed filenames (#4844)", () => {
  it("keeps validateFilename hard for dots, uppercase, and historical shapes", () => {
    for (const name of LANDED_BAD) {
      expect(matchesFilenameConvention(name)).toBe(false);
      expect(validateFilename(`xbrief/completed/${name}`)[0]).toContain("(D7)");
    }
    expect(validateFilename("xbrief/proposed/2026-09-13-UPPER.xbrief.json")[0]).toContain("(D7)");
    expect(validateFilename("xbrief/completed/2026-09-13-has.dot.xbrief.json")[0]).toContain(
      "(D7)",
    );
  });

  it("does not exempt a completed name when git cannot prove it landed", () => {
    const bare = tempRoot("vb-4844-bare-");
    writeBrief(bare, "xbrief", "completed", LANDED_BAD[0], "completed");
    expect(landedUnchangedCompletedPaths(bare)).toBeNull();
    expect(d7Names(validateAll(join(bare, "xbrief")).errors)).toEqual([LANDED_BAD[0]]);

    const unborn = tempRoot("vb-4844-unborn-");
    initMaster(unborn);
    writeBrief(unborn, "xbrief", "completed", LANDED_BAD[2], "completed");
    expect(d7Names(validateAll(join(unborn, "xbrief")).errors)).toEqual([LANDED_BAD[2]]);
  });

  it("does not fail the check walk on an unchanged landed completed name", () => {
    const root = tempRoot("vb-4844-pass-");
    initMaster(root);
    for (const name of LANDED_BAD) {
      writeBrief(root, "xbrief", "completed", name, "completed");
    }
    git(root, ["add", "xbrief/completed"]);
    commit(root, "base");
    git(root, ["checkout", "-b", "change"]);
    writeBrief(
      root,
      "xbrief",
      "completed",
      "2026-09-21-285-wikilink-resolve-existing.xbrief.json",
      "completed",
    );
    git(root, ["add", "xbrief/completed/2026-09-21-285-wikilink-resolve-existing.xbrief.json"]);
    commit(root, "add conforming");
    const edited = join(root, "xbrief", "completed", LANDED_BAD[2]);
    const raw = readFileSync(edited, "utf8").replace('"title":"T"', '"title":"Edited"');
    writeFileSync(edited, raw, "utf8");

    const { errors, warnings } = validateAll(join(root, "xbrief"));
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).not.toContain("(D7)");

    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      expect(runValidate(["--project-root", root])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join("");
    expect(out).not.toContain("FAIL:");
    expect(out).not.toContain("(D7)");
    expect(out).toContain("OK:");
  });

  it("keeps a hard filename error for a change-set add or rename, not a warning", () => {
    const root = tempRoot("vb-4844-hard-");
    initMaster(root);
    for (const name of LANDED_BAD) {
      writeBrief(root, "xbrief", "completed", name, "completed");
    }
    writeBrief(root, "xbrief", "active", "2026-09-11-M0-02-still-bad.xbrief.json", "running");
    writeBrief(root, "xbrief", "proposed", "2026-09-11-M0-03-still-bad.xbrief.json", "proposed");
    writeBrief(root, "xbrief", "active", "2026-09-21-ok-slug.xbrief.json", "running");
    git(root, ["add", "xbrief"]);
    commit(root, "base");
    git(root, ["checkout", "-b", "change"]);
    writeBrief(root, "xbrief", "completed", "2026-09-14-also.bad.xbrief.json", "completed");
    git(root, [
      "mv",
      "xbrief/active/2026-09-21-ok-slug.xbrief.json",
      "xbrief/completed/2026-09-21-Bad.Slug.xbrief.json",
    ]);
    git(root, ["add", "xbrief/completed/2026-09-14-also.bad.xbrief.json"]);
    commit(root, "change set");
    writeBrief(root, "xbrief", "completed", "2026-09-13-UPPER.xbrief.json", "completed");
    writeBrief(root, "xbrief", "completed", "2026-09-13-has.dot.xbrief.json", "completed");
    const edited = join(root, "xbrief", "completed", LANDED_BAD[0]);
    writeFileSync(
      edited,
      readFileSync(edited, "utf8").replace('"title":"T"', '"title":"Edited"'),
      "utf8",
    );

    const { errors, warnings } = validateAll(join(root, "xbrief"));
    expect(d7Names(errors)).toEqual(
      [
        "2026-09-11-M0-02-still-bad.xbrief.json",
        "2026-09-11-M0-03-still-bad.xbrief.json",
        "2026-09-13-UPPER.xbrief.json",
        "2026-09-13-has.dot.xbrief.json",
        "2026-09-14-also.bad.xbrief.json",
        "2026-09-21-Bad.Slug.xbrief.json",
      ].sort(),
    );
    for (const name of LANDED_BAD) {
      expect(d7Names(errors)).not.toContain(name);
    }
    expect(warnings.join("\n")).not.toContain("(D7)");
    expect(errors.some((error) => error.includes("(D7)"))).toBe(true);
  });

  it("does not treat the default-branch tip as an unchanged landed tree", () => {
    const root = tempRoot("vb-4844-head-");
    initMaster(root);
    for (const name of LANDED_BAD) {
      writeBrief(root, "xbrief", "completed", name, "completed");
    }
    writeBrief(root, "xbrief", "active", "2026-09-21-ok-slug.xbrief.json", "running");
    git(root, ["add", "xbrief"]);
    commit(root, "base");
    writeBrief(root, "xbrief", "completed", "2026-09-13-UPPER.xbrief.json", "completed");
    writeBrief(root, "xbrief", "completed", "2026-09-13-has.dot.xbrief.json", "completed");
    git(root, [
      "mv",
      "xbrief/active/2026-09-21-ok-slug.xbrief.json",
      "xbrief/completed/2026-09-21-Bad.Slug.xbrief.json",
    ]);
    const edited = join(root, "xbrief", "completed", LANDED_BAD[0]);
    writeFileSync(
      edited,
      readFileSync(edited, "utf8").replace('"title":"T"', '"title":"Edited"'),
      "utf8",
    );
    git(root, ["add", "xbrief"]);
    commit(root, "direct on master");
    git(root, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    const head = gitText(root, ["rev-parse", "HEAD"]);

    withDeftBaseRef(head, () => {
      const landed = landedUnchangedCompletedPaths(root);
      expect(landed).not.toBeNull();
      for (const name of LANDED_BAD) {
        expect(landed?.has(`xbrief/completed/${name}`)).toBe(true);
      }
      expect(landed?.has("xbrief/completed/2026-09-13-UPPER.xbrief.json")).toBe(false);
      expect(landed?.has("xbrief/completed/2026-09-13-has.dot.xbrief.json")).toBe(false);
      expect(landed?.has("xbrief/completed/2026-09-21-Bad.Slug.xbrief.json")).toBe(false);

      const { errors, warnings } = validateAll(join(root, "xbrief"));
      expect(d7Names(errors)).toEqual(
        [
          "2026-09-13-UPPER.xbrief.json",
          "2026-09-13-has.dot.xbrief.json",
          "2026-09-21-Bad.Slug.xbrief.json",
        ].sort(),
      );
      for (const name of LANDED_BAD) {
        expect(d7Names(errors)).not.toContain(name);
      }
      expect(warnings.join("\n")).not.toContain("(D7)");
    });
  });

  it("does not skip D7 when the introducing commit is HEAD and has no parent", () => {
    const root = tempRoot("vb-4844-root-");
    initMaster(root);
    writeBrief(root, "xbrief", "completed", "2026-09-13-UPPER.xbrief.json", "completed");
    writeBrief(root, "xbrief", "completed", "2026-09-13-has.dot.xbrief.json", "completed");
    git(root, ["add", "xbrief"]);
    commit(root, "root");
    git(root, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    const head = gitText(root, ["rev-parse", "HEAD"]);

    withDeftBaseRef(head, () => {
      expect(landedUnchangedCompletedPaths(root)).toBeNull();
      expect(d7Names(validateAll(join(root, "xbrief")).errors)).toEqual(
        ["2026-09-13-UPPER.xbrief.json", "2026-09-13-has.dot.xbrief.json"].sort(),
      );
    });
  });

  it("does not skip D7 when a root commit has unrelated uncommitted or untracked files", () => {
    const root = tempRoot("vb-4844-dirty-root-");
    initMaster(root);
    writeBrief(root, "xbrief", "completed", "2026-09-13-UPPER.xbrief.json", "completed");
    writeBrief(root, "xbrief", "completed", "2026-09-13-has.dot.xbrief.json", "completed");
    writeFileSync(join(root, "notes.txt"), "tracked\n", "utf8");
    git(root, ["add", "xbrief", "notes.txt"]);
    commit(root, "root");
    git(root, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    const head = gitText(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(root, "notes.txt"), "uncommitted\n", "utf8");
    writeFileSync(join(root, "untracked.txt"), "untracked\n", "utf8");

    withDeftBaseRef(head, () => {
      expect(landedUnchangedCompletedPaths(root)).toBeNull();
      const { errors, warnings } = validateAll(join(root, "xbrief"));
      expect(d7Names(errors)).toEqual(
        ["2026-09-13-UPPER.xbrief.json", "2026-09-13-has.dot.xbrief.json"].sort(),
      );
      expect(warnings.join("\n")).not.toContain("(D7)");
    });
  });

  it("applies the same landed split under vbrief/completed", () => {
    const root = tempRoot("vb-4844-legacy-");
    initMaster(root);
    writeBrief(root, "vbrief", "completed", "directive-adoption.vbrief.json", "completed");
    writeFileSync(join(root, "notes.txt"), "tracked\n", "utf8");
    git(root, ["add", "vbrief", "notes.txt"]);
    commit(root, "base");
    writeFileSync(join(root, "notes.txt"), "next\n", "utf8");
    git(root, ["add", "notes.txt"]);
    commit(root, "child");
    git(root, ["checkout", "-b", "change"]);
    writeBrief(root, "vbrief", "completed", "2026-09-13-UPPER.vbrief.json", "completed");
    const { errors, warnings } = validateAll(join(root, "vbrief"));
    expect(d7Names(errors)).toEqual(["2026-09-13-UPPER.vbrief.json"]);
    expect(warnings.join("\n")).not.toContain("(D7)");
  });
});
