import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  materializeRetainedBrief,
  readReviewedBriefBlob,
  SOURCE_RECOVERY_REMEDIATION,
} from "./brief-transport.js";
import { immutableProjectionDigest, projectionsEqual } from "./immutable-projection.js";
import type { TextCaptureResult } from "./subprocess.js";

describe("immutable projection (#4714 R2)", () => {
  it("ignores namespaced evidence/disposition slots only", () => {
    const base = {
      plan: {
        id: "s1",
        items: [{ id: "c1", title: "t", status: "pending", command: "pnpm test" }],
      },
    };
    const withEvidence = {
      plan: {
        id: "s1",
        items: [
          {
            id: "c1",
            title: "t",
            status: "pending",
            command: "pnpm test",
            "x-directive/evidence": {
              kind: "test",
              pointer: "a.test.ts",
              recorded_at: "2026-09-30T00:00:00Z",
              recorded_by: "agent",
            },
          },
        ],
      },
    };
    expect(projectionsEqual(base, withEvidence)).toBe(true);
    expect(immutableProjectionDigest(base)).toBe(immutableProjectionDigest(withEvidence));
  });

  it("refuses command or criterion changes", () => {
    const left = { plan: { items: [{ id: "c1", command: "pnpm test" }] } };
    const right = { plan: { items: [{ id: "c1", command: "pnpm test --changed" }] } };
    expect(projectionsEqual(left, right)).toBe(false);
  });
});

describe("brief transport (#4714 R5)", () => {
  it("materializes retained bytes that exactly match a reviewed blob", () => {
    const root = mkdtempSync(join(tmpdir(), "brief-transport-"));
    const checkout = mkdtempSync(join(tmpdir(), "brief-checkout-"));
    const rel = "xbrief/active/story-1.xbrief.json";
    const bytes = `${JSON.stringify({ plan: { id: "story-1", status: "running" } }, null, 2)}\n`;
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, rel), bytes, "utf8");
    const runGit = (cmd: readonly string[]): TextCaptureResult => {
      if (cmd[1] === "show" && String(cmd[2]).includes(rel)) {
        return { returncode: 0, stdout: bytes, stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "no" };
    };
    const result = materializeRetainedBrief({
      checkoutRoot: checkout,
      projectRoot: root,
      relPath: rel,
      retainedRoots: [root],
      reviewedCommitIsh: "deadbeef",
      runGit,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(readFileSync(result.path, "utf8")).toBe(bytes);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  it("refuses when retained bytes diverge from the reviewed blob", () => {
    const root = mkdtempSync(join(tmpdir(), "brief-transport-diverge-"));
    const checkout = mkdtempSync(join(tmpdir(), "brief-checkout-diverge-"));
    const rel = "xbrief/active/story-1.xbrief.json";
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, rel), '{"plan":{"id":"local"}}\n', "utf8");
    const runGit = (cmd: readonly string[]): TextCaptureResult => {
      if (cmd[1] === "show") {
        return { returncode: 0, stdout: '{"plan":{"id":"reviewed"}}\n', stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "no" };
    };
    const result = materializeRetainedBrief({
      checkoutRoot: checkout,
      projectRoot: root,
      relPath: rel,
      retainedRoots: [root],
      reviewedCommitIsh: "deadbeef",
      runGit,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("source-recovery");
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  it("returns source-recovery when no reviewed blob exists", () => {
    const lookup = readReviewedBriefBlob("/tmp", "xbrief/active/missing.xbrief.json", null, () => ({
      returncode: 1,
      stdout: "",
      stderr: "missing",
    }));
    expect(lookup.bytes).toBeNull();
    expect(SOURCE_RECOVERY_REMEDIATION).toContain("source-recovery");
  });
});
