import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { routeArgv } from "./cli-router/index.js";
import { resolveCanonicalVerb } from "./dispatch.js";
import {
  parseSyncDefaultArgs,
  pullsFromRestJson,
  runSyncDefaultCli,
  USAGE,
} from "./scm-sync-default.js";

describe("scm-sync-default CLI (#3391)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("registers scm:sync-default as a CLI verb", () => {
    expect(resolveCanonicalVerb("scm:sync-default")).toBe("scm-sync-default");
    expect(routeArgv(["scm:sync-default", "--dry-run"]).argv[0]).toBe("scm:sync-default");
    expect(routeArgv(["scm", "sync-default"]).argv[0]).toBe("scm:sync-default");
  });

  it("parses --max-files, --dry-run, and --json", () => {
    const parsed = parseSyncDefaultArgs([
      "--dry-run",
      "--json",
      "--max-files",
      "100",
      "--repo",
      "o/r",
    ]);
    expect(parsed.error).toBeNull();
    expect(parsed.args.dryRun).toBe(true);
    expect(parsed.args.json).toBe(true);
    expect(parsed.args.maxFiles).toBe(100);
    expect(parsed.args.repo).toBe("o/r");
  });

  it("rejects a bad --max-files", () => {
    const parsed = parseSyncDefaultArgs(["--max-files", "nope"]);
    expect(parsed.error).toMatch(/non-negative integer/);
  });

  it("parses REST pull list rows for dest-base matching", () => {
    const pulls = pullsFromRestJson([
      {
        number: 3,
        html_url: "https://github.com/o/r/pull/3",
        head: { ref: "sync/master-from-develop/leg-1-bbbbbbb", sha: "b".repeat(40) },
        base: { ref: "master" },
      },
      { number: 4, html_url: "x", head: { ref: 1 }, base: { ref: "master" } },
    ]);
    expect(pulls).toEqual([
      {
        number: 3,
        htmlUrl: "https://github.com/o/r/pull/3",
        headRef: "sync/master-from-develop/leg-1-bbbbbbb",
        headSha: "b".repeat(40),
        baseRef: "master",
      },
    ]);
    expect(pullsFromRestJson({})).toEqual([]);
  });

  it("usage says each leg is a new PR when the reviewer first sees it", () => {
    expect(USAGE).toMatch(/new when the reviewer first sees it/i);
    expect(USAGE).toContain("Never retarget");
    expect(USAGE).toMatch(/core-guard/i);
  });

  it("prints help and no-op JSON through the CLI runner", () => {
    const out: string[] = [];
    expect(runSyncDefaultCli({ help: true }, { writeOut: (s) => out.push(s) })).toBe(0);
    expect(out.join("")).toContain("Never retarget");
    root = mkdtempSync(join(tmpdir(), "sync-default-cli-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { title: "P", status: "running", policy: { deliveryBranch: "master" } },
      }),
      "utf8",
    );
    const json: string[] = [];
    const code = runSyncDefaultCli(
      { projectRoot: root, json: true, dryRun: true },
      {
        writeOut: (s) => json.push(s),
        writeErr: () => {},
        runGit: () => ({ code: 1, stdout: "", stderr: "no git" }),
      },
    );
    expect(code).toBe(2);
    expect(json.join("")).toContain("noop");
  });

  it("writes a fixture project without throwing parse", () => {
    root = mkdtempSync(join(tmpdir(), "sync-default-cli-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { title: "P", status: "running", policy: {} } }),
      "utf8",
    );
    const parsed = parseSyncDefaultArgs(["--project-root", root, "--dry-run"]);
    expect(parsed.args.projectRoot).toBe(root);
  });
});
