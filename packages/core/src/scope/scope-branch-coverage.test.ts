import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  append,
  canonicalLogPath,
  findByPath,
  latestForPath,
  newDecisionId,
  readAll,
  ScopeAuditLogError,
} from "./audit-log.js";
import { stampCompletionMetadata } from "./capacity-stamp.js";
import {
  detectLifecycleFolder,
  updateDecomposedChildBackReferences,
  updateDecomposedParentBackReferences,
} from "./decomposed-refs.js";
import {
  batchDemote,
  demoteOne,
  resolveDemoteFilePath,
  resolveFilePath,
  resolveProjectRootStrict,
} from "./demote.js";
import { demoteMain, lifecycleMain, undoMain } from "./main.js";
import { resolveProjectRoot } from "./project-context.js";
import { syncProjectDefinitionAfterScopeMove } from "./project-definition-sync.js";
import { recordWipCapOverride, runTransition } from "./transition.js";
import { findByBatchId, findByDecisionId, isAlreadyUndone, undoBatch, undoOne } from "./undo.js";
import { formatVbriefJson } from "./vbrief-json.js";

function writeVbrief(
  dir: string,
  name: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    formatVbriefJson({ plan: { title: "T", status, items: [], ...extra } }),
  );
}

describe("scope branch coverage", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
    vi.unstubAllEnvs();
    delete process.env.DEFT_PROJECT_ROOT;
  });

  it("audit-log validates all demote_meta and required fields", () => {
    root = mkdtempSync(join(tmpdir(), "audit-br-"));
    const logPath = canonicalLogPath(root);
    expect(() => append({}, logPath)).toThrow(ScopeAuditLogError);
    expect(() => readAll("")).toThrow(ScopeAuditLogError);
    expect(() => append({}, "")).toThrow(ScopeAuditLogError);

    const base = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-17T21:05:00Z",
      action: "demote",
      vbrief_path: "vbrief/proposed/x.vbrief.json",
      from_status: "pending",
      to_status: "proposed",
      actor: "operator",
    };
    expect(() => append({ ...base, decision_id: "bad" }, logPath)).toThrow(ScopeAuditLogError);
    expect(() => append({ ...base, timestamp: "not-iso" }, logPath)).toThrow(ScopeAuditLogError);
    expect(() => append({ ...base, action: "" }, logPath)).toThrow(ScopeAuditLogError);
    expect(() => append({ ...base, demote_meta: { was_promoted: "yes" } }, logPath)).toThrow(
      ScopeAuditLogError,
    );
    expect(() =>
      append(
        {
          ...base,
          demote_meta: {
            was_promoted: true,
            original_promotion_decision_id: "not-uuid",
            days_in_pending: -1,
            demote_reason: "",
            demoted_from: "",
          },
        },
        logPath,
      ),
    ).toThrow(ScopeAuditLogError);
    expect(() => append({ ...base, action: "demote" }, logPath)).toThrow(ScopeAuditLogError);
    expect(latestForPath("missing", "promote", logPath)).toBeNull();
    expect(findByPath("none", logPath)).toEqual([]);
  });

  it("capacity-stamp reads default bucket and handles invalid shapes", () => {
    root = mkdtempSync(join(tmpdir(), "cap-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{", "utf8");
    const plan: Record<string, unknown> = { status: "running" };
    stampCompletionMetadata(plan, root, "2026-06-01T00:00:00Z");
    expect(plan.metadata).toBeTruthy();

    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      formatVbriefJson({
        plan: { policy: { capacityAllocation: { defaultBucket: "core" } } },
      }),
    );
    stampCompletionMetadata(plan, root, "2026-06-01T00:00:00Z");
    expect((plan.metadata as Record<string, unknown>).capacityBucket).toBe("core");

    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      formatVbriefJson({ plan: { policy: { capacityAllocation: { defaultBucket: 1 } } } }),
    );
    const plan2: Record<string, unknown> = {
      metadata: { capacityBucket: "  kept  " },
    };
    stampCompletionMetadata(plan2, root, "2026-06-01T00:00:00Z");
    expect((plan2.metadata as Record<string, unknown>).capacityBucket).toBe("  kept  ");

    const plan3: Record<string, unknown> = { metadata: [] };
    stampCompletionMetadata(plan3, root, "2026-06-01T00:00:00Z");
    expect(plan3.metadata).toBeTruthy();
  });

  it("transition covers error paths, no-ops, block/unblock, complete", () => {
    root = mkdtempSync(join(tmpdir(), "trans-"));
    expect(runTransition("bogus", "/x").ok).toBe(false);
    expect(runTransition("promote", join(root, "missing.vbrief.json")).ok).toBe(false);
    writeFileSync(join(root, "not-vbrief.json"), "{}", "utf8");
    expect(runTransition("promote", join(root, "not-vbrief.json")).ok).toBe(false);
    writeVbrief(root, "outside.vbrief.json", "proposed");
    expect(runTransition("promote", join(root, "outside.vbrief.json")).ok).toBe(false);

    const proposed = join(root, "vbrief", "proposed");
    writeVbrief(proposed, "bad.vbrief.json", "proposed");
    writeFileSync(join(proposed, "bad.vbrief.json"), "{", "utf8");
    expect(runTransition("promote", join(proposed, "bad.vbrief.json")).ok).toBe(false);

    writeVbrief(proposed, "wrong-folder.vbrief.json", "proposed");
    expect(runTransition("activate", join(proposed, "wrong-folder.vbrief.json")).ok).toBe(false);

    writeVbrief(proposed, "already.vbrief.json", "pending");
    expect(runTransition("promote", join(proposed, "already.vbrief.json")).ok).toBe(true);

    writeVbrief(join(root, "vbrief", "active"), "block.vbrief.json", "running");
    const activeFile = join(root, "vbrief", "active", "block.vbrief.json");
    expect(runTransition("block", activeFile).ok).toBe(true);
    expect(runTransition("block", activeFile).message).toContain("No-op");

    writeVbrief(join(root, "vbrief", "active"), "complete.vbrief.json", "running");
    const completeFile = join(root, "vbrief", "active", "complete.vbrief.json");
    expect(runTransition("complete", completeFile).ok).toBe(true);
    const completed = JSON.parse(
      readFileSync(join(root, "vbrief", "completed", "complete.vbrief.json"), "utf8"),
    );
    expect(completed.plan.metadata?.completedAt).toBeTruthy();

    recordWipCapOverride("/outside/file.vbrief.json", root, {
      allowed: true,
      forceOverride: true,
      cap: 10,
      count: 11,
      source: "typed",
    });
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    expect(readAll(canonicalLogPath(root)).length).toBeGreaterThanOrEqual(0);
  });

  it("lifecycleMain wip cap refusal and force override", () => {
    root = mkdtempSync(join(tmpdir(), "life-"));
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    for (let i = 0; i < 10; i += 1) {
      writeVbrief(join(root, "vbrief", "pending"), `p${i}.vbrief.json`, "pending");
    }
    writeVbrief(join(root, "vbrief", "proposed"), "new.vbrief.json", "proposed");
    const file = join(root, "vbrief", "proposed", "new.vbrief.json");
    expect(lifecycleMain(["promote", file, "--project-root", root])).toBe(1);
    expect(lifecycleMain(["promote", file, "--project-root", root, "--force"])).toBe(0);
    expect(lifecycleMain(["notreal", file, "--project-root", root])).toBe(2);
  });

  it("demote and resolve paths cover batch and validation branches", () => {
    root = mkdtempSync(join(tmpdir(), "dem-"));
    expect(resolveFilePath("", null)[1]).toContain("No vBRIEF");
    expect(resolveFilePath("rel.vbrief.json", "/nonexistent-xyz")[1]).toContain("Cannot resolve");
    expect(resolveDemoteFilePath("", null)[1]).toContain("scope_demote");
    expect(resolveProjectRootStrict("/nonexistent-xyz")[1]).toContain("Cannot determine");

    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeVbrief(join(root, "vbrief", "pending"), "old.vbrief.json", "pending", {
      updated: "2020-01-01T00:00:00Z",
    });
    const pending = join(root, "vbrief", "pending", "old.vbrief.json");
    expect(demoteOne(pending, root, "test").ok).toBe(true);
    expect(demoteOne(pending, root, "test").ok).toBe(false);
    expect(demoteOne(join(root, "vbrief", "proposed", "x.vbrief.json"), root, "x").ok).toBe(false);

    expect(batchDemote(root, 9999)[0]).toBe(0);
    expect(() => batchDemote(root, -1)).toThrow();
    writeFileSync(join(root, "vbrief", "pending", "broken.vbrief.json"), "{", "utf8");
    const [, , skipped] = batchDemote(root, 0);
    expect(skipped.some((s) => s.includes("broken"))).toBe(true);

    expect(demoteMain(["--batch", "--older-than-days=0", "--project-root", root])).toBe(0);
    expect(demoteMain(["--project-root", root])).toBe(2);
  });

  it("undo covers restore, cancel meta, terminal refusal, dry-run, batch", () => {
    root = mkdtempSync(join(tmpdir(), "undo-br-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    const logPath = canonicalLogPath(root);

    expect(undoOne({ action: "complete", decision_id: "x" }, root, { logPath }).ok).toBe(false);
    expect(undoOne({ action: "weird", decision_id: "x" }, root, { logPath }).ok).toBe(false);

    const restoreId = newDecisionId();
    append(
      {
        decision_id: restoreId,
        timestamp: "2026-05-18T20:00:00Z",
        action: "restore",
        vbrief_path: "vbrief/cancelled/r.vbrief.json",
        from_status: "cancelled",
        to_status: "proposed",
        actor: "operator",
      },
      logPath,
    );
    mkdirSync(join(root, "vbrief", "cancelled"), { recursive: true });
    writeVbrief(join(root, "vbrief", "cancelled"), "r.vbrief.json", "cancelled");
    const restoreEntry = findByDecisionId(restoreId, readAll(logPath));
    expect(restoreEntry).not.toBeNull();
    expect(undoOne(restoreEntry as Record<string, unknown>, root, { logPath }).ok).toBe(true);

    const cancelId = newDecisionId();
    append(
      {
        decision_id: cancelId,
        timestamp: "2026-05-18T21:00:00Z",
        action: "cancel",
        vbrief_path: "vbrief/cancelled/c.vbrief.json",
        from_status: "running",
        to_status: "cancelled",
        actor: "operator",
        cancel_meta: { cancelled_from: "active" },
      },
      logPath,
    );
    writeVbrief(join(root, "vbrief", "cancelled"), "c.vbrief.json", "cancelled");
    const cancelEntry = findByDecisionId(cancelId, readAll(logPath));
    expect(cancelEntry).not.toBeNull();
    expect(
      undoOne(cancelEntry as Record<string, unknown>, root, {
        logPath,
        dryRun: true,
      }).message,
    ).toContain("DRY-RUN");

    expect(isAlreadyUndone("none", [])).toBe(false);
    expect(findByBatchId("none", readAll(logPath))).toEqual([]);
    expect(undoMain(["--decision-id", "a", "--batch-id", "b", "--project-root", root])).toBe(2);
    expect(undoMain(["a", "--decision-id", "b", "--project-root", root])).toBe(2);
    expect(undoMain(["--latest", "--decision-id", "x", "--project-root", root])).toBe(2);
    expect(undoMain(["--project-root", root])).toBe(2);
    expect(undoMain(["missing-id", "--project-root", root])).toBe(1);
    expect(undoMain(["--batch-id", newDecisionId(), "--project-root", root])).toBe(1);
  });

  it("decomposed-refs and project-definition-sync cover remaining branches", () => {
    root = mkdtempSync(join(tmpdir(), "sync-"));
    const vbrief = join(root, "vbrief");
    expect(detectLifecycleFolder("/tmp/foo.vbrief.json")).toBeNull();
    expect(detectLifecycleFolder(join(vbrief, "active", "x.vbrief.json"))).toBe("active");
    expect(updateDecomposedParentBackReferences({}, "a", "b", vbrief)).toEqual([]);
    expect(updateDecomposedChildBackReferences({ plan: [] }, "a", "b", vbrief)).toEqual([]);

    mkdirSync(join(vbrief, "active"), { recursive: true });
    const parent = join(vbrief, "active", "parent.vbrief.json");
    writeFileSync(
      parent,
      formatVbriefJson({
        plan: {
          references: [
            { type: "other", uri: "x" },
            { type: "x-vbrief/plan", uri: "active/child.vbrief.json" },
          ],
        },
      }),
    );
    const childData = {
      plan: {
        planRef: "active/parent.vbrief.json",
        items: [{ planRef: "active/parent.vbrief.json" }],
      },
    };
    updateDecomposedParentBackReferences(
      childData,
      join(vbrief, "pending", "child.vbrief.json"),
      join(vbrief, "active", "child.vbrief.json"),
      vbrief,
    );

    mkdirSync(join(vbrief, "completed"), { recursive: true });
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
      formatVbriefJson({
        plan: {
          title: "Proj",
          items: [
            {
              id: "2026-04-12-add-oauth",
              title: "Add OAuth support",
              status: "running",
              references: [{ type: "x-vbrief/plan", uri: "file://active/oauth.vbrief.json" }],
              metadata: { source_path: "active/oauth.vbrief.json" },
            },
          ],
          references: [{ type: "x-vbrief/plan", uri: "active/oauth.vbrief.json" }],
        },
      }),
    );
    const oauth = join(vbrief, "active", "oauth.vbrief.json");
    writeFileSync(
      oauth,
      formatVbriefJson({ plan: { title: "Add OAuth support", status: "running", items: [] } }),
    );
    syncProjectDefinitionAfterScopeMove(
      JSON.parse(readFileSync(oauth, "utf8")),
      oauth,
      join(vbrief, "completed", "oauth.vbrief.json"),
      vbrief,
      "completed",
    );
    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"));
    expect(pd.plan.items[0].status).toBe("completed");
    expect(pd.plan.references[0].uri).toContain("completed/");
  });

  it("project-context resolves cli root and env", () => {
    root = mkdtempSync(join(tmpdir(), "ctx-"));
    mkdirSync(join(root, "vbrief"));
    expect(resolveProjectRoot(root)).toBe(root);
    expect(resolveProjectRoot("/nonexistent-deft-path-abc")).toBeNull();
    vi.stubEnv("DEFT_PROJECT_ROOT", root);
    expect(resolveProjectRoot(null)).toBe(root);
  });

  it("undoBatch records failures in skipped", () => {
    root = mkdtempSync(join(tmpdir(), "undo-fail-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const batchId = newDecisionId();
    append(
      {
        decision_id: newDecisionId(),
        timestamp: "2026-05-18T19:00:00Z",
        action: "demote",
        vbrief_path: "vbrief/proposed/nope.vbrief.json",
        from_status: "pending",
        to_status: "proposed",
        actor: "operator",
        demote_meta: {
          was_promoted: true,
          original_promotion_decision_id: null,
          days_in_pending: 0,
          demote_reason: "x",
          demoted_from: "pending",
          batch_id: batchId,
        },
      },
      logPath,
    );
    const [, , skipped] = undoBatch(batchId, root, { logPath });
    expect(skipped.some((s) => s.includes("File not found"))).toBe(true);
  });

  it("undoMain missing log and undo failure paths", () => {
    root = mkdtempSync(join(tmpdir(), "undo-main-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    expect(undoMain(["--latest", "--project-root", root])).toBe(1);

    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    const logPath = canonicalLogPath(root);
    writeFileSync(logPath, "", "utf8");
    const demoteId = newDecisionId();
    append(
      {
        decision_id: demoteId,
        timestamp: "2026-05-18T19:00:00Z",
        action: "demote",
        vbrief_path: "vbrief/proposed/missing.vbrief.json",
        from_status: "pending",
        to_status: "proposed",
        actor: "operator",
        demote_meta: {
          was_promoted: true,
          original_promotion_decision_id: null,
          days_in_pending: 0,
          demote_reason: "x",
          demoted_from: "pending",
        },
      },
      logPath,
    );
    expect(undoMain([demoteId, "--project-root", root])).toBe(1);
  });

  it("lifecycleMain reports resolve errors", () => {
    expect(
      lifecycleMain(["promote", "rel.vbrief.json", "--project-root", "/nonexistent-deft-root-xyz"]),
    ).toBe(2);
  });

  it("scope cli entry executes lifecycleMain", () => {
    root = mkdtempSync(join(tmpdir(), "cli-"));
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeVbrief(join(root, "vbrief", "proposed"), "cli.vbrief.json", "proposed");
    const cliPath = join(process.cwd(), "packages", "core", "dist", "scope", "cli.js");
    const file = join(root, "vbrief", "proposed", "cli.vbrief.json");
    const r = spawnSync("node", [cliPath, "promote", file, "--project-root", root], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(root, "vbrief", "pending", "cli.vbrief.json"))).toBe(true);
  });
});
