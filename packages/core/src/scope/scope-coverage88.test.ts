import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { append, canonicalLogPath, newDecisionId, readAll } from "./audit-log.js";
import {
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
import { recordWipCapOverride, runTransition } from "./transition.js";
import { findByBatchId, undoBatch, undoOne } from "./undo.js";
import { formatVbriefJson } from "./vbrief-json.js";

describe("scope coverage ≥88% buffer", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
    vi.unstubAllEnvs();
    delete process.env.DEFT_PROJECT_ROOT;
  });

  describe("decomposed-refs", () => {
    it("updates parent references on child move and dedupes planRefs", () => {
      root = mkdtempSync(join(tmpdir(), "decomp88-"));
      const vbrief = join(root, "vbrief");
      mkdirSync(join(vbrief, "pending"), { recursive: true });
      mkdirSync(join(vbrief, "active"), { recursive: true });
      const parent = join(vbrief, "pending", "parent.vbrief.json");
      writeFileSync(
        parent,
        formatVbriefJson({
          plan: {
            references: [{ type: "x-vbrief/plan", uri: "file://pending/child.vbrief.json" }],
          },
        }),
      );
      const childPath = join(vbrief, "pending", "child.vbrief.json");
      writeFileSync(
        childPath,
        formatVbriefJson({
          plan: {
            planRef: "pending/parent.vbrief.json",
            items: [{ planRef: "pending/parent.vbrief.json" }],
          },
        }),
      );
      const childData = JSON.parse(readFileSync(childPath, "utf8")) as Record<string, unknown>;
      const newChild = join(vbrief, "active", "child.vbrief.json");
      writeFileSync(newChild, readFileSync(childPath));
      rmSync(childPath);
      const childPlan = childData.plan as Record<string, unknown>;
      childPlan.planRef = "pending/parent.vbrief.json";
      childPlan.items = [
        { planRef: "pending/parent.vbrief.json" },
        { planRef: "pending/parent.vbrief.json" },
      ];
      const updated = updateDecomposedParentBackReferences(childData, childPath, newChild, vbrief);
      expect(updated).toContain(parent);
      expect(JSON.parse(readFileSync(parent, "utf8")).plan.references[0].uri).toContain("active/");
    });

    it("skips malformed parent and child files gracefully", () => {
      root = mkdtempSync(join(tmpdir(), "decomp-skip-"));
      const vbrief = join(root, "vbrief");
      mkdirSync(join(vbrief, "active"), { recursive: true });
      writeFileSync(join(vbrief, "active", "bad-parent.vbrief.json"), "{", "utf8");
      writeFileSync(
        join(vbrief, "active", "no-refs.vbrief.json"),
        formatVbriefJson({ plan: { items: [] } }),
      );
      writeFileSync(join(vbrief, "active", "bad-child.vbrief.json"), "{", "utf8");
      const parentData = {
        plan: {
          references: [
            { type: "x-vbrief/plan", uri: "active/bad-child.vbrief.json" },
            { type: "x-vbrief/plan", uri: "active/missing.vbrief.json" },
          ],
        },
      };
      expect(
        updateDecomposedChildBackReferences(
          parentData,
          join(vbrief, "pending", "p.vbrief.json"),
          join(vbrief, "active", "p.vbrief.json"),
          vbrief,
        ),
      ).toEqual([]);
      expect(
        updateDecomposedParentBackReferences(
          { plan: { planRef: "active/bad-parent.vbrief.json" } },
          join(vbrief, "active", "c.vbrief.json"),
          join(vbrief, "completed", "c.vbrief.json"),
          vbrief,
        ),
      ).toEqual([]);
    });
  });

  describe("demote", () => {
    it("covers validation errors and mtime-based days_in_pending", () => {
      root = mkdtempSync(join(tmpdir(), "demote88-"));
      mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
      expect(demoteOne(join(root, "missing.vbrief.json"), root, "x").ok).toBe(false);
      writeFileSync(join(root, "vbrief", "pending", "bad.txt"), "x", "utf8");
      expect(demoteOne(join(root, "vbrief", "pending", "bad.txt"), root, "x").ok).toBe(false);
      writeFileSync(join(root, "vbrief", "pending", "broken.vbrief.json"), "{", "utf8");
      expect(demoteOne(join(root, "vbrief", "pending", "broken.vbrief.json"), root, "x").ok).toBe(
        false,
      );
      writeFileSync(
        join(root, "vbrief", "pending", "noplan.vbrief.json"),
        formatVbriefJson({ plan: [] }),
      );
      expect(demoteOne(join(root, "vbrief", "pending", "noplan.vbrief.json"), root, "x").ok).toBe(
        false,
      );
      const mtimePath = join(root, "vbrief", "pending", "mtime.vbrief.json");
      writeFileSync(
        mtimePath,
        formatVbriefJson({
          plan: { title: "T", status: "pending", updated: "not-a-date", items: [] },
        }),
      );
      expect(demoteOne(mtimePath, root, "x", { now: new Date("2026-06-01T00:00:00Z") }).ok).toBe(
        true,
      );
    });

    it("records original promotion decision id when promote exists in log", () => {
      root = mkdtempSync(join(tmpdir(), "demote-promo-"));
      mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      const promoteId = newDecisionId();
      append(
        {
          decision_id: promoteId,
          timestamp: "2026-05-01T00:00:00Z",
          action: "promote",
          vbrief_path: "vbrief/pending/with-promo.vbrief.json",
          from_status: "proposed",
          to_status: "pending",
          actor: "operator",
        },
        logPath,
      );
      const pending = join(root, "vbrief", "pending", "with-promo.vbrief.json");
      writeFileSync(
        pending,
        formatVbriefJson({ plan: { title: "T", status: "pending", items: [] } }),
      );
      const result = demoteOne(pending, root, "relief", { logPath });
      expect(result.ok).toBe(true);
      const meta = (result.auditEntry as Record<string, unknown>).demote_meta as Record<
        string,
        unknown
      >;
      expect(meta.original_promotion_decision_id).toBe(promoteId);
    });

    it("batch demote skips young files and handles missing pending dir", () => {
      root = mkdtempSync(join(tmpdir(), "batch88-"));
      expect(batchDemote(root, 30)).toEqual([0, [], []]);
      mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
      writeFileSync(
        join(root, "vbrief", "pending", "young.vbrief.json"),
        formatVbriefJson({
          plan: { title: "T", status: "pending", updated: "2026-06-01T00:00:00Z", items: [] },
        }),
      );
      const [, , skipped] = batchDemote(root, 30, { now: new Date("2026-06-02T00:00:00Z") });
      expect(skipped[0]).toContain("young.vbrief.json");
    });

    it("resolveDemoteFilePath and resolveFilePath edge cases", () => {
      root = mkdtempSync(join(tmpdir(), "resolve88-"));
      mkdirSync(join(root, "vbrief"), { recursive: true });
      expect(resolveDemoteFilePath("", null)[1]).toContain("scope_demote");
      expect(resolveDemoteFilePath("/abs/x.vbrief.json", null)[0]).toContain("x.vbrief.json");
      expect(resolveFilePath("  rel.vbrief.json  ", root)[0]).toContain("rel.vbrief.json");
      expect(resolveProjectRootStrict("/nonexistent-root-xyz")[1]).toContain("Cannot determine");
    });
  });

  describe("main CLI entrypoints", () => {
    it("lifecycleMain rejects single-arg and invalid action", () => {
      expect(lifecycleMain(["promote"])).toBe(2);
      expect(lifecycleMain(["not-an-action", "/tmp/x.vbrief.json"])).toBe(2);
    });

    it("demoteMain covers batch errors and flag forms", () => {
      root = mkdtempSync(join(tmpdir(), "dem-main-"));
      mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
      expect(demoteMain(["--batch", "--project-root", "/missing-root-xyz"])).toBe(2);
      expect(
        demoteMain([
          "--batch",
          "--older-than-days",
          "0",
          "--project-root",
          root,
          "--reason",
          "custom",
        ]),
      ).toBe(0);
    });

    it("undoMain covers log missing, equals flags, dry-run, and failure paths", () => {
      root = mkdtempSync(join(tmpdir(), "undo-main88-"));
      mkdirSync(join(root, "vbrief"), { recursive: true });
      expect(undoMain(["--latest", "--project-root", root])).toBe(1);

      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      writeFileSync(canonicalLogPath(root), "", "utf8");
      const id = newDecisionId();
      append(
        {
          decision_id: id,
          timestamp: "2026-05-18T19:00:00Z",
          action: "demote",
          vbrief_path: "vbrief/proposed/ghost.vbrief.json",
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
        canonicalLogPath(root),
      );
      expect(undoMain([`--decision-id=${id}`, `--project-root=${root}`])).toBe(1);
      expect(undoMain([id, "--dry-run", "--project-root", root])).toBe(0);
    });

    it("undoMain --latest skips already-undone and picks next candidate", () => {
      root = mkdtempSync(join(tmpdir(), "undo-latest88-"));
      mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
      mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      for (const name of ["first.vbrief.json", "second.vbrief.json"]) {
        const pending = join(root, "vbrief", "pending", name);
        writeFileSync(
          pending,
          formatVbriefJson({ plan: { title: name, status: "pending", items: [] } }),
        );
        demoteOne(pending, root, "batch");
      }
      expect(undoMain(["--latest", "--project-root", root])).toBe(0);
      expect(undoMain(["--latest", "--project-root", root])).toBe(0);
      expect(undoMain(["--latest", "--project-root", root])).toBe(1);
    });

    it("undoMain single undo failure writes error", () => {
      root = mkdtempSync(join(tmpdir(), "undo-fail-main-"));
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      const id = newDecisionId();
      append(
        {
          decision_id: id,
          timestamp: "2026-05-18T19:00:00Z",
          action: "restore",
          vbrief_path: "vbrief/cancelled/nope.vbrief.json",
          from_status: "cancelled",
          to_status: "proposed",
          actor: "operator",
        },
        logPath,
      );
      expect(undoMain([id, "--project-root", root])).toBe(1);
    });

    it("undoMain --latest rejects empty decision_id candidate", () => {
      root = mkdtempSync(join(tmpdir(), "undo-empty-id-"));
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      writeFileSync(
        logPath,
        `${JSON.stringify({
          decision_id: "",
          timestamp: "2026-05-18T19:00:00Z",
          action: "demote",
          vbrief_path: "vbrief/proposed/x.vbrief.json",
          from_status: "pending",
          to_status: "proposed",
          actor: "operator",
        })}\n`,
        "utf8",
      );
      expect(undoMain(["--latest", "--project-root", root])).toBe(1);
    });
  });

  describe("undo inversePlan branches", () => {
    it("undoes cancel from varied cancelled_from statuses", () => {
      root = mkdtempSync(join(tmpdir(), "undo-cancel88-"));
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      const cases = [
        { folder: "active", status: "running", from: "running" },
        { folder: "active", status: "blocked", from: "blocked" },
        { folder: "completed", status: "failed", from: "failed" },
      ] as const;
      for (const c of cases) {
        mkdirSync(join(root, "vbrief", "cancelled"), { recursive: true });
        const name = `${c.from}.vbrief.json`;
        writeFileSync(
          join(root, "vbrief", "cancelled", name),
          formatVbriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
        );
        const entry = {
          decision_id: newDecisionId(),
          timestamp: "2026-05-18T20:00:00Z",
          action: "cancel",
          vbrief_path: `vbrief/cancelled/${name}`,
          from_status: c.from,
          to_status: "cancelled",
          actor: "operator",
          cancel_meta: { cancelled_from: c.from },
        };
        append(entry, logPath);
        expect(undoOne(entry, root, { logPath }).ok).toBe(true);
        expect(existsSync(join(root, "vbrief", c.folder, name))).toBe(true);
      }
    });

    it("findByBatchId matches top-level batch_id and batch undo dry-run previews", () => {
      root = mkdtempSync(join(tmpdir(), "undo-batch-prev-"));
      mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
      mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      const batchId = newDecisionId();
      const entry = {
        decision_id: newDecisionId(),
        timestamp: "2026-05-18T19:00:00Z",
        action: "demote",
        vbrief_path: "vbrief/proposed/batch.vbrief.json",
        from_status: "pending",
        to_status: "proposed",
        actor: "operator",
        batch_id: batchId,
        demote_meta: {
          was_promoted: true,
          original_promotion_decision_id: null,
          days_in_pending: 0,
          demote_reason: "x",
          demoted_from: "pending",
        },
      };
      append(entry, logPath);
      writeFileSync(
        join(root, "vbrief", "proposed", "batch.vbrief.json"),
        formatVbriefJson({ plan: { title: "T", status: "proposed", items: [] } }),
      );
      expect(findByBatchId(batchId, readAll(logPath))).toHaveLength(1);
      const [, , , previews] = undoBatch(batchId, root, { logPath, dryRun: true });
      expect(previews.length).toBeGreaterThan(0);
      const [undone] = undoBatch(batchId, root, { logPath });
      expect(undone).toBe(1);
    });

    it("refuses undo when inverse metadata is missing", () => {
      root = mkdtempSync(join(tmpdir(), "undo-meta88-"));
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      expect(
        undoOne(
          {
            decision_id: newDecisionId(),
            action: "cancel",
            vbrief_path: "vbrief/cancelled/x.vbrief.json",
          },
          root,
          { logPath },
        ).ok,
      ).toBe(false);
      expect(
        undoOne(
          {
            decision_id: newDecisionId(),
            action: "undo",
            vbrief_path: "vbrief/pending/x.vbrief.json",
            undo_meta: { original_decision_id: newDecisionId() },
          },
          root,
          { logPath },
        ).ok,
      ).toBe(false);
    });

    it("undoes undo-of-restore and undo-of-cancel chains", () => {
      root = mkdtempSync(join(tmpdir(), "undo-chain88-"));
      mkdirSync(join(root, "vbrief", "cancelled"), { recursive: true });
      mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      const restoreId = newDecisionId();
      append(
        {
          decision_id: restoreId,
          timestamp: "2026-05-18T19:00:00Z",
          action: "restore",
          vbrief_path: "vbrief/cancelled/chain.vbrief.json",
          from_status: "cancelled",
          to_status: "proposed",
          actor: "operator",
        },
        logPath,
      );
      writeFileSync(
        join(root, "vbrief", "cancelled", "chain.vbrief.json"),
        formatVbriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
      );
      const restoreEntry = readAll(logPath)[0] as Record<string, unknown>;
      undoOne(restoreEntry, root, { logPath });
      const undoEntry = readAll(logPath).find((e) => e.action === "undo") as Record<
        string,
        unknown
      >;
      expect(undoOne(undoEntry, root, { logPath, logEntries: readAll(logPath) }).ok).toBe(true);

      const cancelId = newDecisionId();
      append(
        {
          decision_id: cancelId,
          timestamp: "2026-05-18T21:00:00Z",
          action: "cancel",
          vbrief_path: "vbrief/cancelled/c2.vbrief.json",
          from_status: "pending",
          to_status: "cancelled",
          actor: "operator",
        },
        logPath,
      );
      writeFileSync(
        join(root, "vbrief", "cancelled", "c2.vbrief.json"),
        formatVbriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
      );
      const cancelEntry = readAll(logPath).find((e) => e.decision_id === cancelId) as Record<
        string,
        unknown
      >;
      undoOne(cancelEntry, root, { logPath, logEntries: readAll(logPath) });
      const undoCancel = readAll(logPath).find(
        (e) =>
          e.action === "undo" &&
          (e.undo_meta as Record<string, unknown>)?.original_action === "cancel",
      ) as Record<string, unknown>;
      expect(undoOne(undoCancel, root, { logPath, logEntries: readAll(logPath) }).ok).toBe(true);
    });

    it("findByBatchId resolves batch_id nested in demote_meta", () => {
      root = mkdtempSync(join(tmpdir(), "undo-meta-batch-"));
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      const batchId = newDecisionId();
      append(
        {
          decision_id: newDecisionId(),
          timestamp: "2026-05-18T19:00:00Z",
          action: "demote",
          vbrief_path: "vbrief/proposed/nested.vbrief.json",
          from_status: "pending",
          to_status: "proposed",
          actor: "operator",
          demote_meta: {
            batch_id: batchId,
            was_promoted: true,
            original_promotion_decision_id: null,
            days_in_pending: 0,
            demote_reason: "x",
            demoted_from: "pending",
          },
        },
        logPath,
      );
      expect(findByBatchId(batchId, readAll(logPath))).toHaveLength(1);
    });

    it("undo cancel uses folder and status map fallbacks for unknown folders", () => {
      root = mkdtempSync(join(tmpdir(), "undo-fallback-"));
      mkdirSync(join(root, "vbrief", "cancelled"), { recursive: true });
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      const name = "orphan.vbrief.json";
      writeFileSync(
        join(root, "vbrief", "cancelled", name),
        formatVbriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
      );
      append(
        {
          decision_id: newDecisionId(),
          timestamp: "2026-05-18T20:00:00Z",
          action: "cancel",
          vbrief_path: `vbrief/cancelled/${name}`,
          from_status: "custom-zone",
          to_status: "cancelled",
          actor: "operator",
          cancel_meta: { cancelled_from: "custom-zone" },
        },
        logPath,
      );
      const entry = readAll(logPath)[0] as Record<string, unknown>;
      expect(undoOne(entry, root, { logPath }).ok).toBe(true);
      expect(existsSync(join(root, "vbrief", "custom-zone", name))).toBe(true);
    });

    it("undoBatch skips idempotent already-undone members", () => {
      root = mkdtempSync(join(tmpdir(), "undo-batch-skip-"));
      mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      const batchId = newDecisionId();
      const memberId = newDecisionId();
      append(
        {
          decision_id: memberId,
          timestamp: "2026-05-18T19:00:00Z",
          action: "demote",
          vbrief_path: "vbrief/proposed/skip.vbrief.json",
          from_status: "pending",
          to_status: "proposed",
          actor: "operator",
          batch_id: batchId,
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
      writeFileSync(
        join(root, "vbrief", "proposed", "skip.vbrief.json"),
        formatVbriefJson({ plan: { title: "T", status: "proposed", items: [] } }),
      );
      append(
        {
          decision_id: newDecisionId(),
          timestamp: "2026-05-18T19:01:00Z",
          action: "undo",
          vbrief_path: "vbrief/proposed/skip.vbrief.json",
          from_status: "pending",
          to_status: "proposed",
          actor: "operator",
          undo_meta: { original_decision_id: memberId, original_action: "demote" },
        },
        logPath,
      );
      const [, , skipped] = undoBatch(batchId, root, { logPath });
      expect(skipped.some((s) => s.includes("already undone"))).toBe(true);
    });

    it("undoOne rejects invalid JSON at move time", () => {
      root = mkdtempSync(join(tmpdir(), "undo-bad-json-"));
      mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      const logPath = canonicalLogPath(root);
      const id = newDecisionId();
      writeFileSync(join(root, "vbrief", "proposed", "bad.vbrief.json"), "{", "utf8");
      append(
        {
          decision_id: id,
          timestamp: "2026-05-18T19:00:00Z",
          action: "demote",
          vbrief_path: "vbrief/proposed/bad.vbrief.json",
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
      expect(undoOne(readAll(logPath)[0] as Record<string, unknown>, root, { logPath }).ok).toBe(
        false,
      );
    });
  });

  describe("project-context and transition helpers", () => {
    it("resolveProjectRoot returns null for file paths and invalid env", () => {
      const file = join(tmpdir(), `scope-ctx-file-${Date.now()}`);
      writeFileSync(file, "x", "utf8");
      expect(resolveProjectRoot(file)).toBeNull();
      rmSync(file);
      vi.stubEnv("DEFT_PROJECT_ROOT", file);
      expect(resolveProjectRoot(null)).toBeNull();
    });

    it("recordWipCapOverride is best-effort when audit append fails", () => {
      root = mkdtempSync(join(tmpdir(), "wip-audit-fail-"));
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      chmodSync(join(root, "vbrief", ".eval"), 0o444);
      recordWipCapOverride(join(root, "vbrief/pending/x.vbrief.json"), root, {
        allowed: true,
        forceOverride: true,
        cap: 10,
        count: 11,
        source: "typed",
      });
      chmodSync(join(root, "vbrief", ".eval"), 0o755);
      expect(readAll(canonicalLogPath(root))).toEqual([]);
    });

    it("runTransition rejects non-vbrief extensions and uses stay labels", () => {
      root = mkdtempSync(join(tmpdir(), "trans88-"));
      mkdirSync(join(root, "vbrief", "active"), { recursive: true });
      const notVbrief = join(root, "vbrief", "active", "note.txt");
      writeFileSync(notVbrief, "x", "utf8");
      expect(runTransition("block", notVbrief).ok).toBe(false);

      const vbrief = join(root, "vbrief", "active", "stay.vbrief.json");
      writeFileSync(
        vbrief,
        formatVbriefJson({ plan: { title: "T", status: "running", items: [] } }),
      );
      expect(runTransition("block", vbrief).ok).toBe(true);
    });
  });
});
