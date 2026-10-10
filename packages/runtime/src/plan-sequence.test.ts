import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, main as planSequenceMain } from "./plan-sequence.js";
import { main as verifyPlanSequenceMain } from "./verify-plan-sequence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("plan-sequence CLI (#2402)", () => {
  it("skips a lone -- separator (#3439)", () => {
    const parsed = parseArgs(["current", "--", "--json"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.action).toBe("current");
    expect(parsed.emitJson).toBe(true);
  });

  it("set/current/advance/verify happy path for two-PR plan", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "cli-test",
        sequence_kind: "delivery",
        authorized_by: "test",
        entries: [
          { id: "pr-1", kind: "pr", issue: 1 },
          { id: "pr-2", kind: "pr", issue: 2 },
        ],
      }),
    );
    expect(planSequenceMain(["set", "--project-root", root, "--file", file])).toBe(0);
    expect(planSequenceMain(["current", "--project-root", root])).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-1"]),
    ).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-2"]),
    ).toBe(1);
    expect(planSequenceMain(["advance", "--project-root", root])).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-2"]),
    ).toBe(0);
    expect(planSequenceMain(["advance", "--project-root", root])).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-2"]),
    ).toBe(1);
    expect(planSequenceMain(["clear", "--project-root", root])).toBe(0);
  });

  it("verify skips when no sequence", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-empty-"));
    roots.push(root);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "x"]),
    ).toBe(0);
  });

  it("set rejects a JSON payload that is not an object (null/array/primitive)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-non-object-"));
    roots.push(root);
    const nullFile = join(root, "null.json");
    writeFileSync(nullFile, "null");
    expect(planSequenceMain(["set", "--project-root", root, "--file", nullFile])).toBe(1);
    const arrayFile = join(root, "array.json");
    writeFileSync(arrayFile, "[1,2,3]");
    expect(planSequenceMain(["set", "--project-root", root, "--file", arrayFile])).toBe(1);
  });

  it("covers argv/flag and JSON emit branches (#3027)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-branches-"));
    roots.push(root);

    expect(planSequenceMain([])).toBe(2);
    expect(planSequenceMain(["nope"])).toBe(2);
    expect(planSequenceMain(["set", "--unknown"])).toBe(2);
    expect(planSequenceMain(["set", "--project-root"])).toBe(2);
    expect(planSequenceMain(["set", "--file"])).toBe(2);
    expect(planSequenceMain(["set", "--from-json"])).toBe(2);
    expect(planSequenceMain(["current", "--project-root", root])).toBe(1);
    expect(planSequenceMain(["advance", "--project-root", root])).toBe(1);
    expect(planSequenceMain(["clear", "--project-root", root])).toBe(0);

    const inline = JSON.stringify({
      sequence_id: "inline",
      sequence_kind: "checklist",
      authorized_by: "t",
      entries: [{ id: "a", kind: "task" }],
    });
    expect(
      planSequenceMain(["set", `--project-root=${root}`, "--from-json", inline, "--json"]),
    ).toBe(0);
    expect(planSequenceMain(["current", "--project-root", root, "--json"])).toBe(0);
    expect(planSequenceMain(["advance", "--project-root", root, "--json"])).toBe(0);
    // exhausted after advance past single entry
    expect(planSequenceMain(["current", "--project-root", root])).toBe(0);
    expect(planSequenceMain(["clear", "--project-root", root])).toBe(0);
    // already absent
    expect(planSequenceMain(["clear", "--project-root", root])).toBe(0);

    // Full sequence object with current_index uses parsePlanSequence path
    const fullFile = join(root, "full.json");
    writeFileSync(
      fullFile,
      JSON.stringify({
        sequence_id: "full",
        sequence_kind: "delivery",
        authorized_by: "t",
        entries: [
          { id: "p1", kind: "pr", issue: 1 },
          { id: "p2", kind: "pr", issue: 2 },
        ],
        current_index: 0,
        batching_allowed: true,
        continuation_past_final: false,
        exhausted: false,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      }),
    );
    expect(planSequenceMain(["set", `--file=${fullFile}`, "--project-root", root])).toBe(0);
    expect(planSequenceMain(["current", "--project-root", root])).toBe(0);
    expect(planSequenceMain(["set", "--project-root", root])).toBe(1);
  });

  it("current fail-closes when the current issue origin is already in completed/ (#4129)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-drift-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "drift",
        sequence_kind: "delivery",
        authorized_by: "test",
        entries: [
          { id: "287", kind: "issue", issue: 287 },
          { id: "288", kind: "issue", issue: 288 },
        ],
      }),
    );
    expect(planSequenceMain(["set", "--project-root", root, "--file", file])).toBe(0);
    mkdirSync(join(root, "xbrief/completed"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/completed/2026-09-01-287.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Done 287",
          status: "completed",
          references: [
            {
              uri: "https://github.com/acme/app/issues/287",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
    );
    const err: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    try {
      expect(planSequenceMain(["current", "--project-root", root])).toBe(1);
      const text = err.join("");
      expect(text).toContain("terminal in");
      expect(text).toContain("Do not run task plan-sequence:advance until");
      expect(text).toContain("Do not treat this as permission to pick the next id");
    } finally {
      errSpy.mockRestore();
    }
    const out: string[] = [];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    const err2 = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(planSequenceMain(["current", "--project-root", root, "--json"])).toBe(1);
      const payload = JSON.parse(out.join("")) as { terminal_lifecycle_drift?: { code: string } };
      expect(payload.terminal_lifecycle_drift?.code).toBe("terminal-lifecycle");
    } finally {
      outSpy.mockRestore();
      err2.mockRestore();
    }
  });

  it("current names a missing sequence_kind and the pending current terminal fact (#4843)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-kind-"));
    roots.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    mkdirSync(join(root, "xbrief/completed"), { recursive: true });
    writeFileSync(
      join(root, ".deft/plan-sequence.json"),
      JSON.stringify({
        sequence_id: "undefined",
        authorized_by: "",
        current_index: 0,
        exhausted: false,
        entries: [
          { id: "285", kind: "issue", issue: 285 },
          { id: "286", kind: "issue", issue: 286 },
        ],
      }),
    );
    writeFileSync(
      join(root, "xbrief/completed/285.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Done 285",
          status: "completed",
          references: [
            { uri: "https://github.com/acme/app/issues/285", type: "x-xbrief/github-issue" },
          ],
        },
      }),
    );
    const err: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    try {
      expect(planSequenceMain(["current", "--project-root", root])).toBe(1);
      const text = err.join("");
      expect(text).toContain("plan-sequence.json");
      expect(text).toContain("sequence_kind");
      expect(text).toContain("not an authorized sequence");
      expect(text).toContain("issue:285");
      expect(text).toContain("Stop and ask the operator whether to advance, replace, or clear");
      expect(text).not.toContain("every entry");
      expect(text).not.toContain("No active ordered-plan sequence");
    } finally {
      errSpy.mockRestore();
    }
    const out: string[] = [];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    const err2 = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(planSequenceMain(["current", "--project-root", root, "--json"])).toBe(1);
      const payload = JSON.parse(out.join("")) as {
        ok?: boolean;
        authorized?: boolean;
        missing_field?: string;
        sequence_kind?: string;
        entries?: unknown;
        terminal_lifecycle_drift?: { code: string };
      };
      expect(payload.ok).toBe(false);
      expect(payload.authorized).toBe(false);
      expect(payload.missing_field).toBe("sequence_kind");
      expect(payload.terminal_lifecycle_drift?.code).toBe("terminal-lifecycle");
      expect(payload.sequence_kind).toBeUndefined();
      expect(payload.entries).toBeUndefined();
    } finally {
      outSpy.mockRestore();
      err2.mockRestore();
    }
  });

  it("current does not report terminal-lifecycle when only a later entry is terminal (#4843)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-kind-later-"));
    roots.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    mkdirSync(join(root, "xbrief/completed"), { recursive: true });
    writeFileSync(
      join(root, ".deft/plan-sequence.json"),
      JSON.stringify({
        sequence_id: "undefined",
        authorized_by: "",
        entries: [
          { id: "285", kind: "issue", issue: 285 },
          { id: "286", kind: "issue", issue: 286 },
        ],
      }),
    );
    writeFileSync(
      join(root, "xbrief/completed/286.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Done 286",
          status: "completed",
          references: [
            { uri: "https://github.com/acme/app/issues/286", type: "x-xbrief/github-issue" },
          ],
        },
      }),
    );
    const err: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    try {
      expect(planSequenceMain(["current", "--project-root", root])).toBe(1);
      const text = err.join("");
      expect(text).toContain("missing sequence_kind");
      expect(text).not.toContain("terminal in");
      expect(text).not.toContain("every entry");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("set still writes when sequence_kind is omitted and advance keeps the bare throw (#4843)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-kind-set-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "undefined",
        authorized_by: "",
        entries: [{ id: "285", kind: "story", issue: 285 }],
      }),
    );
    expect(planSequenceMain(["set", "--project-root", root, "--file", file])).toBe(0);
    const written = JSON.parse(readFileSync(join(root, ".deft/plan-sequence.json"), "utf8")) as {
      sequence_kind?: string;
    };
    expect(written.sequence_kind).toBeUndefined();
    const err: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    try {
      expect(planSequenceMain(["advance", "--project-root", root])).toBe(1);
      const text = err.join("");
      expect(text).toContain("plan-sequence: sequence_kind required");
      expect(text).not.toContain("not an authorized sequence");
    } finally {
      errSpy.mockRestore();
    }
  });
});
