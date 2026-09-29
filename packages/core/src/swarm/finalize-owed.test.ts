import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_INCOMPLETE, EXIT_OK } from "./constants.js";
import {
  discoverFinalizeOwed,
  finalizeOwed,
  formatFinalizeOwedInventoryLines,
  inventoryHasBlockingOwed,
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
      if (joined.includes("/issues/")) {
        return { returncode: 0, stdout: JSON.stringify({ state: "open", labels: [] }), stderr: "" };
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
        if (joined.includes("/issues/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ state: "open", labels: [] }),
            stderr: "",
          };
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
        return { code: 0, stdout: "deadbeef refs/heads/swarm/finalize/5100-4919\n", stderr: "" };
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
        if (joined.includes("/issues/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ state: "open", labels: [] }),
            stderr: "",
          };
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
        return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/x\n", stderr: "" };
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
        if (joined.includes("/issues/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ state: "open", labels: [] }),
            stderr: "",
          };
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
        if (joined.includes("/issues/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ state: "open", labels: [] }),
            stderr: "",
          };
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

  it("does not mark live claims stale on transient fetch/auth failure (#4919)", () => {
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
        return { code: 0, stdout: "deadbeef refs/heads/swarm/finalize/5100-4919\n", stderr: "" };
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
        if (joined.includes("/issues/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ state: "open", labels: [] }),
            stderr: "",
          };
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(inventory.stories.some((s) => s.state === "in-flight")).toBe(true);
    expect(inventory.stories.some((s) => s.state === "stale")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps claims live on unknown fetch failure (not reclaim) (#4919)", () => {
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
        return { code: 0, stdout: "deadbeef refs/heads/swarm/finalize/5100-4919\n", stderr: "" };
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
        if (joined.includes("/issues/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ state: "open", labels: [] }),
            stderr: "",
          };
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(inventory.stories.some((s) => s.state === "in-flight")).toBe(true);
    expect(inventory.stories.some((s) => s.state === "stale")).toBe(false);
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
        return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/5100-4919\n", stderr: "" };
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
        if (joined.includes("/issues/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ state: "closed", labels: [] }),
            stderr: "",
          };
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
        return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/5100-4919\n", stderr: "" };
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
        if (joined.includes("/issues/")) {
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
        return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/5100-4919\n", stderr: "" };
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
        if (joined.includes("/issues/")) {
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
        return { code: 0, stdout: "claimsha refs/heads/swarm/finalize/5100-4919\n", stderr: "" };
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
        if (joined.includes("/issues/")) {
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
        if (joined.includes("/issues/635")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              state: "open",
              labels: [{ name: "epic" }, { name: "status:tracker" }],
            }),
            stderr: "",
          };
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
        if (joined.includes("/issues/635")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              state: "open",
              labels: [{ name: "epic" }, { name: "status:tracker" }],
            }),
            stderr: "",
          };
        }
        return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
      },
    });
    // Active unmarked would admit, but staying-open labels skip owed (#5143 item 2).
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
        if (joined.includes("/issues/635")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              state: "open",
              labels: [{ name: "epic" }, { name: "status:tracker" }],
            }),
            stderr: "",
          };
        }
        return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
      },
    });
    const owed = inventory.stories.filter((s) => s.blocks);
    expect(owed.length).toBeGreaterThan(0);
    expect(owed.some((s) => s.issue === 635 && s.productPr === 401)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("still blocks true unmarked active Tracking leftovers with open non-protected origin", () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-owed-5143-true-leftover-"));
    const rel = "xbrief/active/stuck-unmarked.xbrief.json";
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, rel),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "true-unmarked-leftover",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/6",
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
        if (joined.includes("/pulls/7")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              merged_at: "2026-09-01T00:00:00Z",
              merge_commit_sha: "deadbeef",
              base: { ref: "master" },
            }),
            stderr: "",
          };
        }
        if (joined.includes("/issues/6")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ state: "open", labels: [] }),
            stderr: "",
          };
        }
        return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
      },
    });
    const owed = inventory.stories.filter((s) => s.state === "owed");
    expect(owed).toHaveLength(1);
    expect(owed[0]?.blocks).toBe(true);
    expect(owed[0]?.detail).toContain("unmarked compose");
    expect(inventoryHasBlockingOwed(inventory)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
