import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_OK } from "./constants.js";
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
