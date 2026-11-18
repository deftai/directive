/**
 * Old-style project recognition and the project-local pre-split copy
 * (#5960 / RC-12). Fixed top-level evidence only; no sub-folder search.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPin } from "../pin.js";
import { findProjectLocalCopy, recognisePreOvprLayout } from "./index.js";

const roots: string[] = [];

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

function fixture(files: Record<string, string>, dirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "pre-ovpr-"));
  roots.push(root);
  for (const dir of dirs) mkdirSync(join(root, ...dir.split("/")), { recursive: true });
  writeFiles(root, files);
  return root;
}

function pkg(deps: Record<string, string>): string {
  return JSON.stringify({ name: "app", dependencies: deps });
}

/** An installed `@deftai/directive` package as files under `prefix`. */
function directiveCopy(
  prefix: string,
  version: string,
  options: { preSplit?: boolean; bin?: Record<string, string> } = {},
): Record<string, string> {
  const preSplit = options.preSplit ?? true;
  const bin = options.bin ?? {
    deft: "dist/bin.js",
    directive: "dist/bin.js",
    "deft-hook": "dist/hook-bin.js",
  };
  return {
    [`${prefix}/package.json`]: JSON.stringify({
      name: "@deftai/directive",
      version,
      bin,
      dependencies: preSplit ? { "@deftai/directive-core": `^${version}` } : {},
    }),
    [`${prefix}/dist/bin.js`]: "",
    [`${prefix}/dist/hook-bin.js`]: "",
  };
}

const COPY = "node_modules/@deftai/directive";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("recognisePreOvprLayout — old-style project", () => {
  it("exact pre-split pin + .deft/core/VERSION, copy not installed", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "0.126.2" }),
      ".deft/core/VERSION": "0.126.2\n",
    });
    const found = recognisePreOvprLayout(root);
    expect(found?.evidence.slice(1)).toEqual([".deft/core"]);
    expect(found?.localCopy).toBeNull();
  });

  it("range ^0.126.2 with the project's own pre-split copy installed", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "^0.126.2" }),
      ...directiveCopy(COPY, "0.126.2"),
    });
    const found = recognisePreOvprLayout(root);
    expect(found?.evidence.slice(1)).toEqual(["node_modules/@deftai/directive 0.126.2"]);
    expect(found?.localCopy?.version).toBe("0.126.2");
    expect(Object.keys(found?.localCopy?.bins ?? {}).sort()).toEqual([
      "deft",
      "deft-hook",
      "directive",
    ]);
  });

  it("^0.126.2 + .githooks/_deft-run.sh only", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "^0.126.2" }),
      ".githooks/_deft-run.sh": "#!/bin/sh\n",
    });
    expect(recognisePreOvprLayout(root)?.evidence.slice(1)).toEqual([".githooks/_deft-run.sh"]);
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
    expect(recognisePreOvprLayout(root)?.evidence.slice(1)).toEqual([
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
    expect(recognisePreOvprLayout(root)?.evidence.slice(1)).toEqual([
      ".cursor/hooks.json (bare deft-hook command)",
    ]);
  });

  it("old Grok wrapper script + root dependency", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "latest" }),
      ".grok/hooks/deft-pretooluse-wrapper.sh": "#!/usr/bin/env sh\n",
    });
    expect(recognisePreOvprLayout(root)?.evidence.slice(1)).toEqual([
      ".grok/hooks/deft-pretooluse-wrapper.sh",
    ]);
  });

  it("fresh clone, nothing installed: the root dependency alone makes it old-style", () => {
    const root = fixture({ "package.json": pkg({ "@deftai/directive": "^0.126.2" }) });
    const found = recognisePreOvprLayout(root);
    expect(found?.evidence).toEqual(["package.json#@deftai/directive ^0.126.2"]);
    expect(found?.localCopy).toBeNull();
    expect(recognisePreOvprLayout(root, { hookCall: true })?.evidence.slice(1)).toEqual([
      "bare deft-hook call",
    ]);
  });
});

describe("recognisePreOvprLayout — not old-style", () => {
  it("root lists @deftai/directive-runtime, even with leftovers and an old copy (AC10.11)", () => {
    const root = fixture({
      "package.json": pkg({
        "@deftai/directive-runtime": "0.129.14",
        "@deftai/directive": "^0.126.2",
      }),
      ".deft/core/VERSION": "0.126.2\n",
      ".githooks/_deft-run.sh": "#!/bin/sh\n",
      ...directiveCopy(COPY, "0.126.2"),
    });
    expect(recognisePreOvprLayout(root, { hookCall: true })).toBeNull();
  });

  it("greenfield empty repo", () => {
    expect(recognisePreOvprLayout(fixture({}), { hookCall: true })).toBeNull();
  });

  it("launcher-only dependency with the new (post-split) launcher installed", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "^0.129.0" }),
      ...directiveCopy(COPY, "0.129.14", { preSplit: false }),
    });
    expect(recognisePreOvprLayout(root)).toBeNull();
  });

  it(".deft/ with only xbrief-style data, new launcher installed", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "^0.129.0" }),
      ...directiveCopy(COPY, "0.129.14", { preSplit: false }),
      ".deft/xbrief/state.json": "{}",
      "xbrief/plan.xbrief.json": "{}",
    });
    expect(recognisePreOvprLayout(root)).toBeNull();
  });

  it("new .mjs outer registration is not a bare deft-hook", () => {
    const root = fixture({
      "package.json": pkg({ "@deftai/directive": "^0.126.2" }),
      ".claude/settings.json": JSON.stringify({
        command: "node .claude/hooks/deft-hook-1a2b3c4d.mjs --host claude --event tool.before",
      }),
    });
    expect(recognisePreOvprLayout(root)?.evidence.slice(1)).toEqual([]);
  });

  it("no root @deftai/directive dependency: old leftovers alone are not old-style", () => {
    const root = fixture({
      ".claude/settings.json": JSON.stringify({ command: "deft-hook --host claude" }),
      ".deft/core/VERSION": "0.126.2\n",
      "deft/main.md": "# deft\n",
    });
    expect(recognisePreOvprLayout(root, { hookCall: true })).toBeNull();
  });

  it("does not search sub-folders: a nested package.json is never read", () => {
    const root = fixture(
      { "tools/deft-cli/package.json": pkg({ "@deftai/directive": "^0.126.1" }) },
      [".deft/core"],
    );
    expect(recognisePreOvprLayout(root, { hookCall: true })).toBeNull();
  });
});

describe("findProjectLocalCopy — only the project's own installed copy", () => {
  it("a post-split (new launcher) copy is not a pre-split copy", () => {
    const root = fixture(directiveCopy(COPY, "0.129.14", { preSplit: false }));
    expect(findProjectLocalCopy(root, "^0.129.0")).toBeNull();
  });

  it("an exact pin with a different installed version is refused", () => {
    const root = fixture(directiveCopy(COPY, "0.125.0"));
    expect(findProjectLocalCopy(root, "0.126.2")).toBeNull();
    expect(findProjectLocalCopy(root, "0.125.0")?.version).toBe("0.125.0");
  });

  it("a copy in a parent folder's node_modules is never used", () => {
    const outer = fixture(directiveCopy(COPY, "0.126.2"));
    const root = join(outer, "project");
    writeFiles(root, { "package.json": pkg({ "@deftai/directive": "^0.126.2" }) });
    expect(findProjectLocalCopy(root, "^0.126.2")).toBeNull();
    expect(recognisePreOvprLayout(root)?.localCopy).toBeNull();
  });

  it("a link that leaves the project is never used", () => {
    const outside = fixture(directiveCopy("pkg", "0.126.2"));
    const root = fixture({ "package.json": pkg({ "@deftai/directive": "^0.126.2" }) });
    mkdirSync(join(root, "node_modules", "@deftai"), { recursive: true });
    symlinkSync(join(outside, "pkg"), join(root, ...COPY.split("/")), "junction");
    expect(findProjectLocalCopy(root, "^0.126.2")).toBeNull();
  });

  it("bins come from the copy's own bin map; a bin outside the package is dropped", () => {
    const root = fixture(
      directiveCopy(COPY, "0.126.2", {
        bin: { deft: "dist/bin.js", "deft-hook": "../../../evil.js", ghost: "dist/none.js" },
      }),
    );
    writeFiles(root, { "evil.js": "" });
    const copy = findProjectLocalCopy(root, "^0.126.2");
    expect(Object.keys(copy?.bins ?? {})).toEqual(["deft"]);
  });
});

describe("recognisePreOvprLayout — AC10.1 unchanged", () => {
  it("a range pin recognised as old-style is still not readPin().oldStyle", () => {
    const root = fixture({ "package.json": pkg({ "@deftai/directive": "^0.126.2" }) }, [
      ".deft/core",
    ]);
    expect(recognisePreOvprLayout(root)).not.toBeNull();
    expect(readPin(root).oldStyle).toBe(false);
  });
});
