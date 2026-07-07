import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { append, canonicalLogPath, newDecisionId, readAll } from "./audit-log.js";
import {
  detectLifecycleFolder,
  updateDecomposedChildBackReferences,
  updateDecomposedParentBackReferences,
} from "./decomposed-refs.js";
import { batchDemote, demoteOne, resolveFilePath } from "./demote.js";
import { demoteMain, lifecycleMain, undoMain } from "./main.js";
import { resolveProjectRoot } from "./project-context.js";
import { syncProjectDefinitionAfterScopeMove } from "./project-definition-sync.js";
import { recordWipCapOverride, runTransition } from "./transition.js";
import { undoOne } from "./undo.js";
import { formatVbriefJson } from "./vbrief-json.js";
import {
  canonicalRelpath,
  collectChildUris,
  collectPlanRefs,
  relativeToVbrief,
  resolveVbriefRef,
  scopeIdsForFilename,
} from "./vbrief-ref.js";
import { checkWipCap, formatWipCapRefusal } from "./wip-cap-check.js";

const PARENT = "parent-epic.xbrief.json";
const CHILD = "child-story.xbrief.json";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-ext-"));
  for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", f), { recursive: true });
  }
  return root;
}

function writeVbrief(path: string, data: unknown): void {
  writeFileSync(path, formatVbriefJson(data), "utf8");
}

function makeDecomposedPair(root: string): { parent: string; child: string } {
  const vbrief = join(root, "xbrief");
  const parentPath = join(vbrief, "pending", PARENT);
  const childPath = join(vbrief, "pending", CHILD);
  writeVbrief(parentPath, {
    plan: {
      title: "Parent",
      status: "pending",
      items: [],
      references: [{ uri: `pending/${CHILD}`, type: "x-vbrief/plan", title: "Child" }],
    },
  });
  writeVbrief(childPath, {
    plan: {
      title: "Child",
      status: "pending",
      items: [],
      planRef: `pending/${PARENT}`,
    },
  });
  return { parent: parentPath, child: childPath };
}

describe("scope extended coverage", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("covers cancel and restore transitions", () => {
    root = makeRepo();
    const active = join(root, "xbrief", "active", "x.xbrief.json");
    writeVbrief(active, { plan: { title: "T", status: "running", items: [] } });
    expect(runTransition("cancel", active).ok).toBe(true);
    const cancelled = join(root, "xbrief", "cancelled", "x.xbrief.json");
    expect(runTransition("restore", cancelled).ok).toBe(true);
    expect(existsSync(join(root, "xbrief", "proposed", "x.xbrief.json"))).toBe(true);
  });

  it("covers block idempotent and invalid status", () => {
    root = makeRepo();
    const active = join(root, "xbrief", "active", "x.xbrief.json");
    writeVbrief(active, { plan: { title: "T", status: "running", items: [] } });
    expect(runTransition("block", active).message).toContain("Blocked");
    expect(runTransition("block", active).message).toContain("No-op");
    writeVbrief(active, { plan: { title: "T", status: "pending", items: [] } });
    expect(runTransition("block", active).ok).toBe(false);
  });

  it("stamps capacity bucket from policy on complete", () => {
    root = makeRepo();
    writeVbrief(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), {
      plan: {
        title: "P",
        status: "running",
        items: [],
        policy: {
          capacityAllocation: {
            window: 30,
            defaultBucket: "feature",
            buckets: [{ id: "feature", target: 1 }],
          },
        },
      },
    });
    const active = join(root, "xbrief", "active", "cap.xbrief.json");
    writeVbrief(active, { plan: { title: "T", status: "running", items: [] } });
    runTransition("complete", active);
    const data = JSON.parse(
      readFileSync(join(root, "xbrief", "completed", "cap.xbrief.json"), "utf8"),
    );
    expect(data.plan.metadata.capacityBucket).toBe("feature");
  });

  it("updates decomposed parent and child references on move", () => {
    root = makeRepo();
    const { parent, child } = makeDecomposedPair(root);
    runTransition("activate", child);
    const activeChild = join(root, "xbrief", "active", CHILD);
    const parentData = JSON.parse(readFileSync(parent, "utf8"));
    expect(
      (parentData.plan.references as Array<{ uri: string }>).find((r) => r.uri.includes("active"))
        ?.uri,
    ).toContain("active/");
    runTransition("activate", parent);
    runTransition("complete", join(root, "xbrief", "active", PARENT));
    const childData = JSON.parse(readFileSync(activeChild, "utf8"));
    expect(String(childData.plan.planRef)).toContain("completed/");
  });

  it("syncs project definition on scope move", () => {
    root = makeRepo();
    writeVbrief(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), {
      plan: {
        title: "P",
        status: "running",
        items: [{ id: "story", title: "Move me", status: "running", metadata: {} }],
        references: [],
      },
    });
    const active = join(root, "xbrief", "active", "2026-01-01-story.xbrief.json");
    writeVbrief(active, { plan: { title: "Move me", status: "running", items: [] } });
    const data = JSON.parse(readFileSync(active, "utf8"));
    syncProjectDefinitionAfterScopeMove(
      data,
      active,
      join(root, "xbrief", "completed", "2026-01-01-story.xbrief.json"),
      join(root, "xbrief"),
      "completed",
    );
    const pd = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    );
    expect(pd.plan.items[0].status).toBe("completed");
  });

  it("covers vbrief-ref helpers", () => {
    root = makeRepo();
    const vbrief = join(root, "xbrief");
    expect(resolveVbriefRef("file://proposed/x.xbrief.json", vbrief)).toContain("proposed");
    expect(resolveVbriefRef("https://x", vbrief)).toBeNull();
    expect(collectPlanRefs({ planRef: "p", items: [{ planRef: "c" }] })).toEqual(["p", "c"]);
    expect(collectChildUris({ references: [{ type: "x-vbrief/plan", uri: "a" }] })).toEqual(["a"]);
    expect(scopeIdsForFilename("2026-01-02-slug.xbrief.json").has("slug")).toBe(true);
    expect(relativeToVbrief(join(vbrief, "active", "x.json"), vbrief)).toBe("active/x.json");
    expect(canonicalRelpath(join(root, "xbrief", "active", "x.json"), root)).toBe(
      "xbrief/active/x.json",
    );
  });

  it("covers demote and resolve errors", () => {
    root = makeRepo();
    expect(demoteOne("/missing", root, "r").ok).toBe(false);
    const wrong = join(root, "xbrief", "active", "x.xbrief.json");
    writeVbrief(wrong, { plan: { title: "T", status: "running", items: [] } });
    expect(demoteOne(wrong, root, "r").ok).toBe(false);
    expect(resolveFilePath("", root)[1]).toContain("No vBRIEF");
    expect(resolveFilePath("rel.json", "/nonexistent-no-sentinel-xyz")[1]).toContain(
      "Cannot resolve",
    );
    expect(() => batchDemote(root, -1)).toThrow();
  });

  it("covers undo cancel round-trip", () => {
    root = makeRepo();
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const cancelled = join(root, "xbrief", "cancelled", "c.xbrief.json");
    writeVbrief(cancelled, { plan: { title: "T", status: "cancelled", items: [] } });
    const entry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T20:00:00Z",
      action: "cancel",
      vbrief_path: "xbrief/cancelled/c.xbrief.json",
      from_status: "active",
      to_status: "cancelled",
      actor: "operator",
      cancel_meta: { cancelled_from: "active" },
    };
    append(entry, logPath);
    const result = undoOne(entry, root, { logPath, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("DRY-RUN");
  });

  it("covers wip cap refusal and override audit", () => {
    root = makeRepo();
    for (let i = 0; i < 10; i += 1) {
      writeVbrief(join(root, "xbrief", "pending", `p${i}.xbrief.json`), {
        plan: { title: "T", status: "pending", items: [] },
      });
    }
    writeVbrief(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), {
      plan: { title: "P", status: "running", items: [], policy: { wipCap: 10 } },
    });
    const check = checkWipCap(root);
    expect(check.allowed).toBe(false);
    expect(formatWipCapRefusal(check)).toContain("WIP cap reached");
    recordWipCapOverride(join(root, "xbrief", "pending", "p0.xbrief.json"), root, {
      ...check,
      allowed: true,
      forceOverride: true,
    });
    expect(readAll(canonicalLogPath(root)).length).toBe(1);
  });

  it("covers lifecycle and demote CLI paths", () => {
    root = makeRepo();
    const file = join(root, "xbrief", "proposed", "cli.xbrief.json");
    writeVbrief(file, { plan: { title: "T", status: "proposed", items: [] } });
    expect(lifecycleMain(["promote", file, "--project-root", root])).toBe(0);
    expect(lifecycleMain(["not-an-action", file, "--project-root", root])).toBe(2);
    const pending = join(root, "xbrief", "pending", "cli.xbrief.json");
    expect(demoteMain([pending, "--project-root", root])).toBe(0);
    expect(demoteMain(["--batch", "--project-root", root, "--older-than-days", "0"])).toBe(0);
  });

  it("covers undo CLI batch and latest", () => {
    root = makeRepo();
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const pending = join(root, "xbrief", "pending", "u.xbrief.json");
    writeVbrief(pending, { plan: { title: "T", status: "pending", items: [] } });
    const demoted = demoteOne(pending, root, "x");
    expect(demoted.auditEntry).not.toBeNull();
    expect(undoMain(["--latest", "--project-root", root])).toBe(0);
    expect(undoMain(["--decision-id", "missing", "--project-root", root])).toBe(1);
  });

  it("covers project root env and decomposed helper noops", () => {
    root = makeRepo();
    const prev = process.env.DEFT_PROJECT_ROOT;
    process.env.DEFT_PROJECT_ROOT = root;
    expect(resolveProjectRoot(null)).toBe(root);
    process.env.DEFT_PROJECT_ROOT = prev;
    const vbrief = join(root, "xbrief");
    const childData = { plan: { title: "C", items: [] } };
    expect(updateDecomposedParentBackReferences(childData, "/a", "/b", vbrief)).toEqual([]);
    expect(updateDecomposedChildBackReferences(childData, "/a", "/b", vbrief)).toEqual([]);
    expect(detectLifecycleFolder("/tmp/xbrief/nope/x.xbrief.json")).toBeNull();
  });

  it("rejects unknown transition and bad json", () => {
    root = makeRepo();
    expect(runTransition("nope", join(root, "xbrief", "proposed", "x.xbrief.json")).ok).toBe(false);
    const bad = join(root, "xbrief", "proposed", "bad.xbrief.json");
    writeFileSync(bad, "{", "utf8");
    expect(runTransition("promote", bad).ok).toBe(false);
    const notVbrief = join(root, "xbrief", "proposed", "bad.txt");
    writeFileSync(notVbrief, "x", "utf8");
    expect(runTransition("promote", notVbrief).ok).toBe(false);
  });
});
