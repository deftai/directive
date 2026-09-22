import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectMissingSequenceKind, missingSequenceKindPayload } from "./missing-kind.js";
import { planSequencePath, readPlanSequence } from "./store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ps-kind-"));
  roots.push(root);
  return root;
}

function writeSequence(root: string, body: unknown): void {
  mkdirSync(join(root, ".deft"), { recursive: true });
  writeFileSync(planSequencePath(root), `${JSON.stringify(body)}\n`);
}

function writeOrigin(root: string, issue: number, folder: "completed" | "cancelled"): void {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${issue}.xbrief.json`),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: `Issue ${issue}`,
        status: folder === "cancelled" ? "cancelled" : "completed",
        references: [
          {
            uri: `https://github.com/acme/app/issues/${issue}`,
            type: "x-xbrief/github-issue",
          },
        ],
      },
    }),
  );
}

function legacy(entries: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sequence_id: "undefined",
    authorized_by: "",
    current_index: 0,
    exhausted: false,
    entries,
    ...extra,
  };
}

describe("inspectMissingSequenceKind (#4843)", () => {
  it("returns null when the file is absent or sequence_kind is a string", () => {
    const root = tempRoot();
    expect(inspectMissingSequenceKind(root)).toBeNull();
    writeSequence(root, legacy([{ id: "1", kind: "issue", issue: 1 }], { sequence_kind: "" }));
    expect(inspectMissingSequenceKind(root)).toBeNull();
    expect(readPlanSequence(root)?.sequence_kind).toBe("");
  });

  it("leaves earlier parse failures on the throwing read", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(planSequencePath(root), "not-json");
    expect(inspectMissingSequenceKind(root)).toBeNull();
    for (const body of [null, [1], { entries: [{ id: "1", kind: "issue" }] }]) {
      writeSequence(root, body);
      expect(inspectMissingSequenceKind(root)).toBeNull();
      expect(() => readPlanSequence(root)).toThrow(/plan-sequence:/);
    }
  });

  it("names the file and field and does not return a sequence", () => {
    const root = tempRoot();
    writeSequence(root, legacy([{ id: "285", kind: "issue", issue: 285 }], { sequence_kind: 1 }));
    const report = inspectMissingSequenceKind(root);
    expect(report).not.toBeNull();
    expect(report?.authorized).toBe(false);
    expect(report?.missingField).toBe("sequence_kind");
    expect(report?.path).toBe(planSequencePath(root));
    expect(report?.message).toContain("sequence_kind");
    expect(report?.message).toContain("plan-sequence: sequence_kind required");
    expect(report?.message).toContain("not an authorized sequence");
    expect(report?.terminalLifecycle).toBeNull();
    expect(report?.message).not.toContain("terminal in");
    expect(report?.message).not.toContain("every entry");
    if (report === null) {
      throw new Error("expected missing-kind report");
    }
    const payload = missingSequenceKindPayload(report);
    expect(payload.ok).toBe(false);
    expect(payload.authorized).toBe(false);
    expect(payload).not.toHaveProperty("sequence_kind");
    expect(payload).not.toHaveProperty("entries");
    expect(payload).not.toHaveProperty("sequence_id");
    expect(payload).not.toHaveProperty("terminal_lifecycle_drift");
    expect(() => readPlanSequence(root)).toThrow(/plan-sequence: sequence_kind required/);
  });

  it("includes terminal-lifecycle only for the pending current entry", () => {
    const root = tempRoot();
    writeOrigin(root, 285, "completed");
    writeOrigin(root, 286, "completed");
    writeSequence(
      root,
      legacy([
        { id: "285", kind: "issue", issue: 285 },
        { id: "286", kind: "issue", issue: 286 },
      ]),
    );
    const current = inspectMissingSequenceKind(root);
    expect(current?.terminalLifecycle?.code).toBe("terminal-lifecycle");
    expect(current?.terminalLifecycle?.folder).toBe("completed");
    expect(current?.message).toContain("issue:285");
    expect(current?.message).toContain(
      "Stop and ask the operator whether to advance, replace, or clear",
    );
    expect(current?.message).not.toContain("every entry");
    if (current === null) {
      throw new Error("expected missing-kind report");
    }
    expect(missingSequenceKindPayload(current).terminal_lifecycle_drift?.code).toBe(
      "terminal-lifecycle",
    );

    const laterOnly = tempRoot();
    writeOrigin(laterOnly, 286, "completed");
    writeSequence(
      laterOnly,
      legacy([
        { id: "285", kind: "issue", issue: 285 },
        { id: "286", kind: "issue", issue: 286 },
      ]),
    );
    const later = inspectMissingSequenceKind(laterOnly);
    expect(later?.terminalLifecycle).toBeNull();
    expect(later?.message).not.toContain("terminal in");
    expect(later?.message).toContain(planSequencePath(laterOnly));
  });

  it("does not treat a completed current entry, an exhausted sequence, or a cancelled non-match as drift", () => {
    const completedCurrent = tempRoot();
    writeOrigin(completedCurrent, 285, "completed");
    writeSequence(
      completedCurrent,
      legacy([{ id: "285", kind: "issue", issue: 285, status: "completed" }]),
    );
    expect(inspectMissingSequenceKind(completedCurrent)?.terminalLifecycle).toBeNull();

    const exhausted = tempRoot();
    writeOrigin(exhausted, 285, "completed");
    writeSequence(
      exhausted,
      legacy([{ id: "285", kind: "issue", issue: 285 }], { exhausted: true }),
    );
    expect(inspectMissingSequenceKind(exhausted)?.terminalLifecycle).toBeNull();

    const cancelled = tempRoot();
    writeOrigin(cancelled, 285, "cancelled");
    writeSequence(cancelled, legacy([{ id: "285", kind: "issue", issue: 285, status: "pending" }]));
    const report = inspectMissingSequenceKind(cancelled);
    expect(report?.terminalLifecycle?.folder).toBe("cancelled");
    expect(report?.message).toContain("cancelled/");

    const pastEnd = tempRoot();
    writeOrigin(pastEnd, 285, "completed");
    writeSequence(
      pastEnd,
      legacy([{ id: "285", kind: "issue", issue: 285, status: "pending" }], { current_index: 3 }),
    );
    expect(inspectMissingSequenceKind(pastEnd)?.terminalLifecycle).toBeNull();
  });

  it("skips the terminal fact when entries cannot be read", () => {
    const root = tempRoot();
    writeSequence(root, legacy("nope"));
    const report = inspectMissingSequenceKind(root);
    expect(report?.terminalLifecycle).toBeNull();
    expect(report?.missingField).toBe("sequence_kind");
    writeSequence(root, legacy([{ id: 1, kind: "issue" }]));
    expect(inspectMissingSequenceKind(root)?.terminalLifecycle).toBeNull();
    writeSequence(root, legacy([{ id: "1", kind: "nope" }]));
    expect(inspectMissingSequenceKind(root)?.terminalLifecycle).toBeNull();
    writeSequence(root, legacy([null]));
    expect(inspectMissingSequenceKind(root)?.terminalLifecycle).toBeNull();
    writeSequence(root, legacy([["x"]]));
    expect(inspectMissingSequenceKind(root)?.terminalLifecycle).toBeNull();
    writeSequence(root, legacy([]));
    expect(inspectMissingSequenceKind(root)?.message).toContain("missing sequence_kind");
    writeSequence(root, { sequence_id: "", entries: [{ id: "1", kind: "issue" }] });
    expect(inspectMissingSequenceKind(root)).toBeNull();
    writeSequence(root, {
      sequence_id: "undefined",
      entries: [{ id: "1", kind: "task", title: "t", issue: "nope", status: "skipped" }],
    });
    const skipped = inspectMissingSequenceKind(root);
    expect(skipped?.terminalLifecycle).toBeNull();
    expect(skipped?.message).toContain("missing sequence_kind");
  });
});
