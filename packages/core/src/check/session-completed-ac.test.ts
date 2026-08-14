import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveSessionCompletedVerifyAcTarget,
  SESSION_COMPLETED_AC_REMEDIATION,
} from "./session-completed-ac.js";

function writeCompleted(
  root: string,
  name: string,
  meta: Record<string, unknown>,
  dirName = "xbrief",
): string {
  const dir = join(root, dirName, "completed");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: name,
        status: "completed",
        metadata: meta,
      },
    }),
    "utf8",
  );
  return path;
}

describe("resolveSessionCompletedVerifyAcTarget (#3357)", () => {
  it("returns none when no completed briefs exist", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-none-"));
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns none when session is unknown even if completed briefs exist", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-unk-"));
    writeCompleted(root, "old.xbrief.json", {
      completedAt: "2026-01-01T00:00:00Z",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        env: {},
      }),
    ).toEqual({ kind: "none" });
  });

  it("targets the most recent same-session completed brief", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-hit-"));
    writeCompleted(root, "older.xbrief.json", {
      completedAt: "2026-08-14T10:00:00Z",
      completedSessionId: "sess-1",
    });
    const latest = writeCompleted(root, "newer.xbrief.json", {
      completedAt: "2026-08-14T12:00:00Z",
      completedSessionId: "sess-1",
    });
    writeCompleted(root, "other-session.xbrief.json", {
      completedAt: "2026-08-14T13:00:00Z",
      completedSessionId: "sess-2",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
      }),
    ).toEqual({ kind: "target", path: latest });
  });

  it("matches completedAt after session start when session id was not stamped", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-time-"));
    writeCompleted(root, "before.xbrief.json", {
      completedAt: "2026-08-14T09:00:00Z",
    });
    const during = writeCompleted(root, "during.xbrief.json", {
      completedAt: "2026-08-14T11:00:00Z",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-time",
        sessionStartedAt: new Date("2026-08-14T10:00:00Z"),
      }),
    ).toEqual({ kind: "target", path: during });
  });

  it("returns cannot with the single remediation when every completed brief is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-bad-"));
    const dir = join(root, "xbrief", "completed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.xbrief.json"), "{not-json", "utf8");
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-bad",
      }),
    ).toEqual({ kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION });
  });
});
