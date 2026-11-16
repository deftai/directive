import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultRunGh } from "../pr-protected-issues/gh.js";
import type { RunGhApiFn } from "../scm/gh-rest.js";
import { EXIT_GATE_FAILED, EXIT_INCOMPLETE, EXIT_OK } from "./constants.js";
import {
  bindUnmarkedFinalizePair,
  CLAIM_PROBE_UNKNOWN_DETAIL,
  createOriginIssueStateLookup,
  discoverFinalizeOwed,
  fetchDeliveryTipPrivate,
  finalizeOwed,
  formatFinalizeOwedInventoryLines,
  inventoryHasBlockingOwed,
  loadTipPlanBodies,
  parseFinalizeClaimBatchStdout,
  runGhApiFromRunGh,
  UNMARKED_STAMP_REMEDIATION,
} from "./finalize-owed.js";
import { parseFinalizeOwedArgv } from "./finalize-owed-cli.js";

function writeTipBrief(
  root: string,
  rel: string,
  issue: number,
  opts: { productPullRequest?: number; title?: string } = {},
): void {
  const full = join(root, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(
    full,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: opts.title ?? `story-${String(issue)}`,
        status: "running",
        references: [
          {
            uri: `https://github.com/deftai/directive/issues/${String(issue)}`,
            type: "x-xbrief/github-issue",
          },
        ],
        ...(opts.productPullRequest !== undefined
          ? { metadata: { productPullRequest: opts.productPullRequest } }
          : {}),
      },
    }),
    "utf8",
  );
}

/** The one paged open-issue list discover reads (#5927). */
function isOpenIssueList(joined: string): boolean {
  return joined.includes("/issues?state=open");
}

/** `gh api --paginate --slurp` output: one page with these open issues (#5927). */
function openIssueList(open: readonly (number | { number: number; labels: unknown[] })[]): {
  returncode: number;
  stdout: string;
  stderr: string;
} {
  const rows = open.map((o) =>
    typeof o === "number"
      ? { number: o, state: "open", labels: [] }
      : { number: o.number, state: "open", labels: o.labels },
  );
  return { returncode: 0, stdout: JSON.stringify([rows]), stderr: "" };
}

describe("finalize-owed parseArgs", () => {
  it("parses inventory and wait flags", () => {
    const parsed = parseFinalizeOwedArgv([
      "--inventory-only",
      "--wait-through-land",
      "--repo=deftai/directive",
      "--dry-run",
      "--json",
    ]);
    expect(parsed.error).toBeNull();
    expect(parsed.inventoryOnly).toBe(true);
    expect(parsed.waitThroughLand).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.emitJson).toBe(true);
    expect(parsed.repo).toBe("deftai/directive");
  });
});

describe("discoverFinalizeOwed twin identity (#4919)", () => {
  it("does not treat a sibling completed brief as twin for a second story on same issue N", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-twin-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
      title: "story-a",
    });
    writeTipBrief(root, "xbrief/completed/story-b.xbrief.json", 4919, {
      productPullRequest: 5101,
      title: "story-b",
    });
    const tipBlobs = new Map<string, string>();
    for (const rel of [
      "xbrief/active/story-a.xbrief.json",
      "xbrief/completed/story-b.xbrief.json",
    ]) {
      tipBlobs.set(rel, readFileSync(join(root, rel), "utf8"));
    }
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const runGh = (cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("/pulls?")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (joined.includes("/pulls/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            merged_at: "2026-09-27T00:00:00Z",
            merge_commit_sha: "abc",
            base: { ref: "master" },
          }),
          stderr: "",
        };
      }
      if (isOpenIssueList(joined)) {
        return openIssueList([4919]);
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit,
      runGh,
    });
    const owed = inventory.stories.filter((s) => s.state === "owed");
    expect(owed.some((s) => s.relPath.includes("story-a"))).toBe(true);
    expect(inventoryHasBlockingOwed(inventory)).toBe(true);
    const lines = formatFinalizeOwedInventoryLines(inventory);
    expect(lines.some((l) => l.includes("owed"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("discoverFinalizeOwed tip batch inventory (#5171)", () => {
  it("reads tip plans via chunked showBlobsBatch without per-path git show", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-batch-"));
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root, stdio: "ignore" });
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 5171, {
      productPullRequest: 5200,
      title: "story-a",
    });
    writeTipBrief(root, "xbrief/completed/story-b.xbrief.json", 5171, {
      productPullRequest: 5201,
      title: "story-b",
    });
    execFileSync("git", ["add", "xbrief"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "tip"], { cwd: root, stdio: "ignore" });
    const tip = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    const showCalls: string[][] = [];
    const runGit = (cwd: string, args: readonly string[]) => {
      if (args[0] === "show") {
        showCalls.push([...args]);
      }
      if (args[0] === "ls-tree") {
        const result = execFileSync("git", [...args], { cwd, encoding: "utf8" });
        return { code: 0, stdout: result, stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const runGh = (cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("/pulls?")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (joined.includes("/pulls/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            merged_at: "2026-09-27T00:00:00Z",
            merge_commit_sha: tip,
            base: { ref: "master" },
          }),
          stderr: "",
        };
      }
      if (isOpenIssueList(joined)) {
        return openIssueList([5171]);
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };

    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip,
      runGit,
      runGh,
    });
    expect(showCalls).toEqual([]);
    expect(inventory.stories.some((s) => s.relPath.includes("story-a"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("loadTipPlanBodies uses chunk-retry and never whole-N show on batch miss", () => {
    const showCalls: string[][] = [];
    const paths = ["a.json", "b.json", "c.json", "d.json"];
    const bodies = loadTipPlanBodies(
      "/definitely-not-a-git-repo-5171",
      "HEAD",
      paths,
      (_cwd, args) => {
        if (args[0] === "show") {
          showCalls.push([...args]);
        }
        return { code: 1, stdout: "", stderr: "fail" };
      },
    );
    // Chunk-retry may show size-1 paths only; never one silent whole-N fan-out wave.
    expect(showCalls.length).toBe(paths.length);
    expect(showCalls.every((args) => args[0] === "show")).toBe(true);
    expect(bodies.size).toBe(paths.length);
    for (const path of paths) {
      expect(bodies.get(path)).toBeNull();
    }
  });
});

describe("finalizeOwed inventory-only", () => {
  it("returns CLEAN with empty inventory when tip has no marks", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-empty-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { title: "p", status: "running", policy: { deliveryBranch: "master" } },
      }),
      "utf8",
    );
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: "TIPSHA\n", stderr: "" };
      }
      if (args[0] === "ls-tree") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = finalizeOwed({
      projectRoot: root,
      repo: "deftai/directive",
      deliveryBranch: "master",
      inventoryOnly: true,
      runGit,
      runGh: () => ({ returncode: 0, stdout: "[]", stderr: "" }),
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.result.stories).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("finalize-owed claim/snapshot residuals (#4919)", () => {
  it("checks merge ancestry against the privately fetched tip SHA", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-tip-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
    });
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/active/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    const mergeBaseArgs: string[][] = [];
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base") {
        mergeBaseArgs.push([...args]);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "PRIVATETIP",
      runGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-09-27T00:00:00Z",
              merge_commit_sha: "abc",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([4919]);
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(mergeBaseArgs.some((a) => a.includes("PRIVATETIP"))).toBe(true);
    expect(mergeBaseArgs.every((a) => !a.includes("origin/master"))).toBe(true);
    expect(inventory.stories.some((s) => s.state === "owed")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("treats unreachable remote claims as stale/reclaimable", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-stale-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
    });
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/active/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "deadbeef refs/heads/swarm/finalize/pr-5100\n", stderr: "" };
      }
      if (args[0] === "fetch" && args.some((a) => String(a).includes("finalize-owed-claim"))) {
        return { code: 1, stdout: "", stderr: "missing objects" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-09-27T00:00:00Z",
              merge_commit_sha: "abc",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([4919]);
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(inventory.stories.some((s) => s.state === "stale")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("uses claim committer age rather than delivery-tip age for staleness", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-age-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
    });
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/active/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    const nowMs = Date.parse("2026-09-27T12:00:00Z");
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/pr-5100\n", stderr: "" };
      }
      if (args[0] === "fetch" && args.some((a) => String(a).includes("finalize-owed-claim"))) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "log" && args.some((a) => String(a).includes("%ct"))) {
        // Fresh claim marker (5 minutes old), even if delivery tip is ancient.
        return { code: 0, stdout: String(Math.floor((nowMs - 5 * 60 * 1000) / 1000)), stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      now: () => nowMs,
      runGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-09-20T00:00:00Z",
              merge_commit_sha: "abc",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([4919]);
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(inventory.stories.some((s) => s.state === "in-flight")).toBe(true);
    expect(inventory.stories.some((s) => s.state === "stale")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("close-owed does not proceed when create-only claim fails (#4919)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-close-"));
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { title: "p", status: "running", policy: { deliveryBranch: "master" } },
      }),
      "utf8",
    );
    writeTipBrief(root, "xbrief/completed/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
      title: "story-a",
    });
    // completed briefs use status done in writeTipBrief helper? helper writes running — patch file.
    writeFileSync(
      join(root, "xbrief", "completed", "story-a.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "story-a",
          status: "done",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/4919",
              type: "x-xbrief/github-issue",
            },
          ],
          metadata: { productPullRequest: 5100 },
        },
      }),
      "utf8",
    );
    const tipBody = readFileSync(join(root, "xbrief/completed/story-a.xbrief.json"), "utf8");
    let finalizeCalls = 0;
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        if (args[1]?.includes("^{tree}")) {
          return { code: 0, stdout: "TREE\n", stderr: "" };
        }
        return { code: 0, stdout: "TIPSHA\n", stderr: "" };
      }
      if (args[0] === "commit-tree") {
        return { code: 0, stdout: "CLAIMSHA\n", stderr: "" };
      }
      if (args[0] === "push") {
        return { code: 1, stdout: "", stderr: "already exists" };
      }
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const path = "xbrief/completed/story-a.xbrief.json";
        const matched = prefixes.some((p) => path.startsWith(String(p))) ? path : "";
        return { code: 0, stdout: matched, stderr: "" };
      }
      if (args[0] === "show") {
        return { code: 0, stdout: tipBody, stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = finalizeOwed({
      projectRoot: root,
      repo: "deftai/directive",
      deliveryBranch: "master",
      runGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([4919]);
        }
        return { returncode: 0, stdout: "[]", stderr: "" };
      },
      runFinalize: () => {
        finalizeCalls += 1;
        return {
          exitCode: EXIT_OK,
          stdout: "ok",
          result: {
            project_root: root,
            dry_run: false,
            no_commit: false,
            pr_numbers: [5100],
            story_paths: [],
            closing_issues: [4919],
            sweep: null,
            commit_sha: null,
            branch: null,
            pr_url: null,
            delivery_branch: "master",
            sweep_base: "master",
            delivery_errors: [],
            errors: [],
            warnings: [],
            ok: true,
            pending: null,
          },
        };
      },
    });
    expect(finalizeCalls).toBe(0);
    expect(result.result.finalized).not.toContain(4919);
    expect(result.result.skipped).toContain(4919);
    expect(result.result.warnings.some((w) => w.includes("in flight"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("maps transient claim hit-fetch failure to unknown+blocking (#6008 Recut-5)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-fetch-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
    });
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/active/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "deadbeef refs/heads/swarm/finalize/pr-5100\n", stderr: "" };
      }
      if (args[0] === "fetch" && args.some((a) => String(a).includes("finalize-owed-claim"))) {
        return {
          code: 1,
          stdout: "",
          stderr: "fatal: unable to access 'https://github.com/': Could not resolve host",
        };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-09-27T00:00:00Z",
              merge_commit_sha: "abc",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([4919]);
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(inventory.stories.some((s) => s.state === "unknown" && s.blocks)).toBe(true);
    expect(inventory.stories.some((s) => s.state === "stale")).toBe(false);
    expect(inventory.stories.some((s) => s.state === "in-flight")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("maps unknown claim hit-fetch failure to unknown+blocking (#6008 Recut-5)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-unknown-fetch-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
    });
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/active/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "deadbeef refs/heads/swarm/finalize/pr-5100\n", stderr: "" };
      }
      if (args[0] === "fetch" && args.some((a) => String(a).includes("finalize-owed-claim"))) {
        return { code: 1, stdout: "", stderr: "fatal: remote error: unexpected backend failure" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-09-27T00:00:00Z",
              merge_commit_sha: "abc",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([4919]);
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(inventory.stories.some((s) => s.state === "unknown" && s.blocks)).toBe(true);
    expect(inventory.stories.some((s) => s.state === "stale")).toBe(false);
    expect(inventory.stories.some((s) => s.state === "in-flight")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not reclaim stale claim when completed brief issue is already closed (#4919)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-closed-stale-"));
    writeTipBrief(root, "xbrief/completed/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
      title: "story-a",
    });
    writeFileSync(
      join(root, "xbrief", "completed", "story-a.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "story-a",
          status: "done",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/4919",
              type: "x-xbrief/github-issue",
            },
          ],
          metadata: { productPullRequest: 5100 },
        },
      }),
      "utf8",
    );
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/completed/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/completed/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    const nowMs = Date.parse("2026-09-27T12:00:00Z");
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/pr-5100\n", stderr: "" };
      }
      if (args[0] === "fetch" && args.some((a) => String(a).includes("finalize-owed-claim"))) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "log" && args.some((a) => String(a).includes("%ct"))) {
        // Older than FINALIZE_CLAIM_STALE_MS.
        return {
          code: 0,
          stdout: String(Math.floor((nowMs - 3 * 60 * 60 * 1000) / 1000)),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      now: () => nowMs,
      runGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (isOpenIssueList(joined)) {
          // #4919 is closed: absent from the open-issue list (#5927).
          return openIssueList([]);
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(inventory.stories).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps already-stale nonterminal claims blocking when issue fetch fails (#4919)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-stale-issue-fail-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
    });
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/active/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    const nowMs = Date.parse("2026-09-27T12:00:00Z");
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/pr-5100\n", stderr: "" };
      }
      if (args[0] === "fetch" && args.some((a) => String(a).includes("finalize-owed-claim"))) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "log" && args.some((a) => String(a).includes("%ct"))) {
        return {
          code: 0,
          stdout: String(Math.floor((nowMs - 3 * 60 * 60 * 1000) / 1000)),
          stderr: "",
        };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      now: () => nowMs,
      runGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-09-27T00:00:00Z",
              merge_commit_sha: "abc",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return { returncode: 1, stdout: "", stderr: "API rate limit exceeded" };
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    const blocked = inventory.stories.filter((s) => s.state === "stale-unverified");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.blocks).toBe(true);
    expect(inventory.stories.some((s) => s.state === "stale")).toBe(false);
    expect(inventory.stories.some((s) => s.state === "unverified")).toBe(false);
    expect(inventoryHasBlockingOwed(inventory)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  // Seam test: the injected runGh wraps the real defaultRunGh with a stub binary.
  // It does not exercise session:start's default runGh wiring (#6023).
  it("seam: closed issue stays closed via real defaultRunGh, CLICOLOR_FORCE=1 (#6023)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-color-gh-"));
    // Stub `gh` for the open-issue list (#5927): colors on CLICOLOR_FORCE like real gh.
    const stub = join(root, "color-gh-list-stub.mjs");
    writeFileSync(
      stub,
      [
        'const text = JSON.stringify([[{ number: 1, state: "open", labels: [] }]]);',
        "const v = process.env.CLICOLOR_FORCE;",
        'const color = v !== undefined && v !== "" && v !== "0";',
        'process.stdout.write(color ? "\\u001b[1;38m" + text + "\\u001b[m\\n" : text + "\\n");',
        "",
      ].join("\n"),
      "utf8",
    );
    vi.stubEnv("CLICOLOR_FORCE", "1");
    try {
      writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 4919, {
        productPullRequest: 5100,
      });
      const tipBlobs = new Map<string, string>([
        [
          "xbrief/active/story-a.xbrief.json",
          readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8"),
        ],
      ]);
      const nowMs = Date.parse("2026-09-27T12:00:00Z");
      const runGit = (_projectRoot: string, args: readonly string[]) => {
        if (args[0] === "ls-tree") {
          const dash = args.indexOf("--");
          const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
          const matched = [...tipBlobs.keys()].filter((p) =>
            prefixes.some((pref) => p.startsWith(String(pref))),
          );
          return { code: 0, stdout: matched.join("\n"), stderr: "" };
        }
        if (args[0] === "show") {
          const spec = String(args[1] ?? "");
          const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
          const body = tipBlobs.get(rel);
          return body !== undefined
            ? { code: 0, stdout: body, stderr: "" }
            : { code: 1, stdout: "", stderr: "missing" };
        }
        if (args[0] === "ls-remote") {
          return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/pr-5100\n", stderr: "" };
        }
        if (args[0] === "fetch" && args.some((a) => String(a).includes("finalize-owed-claim"))) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "log" && args.some((a) => String(a).includes("%ct"))) {
          // Older than FINALIZE_CLAIM_STALE_MS: a failed issue read would block.
          return {
            code: 0,
            stdout: String(Math.floor((nowMs - 3 * 60 * 60 * 1000) / 1000)),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const issueReads: string[] = [];
      const inventory = discoverFinalizeOwed(root, {
        repo: "deftai/directive",
        deliveryBranch: "master",
        tip: "TIP",
        now: () => nowMs,
        runGit,
        runGh: (cmd) => {
          const joined = cmd.join(" ");
          if (joined.includes("/pulls?")) {
            return { returncode: 0, stdout: "[]", stderr: "" };
          }
          if (joined.includes("/pulls/")) {
            return {
              returncode: 0,
              stdout: JSON.stringify({
                merged_at: "2026-09-27T00:00:00Z",
                merge_commit_sha: "abc",
                base: { ref: "master" },
              }),
              stderr: "",
            };
          }
          if (isOpenIssueList(joined)) {
            // Real runner, stub binary: node <stub> api --paginate --slurp repos/.../issues?….
            const result = defaultRunGh(["gh", stub, ...cmd.slice(1)], process.execPath);
            issueReads.push(result.stdout);
            return result;
          }
          return { returncode: 1, stdout: "", stderr: "unexpected" };
        },
      });
      // Two confirming list reads (#5927), both plain JSON.
      expect(issueReads).toHaveLength(2);
      for (const read of issueReads) {
        expect(read).not.toContain("\u001b");
      }
      expect(inventory.stories.some((s) => s.state === "stale-unverified")).toBe(false);
      expect(inventoryHasBlockingOwed(inventory)).toBe(false);
      expect(inventory.stories).toEqual([]);
      expect(process.env.CLICOLOR_FORCE).toBe("1");
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps already-stale completed claims blocking when issue fetch fails (#4919)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-close-stale-issue-fail-"));
    writeTipBrief(root, "xbrief/completed/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
      title: "story-a",
    });
    writeFileSync(
      join(root, "xbrief", "completed", "story-a.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "story-a",
          status: "done",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/4919",
              type: "x-xbrief/github-issue",
            },
          ],
          metadata: { productPullRequest: 5100 },
        },
      }),
      "utf8",
    );
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/completed/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/completed/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    const nowMs = Date.parse("2026-09-27T12:00:00Z");
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/pr-5100\n", stderr: "" };
      }
      if (args[0] === "fetch" && args.some((a) => String(a).includes("finalize-owed-claim"))) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "log" && args.some((a) => String(a).includes("%ct"))) {
        return {
          code: 0,
          stdout: String(Math.floor((nowMs - 3 * 60 * 60 * 1000) / 1000)),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      now: () => nowMs,
      runGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (isOpenIssueList(joined)) {
          return { returncode: 1, stdout: "", stderr: "API rate limit exceeded" };
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    const blocked = inventory.stories.filter((s) => s.state === "stale-unverified");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.blocks).toBe(true);
    expect(blocked[0]?.detail).toContain("close-owed window");
    expect(inventory.stories.some((s) => s.state === "stale")).toBe(false);
    expect(inventory.stories.some((s) => s.state === "unverified")).toBe(false);
    expect(inventoryHasBlockingOwed(inventory)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not reclaim/delete when stale claim issue verify fails (#4919)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-no-reclaim-unverified-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 4919, {
      productPullRequest: 5100,
    });
    const tipBody = readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8");
    const nowMs = Date.parse("2026-09-27T12:00:00Z");
    const deletePushes: string[][] = [];
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "fetch" && args.includes("origin") && args.includes("master")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        if (args[1]?.includes("^{tree}")) {
          return { code: 0, stdout: "TREE\n", stderr: "" };
        }
        return { code: 0, stdout: "TIPSHA\n", stderr: "" };
      }
      if (args[0] === "update-ref") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const path = "xbrief/active/story-a.xbrief.json";
        const matched = prefixes.some((p) => path.startsWith(String(p))) ? path : "";
        return { code: 0, stdout: matched, stderr: "" };
      }
      if (args[0] === "show") {
        return { code: 0, stdout: tipBody, stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/pr-5100\n", stderr: "" };
      }
      if (args[0] === "fetch" && args.some((a) => String(a).includes("finalize-owed-claim"))) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "log" && args.some((a) => String(a).includes("%ct"))) {
        return {
          code: 0,
          stdout: String(Math.floor((nowMs - 3 * 60 * 60 * 1000) / 1000)),
          stderr: "",
        };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "push" && args.includes("--delete")) {
        deletePushes.push([...args]);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    let finalizeCalls = 0;
    const result = finalizeOwed({
      projectRoot: root,
      repo: "deftai/directive",
      deliveryBranch: "master",
      now: () => nowMs,
      runGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-09-27T00:00:00Z",
              merge_commit_sha: "abc",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return { returncode: 1, stdout: "", stderr: "API rate limit exceeded" };
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
      runFinalize: () => {
        finalizeCalls += 1;
        // Returned failure — stale-unverified must not reclaim/finalize (#4919).
        return {
          exitCode: EXIT_INCOMPLETE,
          stdout: "",
          result: {
            project_root: root,
            dry_run: false,
            no_commit: false,
            pr_numbers: [],
            story_paths: [],
            closing_issues: [],
            sweep: null,
            commit_sha: null,
            branch: null,
            pr_url: null,
            delivery_branch: "master",
            sweep_base: "master",
            delivery_errors: [],
            errors: ["finalize must not run for stale-unverified"],
            warnings: [],
            ok: false,
            pending: null,
          },
        };
      },
    });
    expect(finalizeCalls).toBe(0);
    expect(deletePushes).toHaveLength(0);
    expect(result.result.skipped).toContain(4919);
    expect(result.result.finalized).not.toContain(4919);
    expect(result.result.stories.some((s) => s.state === "stale-unverified" && s.blocks)).toBe(
      true,
    );
    expect(result.exitCode).toBe(EXIT_INCOMPLETE);
    expect(result.result.ok).toBe(true);
    expect(result.result.warnings.some((w) => w.includes("origin-issue unverified"))).toBe(true);
    expect(result.stdout).toContain("FINALIZE-OWED INCOMPLETE");
    expect(result.stdout).toContain("claim still blocking");
    expect(result.stdout).not.toContain("FINALIZE-OWED CLEAN");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("finalize-owed proposed historical cite refuse (#5143)", () => {
  function tipGit(tipBlobs: Map<string, string>) {
    return (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  it("refuses #635/#401 proposed unmarked historical cite (zero blocking owed)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-5143-proposed-"));
    const rel = "xbrief/proposed/2026-04-635-epic.xbrief.json";
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    writeFileSync(
      join(root, rel),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "epic-635-historical",
          status: "proposed",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/635",
              type: "x-xbrief/github-issue",
            },
            {
              uri: "https://github.com/deftai/directive/pull/401",
              type: "x-xbrief/github-pr",
            },
          ],
        },
      }),
      "utf8",
    );
    const tipBlobs = new Map<string, string>([[rel, readFileSync(join(root, rel), "utf8")]]);
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(tipBlobs),
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/401")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-04-01T00:00:00Z",
              merge_commit_sha: "deadbeef401",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([
            { number: 635, labels: [{ name: "epic" }, { name: "status:tracker" }] },
          ]);
        }
        return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
      },
    });
    expect(inventory.stories.filter((s) => s.blocks)).toHaveLength(0);
    expect(inventoryHasBlockingOwed(inventory)).toBe(false);
    expect(inventory.stories.some((s) => s.state === "owed")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("skips owed for open epic/status:tracker even when unmarked active admits", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-5143-tracker-"));
    const rel = "xbrief/active/stuck-tracker.xbrief.json";
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, rel),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "active-unmarked-tracker",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/635",
              type: "x-xbrief/github-issue",
            },
            {
              uri: "https://github.com/deftai/directive/pull/401",
              type: "x-xbrief/github-pr",
            },
          ],
        },
      }),
      "utf8",
    );
    const tipBlobs = new Map<string, string>([[rel, readFileSync(join(root, rel), "utf8")]]);
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(tipBlobs),
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/401")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-04-01T00:00:00Z",
              merge_commit_sha: "deadbeef401",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([
            { number: 635, labels: [{ name: "epic" }, { name: "status:tracker" }] },
          ]);
        }
        return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
      },
    });
    // Unmarked tracker is not owed (#5122); staying-open skip remains for later-ship admit.
    expect(inventory.stories.filter((s) => s.blocks)).toHaveLength(0);
    expect(inventoryHasBlockingOwed(inventory)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("marked productPullRequest under epic/tracker still owes (#5143 Class A)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-5143-marked-epic-"));
    const rel = "xbrief/active/marked-under-epic.xbrief.json";
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, rel),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "marked-under-epic",
          status: "running",
          metadata: { productPullRequest: 401 },
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/635",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const tipBlobs = new Map<string, string>([[rel, readFileSync(join(root, rel), "utf8")]]);
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(tipBlobs),
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/401")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-04-01T00:00:00Z",
              merge_commit_sha: "deadbeef401",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([
            { number: 635, labels: [{ name: "epic" }, { name: "status:tracker" }] },
          ]);
        }
        return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
      },
    });
    const owed = inventory.stories.filter((s) => s.blocks);
    expect(owed.length).toBeGreaterThan(0);
    expect(owed.some((s) => s.issue === 635 && s.productPr === 401)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not owe unmarked Tracking leftovers; stamp/complete/close stay untriggered (#5122)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-5122-true-leftover-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { title: "p", status: "running", policy: { deliveryBranch: "master" } },
      }),
      "utf8",
    );
    const rel = "xbrief/active/stuck-unmarked.xbrief.json";
    writeFileSync(
      join(root, rel),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "true-unmarked-leftover",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/9999",
              type: "x-xbrief/github-issue",
            },
            {
              uri: "https://github.com/deftai/directive/pull/7",
              type: "x-xbrief/github-pr",
            },
          ],
        },
      }),
      "utf8",
    );
    const before = readFileSync(join(root, rel), "utf8");
    const tipBlobs = new Map<string, string>([[rel, before]]);
    let finalizeCalls = 0;
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: "TIPSHA\n", stderr: "" };
      }
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const tipRel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(tipRel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(tipBlobs),
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/7")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-09-01T00:00:00Z",
              merge_commit_sha: "deadbeef",
              base: { ref: "master" },
              body: "Closes #1234",
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([9999]);
        }
        return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
      },
    });
    expect(inventory.stories.filter((s) => s.state === "owed")).toHaveLength(0);
    expect(inventoryHasBlockingOwed(inventory)).toBe(false);
    const listed = inventory.stories.find((s) => s.relPath === rel);
    expect(listed?.state).toBe("unverified");
    expect(listed?.blocks).toBe(false);
    expect(listed?.issue).toBe(9999);
    expect(listed?.productPr).toBe(0);
    expect(listed?.detail).toBe(UNMARKED_STAMP_REMEDIATION);

    const result = finalizeOwed({
      projectRoot: root,
      repo: "deftai/directive",
      deliveryBranch: "master",
      runGit,
      runGh: () => ({ returncode: 0, stdout: "[]", stderr: "" }),
      runFinalize: () => {
        finalizeCalls += 1;
        throw new Error("finalizeCohort must not run for unmarked #5122");
      },
    });
    expect(finalizeCalls).toBe(0);
    expect(result.result.finalized).toEqual([]);
    expect(result.result.stories.some((s) => s.state === "owed")).toBe(false);
    expect(result.result.stories.some((s) => s.blocks)).toBe(false);
    expect(readFileSync(join(root, rel), "utf8")).toBe(before);
    expect(JSON.parse(before).plan.metadata?.productPullRequest).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("later-ship bind assigns both fields from one admit tuple", () => {
    const bound = bindUnmarkedFinalizePair({
      admit: { productPr: 8, issue: 9999, detail: "later unique pair" },
      issueFromPlan: 9999,
      plan: {
        references: [
          {
            uri: "https://github.com/deftai/directive/issues/9999",
            type: "x-xbrief/github-issue",
          },
        ],
      },
    });
    expect(bound).toEqual({
      kind: "admit",
      issue: 9999,
      productPr: 8,
      detail: "later unique pair",
    });
  });
});

describe("finalize-owed AppSec fetch gate (#5545)", () => {
  it("fetchDeliveryTipPrivate uses privateDestFetchArgv and refuses hostile names before spawn", () => {
    const calls: string[][] = [];
    const runGit = (_cwd: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: "TIPSHA\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    for (const hostile of ["--upload-pack=evil", "attacker:master", "-x", "a..b", " ", ""]) {
      calls.length = 0;
      const result = fetchDeliveryTipPrivate("/tmp", hostile, runGit);
      expect(result.tip).toBeNull();
      expect(result.error).toMatch(/Invalid|must match/i);
      expect(calls).toHaveLength(0);
    }
    calls.length = 0;
    const ok = fetchDeliveryTipPrivate("/tmp", "release/1.0", runGit);
    expect(ok.tip).toBe("TIPSHA");
    expect(calls[0]).toEqual([
      "fetch",
      "--force",
      "origin",
      "--",
      "refs/heads/release/1.0:refs/deft/finalize-owed/release/1.0",
    ]);
    expect(calls[1]).toEqual(["rev-parse", "refs/deft/finalize-owed/release/1.0"]);
  });

  it("finalizeOwed refuses present-invalid --delivery-branch before fetch", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-hostile-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const calls: string[][] = [];
    const result = finalizeOwed({
      projectRoot: root,
      repo: "deftai/directive",
      deliveryBranch: "--upload-pack=evil",
      inventoryOnly: true,
      runGit: (_cwd, args) => {
        calls.push([...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
      runGh: () => ({ returncode: 0, stdout: "[]", stderr: "" }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => /Invalid|--upload-pack/i.test(e))).toBe(true);
    expect(calls.every((c) => c[0] !== "fetch")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("finalize-owed claim batch (#6008)", () => {
  it("parses claim-batch stdout by exact head name", () => {
    const map = parseFinalizeClaimBatchStdout(
      "abc123 refs/heads/swarm/finalize/1-2\ndef456\trefs/heads/swarm/finalize/3-4\n",
    );
    expect(map).not.toBeNull();
    expect(map?.get("swarm/finalize/1-2")).toBe("abc123");
    expect(map?.get("swarm/finalize/3-4")).toBe("def456");
    expect(parseFinalizeClaimBatchStdout("not-a-ref-line\n")).toBeNull();
    expect(parseFinalizeClaimBatchStdout("").size).toBe(0);
  });

  it("memoizes one ls-remote batch across two probe demands", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-batch-once-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 6008, {
      productPullRequest: 6100,
    });
    writeTipBrief(root, "xbrief/active/story-b.xbrief.json", 6009, {
      productPullRequest: 6101,
    });
    const tipBlobs = new Map<string, string>();
    for (const rel of ["xbrief/active/story-a.xbrief.json", "xbrief/active/story-b.xbrief.json"]) {
      tipBlobs.set(rel, readFileSync(join(root, rel), "utf8"));
    }
    let lsRemoteCalls = 0;
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: (_projectRoot, args) => {
        if (args[0] === "ls-tree") {
          const dash = args.indexOf("--");
          const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
          const matched = [...tipBlobs.keys()].filter((p) =>
            prefixes.some((pref) => p.startsWith(String(pref))),
          );
          return { code: 0, stdout: matched.join("\n"), stderr: "" };
        }
        if (args[0] === "show") {
          const spec = String(args[1] ?? "");
          const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
          const body = tipBlobs.get(rel);
          return body !== undefined
            ? { code: 0, stdout: body, stderr: "" }
            : { code: 1, stdout: "", stderr: "missing" };
        }
        if (args[0] === "ls-remote") {
          lsRemoteCalls += 1;
          expect(args).toContain("refs/heads/swarm/finalize/*");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "merge-base") {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-11-01T00:00:00Z",
              merge_commit_sha: "abc",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([6008, 6009]);
        }
        return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
      },
    });
    expect(lsRemoteCalls).toBe(1);
    expect(inventory.stories.filter((s) => s.state === "owed")).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("maps batch failure to unknown+blocking and skips network when no probe demand", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-batch-fail-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 6008, {
      productPullRequest: 6100,
    });
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/active/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    let lsRemoteCalls = 0;
    const tipGit = (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        lsRemoteCalls += 1;
        return { code: 128, stdout: "", stderr: "timed out" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit,
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("/pulls/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-11-01T00:00:00Z",
              merge_commit_sha: "abc",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (isOpenIssueList(joined)) {
          return openIssueList([6008]);
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(lsRemoteCalls).toBe(1);
    expect(inventory.stories).toHaveLength(1);
    expect(inventory.stories[0]?.state).toBe("unknown");
    expect(inventory.stories[0]?.blocks).toBe(true);
    expect(inventory.stories[0]?.detail).toBe(CLAIM_PROBE_UNKNOWN_DETAIL);
    expect(inventory.stories[0]?.detail).not.toMatch(/timed out|stderr/i);

    // Open leftover PR → in-flight without claim probe.
    lsRemoteCalls = 0;
    const inFlightOnly = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: (_projectRoot, args) => {
        if (args[0] === "ls-tree") {
          const dash = args.indexOf("--");
          const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
          const matched = [...tipBlobs.keys()].filter((p) =>
            prefixes.some((pref) => p.startsWith(String(pref))),
          );
          return { code: 0, stdout: matched.join("\n"), stderr: "" };
        }
        if (args[0] === "show") {
          const spec = String(args[1] ?? "");
          const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
          const body = tipBlobs.get(rel);
          return body !== undefined
            ? { code: 0, stdout: body, stderr: "" }
            : { code: 1, stdout: "", stderr: "missing" };
        }
        if (args[0] === "ls-remote") {
          lsRemoteCalls += 1;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "merge-base") {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      runGh: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("/pulls?")) {
          return {
            returncode: 0,
            stdout: JSON.stringify([{ head: { ref: "swarm/finalize/pr-6100" } }]),
            stderr: "",
          };
        }
        if (joined.includes("/pulls/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-11-01T00:00:00Z",
              merge_commit_sha: "abc",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(lsRemoteCalls).toBe(0);
    expect(inFlightOnly.stories[0]?.state).toBe("in-flight");
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps reclaimable hit-fetch as stale and remaps non-reclaimable to unknown", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-reclaimable-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 6008, {
      productPullRequest: 6100,
    });
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/active/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    const claimLine = "deadbeef refs/heads/swarm/finalize/pr-6100\n";
    const baseGit = (fetchStderr: string) => (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: claimLine, stderr: "" };
      }
      if (args[0] === "fetch" && args.some((a) => String(a).includes("finalize-owed-claim"))) {
        return { code: 1, stdout: "", stderr: fetchStderr };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const ghOpen = (cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("/pulls?")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (joined.includes("/pulls/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            merged_at: "2026-11-01T00:00:00Z",
            merge_commit_sha: "abc",
            base: { ref: "master" },
          }),
          stderr: "",
        };
      }
      if (isOpenIssueList(joined)) {
        return openIssueList([6008]);
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };

    const reclaimable = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: baseGit("couldn't find remote ref swarm/finalize/pr-6100"),
      runGh: ghOpen,
    });
    expect(reclaimable.stories[0]?.state).toBe("stale");
    expect(reclaimable.stories[0]?.blocks).toBe(true);

    const nonReclaimable = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: baseGit("fatal: unable to access 'https://github.com/': Could not resolve host"),
      runGh: ghOpen,
    });
    expect(nonReclaimable.stories[0]?.state).toBe("unknown");
    expect(nonReclaimable.stories[0]?.blocks).toBe(true);
    expect(nonReclaimable.stories[0]?.detail).toBe(CLAIM_PROBE_UNKNOWN_DETAIL);
    rmSync(root, { recursive: true, force: true });
  });

  it("finalizeOwed ordinary path exits non-zero on unknown; inventory-only stays report-only", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-unknown-exit-"));
    writeTipBrief(root, "xbrief/active/story-a.xbrief.json", 6008, {
      productPullRequest: 6100,
    });
    const tipBlobs = new Map<string, string>([
      [
        "xbrief/active/story-a.xbrief.json",
        readFileSync(join(root, "xbrief/active/story-a.xbrief.json"), "utf8"),
      ],
    ]);
    const runGit = (_projectRoot: string, args: readonly string[]) => {
      if (
        args[0] === "fetch" &&
        args.includes("origin") &&
        !args.some((a) => String(a).includes("finalize-owed-claim"))
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: "TIPSHA\n", stderr: "" };
      }
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "ls-remote") {
        return { code: 128, stdout: "", stderr: "network down" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const runGh = (cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("/pulls?")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (joined.includes("/pulls/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            merged_at: "2026-11-01T00:00:00Z",
            merge_commit_sha: "abc",
            base: { ref: "master" },
          }),
          stderr: "",
        };
      }
      if (isOpenIssueList(joined)) {
        return openIssueList([6008]);
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };

    const live = finalizeOwed({
      projectRoot: root,
      repo: "deftai/directive",
      deliveryBranch: "master",
      runGit,
      runGh,
      runFinalize: () => {
        throw new Error("must not finalize unknown");
      },
    });
    expect(live.exitCode).toBe(EXIT_GATE_FAILED);
    expect(live.result.ok).toBe(false);
    expect(live.result.stories.some((s) => s.state === "unknown")).toBe(true);

    const inventoryOnly = finalizeOwed({
      projectRoot: root,
      repo: "deftai/directive",
      deliveryBranch: "master",
      inventoryOnly: true,
      runGit,
      runGh,
    });
    expect(inventoryOnly.exitCode).toBe(EXIT_OK);
    expect(inventoryOnly.result.stories.some((s) => s.state === "unknown")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("finalize-owed issue-less pr-only rows (#680 P2)", () => {
  function writeIssueLessBrief(
    root: string,
    rel: string,
    opts: { productPullRequest?: number; status?: string; references?: unknown[] } = {},
  ): string {
    const full = join(root, ...rel.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(
      full,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "issue-less story",
          status: opts.status ?? "running",
          references: opts.references ?? [],
          ...(opts.productPullRequest !== undefined
            ? { metadata: { productPullRequest: opts.productPullRequest } }
            : {}),
        },
      }),
      "utf8",
    );
    return readFileSync(full, "utf8");
  }

  function tipGit(tipBlobs: Map<string, string>) {
    return (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return {
          code: 0,
          stdout: args[1]?.includes("^{tree}") ? "TREE\n" : "TIPSHA\n",
          stderr: "",
        };
      }
      if (args.includes("commit-tree")) {
        return { code: 0, stdout: "CLAIMSHA\n", stderr: "" };
      }
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  function forge(ghCalls: string[]) {
    return (cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      ghCalls.push(joined);
      if (joined.includes("/pulls?")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (joined.includes("/pulls/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            merged_at: "2026-11-12T00:00:00Z",
            merge_commit_sha: "abc",
            base: { ref: "master" },
          }),
          stderr: "",
        };
      }
      if (isOpenIssueList(joined)) {
        return openIssueList([4919]);
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
  }

  function okFinalizeResult(root: string, pr: number) {
    return {
      project_root: root,
      dry_run: false,
      no_commit: false,
      pr_numbers: [pr],
      story_paths: [],
      closing_issues: [],
      sweep: null,
      commit_sha: null,
      branch: null,
      pr_url: null,
      delivery_branch: "master",
      sweep_base: "master",
      delivery_errors: [],
      errors: [],
      warnings: [],
      ok: true,
      pending: null,
    };
  }

  it("admits a stamped issue-less brief as owed with a null issue and no origin verify", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-680-admit-"));
    const rel = "xbrief/active/issue-less.xbrief.json";
    const body = writeIssueLessBrief(root, rel, { productPullRequest: 6240 });
    const ghCalls: string[] = [];
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(new Map([[rel, body]])),
      runGh: forge(ghCalls),
    });
    expect(inventory.stories).toHaveLength(1);
    const story = inventory.stories[0];
    expect(story?.issue).toBeNull();
    expect(story?.productPr).toBe(6240);
    expect(story?.state).toBe("owed");
    expect(story?.blocks).toBe(true);
    expect(story?.detail).toContain("pr-only identity");
    // Origin-issue verify is skipped: no issues/<N> read at all.
    expect(ghCalls.some((c) => c.includes("/issues/"))).toBe(false);
    expect(formatFinalizeOwedInventoryLines(inventory).join("\n")).toContain("pr #6240 owed");
    rmSync(root, { recursive: true, force: true });
  });

  it("does not list a completed issue-less brief: no origin to close", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-680-completed-"));
    const rel = "xbrief/completed/issue-less.xbrief.json";
    const body = writeIssueLessBrief(root, rel, { productPullRequest: 6240, status: "done" });
    const ghCalls: string[] = [];
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(new Map([[rel, body]])),
      runGh: forge(ghCalls),
    });
    expect(inventory.stories).toEqual([]);
    expect(ghCalls.some((c) => c.includes("/issues/"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a foreign-repo issue ref unverified, with a null issue (never #0)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-680-foreign-"));
    const rel = "xbrief/active/foreign.xbrief.json";
    const body = writeIssueLessBrief(root, rel, {
      productPullRequest: 6240,
      references: [
        { uri: "https://github.com/other/repo/issues/12", type: "x-xbrief/github-issue" },
      ],
    });
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(new Map([[rel, body]])),
      runGh: forge([]),
    });
    expect(inventory.stories.map((s) => [s.issue, s.state])).toEqual([[null, "unverified"]]);
    rmSync(root, { recursive: true, force: true });
  });

  it("finalizes an issue-less row by path and reports it by product PR", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-680-run-"));
    const rel = "xbrief/active/issue-less.xbrief.json";
    const body = writeIssueLessBrief(root, rel, { productPullRequest: 6240 });
    const seen: { issue: number | null; relPaths: readonly string[]; productPr: number }[] = [];
    const result = finalizeOwed({
      projectRoot: root,
      repo: "deftai/directive",
      deliveryBranch: "master",
      runGit: tipGit(new Map([[rel, body]])),
      runGh: forge([]),
      runFinalize: (input) => {
        seen.push({ issue: input.issue, relPaths: input.relPaths, productPr: input.productPr });
        return { exitCode: EXIT_OK, stdout: "ok", result: okFinalizeResult(root, 6240) };
      },
    });
    expect(seen).toEqual([{ issue: null, relPaths: [rel], productPr: 6240 }]);
    expect(result.result.finalized).toEqual([]);
    expect(result.result.finalized_prs).toEqual([6240]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("Finalized: pr #6240");
    rmSync(root, { recursive: true, force: true });
  });

  it("finalizes issue-less rows that share a product PR in one call under one claim", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-680-group-"));
    const relA = "xbrief/active/issue-less-a.xbrief.json";
    const relB = "xbrief/active/issue-less-b.xbrief.json";
    const bodyA = writeIssueLessBrief(root, relA, { productPullRequest: 6240 });
    const bodyB = writeIssueLessBrief(root, relB, { productPullRequest: 6240 });
    const seen: (readonly string[])[] = [];
    const result = finalizeOwed({
      projectRoot: root,
      repo: "deftai/directive",
      deliveryBranch: "master",
      runGit: tipGit(
        new Map([
          [relA, bodyA],
          [relB, bodyB],
        ]),
      ),
      runGh: forge([]),
      runFinalize: (input) => {
        seen.push(input.relPaths);
        return { exitCode: EXIT_OK, stdout: "ok", result: okFinalizeResult(root, 6240) };
      },
    });
    expect(seen).toEqual([[relA, relB]]);
    expect(result.result.finalized_prs).toEqual([6240]);
    expect(result.result.warnings.some((w) => w.includes("in flight"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a stamped issue-less brief outside active/ unverified: it cannot complete", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-680-pending-"));
    const rel = "xbrief/pending/issue-less.xbrief.json";
    const body = writeIssueLessBrief(root, rel, { productPullRequest: 6240, status: "pending" });
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(new Map([[rel, body]])),
      runGh: forge([]),
    });
    expect(inventory.stories.map((s) => [s.issue, s.state, s.blocks])).toEqual([
      [null, "unverified", false],
    ]);
    expect(inventory.stories[0]?.detail).toContain("not in active/");
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves an owed story pending when finalize refuses its own mark (#680 P3)", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-680-refused-"));
    const rel = "xbrief/active/story-a.xbrief.json";
    writeTipBrief(root, rel, 4919, { productPullRequest: 5100 });
    const result = finalizeOwed({
      projectRoot: root,
      repo: "deftai/directive",
      deliveryBranch: "master",
      runGit: tipGit(new Map([[rel, readFileSync(join(root, rel), "utf8")]])),
      runGh: forge([]),
      runFinalize: () => ({
        exitCode: EXIT_INCOMPLETE,
        stdout: "incomplete",
        result: {
          ...okFinalizeResult(root, 5100),
          ok: false,
          refused_marks: [{ issue: 4919, pr: 5100, detail: "#4919: refused" }],
        },
      }),
    });
    expect(result.result.finalized).toEqual([]);
    expect(result.result.skipped).toContain(4919);
    expect(result.exitCode).toBe(EXIT_INCOMPLETE);
    expect(result.result.warnings.some((w) => w.includes("story left pending"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("finalize-owed origin issue state from one open-issue list (#5927)", () => {
  const OPEN_ACTIVE = "xbrief/active/story-open.xbrief.json";
  const OPEN_COMPLETED = "xbrief/completed/story-open-done.xbrief.json";
  const CLOSED_COMPLETED = "xbrief/completed/story-closed-done.xbrief.json";

  function seedTip(root: string): Map<string, string> {
    writeTipBrief(root, OPEN_ACTIVE, 101, { productPullRequest: 1101 });
    writeTipBrief(root, OPEN_COMPLETED, 102, { productPullRequest: 1102 });
    writeTipBrief(root, CLOSED_COMPLETED, 103, { productPullRequest: 1103 });
    const tipBlobs = new Map<string, string>();
    for (const rel of [OPEN_ACTIVE, OPEN_COMPLETED, CLOSED_COMPLETED]) {
      tipBlobs.set(rel, readFileSync(join(root, rel), "utf8"));
    }
    return tipBlobs;
  }

  function tipGit(tipBlobs: Map<string, string>) {
    return (_projectRoot: string, args: readonly string[]) => {
      if (args[0] === "ls-tree") {
        const dash = args.indexOf("--");
        const prefixes = dash >= 0 ? args.slice(dash + 1) : [];
        const matched = [...tipBlobs.keys()].filter((p) =>
          prefixes.some((pref) => p.startsWith(String(pref))),
        );
        return { code: 0, stdout: matched.join("\n"), stderr: "" };
      }
      if (args[0] === "show") {
        const spec = String(args[1] ?? "");
        const rel = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : "";
        const body = tipBlobs.get(rel);
        return body !== undefined
          ? { code: 0, stdout: body, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  function forge(
    ghCalls: string[],
    list: () => { returncode: number; stdout: string; stderr: string },
  ) {
    return (cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      ghCalls.push(joined);
      if (joined.includes("/pulls?")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (joined.includes("/pulls/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            merged_at: "2026-09-27T00:00:00Z",
            merge_commit_sha: "abc",
            base: { ref: "master" },
          }),
          stderr: "",
        };
      }
      if (isOpenIssueList(joined)) {
        return list();
      }
      return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
    };
  }

  it("reads one paged open-issue list and no per-issue read; absent issues are closed", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-5927-list-"));
    const ghCalls: string[] = [];
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(seedTip(root)),
      runGh: forge(ghCalls, () => openIssueList([101, 102, 4242])),
    });
    // One paged list, read twice to confirm the set; no per-issue read.
    const listCalls = ghCalls.filter((c) => isOpenIssueList(c));
    const listArgv =
      "gh api --paginate --slurp repos/deftai/directive/issues?state=open&per_page=100";
    expect(listCalls).toEqual([listArgv, listArgv]);
    expect(ghCalls.some((c) => /\/issues\/\d+/.test(c))).toBe(false);
    const byPath = new Map(inventory.stories.map((s) => [s.relPath, s]));
    expect(byPath.get(OPEN_ACTIVE)?.state).toBe("owed");
    expect(byPath.get(OPEN_ACTIVE)?.blocks).toBe(true);
    expect(byPath.get(OPEN_COMPLETED)?.state).toBe("close-owed");
    expect(byPath.get(OPEN_COMPLETED)?.blocks).toBe(true);
    // #103 is not in the open list: closed, so nothing is owed for it.
    expect(byPath.has(CLOSED_COMPLETED)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps every item unverified when the list fails; never closed or clean", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-5927-fail-"));
    const ghCalls: string[] = [];
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(seedTip(root)),
      runGh: forge(ghCalls, () => ({
        returncode: 1,
        stdout: "",
        stderr: "API rate limit exceeded",
      })),
    });
    // One attempt, memoized across all three lookups.
    expect(ghCalls.filter((c) => isOpenIssueList(c))).toHaveLength(1);
    expect(ghCalls.some((c) => /\/issues\/\d+/.test(c))).toBe(false);
    expect(inventory.stories.map((s) => s.relPath).sort()).toEqual(
      [CLOSED_COMPLETED, OPEN_ACTIVE, OPEN_COMPLETED].sort(),
    );
    for (const story of inventory.stories) {
      expect(story.state).toBe("unverified");
      expect(story.detail).toContain("open-issue list failed");
      expect(story.detail).toContain("API rate limit exceeded");
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("does not list issues when no item needs an origin issue state", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-5927-none-"));
    const ghCalls: string[] = [];
    discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: tipGit(new Map()),
      runGh: forge(ghCalls, () => openIssueList([])),
    });
    expect(ghCalls.some((c) => isOpenIssueList(c))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("createOriginIssueStateLookup (#5927)", () => {
  function runner(result: { returncode: number; stdout: string; stderr: string }) {
    const calls: string[][] = [];
    const fn: RunGhApiFn = (args) => {
      calls.push([...args]);
      return result;
    };
    return { fn, calls };
  }

  it("maps open rows to open with the protected-label check and absent issues to closed", () => {
    const { fn, calls } = runner(openIssueList([7, { number: 8, labels: [{ name: "epic" }] }]));
    const lookup = createOriginIssueStateLookup("deftai/directive", fn);
    expect(lookup(7)).toEqual({ state: "open", protectedUmbrella: false, error: null });
    expect(lookup(8)).toEqual({ state: "open", protectedUmbrella: true, error: null });
    expect(lookup(9)).toEqual({ state: "closed", protectedUmbrella: false, error: null });
    // Two confirming reads, memoized across lookups.
    expect(calls).toHaveLength(2);
  });

  it("fails closed when an open issue is missing from one of the two reads", () => {
    // A row skipped by a page shift (issue closed mid-read) must not read as closed.
    const reads = [openIssueList([7, 8]), openIssueList([8])];
    const calls: string[][] = [];
    const lookup = createOriginIssueStateLookup("deftai/directive", (args) => {
      calls.push([...args]);
      return reads[calls.length - 1] ?? openIssueList([]);
    });
    for (const issue of [7, 8, 9]) {
      const state = lookup(issue);
      expect(state.state).toBeNull();
      expect(state.error).toContain("open issues changed between two reads");
    }
    expect(calls).toHaveLength(2);
  });

  it("fails closed when the confirming read fails", () => {
    const reads = [openIssueList([7]), { returncode: 1, stdout: "", stderr: "HTTP 502" }];
    let n = 0;
    const lookup = createOriginIssueStateLookup("deftai/directive", () => {
      n += 1;
      return reads[n - 1] ?? openIssueList([]);
    });
    expect(lookup(7).state).toBeNull();
    expect(lookup(7).error).toContain("HTTP 502");
    expect(n).toBe(2);
  });

  it("fails closed when two reads have the same size but different issues", () => {
    const reads = [openIssueList([7, 8]), openIssueList([7, 9])];
    let n = 0;
    const lookup = createOriginIssueStateLookup("deftai/directive", () => {
      n += 1;
      return reads[n - 1] ?? openIssueList([]);
    });
    expect(lookup(7).error).toContain("open issues changed between two reads");
  });

  it("fails closed when a pull request row leaves between reads (it shifts pages too)", () => {
    // A PR merged mid-read can skip an open issue; the issue sets alone could match.
    const pr = { number: 50, state: "open", labels: [], pull_request: {} };
    const issue = { number: 7, state: "open", labels: [] };
    const reads = [
      { returncode: 0, stdout: JSON.stringify([[pr, issue]]), stderr: "" },
      { returncode: 0, stdout: JSON.stringify([[issue]]), stderr: "" },
    ];
    let n = 0;
    const lookup = createOriginIssueStateLookup("deftai/directive", () => {
      n += 1;
      return reads[n - 1] ?? openIssueList([]);
    });
    expect(lookup(8).state).toBeNull();
    expect(lookup(8).error).toContain("open issues changed between two reads");
  });

  it("ignores pull request rows for state but accepts two matching reads", () => {
    const pr = { number: 50, state: "open", labels: [], pull_request: {} };
    const issue = { number: 7, state: "open", labels: [] };
    const page = { returncode: 0, stdout: JSON.stringify([pr, issue]), stderr: "" };
    const lookup = createOriginIssueStateLookup("deftai/directive", () => page);
    expect(lookup(7).state).toBe("open");
    // A PR number is not an open issue.
    expect(lookup(50).state).toBe("closed");
  });

  it.each([
    ["a non-zero exit", { returncode: 1, stdout: "", stderr: "HTTP 502" }, "HTTP 502"],
    ["a silent non-zero exit", { returncode: 4, stdout: "", stderr: "" }, "gh api failed"],
    ["empty output", { returncode: 0, stdout: "  \n", stderr: "" }, "empty output"],
    ["non-JSON output", { returncode: 0, stdout: "not json", stderr: "" }, "non-JSON"],
    ["a non-array payload", { returncode: 0, stdout: '{"state":"open"}', stderr: "" }, "type"],
    [
      "a row without an issue number",
      { returncode: 0, stdout: JSON.stringify([[{ state: "open" }]]), stderr: "" },
      "row without an issue number",
    ],
  ])("fails every lookup closed on %s", (_label, result, detail) => {
    const { fn, calls } = runner(result);
    const lookup = createOriginIssueStateLookup("deftai/directive", fn);
    for (const issue of [1, 2]) {
      const state = lookup(issue);
      expect(state.state).toBeNull();
      expect(state.error).toContain("open-issue list failed");
      expect(state.error).toContain(detail);
    }
    expect(calls).toHaveLength(1);
  });

  it("fails closed when the list runner throws", () => {
    const lookup = createOriginIssueStateLookup("deftai/directive", () => {
      throw new Error("spawn EPERM");
    });
    expect(lookup(1)).toEqual({
      state: null,
      protectedUmbrella: false,
      error: "open-issue list failed: Error: spawn EPERM",
    });
  });

  it("prefers an injected list runner over the gh seam in discover", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-5927-runner-"));
    writeTipBrief(root, "xbrief/completed/story-a.xbrief.json", 77, { productPullRequest: 770 });
    const body = readFileSync(join(root, "xbrief/completed/story-a.xbrief.json"), "utf8");
    const ghCalls: string[] = [];
    const listCalls: string[][] = [];
    const inventory = discoverFinalizeOwed(root, {
      repo: "deftai/directive",
      deliveryBranch: "master",
      tip: "TIP",
      runGit: (_projectRoot, args) => {
        if (args[0] === "ls-tree") {
          const wanted = args
            .slice(args.indexOf("--") + 1)
            .some((p) => String(p).endsWith("completed"));
          return {
            code: 0,
            stdout: wanted ? "xbrief/completed/story-a.xbrief.json" : "",
            stderr: "",
          };
        }
        if (args[0] === "show") {
          return { code: 0, stdout: body, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      runGh: (cmd) => {
        ghCalls.push(cmd.join(" "));
        return { returncode: 0, stdout: "[]", stderr: "" };
      },
      runGhApi: (args) => {
        listCalls.push([...args]);
        return openIssueList([77]);
      },
    });
    expect(listCalls).toHaveLength(2);
    expect(ghCalls.some((c) => isOpenIssueList(c))).toBe(false);
    expect(inventory.stories.map((s) => s.state)).toEqual(["close-owed"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed on an invalid repo without listing", () => {
    const { fn, calls } = runner(openIssueList([1]));
    const lookup = createOriginIssueStateLookup("not-a-repo", fn);
    expect(lookup(1)).toEqual({
      state: null,
      protectedUmbrella: false,
      error: "invalid repo: not-a-repo",
    });
    expect(calls).toHaveLength(0);
  });

  it("adapts an injected gh seam to the list runner argv", () => {
    const seen: string[][] = [];
    const fn = runGhApiFromRunGh((cmd) => {
      seen.push([...cmd]);
      return { returncode: 0, stdout: "[[]]", stderr: "" };
    });
    expect(fn(["--paginate", "x"])).toEqual({ returncode: 0, stdout: "[[]]", stderr: "" });
    expect(seen).toEqual([["gh", "api", "--paginate", "x"]]);
  });
});
