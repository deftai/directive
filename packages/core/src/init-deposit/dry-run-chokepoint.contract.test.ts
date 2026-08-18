/**
 * Dest-mutation ban on the update path (#3437 / #3392 / #3458 / #3462 / ADR-004).
 *
 * Condition 1a: dest-mutating node:fs and dest-mutating child_process/git
 * must go through the port module. Allowlist = contained-write.ts only.
 * Instance 5: an fs-only ban staying green while git config mutates is
 * the failure this forbids.
 *
 * Condition 3: printed exclusions label + content-contract; shrink as
 * sites fold; never silently disappear.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPDATE_DRY_RUN_EXCLUSIONS, UPDATE_DRY_RUN_EXCLUSIONS_LABEL } from "./refresh.js";

const CORE_SRC = join(import.meta.dirname, "..");
const PORT_REL = "fs/contained-write.ts";
const MIGRATE_PROJECT = join(CORE_SRC, "xbrief-migrate", "migrate-project.ts");
const REFRESH_TS = join(CORE_SRC, "init-deposit", "refresh.ts");

/** Dest-mutating node:fs APIs. Reads (readFileSync, existsSync, …) stay allowed. */
const DEST_MUTATION_CALL =
  /\b(rmSync|unlinkSync|unlink|rmdirSync|rmdir|writeFileSync|appendFileSync|renameSync|copyFileSync|cpSync|chmodSync)\s*\(/g;

const UPDATE_PATH_RELS = [
  "init-deposit/refresh.ts",
  "init-deposit/scaffold.ts",
  "init-deposit/agent-hooks.ts",
  "init-deposit/hygiene.ts",
  "init-deposit/gitignore.ts",
  "init-deposit/prettierignore.ts",
  "init-deposit/slash-deposit.ts",
  "init-deposit/skill-discovery-deposit.ts",
  "init-deposit/xbrief-projections.ts",
  "deposit/copy-tree.ts",
  "policy/org-force-on-migration.ts",
  "xbrief-migrate/migrate-project.ts",
] as const;

const DEST_MUTATING_GIT_SUB = new Set([
  "add",
  "rm",
  "commit",
  "mv",
  "clean",
  "update-index",
  "apply",
]);

function extractFunctionBody(source: string, name: string): string | null {
  const header = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{`,
    "m",
  );
  const match = header.exec(source);
  if (match === null || match.index === undefined) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function destMutationHits(source: string, rel: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(DEST_MUTATION_CALL)) {
    const idx = match.index ?? 0;
    const line = source.slice(0, idx).split("\n").length;
    hits.push(`${rel}:${line} ${match[1]}`);
  }
  return hits;
}

function gitWindowIsReadOnly(window: string): boolean {
  if (
    /config[\s\S]{0,120}--get|--get[\s\S]{0,120}config|--list|--get-regexp|--get-all/.test(window)
  ) {
    return true;
  }
  if (/"diff"|'diff'/.test(window)) return true;
  if (/"ls-files"|'ls-files'/.test(window)) return true;
  if (/"status"|'status'/.test(window)) return true;
  if (/"rev-parse"|'rev-parse'/.test(window)) return true;
  if (/"symbolic-ref"|'symbolic-ref'/.test(window)) return true;
  return false;
}

function gitWindowIsDestMutating(window: string): boolean {
  if (gitWindowIsReadOnly(window)) return false;
  if (/"config"|'config'/.test(window)) return true;
  for (const sub of DEST_MUTATING_GIT_SUB) {
    if (new RegExp(`["']${sub}["']`).test(window)) return true;
  }
  return false;
}

export function destMutatingGitHits(source: string, rel: string): string[] {
  const hits: string[] = [];
  const re = /execFileSync\(\s*["']git["']/g;
  for (const match of source.matchAll(re)) {
    const idx = match.index ?? 0;
    const start = Math.max(0, idx - 280);
    const window = source.slice(start, idx + 420);
    if (!gitWindowIsDestMutating(window)) continue;
    const line = source.slice(0, idx).split("\n").length;
    hits.push(`${rel}:${line} execFileSync(git)`);
  }
  return hits;
}

function walkTsFiles(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = prefix.length > 0 ? `${prefix}/${entry}` : entry;
    const info = statSync(abs);
    if (info.isDirectory()) {
      walkTsFiles(abs, rel, out);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(rel.replace(/\\/g, "/"));
    }
  }
}

describe("removeStaleMigratedFrameworkNarrative dest-mutation ban (#3437 / #3392 / #3458 / #3462)", () => {
  it("bans raw dest-mutating node:fs on removeStaleMigratedFrameworkNarrative", () => {
    const source = readFileSync(MIGRATE_PROJECT, "utf8");
    const rel = "xbrief-migrate/migrate-project.ts#removeStaleMigratedFrameworkNarrative";
    const body = extractFunctionBody(source, "removeStaleMigratedFrameworkNarrative");
    expect(
      body,
      "migrate-project.ts must export removeStaleMigratedFrameworkNarrative",
    ).not.toBeNull();
    const violations = destMutationHits(body ?? "", rel);
    expect(violations, `dest-mutation bypasses:\n${violations.join("\n")}`).toEqual([]);
  });
});

describe("update-path dest-mutating git/exec ban (ADR-004 condition 1a)", () => {
  it("flags dest-mutating git config SET and allows --get / diff reads", () => {
    expect(
      destMutatingGitHits(
        `execFileSync("git", ["-C", dir, "config", "core.hooksPath", value])`,
        "sample.ts",
      ),
    ).toHaveLength(1);
    expect(
      destMutatingGitHits(
        `execFileSync("git", ["-C", dir, "config", "--get", "core.hooksPath"])`,
        "sample.ts",
      ),
    ).toEqual([]);
    expect(
      destMutatingGitHits(
        `const args = ["diff", "--name-only"];\nexecFileSync("git", args)`,
        "sample.ts",
      ),
    ).toEqual([]);
    expect(
      destMutatingGitHits(`execFileSync("git", ["add", "--", ...stagePaths])`, "sample.ts"),
    ).toHaveLength(1);
  });

  it("bans dest-mutating execFileSync(git) on the update path outside the port", () => {
    const violations: string[] = [];
    for (const rel of UPDATE_PATH_RELS) {
      if (rel === PORT_REL) continue;
      const source = readFileSync(join(CORE_SRC, rel), "utf8");
      violations.push(...destMutatingGitHits(source, rel));
    }
    expect(violations, `dest-mutating git bypasses:\n${violations.join("\n")}`).toEqual([]);
  });

  it("allowlists only the contained-write port for dest-mutating git", () => {
    const files: string[] = [];
    walkTsFiles(join(CORE_SRC, "fs"), "fs", files);
    expect(files).toContain(PORT_REL);
    const portHits = destMutatingGitHits(readFileSync(join(CORE_SRC, PORT_REL), "utf8"), PORT_REL);
    expect(portHits).toEqual([]);
  });
});

describe("dry-run exclusions content-contract (ADR-004 condition 3)", () => {
  it("prints a non-empty exclusions label and keeps OpenClaw $HOME while deposits remain", () => {
    expect(UPDATE_DRY_RUN_EXCLUSIONS_LABEL.length).toBeGreaterThan(0);
    expect(UPDATE_DRY_RUN_EXCLUSIONS.length).toBeGreaterThan(0);
    const refresh = readFileSync(REFRESH_TS, "utf8");
    expect(refresh).toContain("UPDATE_DRY_RUN_EXCLUSIONS_LABEL");
    if (/depositOpenClaw/.test(refresh)) {
      expect(UPDATE_DRY_RUN_EXCLUSIONS).toContain("openclaw-home-skills");
    }
  });
});
