import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import { CLEARANCE_LOG_NAME, recordClearance } from "./verify-judgment-gates.js";

const itSymlink = it.skipIf(process.platform === "win32");

describe("verify-judgment-gates symlink containment (#2632)", () => {
  let root = "";
  let escapeDir = "";

  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
    if (escapeDir.length > 0) {
      rmSync(escapeDir, { recursive: true, force: true });
      escapeDir = "";
    }
  });

  itSymlink("recordClearance refuses when xbrief/.audit is a symlink outside the project", () => {
    root = mkdtempSync(join(tmpdir(), "judgment-gates-audit-symlink-"));
    escapeDir = mkdtempSync(join(tmpdir(), "judgment-gates-audit-escape-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const victim = join(escapeDir, CLEARANCE_LOG_NAME);
    writeFileSync(victim, "victim\n", "utf8");
    symlinkSync(escapeDir, join(root, "xbrief", ".audit"), "dir");

    expect(() =>
      recordClearance(root, {
        gate_id: "secrets-and-credentials",
        cleared_scope: "abc123",
      }),
    ).toThrow(ProjectionContainmentError);
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
  });

  itSymlink(
    "recordClearance refuses when the clearance log is a symlink outside the project",
    () => {
      root = mkdtempSync(join(tmpdir(), "judgment-gates-log-symlink-"));
      escapeDir = mkdtempSync(join(tmpdir(), "judgment-gates-log-escape-"));
      mkdirSync(join(root, "xbrief", ".audit"), { recursive: true });
      const victim = join(escapeDir, CLEARANCE_LOG_NAME);
      writeFileSync(victim, "victim\n", "utf8");
      symlinkSync(victim, join(root, "xbrief", ".audit", CLEARANCE_LOG_NAME));

      expect(() =>
        recordClearance(root, {
          gate_id: "secrets-and-credentials",
          cleared_scope: "abc123",
        }),
      ).toThrow(ProjectionContainmentError);
      expect(readFileSync(victim, "utf8")).toBe("victim\n");
    },
  );
});
