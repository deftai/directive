import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  batchApproveEscalations,
  fileEscalation,
  listEscalationsFiltered,
  resolveEscalation,
} from "./actions.js";
import { escalationPath } from "./paths.js";
import {
  listOpenEscalations,
  loadEscalation,
  parseEscalation,
  validateEscalationType,
} from "./store.js";
import { DEFAULT_SLA_HOURS, ESCALATION_TYPES } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "esc-store-"));
  roots.push(root);
  return root;
}

describe("escalation schema (#518)", () => {
  it("accepts every fixed type", () => {
    for (const t of ESCALATION_TYPES) {
      expect(validateEscalationType(t)).toBe(t);
    }
  });

  it("rejects invalid types", () => {
    expect(() => validateEscalationType("blocked")).toThrow(/invalid escalation type/);
    expect(() => validateEscalationType("CMD_APPROVAL")).not.toThrow(); // lowercased
    expect(parseEscalation({ id: "x", agentId: "a", type: "nope", title: "t" })).toBeNull();
  });

  it("parseEscalation requires id agentId type title", () => {
    expect(parseEscalation({ agentId: "a", type: "question", title: "t" })).toBeNull();
    expect(parseEscalation({ id: "e1", type: "question", title: "t" })).toBeNull();
    expect(parseEscalation({ id: "e1", agentId: "a", type: "question" })).toBeNull();
  });

  it("accepts snake_case aliases from issue schema", () => {
    const event = parseEscalation({
      id: "esc-0001",
      agent_id: "agent-b",
      type: "design_decision",
      title: "Ambiguity",
      body: "details",
      context_refs: ["xbrief/a.json", "#496"],
      created_at: "2025-10-21T10:00:00Z",
      sla_hours: 4,
      status: "open",
    });
    expect(event).not.toBeNull();
    expect(event?.agentId).toBe("agent-b");
    expect(event?.contextRefs).toEqual(["xbrief/a.json", "#496"]);
    expect(event?.slaHours).toBe(4);
  });
});

describe("escalation store + actions (#518)", () => {
  it("files under .deft/escalations and lists open", () => {
    const root = tempRoot();
    const filed = fileEscalation({
      projectRoot: root,
      type: "cmd_approval",
      title: "run ls",
      agentId: "worker-1",
      body: "ls -la",
    });
    expect(filed.status).toBe("open");
    expect(filed.type).toBe("cmd_approval");
    const onDisk = JSON.parse(readFileSync(escalationPath(root, filed.id), "utf8")) as {
      schemaVersion: number;
    };
    expect(onDisk.schemaVersion).toBe(1);
    expect(listOpenEscalations(root).map((e) => e.id)).toEqual([filed.id]);
  });

  it("resolve closes an open item", () => {
    const root = tempRoot();
    const filed = fileEscalation({
      projectRoot: root,
      type: "design_decision",
      title: "pick A or B",
    });
    const result = resolveEscalation({
      projectRoot: root,
      id: filed.id,
      decision: "approved",
      actor: "op",
      note: "choose A",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.status).toBe("resolved");
    expect(result.event.resolution?.decision).toBe("approved");
    expect(listOpenEscalations(root)).toHaveLength(0);
    expect(loadEscalation(root, filed.id)?.resolution?.note).toBe("choose A");
  });

  it("batch-approve only cmd_approval and question", () => {
    const root = tempRoot();
    const cmd = fileEscalation({
      projectRoot: root,
      type: "cmd_approval",
      title: "safe read",
      id: "esc-cmd",
    });
    const q = fileEscalation({
      projectRoot: root,
      type: "question",
      title: "async q",
      id: "esc-q",
    });
    const design = fileEscalation({
      projectRoot: root,
      type: "design_decision",
      title: "hard",
      id: "esc-design",
    });
    const batch = batchApproveEscalations({ projectRoot: root, actor: "op" });
    expect(batch.approved.map((e) => e.id).sort()).toEqual(["esc-cmd", "esc-q"]);
    expect(batch.skipped.some((s) => s.id === design.id)).toBe(true);
    expect(loadEscalation(root, cmd.id)?.status).toBe("resolved");
    expect(loadEscalation(root, q.id)?.resolution?.decision).toBe("answered");
    expect(loadEscalation(root, design.id)?.status).toBe("open");
  });

  it("batch-approve skips dangerous unless includeDangerous", () => {
    const root = tempRoot();
    fileEscalation({
      projectRoot: root,
      type: "cmd_approval",
      title: "rm -rf",
      id: "esc-danger",
      dangerous: true,
    });
    const skipped = batchApproveEscalations({ projectRoot: root });
    expect(skipped.approved).toHaveLength(0);
    expect(skipped.skipped[0]?.reason).toMatch(/dangerous/);
    const forced = batchApproveEscalations({
      projectRoot: root,
      includeDangerous: true,
    });
    expect(forced.approved).toHaveLength(1);
  });

  it("list filters by type and openOnly", () => {
    const root = tempRoot();
    fileEscalation({ projectRoot: root, type: "resource", title: "need secret", id: "r1" });
    fileEscalation({ projectRoot: root, type: "external", title: "waiting CI", id: "e1" });
    const r = resolveEscalation({
      projectRoot: root,
      id: "e1",
      decision: "dismissed",
    });
    expect(r.ok).toBe(true);
    expect(listEscalationsFiltered(root, { openOnly: true })).toHaveLength(1);
    expect(listEscalationsFiltered(root, { type: "external" })).toHaveLength(1);
  });

  it("corrupt json is skipped by list", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "escalations"), { recursive: true });
    writeFileSync(join(root, ".deft", "escalations", "bad.json"), "{not-json", "utf8");
    expect(listOpenEscalations(root)).toEqual([]);
  });

  it("parseEscalation covers resolution snake_case, invalid status, non-string body, zero sla", () => {
    expect(
      parseEscalation({
        id: "e1",
        agentId: "a",
        type: "question",
        title: "q",
        status: "nope",
      }),
    ).toBeNull();
    const withRes = parseEscalation({
      id: "e2",
      agentId: "a",
      type: "approval",
      title: "merge",
      body: 42,
      status: "resolved",
      slaHours: 0,
      resolution: {
        decision: "approved",
        resolved_at: "2026-01-01T00:00:00Z",
        resolved_by: "op",
        note: "ok",
        answer: null,
      },
    });
    expect(withRes?.body).toBe("");
    expect(withRes?.slaHours).toBe(DEFAULT_SLA_HOURS.approval);
    expect(withRes?.resolution?.resolvedBy).toBe("op");
    expect(
      parseEscalation({ id: "e3", agentId: "a", type: "external", title: "x", resolution: "bad" })
        ?.resolution,
    ).toBeNull();
    expect(
      parseEscalation({
        id: "e4",
        agentId: "a",
        type: "resource",
        title: "key",
        resolution: { decision: "invalid" },
      })?.resolution,
    ).toBeNull();
    expect(parseEscalation(null)).toBeNull();
    expect(parseEscalation([])).toBeNull();
  });

  it("loadEscalation returns null for missing and corrupt files", () => {
    const root = tempRoot();
    expect(loadEscalation(root, "missing")).toBeNull();
    mkdirSync(join(root, ".deft", "escalations"), { recursive: true });
    writeFileSync(join(root, ".deft", "escalations", "broken.json"), "{", "utf8");
    expect(loadEscalation(root, "broken")).toBeNull();
  });
});
