import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindSessionGeneration,
  legacySessionBindPath,
  legacySessionFileName,
  parseBoundGeneration,
  readBoundGeneration,
  safeSessionFileName,
  sessionBindPath,
} from "./bind.js";
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
      payloadLoaded: true,
    });
    expect(b.boundGeneration).toBe(l.generation);
    expect(b.sessionId).toBe("host-session-1");
    expect(existsSync(path)).toBe(true);
    expect(readBoundGeneration(root, { sessionId: "host-session-1" })?.boundGeneration).toBe(1);
    const report = reportFreshness(root, { sessionId: "host-session-1" });
    expect(report.state).toBe("current");
    expect(report.ready).toBe(true);
    // Unpinned report never ready even if a bind matches live.
    expect(reportFreshness(root).ready).toBe(false);
  });

  it("rebind after upgrade moves session to current", () => {
    const root = tempProject();
    stampLiveGeneration(root, {
      contentVersion: "1.0.0",
      stampedBy: "directive-init",
      increment: true,
    });
    bindSessionGeneration(root, { sessionId: "sid-1", payloadLoaded: true });
    stampLiveGeneration(root, {
      contentVersion: "2.0.0",
      stampedBy: "directive-update",
      increment: true,
    });
    expect(reportFreshness(root, { sessionId: "sid-1" }).state).toBe("stale_hard");
    bindSessionGeneration(root, { sessionId: "sid-1", payloadLoaded: true });
    expect(reportFreshness(root, { sessionId: "sid-1" }).state).toBe("current");
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
    bindSessionGeneration(root, { sessionId: "session-a", payloadLoaded: true });
    stampLiveGeneration(root, {
      contentVersion: "2.0.0",
      stampedBy: "directive-update",
      increment: true,
    });
    // Session B rebinds to the new generation (no default mirror).
    bindSessionGeneration(root, { sessionId: "session-b", payloadLoaded: true });
    // Session A must still report hard drift (not B's current).
    expect(reportFreshness(root, { sessionId: "session-a" }).state).toBe("stale_hard");
    expect(reportFreshness(root, { sessionId: "session-b" }).state).toBe("current");
    // Bare report without sessionId does not use B's bind (unbound unless default set).
    expect(reportFreshness(root).state).toBe("unbound");
    expect(readBoundGeneration(root, { sessionId: "session-a" })?.boundGeneration).toBe(1);
    expect(readBoundGeneration(root, { sessionId: "session-b" })?.boundGeneration).toBe(2);
  });
});

describe("bind record file names (#3768)", () => {
  // Synthetic id: a real host session id would be published by this fixture,
  // which is the exact exposure #3768 removes from the record names.
  const sessionId = "deadbeef-1234-4567-89ab-cdef01234567";

  function writeLegacyRecord(root: string, bound: Record<string, unknown>): string {
    const path = legacySessionBindPath(root, sessionId);
    mkdirSync(join(root, ".deft", "session-binds"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(bound, null, 2)}\n`);
    return path;
  }

  it("names records by hash only, with no fragment of the session id", () => {
    const name = safeSessionFileName(sessionId);
    expect(name).toMatch(/^[0-9a-f]{24}\.json$/);
    expect(safeSessionFileName(`  ${sessionId}  `)).toBe(name);
    expect(name).not.toContain(sessionId.slice(0, 8));
    expect(name).not.toBe(legacySessionFileName(sessionId));
    expect(legacySessionFileName(sessionId)).toContain(sessionId.slice(0, 8));
  });

  it("keeps the character sanitizer on the legacy name only", () => {
    expect(legacySessionFileName("urn:uuid:ab cd")).toMatch(/^urn_uuid_ab_cd-[0-9a-f]{24}\.json$/);
    expect(legacySessionFileName("::sid::")).toMatch(/^sid-[0-9a-f]{24}\.json$/);
    expect(legacySessionFileName(":::")).toMatch(/^[0-9a-f]{24}\.json$/);
  });

  it("resolves a written record from the id through one derived path", () => {
    const root = tempProject();
    stampLiveGeneration(root, {
      contentVersion: "1.0.0",
      stampedBy: "directive-init",
      increment: true,
    });
    const { path } = bindSessionGeneration(root, { sessionId, payloadLoaded: true });
    expect(path).toBe(sessionBindPath(root, sessionId));
    expect(basename(path)).toBe(safeSessionFileName(sessionId));
    expect(existsSync(legacySessionBindPath(root, sessionId))).toBe(false);
    expect(readBoundGeneration(root, { sessionId })?.boundGeneration).toBe(1);
    expect(reportFreshness(root, { sessionId }).state).toBe("current");
  });

  it("tolerates pre-rename records instead of orphaning their pins", () => {
    const root = tempProject();
    const live = stampLiveGeneration(root, {
      contentVersion: "1.0.0",
      stampedBy: "directive-init",
      increment: true,
    });
    writeLegacyRecord(root, {
      boundGeneration: live.generation,
      boundAt: "2026-08-05T00:00:00Z",
      contentVersion: live.contentVersion,
      surfaces: live.surfaces,
      sessionId,
      payloadLoaded: true,
    });
    expect(existsSync(sessionBindPath(root, sessionId))).toBe(false);
    expect(readBoundGeneration(root, { sessionId })?.boundGeneration).toBe(live.generation);
    expect(reportFreshness(root, { sessionId }).state).toBe("current");
  });

  it("supersedes a legacy record once the session rebinds", () => {
    const root = tempProject();
    const first = stampLiveGeneration(root, {
      contentVersion: "1.0.0",
      stampedBy: "directive-init",
      increment: true,
    });
    writeLegacyRecord(root, {
      boundGeneration: first.generation,
      boundAt: "2026-08-05T00:00:00Z",
      contentVersion: first.contentVersion,
      surfaces: first.surfaces,
      sessionId,
      payloadLoaded: true,
    });
    stampLiveGeneration(root, {
      contentVersion: "2.0.0",
      stampedBy: "directive-update",
      increment: true,
    });
    bindSessionGeneration(root, { sessionId, payloadLoaded: true });
    expect(readBoundGeneration(root, { sessionId })?.boundGeneration).toBe(2);
    expect(reportFreshness(root, { sessionId }).state).toBe("current");
  });

  it("refuses a legacy record bound to another session", () => {
    const root = tempProject();
    const live = stampLiveGeneration(root, {
      contentVersion: "1.0.0",
      stampedBy: "directive-init",
      increment: true,
    });
    writeLegacyRecord(root, {
      boundGeneration: live.generation,
      boundAt: "2026-08-05T00:00:00Z",
      contentVersion: live.contentVersion,
      surfaces: live.surfaces,
      sessionId: "another-session",
      payloadLoaded: true,
    });
    expect(readBoundGeneration(root, { sessionId })).toBeNull();
  });

  it("never falls back for the default bind path", () => {
    const root = tempProject();
    expect(readBoundGeneration(root)).toBeNull();
  });
});
