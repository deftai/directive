/**
 * resolveRunSummarySessionId precedence (#3399).
 *
 * explicit → DEFT_SESSION_ID → ritual-state → destination JSONL tail → mint.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRitualStatePayload, writeRitualState } from "../session/ritual-sentinel.js";
import { resolveRunSummarySessionId } from "./session-id.js";
import { ENV_RUN_SUMMARY_PATH } from "./types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "run-summary-sid-"));
  tempDirs.push(root);
  return root;
}

function writeRitual(root: string, sessionId: string): void {
  writeRitualState(
    root,
    newRitualStatePayload({
      sessionId,
      gitHead: "abc123",
      worktreePath: root,
    }),
  );
}

describe("resolveRunSummarySessionId (#3399)", () => {
  it("prefers an explicit option over env, ritual-state, and JSONL", () => {
    const root = freshRoot();
    writeRitual(root, "ritual-sid");
    const dest = join(root, "summary.jsonl");
    writeFileSync(
      dest,
      `${JSON.stringify({ event: "session_start", session_id: "jsonl-sid", payload: {} })}\n`,
      "utf8",
    );
    expect(
      resolveRunSummarySessionId({
        projectRoot: root,
        explicit: "explicit-sid",
        env: { DEFT_SESSION_ID: "env-sid", [ENV_RUN_SUMMARY_PATH]: dest },
        mint: () => "minted-sid",
      }),
    ).toBe("explicit-sid");
  });

  it("uses DEFT_SESSION_ID when explicit is unset", () => {
    const root = freshRoot();
    writeRitual(root, "ritual-sid");
    expect(
      resolveRunSummarySessionId({
        projectRoot: root,
        env: { DEFT_SESSION_ID: "  env-sid  " },
        mint: () => "minted-sid",
      }),
    ).toBe("env-sid");
  });

  it("uses ritual-state session_id when env is unset", () => {
    const root = freshRoot();
    writeRitual(root, "ritual-sid");
    expect(
      resolveRunSummarySessionId({
        projectRoot: root,
        env: {},
        mint: () => "minted-sid",
      }),
    ).toBe("ritual-sid");
  });

  it("uses the last session_id already in the destination JSONL", () => {
    const root = freshRoot();
    const dest = join(root, "summary.jsonl");
    writeFileSync(
      dest,
      `${JSON.stringify({ event: "session_start", session_id: "jsonl-first", payload: {} })}\n${JSON.stringify({ event: "check_invocation", session_id: "jsonl-last", payload: {} })}\n`,
      "utf8",
    );
    expect(
      resolveRunSummarySessionId({
        projectRoot: root,
        env: { [ENV_RUN_SUMMARY_PATH]: dest },
        mint: () => "minted-sid",
      }),
    ).toBe("jsonl-last");
  });

  it("mints only when no workspace session exists", () => {
    const root = freshRoot();
    expect(
      resolveRunSummarySessionId({
        projectRoot: root,
        env: {},
        mint: () => "minted-sid",
      }),
    ).toBe("minted-sid");
  });

  it("does not mint when ritual-state already has a workspace session", () => {
    const root = freshRoot();
    writeRitual(root, "ritual-sid");
    let minted = 0;
    expect(
      resolveRunSummarySessionId({
        projectRoot: root,
        env: {},
        mint: () => {
          minted += 1;
          return "minted-sid";
        },
      }),
    ).toBe("ritual-sid");
    expect(minted).toBe(0);
  });

  it("treats blank explicit and env as absent", () => {
    const root = freshRoot();
    writeRitual(root, "ritual-sid");
    expect(
      resolveRunSummarySessionId({
        projectRoot: root,
        explicit: "   ",
        env: { DEFT_SESSION_ID: "" },
        mint: () => "minted-sid",
      }),
    ).toBe("ritual-sid");
  });

  it("skips JSONL tail when destination is not a file", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".deft"), { recursive: true });
    expect(
      resolveRunSummarySessionId({
        projectRoot: root,
        env: { [ENV_RUN_SUMMARY_PATH]: "-" },
        mint: () => "minted-stdout",
      }),
    ).toBe("minted-stdout");
  });
});
