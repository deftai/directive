/**
 * #6002 / AC10.6 (RC-03): the upgrade plan lists files Git reports as modified
 * or untracked under `.deft/core` before removing it. List only: no prompt,
 * no refusal.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listDeftCoreGitEdits, runUpgrade } from "./bookends.js";
import { LAUNCHER_PACKAGE_NAME } from "./constants.js";
import { readProjectInstallState } from "./pin.js";
import {
  DEFT_CORE_EDIT_LIST_LIMIT,
  type PresentIo,
  writeDeftCoreGitEdits,
} from "./plan-present.js";

const TEMPS: string[] = [];

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

function capture(): { io: PresentIo; out: () => string } {
  const buf: string[] = [];
  return {
    io: { writeOut: (t: string) => void buf.push(t), writeErr: (t: string) => void buf.push(t) },
    out: () => buf.join(""),
  };
}

function git(root: string, args: string[]): void {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** Old-layout project in a real Git repo: exact launcher pin + committed copied core. */
function legacyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-core-edits-"));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "legacy-t",
        version: "0.0.0",
        private: true,
        devDependencies: { [LAUNCHER_PACKAGE_NAME]: "0.119.2" },
      },
      null,
      2,
    )}\n`,
  );
  const core = join(root, ".deft", "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(
    join(core, "VERSION"),
    "ref: 'v0.119.2'\nsha: 'content-package'\ntag: 'v0.119.2'\ninstall_root: '.deft/core'\n" +
      "fetched_at: '2026-09-17T20:29:29Z'\nfetched_by: 'directive-update'\n",
  );
  writeFileSync(
    join(core, "package.json"),
    `${JSON.stringify({ name: "@deftai/directive-content", version: "0.119.2", deftConsumerDeposit: true })}\n`,
  );
  writeFileSync(join(core, "main.md"), "# deposited main\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    "init",
  ]);
  return root;
}

const upgradeDeps = {
  resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
  runPmAdd: () => ({ ok: true as const }),
  invokeSetup: () => ({ exitCode: 0, stdout: "{}", stderr: "", message: null }),
  invokeMigrate: () => ({ exitCode: 0, stdout: "{}", stderr: "", message: null }),
};

describe("listDeftCoreGitEdits (#6002)", () => {
  it("returns modified and untracked paths under .deft/core only", () => {
    const root = legacyRepo();
    writeFileSync(join(root, ".deft", "core", "main.md"), "# edited\n");
    writeFileSync(join(root, ".deft", "core", "mine.md"), "my notes\n");
    writeFileSync(join(root, "outside.md"), "not listed\n");
    expect(listDeftCoreGitEdits(root).sort()).toEqual([".deft/core/main.md", ".deft/core/mine.md"]);
  });

  it("returns nothing for a clean tree, an ignored .deft/core, or no Git repo", () => {
    const clean = legacyRepo();
    expect(listDeftCoreGitEdits(clean)).toEqual([]);

    const ignored = legacyRepo();
    git(ignored, ["rm", "-r", "-q", "--cached", ".deft/core"]);
    writeFileSync(join(ignored, ".gitignore"), ".deft/core/\n");
    git(ignored, ["add", ".gitignore"]);
    git(ignored, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--no-verify",
      "-m",
      "ignore",
    ]);
    writeFileSync(join(ignored, ".deft", "core", "main.md"), "# edited\n");
    expect(listDeftCoreGitEdits(ignored)).toEqual([]);

    const noGit = mkdtempSync(join(tmpdir(), "deft-core-nogit-"));
    TEMPS.push(noGit);
    mkdirSync(join(noGit, ".deft", "core"), { recursive: true });
    writeFileSync(join(noGit, ".deft", "core", "main.md"), "x\n");
    expect(listDeftCoreGitEdits(noGit)).toEqual([]);
  });
});

describe("writeDeftCoreGitEdits (#6002)", () => {
  it("prints nothing when there are no edits", () => {
    const c = capture();
    writeDeftCoreGitEdits(c.io, []);
    writeDeftCoreGitEdits(c.io, null);
    expect(c.out()).toBe("");
  });

  it("lists the first 20 paths, then a count", () => {
    const paths = Array.from(
      { length: DEFT_CORE_EDIT_LIST_LIMIT + 5 },
      (_, i) => `.deft/core/f${i}.md`,
    );
    const c = capture();
    writeDeftCoreGitEdits(c.io, paths);
    const text = c.out();
    expect(text).toContain("Git reports 25 modified or untracked files under .deft/core.");
    expect(text).toContain(".deft/core/f19.md");
    expect(text).not.toContain(".deft/core/f20.md");
    expect(text).toContain("...and 5 more");
  });
});

describe("upgrade plan lists .deft/core edits (#6002 / AC10.6)", () => {
  it("dry-run plan lists Git-reported edits and still exits 0 without a prompt", () => {
    const root = legacyRepo();
    writeFileSync(join(root, ".deft", "core", "main.md"), "# edited\n");
    writeFileSync(join(root, ".deft", "core", "mine.md"), "my notes\n");
    const state = readProjectInstallState(root);
    expect(state.oldStyle).toBe(true);
    const c = capture();
    let prompted = false;
    const code = runUpgrade(
      root,
      state,
      ["--dry-run", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      {
        ...upgradeDeps,
        confirm: () => {
          prompted = true;
          return true;
        },
      },
    );
    expect(code).toBe(0);
    expect(prompted).toBe(false);
    const text = c.out();
    expect(text).toContain("Git reports 2 modified or untracked files under .deft/core.");
    expect(text).toContain(".deft/core/main.md");
    expect(text).toContain(".deft/core/mine.md");
    expect(text.indexOf(".deft/core/mine.md")).toBeLessThan(text.indexOf("[dry-run]"));
  });

  it("verbose plan also gives the edit count in the keyed block", () => {
    const root = legacyRepo();
    writeFileSync(join(root, ".deft", "core", "main.md"), "# edited\n");
    const state = readProjectInstallState(root);
    const c = capture();
    const code = runUpgrade(
      root,
      state,
      ["--dry-run", "-v", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      upgradeDeps,
    );
    expect(code).toBe(0);
    const text = c.out();
    expect(text).toContain(".deft/core/main.md");
    expect(text).toContain(".deft/core Git edits: 1 (listed above; removed with it)");
  });

  it("prints no list when .deft/core is clean", () => {
    const root = legacyRepo();
    const state = readProjectInstallState(root);
    const c = capture();
    const code = runUpgrade(
      root,
      state,
      ["--dry-run", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      upgradeDeps,
    );
    expect(code).toBe(0);
    expect(c.out()).not.toContain("modified or untracked");
  });
});
