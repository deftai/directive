import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn(() => ({ status: 0, stdout: "abc123def456\n" }));

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import { agentsRefreshPlan, hasV3ManagedMarker } from "./agents-md.js";

const MANAGED = "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->";

describe("agents-md extra branches", () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "abc123def456\n" });
  });

  it("uses resolveSha seam when provided", () => {
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => null,
      resolveSha: () => "customsha12",
    });
    expect(plan.sha).toBe("customsha12");
  });

  it("returns unknown when git rev-parse fails", () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => null,
    });
    expect(plan.sha).toBe("unknown");
  });

  it("returns unknown when git stdout is empty", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "   \n" });
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => null,
    });
    expect(plan.sha).toBe("unknown");
  });

  it("returns unknown when git throws", () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("git missing");
    });
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => null,
    });
    expect(plan.sha).toBe("unknown");
  });

  it("detects template-malformed when close marker missing", () => {
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => "<!-- deft:managed-section v3 -->\nno close",
      readAgents: () => null,
    });
    expect(plan.state).toBe("template-malformed");
  });

  it("wraps legacy content without managed section", () => {
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => "# Legacy header\n",
      resolveSha: () => "sha1",
      nowIso: () => "2026-01-01T00:00:00Z",
      newSession: () => "sess12345678",
    });
    expect(plan.state).toBe("missing");
    expect(String(plan.new_content)).toContain("Legacy header");
  });

  it("wraps empty legacy body with only rendered section", () => {
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => "",
      resolveSha: () => "sha1",
    });
    expect(plan.state).toBe("missing");
    expect(String(plan.new_content)).toMatch(/^<!-- deft:managed-section/);
  });

  it("deduplicates multiple managed sections", () => {
    const existing =
      "<!-- deft:managed-section v3 -->\nold1\n<!-- /deft:managed-section -->\n\n" +
      "<!-- deft:managed-section v3 -->\nold2\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => existing,
      resolveSha: () => "sha1",
      nowIso: () => "2026-01-01T00:00:00Z",
      newSession: () => "sess12345678",
    });
    expect(plan.state).toBe("stale");
    expect(String(plan.new_content)).not.toContain("old2");
  });

  it("marks legacy v1 marker as stale", () => {
    const existing = "<!-- deft:managed-section v1 -->\nlegacy\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => existing,
      resolveSha: () => "sha1",
    });
    expect(plan.state).toBe("stale");
  });

  it("returns current when strip matches rendered", () => {
    const rendered = MANAGED;
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => rendered,
      readAgents: () => rendered,
      resolveSha: () => "sha1",
    });
    expect(plan.state).toBe("current");
  });

  it("returns unreadable when readAgents throws", () => {
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => {
        throw new Error("permission denied");
      },
    });
    expect(plan.state).toBe("unreadable");
  });

  it("hasV3ManagedMarker false for missing file via default reader", () => {
    expect(hasV3ManagedMarker("/nonexistent/path/xyz")).toBe(false);
  });

  it("uses default readTemplate when seam omitted and template missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      const plan = agentsRefreshPlan(root, {
        frameworkRoot: root,
        readAgents: () => null,
      });
      expect(plan.state).toBe("template-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses default readAgents when seam omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      const plan = agentsRefreshPlan(root, {
        readTemplate: () => MANAGED,
        resolveSha: () => "sha1",
      });
      expect(plan.state).toBe("absent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops iterManagedSections when close marker missing mid-file", () => {
    const existing = "<!-- deft:managed-section v3 -->\nunclosed\n";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => existing,
      resolveSha: () => "sha1",
    });
    expect(plan.state).toBe("missing");
  });
});
