import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindSessionGeneration, parseBoundGeneration, readBoundGeneration } from "./bind.js";
import { stampLiveGeneration } from "./generation.js";
import { reportFreshness } from "./report.js";

const temps: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-fresh-bind-"));
  temps.push(root);
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fresh-fixture" })}\n`);
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "t" } })}\n`,
  );
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const p = temps.pop();
    if (p) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("bindSessionGeneration (#3117)", () => {
  it("binds live generation into session-bind.json", () => {
    const root = tempProject();
    stampLiveGeneration(root, {
      contentVersion: "3.0.0",
      stampedBy: "directive-init",
      increment: true,
      nowIso: "2026-08-04T01:00:00Z",
    });
    const {
      bound: b,
      live: l,
      path,
    } = bindSessionGeneration(root, {
      sessionId: "host-session-1",
      nowIso: "2026-08-04T01:05:00Z",
    });
    expect(b.boundGeneration).toBe(l.generation);
    expect(b.sessionId).toBe("host-session-1");
    expect(existsSync(path)).toBe(true);
    expect(readBoundGeneration(root, { sessionId: "host-session-1" })?.boundGeneration).toBe(1);
    const report = reportFreshness(root, { sessionId: "host-session-1" });
    expect(report.state).toBe("current");
    expect(report.ready).toBe(true);
  });

  it("rebind after upgrade moves session to current", () => {
    const root = tempProject();
    stampLiveGeneration(root, {
      contentVersion: "1.0.0",
      stampedBy: "directive-init",
      increment: true,
    });
    bindSessionGeneration(root);
    stampLiveGeneration(root, {
      contentVersion: "2.0.0",
      stampedBy: "directive-update",
      increment: true,
    });
    expect(reportFreshness(root).state).toBe("stale_hard");
    bindSessionGeneration(root);
    expect(reportFreshness(root).state).toBe("current");
  });

  it("parseBoundGeneration rejects invalid", () => {
    expect(parseBoundGeneration({})).toBeNull();
    expect(parseBoundGeneration({ boundGeneration: 1, boundAt: "t", contentVersion: "1" })).toEqual(
      expect.objectContaining({ boundGeneration: 1 }),
    );
  });

  it("isolates concurrent sessions so one bind cannot certify another", () => {
    const root = tempProject();
    stampLiveGeneration(root, {
      contentVersion: "1.0.0",
      stampedBy: "directive-init",
      increment: true,
    });
    bindSessionGeneration(root, { sessionId: "session-a" });
    stampLiveGeneration(root, {
      contentVersion: "2.0.0",
      stampedBy: "directive-update",
      increment: true,
    });
    // Session B rebinds to the new generation (no default mirror).
    bindSessionGeneration(root, { sessionId: "session-b" });
    // Session A must still report hard drift (not B's current).
    expect(reportFreshness(root, { sessionId: "session-a" }).state).toBe("stale_hard");
    expect(reportFreshness(root, { sessionId: "session-b" }).state).toBe("current");
    // Bare report without sessionId does not use B's bind (unbound unless default set).
    expect(reportFreshness(root).state).toBe("unbound");
    expect(readBoundGeneration(root, { sessionId: "session-a" })?.boundGeneration).toBe(1);
    expect(readBoundGeneration(root, { sessionId: "session-b" })?.boundGeneration).toBe(2);
  });
});
