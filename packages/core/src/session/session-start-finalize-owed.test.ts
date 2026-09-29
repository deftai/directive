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
  it("skips tip fetch when --defer-owed is set (#5145 Prefer-A)", () => {
    let fetchCalls = 0;
    const result = evaluateFinalizeOwedSessionGate("/tmp/proj", {
      deferOwedReason: "cohort-add",
      runGit: () => {
        fetchCalls += 1;
        return { code: 0, stdout: "TIP\n", stderr: "" };
      },
      env: { GH_REPO: "deftai/directive" },
    });
    expect(result.blocks).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.deferReason).toBe("cohort-add");
    expect(result.lines.join("\n")).toContain("deferred");
    // Live path must not thrash tip/network under defer (spy via runGit never called).
    expect(fetchCalls).toBe(0);
  });

  it("linked worktree Prefer-A when primary already deferred (#5145 dest-default)", () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const primary = mkdtempSync(join(tmpdir(), "pd-primary-"));
    const dest = mkdtempSync(join(tmpdir(), "pd-dest-"));
    try {
      mkdirSync(join(primary, ".deft"), { recursive: true });
      const nowIso = new Date().toISOString();
      writeFileSync(
        join(primary, ".deft", "ritual-state.json"),
        JSON.stringify({
          schemaVersion: 1,
          contract: "session-ritual-state",
          session_id: "host:test:primary",
          git_head: "abc",
          worktree_path: primary,
          started_at: nowIso,
          quick_steps: {},
          gated_steps: {},
          finalize_owed: {
            ok: true,
            ts: nowIso,
            deferred_reason: "cohort-add",
            message: "finalize owed deferred: cohort-add",
          },
        }),
        "utf8",
      );
      let fetchCalls = 0;
      const result = evaluateFinalizeOwedSessionGate(dest, {
        isLinkedWorktree: () => true,
        runGit: (_cwd, args) => {
          if (args.includes("--git-common-dir")) {
            return { code: 0, stdout: `${join(primary, ".git")}\n`, stderr: "" };
          }
          if (args[0] === "rev-parse" && args.includes("HEAD")) {
            return { code: 0, stdout: "abc\n", stderr: "" };
          }
          fetchCalls += 1;
          return { code: 0, stdout: "TIP\n", stderr: "" };
        },
        env: { GH_REPO: "deftai/directive" },
      });
      expect(result.blocks).toBe(false);
      expect(result.deferred).toBe(true);
      expect(result.deferReason).toBe("primary:cohort-add");
      expect(fetchCalls).toBe(0);
    } finally {
      rmSync(primary, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("refuses inherit when sessionRitualStalenessHours is invalid", () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const primary = mkdtempSync(join(tmpdir(), "pd-bad-policy-"));
    const dest = mkdtempSync(join(tmpdir(), "pd-dest-bad-policy-"));
    try {
      mkdirSync(join(primary, ".deft"), { recursive: true });
      mkdirSync(join(primary, "xbrief"), { recursive: true });
      writeFileSync(
        join(primary, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "bad-policy",
            status: "running",
            narratives: { Overview: "O", TechStack: "T" },
            items: [],
            policy: { sessionRitualStalenessHours: 0 },
          },
        }),
        "utf8",
      );
      const nowIso = new Date().toISOString();
      writeFileSync(
        join(primary, ".deft", "ritual-state.json"),
        JSON.stringify({
          schemaVersion: 1,
          contract: "session-ritual-state",
          session_id: "host:test:primary",
          git_head: "abc",
          worktree_path: primary,
          started_at: nowIso,
          quick_steps: {},
          gated_steps: {},
          finalize_owed: {
            ok: true,
            ts: nowIso,
            deferred_reason: "cohort-add",
            message: "finalize owed deferred: cohort-add",
          },
        }),
        "utf8",
      );
      const result = evaluateFinalizeOwedSessionGate(dest, {
        isLinkedWorktree: () => true,
        runGit: (_cwd, args) => {
          if (args.includes("--git-common-dir")) {
            return { code: 0, stdout: `${join(primary, ".git")}\n`, stderr: "" };
          }
          if (args[0] === "rev-parse" && args.includes("HEAD")) {
            return { code: 0, stdout: "abc\n", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        probeFinalizeOwed: () => ({
          lines: ["finalize owed inventory:", "  #4919 owed [blocks]"],
          blocks: true,
          unknown: false,
        }),
      });
      expect(result.blocks).toBe(true);
      expect(result.deferred).toBe(false);
    } finally {
      rmSync(primary, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("linked worktree refuses stale primary finalize_owed inherit", () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const primary = mkdtempSync(join(tmpdir(), "pd-stale-"));
    const dest = mkdtempSync(join(tmpdir(), "pd-dest-stale-"));
    try {
      mkdirSync(join(primary, ".deft"), { recursive: true });
      writeFileSync(
        join(primary, ".deft", "ritual-state.json"),
        JSON.stringify({
          schemaVersion: 1,
          contract: "session-ritual-state",
          session_id: "host:test:primary",
          git_head: "old",
          worktree_path: primary,
          started_at: "2020-01-01T00:00:00Z",
          quick_steps: {},
          gated_steps: {},
          finalize_owed: {
            ok: true,
            ts: "2020-01-01T00:00:00Z",
            deferred_reason: "cohort-add",
            message: "finalize owed deferred: cohort-add",
          },
        }),
        "utf8",
      );
      const result = evaluateFinalizeOwedSessionGate(dest, {
        isLinkedWorktree: () => true,
        runGit: (_cwd, args) => {
          if (args.includes("--git-common-dir")) {
            return { code: 0, stdout: `${join(primary, ".git")}\n`, stderr: "" };
          }
          if (args[0] === "rev-parse" && args.includes("HEAD")) {
            return { code: 0, stdout: "new\n", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        probeFinalizeOwed: () => ({
          lines: ["finalize owed inventory:", "  #4919 owed [blocks]"],
          blocks: true,
          unknown: false,
        }),
      });
      expect(result.blocks).toBe(true);
      expect(result.deferred).toBe(false);
    } finally {
      rmSync(primary, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("linked worktree without primary finalize_owed still probes", () => {
    const result = evaluateFinalizeOwedSessionGate("/tmp/dest-alone", {
      isLinkedWorktree: () => true,
      runGit: () => ({ code: 1, stdout: "", stderr: "no common" }),
      probeFinalizeOwed: () => ({
        lines: ["finalize owed inventory:", "  #4919 owed [blocks]"],
        blocks: true,
        unknown: false,
      }),
    });
    expect(result.blocks).toBe(true);
    expect(result.deferred).toBe(false);
  });
});
