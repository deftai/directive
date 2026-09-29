import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverFinalizeOwed,
  formatFinalizeOwedInventoryLines,
  inventoryHasBlockingOwed,
} from "../swarm/finalize-owed.js";
import { evaluateFinalizeOwedSessionGate } from "./session-start.js";

describe("evaluateFinalizeOwedSessionGate (#4919)", () => {
  it("prints inventory and blocks when probe reports blocking owed", () => {
    const result = evaluateFinalizeOwedSessionGate("/tmp/proj", {
      probeFinalizeOwed: () => ({
        lines: ["finalize owed inventory:", "  #4919 owed [blocks] pr=#5100 xbrief/active/a.json"],
        blocks: true,
        unknown: false,
      }),
    });
    expect(result.blocks).toBe(true);
    expect(result.lines.join("\n")).toContain("4919");
  });

  it("does not block when --defer-owed reason is recorded", () => {
    const result = evaluateFinalizeOwedSessionGate("/tmp/proj", {
      deferOwedReason: "finishing unrelated hotfix",
      probeFinalizeOwed: () => ({
        lines: ["finalize owed inventory:", "  #4919 owed [blocks]"],
        blocks: true,
        unknown: false,
      }),
    });
    expect(result.blocks).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.deferReason).toBe("finishing unrelated hotfix");
    expect(result.lines.join("\n")).toContain("deferred");
  });

  it("records unknown without blocking on failed fetch probe", () => {
    const result = evaluateFinalizeOwedSessionGate("/tmp/proj", {
      probeFinalizeOwed: () => ({
        lines: ["finalize owed: unknown"],
        blocks: false,
        unknown: true,
      }),
    });
    expect(result.unknown).toBe(true);
    expect(result.blocks).toBe(false);
  });

  it("fails closed when tip fetch works but repo cannot be resolved", () => {
    const result = evaluateFinalizeOwedSessionGate("/tmp/proj", {
      env: {},
      runGit: (_cwd, args) => {
        if (args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          return { code: 0, stdout: "TIPSHA\n", stderr: "" };
        }
        if (args[0] === "remote") {
          return { code: 1, stdout: "", stderr: "no remote" };
        }
        if (args[0] === "symbolic-ref" || args.includes("--abbrev-ref")) {
          return { code: 0, stdout: "master\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.blocks).toBe(true);
    expect(result.unknown).toBe(true);
    expect(result.lines.join("\n")).toContain("repo required");
  });

  it("does not block on #635/#401 proposed historical cite without --defer-owed (#5143)", () => {
    const root = mkdtempSync(join(tmpdir(), "session-owed-5143-"));
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
      },
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
    expect(inventoryHasBlockingOwed(inventory)).toBe(false);
    const result = evaluateFinalizeOwedSessionGate(root, {
      probeFinalizeOwed: () => ({
        lines: formatFinalizeOwedInventoryLines(inventory),
        blocks: inventoryHasBlockingOwed(inventory),
        unknown: false,
      }),
    });
    expect(result.blocks).toBe(false);
    expect(result.deferred).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("still blocks true unmarked Tracking leftovers without --defer-owed (#5143)", () => {
    const result = evaluateFinalizeOwedSessionGate("/tmp/proj", {
      probeFinalizeOwed: () => ({
        lines: [
          "finalize owed inventory:",
          "  #6 owed [blocks] pr=#7 xbrief/active/stuck-unmarked.xbrief.json",
        ],
        blocks: true,
        unknown: false,
      }),
    });
    expect(result.blocks).toBe(true);
    expect(result.deferred).toBe(false);
    expect(result.lines.join("\n")).toContain("blocks mutation");
  });
});
