/**
 * Message-only pre-OVPR recogniser (#5960 / RC-01). Positive, negative and
 * walk-bound cases from unit spec P1-U2.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPin } from "../pin.js";
import { recognisePreOvprLayout } from "./index.js";

const roots: string[] = [];

function fixture(files: Record<string, string>, dirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "pre-ovpr-"));
  roots.push(root);
  for (const dir of dirs) mkdirSync(join(root, ...dir.split("/")), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

function pkg(deps: Record<string, string>): string {
  return JSON.stringify({ name: "app", dependencies: deps });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("recognisePreOvprLayout — positive", () => {
  it("exact pre-split pin + .deft/core/VERSION (AC10.1 shape)", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "0.126.2" }),
      ".deft/core/VERSION": "0.126.2\n",
    });
    expect(recognisePreOvprLayout(root)?.evidence).toContain(
      "install shape npm-hybrid-pin-copied-core",
    );
  });

  it("range ^0.126.2 + empty .deft/core/", () => {
    const root = fixture({ "package.json": pkg({ "@deftai/directive": "^0.126.2" }) }, [
      ".deft/core",
    ]);
    expect(recognisePreOvprLayout(root)?.evidence).toEqual([
      ".deft/core + package.json#@deftai/directive",
    ]);
  });

  it("nested tools/deft-cli/package.json ^0.126.1 + .deft/core deposit package.json", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "app" }),
      "tools/deft-cli/package.json": pkg({ "@deftai/directive": "^0.126.1" }),
      ".deft/core/package.json": JSON.stringify({ deftConsumerDeposit: true }),
    });
    const found = recognisePreOvprLayout(root);
    expect(found?.evidence).toContain(".deft/core + tools/deft-cli/package.json#@deftai/directive");
  });

  it("^0.126.2 + .githooks/_deft-run.sh only", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "^0.126.2" }),
      ".githooks/_deft-run.sh": "#!/bin/sh\n",
    });
    expect(recognisePreOvprLayout(root)?.evidence).toEqual([".githooks/_deft-run.sh"]);
  });

  it("^0.126.2 + .claude/settings.json with bare deft-hook only (fresh clone)", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "^0.126.2" }),
      ".claude/settings.json": JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [{ type: "command", command: "deft-hook --host claude --event tool.before" }],
            },
          ],
        },
      }),
    });
    expect(recognisePreOvprLayout(root)?.evidence).toEqual([
      ".claude/settings.json (bare deft-hook command)",
    ]);
  });

  it("older `deft hook:dispatch` registration in .cursor/hooks.json", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "0.120.0" }),
      ".cursor/hooks.json": JSON.stringify({
        hooks: {
          preToolUse: [{ command: "deft hook:dispatch --host cursor --event tool.before" }],
        },
      }),
    });
    expect(recognisePreOvprLayout(root)?.evidence).toEqual([
      ".cursor/hooks.json (bare deft-hook command)",
    ]);
  });

  it("old Grok wrapper script + root dependency", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "latest" }),
      ".grok/hooks/deft-pretooluse-wrapper.sh": "#!/usr/bin/env sh\n",
    });
    expect(recognisePreOvprLayout(root)?.evidence).toEqual([
      ".grok/hooks/deft-pretooluse-wrapper.sh",
    ]);
  });

  it("framework deft/ directory", () => {
    const root = fixture({ "deft/main.md": "# deft\n" });
    expect(recognisePreOvprLayout(root)?.evidence).toEqual(["install shape go-tarball-deft-root"]);
  });
});

describe("recognisePreOvprLayout — negative", () => {
  it("root lists @deftai/directive-runtime, even with leftover .deft/core and _deft-run.sh", () => {
    const root = fixture({
      "package.json": pkg({
        "@deftai/directive-runtime": "0.129.14",
        "@deftai/directive": "^0.126.2",
      }),
      ".deft/core/VERSION": "0.126.2\n",
      ".githooks/_deft-run.sh": "#!/bin/sh\n",
    });
    expect(recognisePreOvprLayout(root)).toBeNull();
  });

  it("runtime listed as a range still counts as OVPR", () => {
    const root = fixture({
      "package.json": JSON.stringify({
        devDependencies: { "@deftai/directive-runtime": "^0.129.0" },
      }),
      ".deft/core/VERSION": "0.126.2\n",
    });
    expect(recognisePreOvprLayout(root)).toBeNull();
  });

  it("greenfield empty repo", () => {
    expect(recognisePreOvprLayout(fixture({}))).toBeNull();
  });

  it("launcher-only @deftai/directive dependency with no other evidence", () => {
    const root = fixture({ "package.json": pkg({ "@deftai/directive": "^0.129.0" }) });
    expect(recognisePreOvprLayout(root)).toBeNull();
  });

  it(".deft/ with only xbrief-style data", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "^0.129.0" }),
      ".deft/xbrief/state.json": "{}",
      "xbrief/plan.xbrief.json": "{}",
    });
    expect(recognisePreOvprLayout(root)).toBeNull();
  });

  it("new .mjs outer registration is not a bare deft-hook", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "^0.129.0" }),
      ".claude/settings.json": JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  command:
                    "node .claude/hooks/deft-hook-1a2b3c4d.mjs --host claude --event tool.before",
                },
              ],
            },
          ],
        },
      }),
    });
    expect(recognisePreOvprLayout(root)).toBeNull();
  });

  it("bare deft-hook in a host config without a root @deftai/directive dependency", () => {
    const root = fixture({
      ".claude/settings.json": JSON.stringify({ command: "deft-hook --host claude" }),
    });
    expect(recognisePreOvprLayout(root)).toBeNull();
  });
});

describe("recognisePreOvprLayout — nested walk bounds", () => {
  it("reads a package.json 3 folders deep", () => {
    const root = fixture({ "a/b/c/package.json": pkg({ "@deftai/directive": "^0.126.2" }) }, [
      ".deft/core",
    ]);
    expect(recognisePreOvprLayout(root)?.evidence).toEqual([
      ".deft/core + a/b/c/package.json#@deftai/directive",
    ]);
  });

  it("does not read a package.json 5 folders deep", () => {
    const root = fixture({ "a/b/c/d/e/package.json": pkg({ "@deftai/directive": "^0.126.2" }) }, [
      ".deft/core",
    ]);
    expect(recognisePreOvprLayout(root)).toBeNull();
  });

  it("skips node_modules and dot-dirs", () => {
    const root = fixture(
      {
        "node_modules/x/package.json": pkg({ "@deftai/directive": "^0.126.2" }),
        ".tools/package.json": pkg({ "@deftai/directive": "^0.126.2" }),
      },
      [".deft/core"],
    );
    expect(recognisePreOvprLayout(root)).toBeNull();
  });

  it("stops after 200 files", () => {
    const files: Record<string, string> = {};
    // Root files are counted before any subfolder is opened.
    for (let i = 0; i < 210; i++) files[`f${i}.txt`] = "";
    files["zzz/package.json"] = pkg({ "@deftai/directive": "^0.126.2" });
    const root = fixture(files, [".deft/core"]);
    expect(recognisePreOvprLayout(root)).toBeNull();
  });
});

describe("recognisePreOvprLayout — message only (AC10.1 unchanged)", () => {
  it("a range pin recognised for the message is still not readPin().oldStyle", () => {
    const root = fixture({ "package.json": pkg({ "@deftai/directive": "^0.126.2" }) }, [
      ".deft/core",
    ]);
    expect(recognisePreOvprLayout(root)).not.toBeNull();
    expect(readPin(root).oldStyle).toBe(false);
  });
});
