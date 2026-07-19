import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEmitInvocation, runLifecycleEvent } from "./event.js";
import { clearRegistryCache, readEvents } from "./events.js";

const tempRoots: string[] = [];

afterEach(() => {
  clearRegistryCache();
  delete process.env.DEFT_EVENT_LOG;
  const cwd = process.cwd();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root === undefined) {
      continue;
    }
    try {
      if (cwd.startsWith(root)) {
        process.chdir(tmpdir());
      }
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup on Windows file locks.
    }
  }
});

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("lifecycle event approval recorder (#2631)", () => {
  it("parseEmitInvocation accepts documented review-cycle flags", () => {
    const parsed = parseEmitInvocation([
      "plan:approved",
      "--plan-ref",
      "https://github.com/deftai/directive/pull/42",
      "--approver",
      "msadams",
      "--approval-phrase",
      "yes",
      "--pr-number",
      "42",
      "--head-sha",
      "abc123",
    ]);
    expect(parsed.name).toBe("plan:approved");
    expect(parsed.payload).toMatchObject({
      plan_ref: "https://github.com/deftai/directive/pull/42",
      approver: "msadams",
      approval_phrase: "yes",
      pr_number: 42,
      head_sha: "abc123",
    });
  });

  it("records plan:approved with repository and timestamp envelope", () => {
    const root = makeTempRoot("lifecycle-event-");
    const log = join(root, "events.jsonl");
    const rc = runLifecycleEvent(
      [
        "emit",
        "plan:approved",
        "--log",
        log,
        "--plan-ref",
        "https://github.com/deftai/directive/pull/99",
        "--approver",
        "operator",
        "--approval-phrase",
        "confirmed",
        "--pr-number",
        "99",
        "--head-sha",
        "deadbeef",
      ],
      { projectRoot: root },
    );
    expect(rc).toBe(0);
    const records = readEvents(log);
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe("plan:approved");
    expect(records[0]?.payload).toMatchObject({
      repository: "deftai/directive",
      plan_ref: "https://github.com/deftai/directive/pull/99",
      approver: "operator",
      approval_phrase: "confirmed",
      pr_number: 99,
      head_sha: "deadbeef",
    });
    expect(records[0]?.detected_at.endsWith("Z")).toBe(true);
  });

  it("repeating the same approval is idempotent", () => {
    const root = makeTempRoot("lifecycle-event-dedupe-");
    const log = join(root, "events.jsonl");
    const argv = [
      "emit",
      "plan:approved",
      "--log",
      log,
      "--plan-ref",
      "https://github.com/deftai/directive/pull/7",
      "--approver",
      "operator",
      "--approval-phrase",
      "approve",
      "--pr-number",
      "7",
      "--head-sha",
      "sha1",
    ] as const;
    expect(runLifecycleEvent([...argv], { projectRoot: root })).toBe(0);
    expect(runLifecycleEvent([...argv], { projectRoot: root })).toBe(0);
    expect(readEvents(log)).toHaveLength(1);
  });

  it("rejects invalid approval phrase before writing", () => {
    const root = makeTempRoot("lifecycle-event-invalid-");
    const log = join(root, "events.jsonl");
    const rc = runLifecycleEvent(
      [
        "emit",
        "plan:approved",
        "--log",
        log,
        "--plan-ref",
        "https://github.com/deftai/directive/pull/1",
        "--approver",
        "operator",
        "--approval-phrase",
        "maybe",
      ],
      { projectRoot: root },
    );
    expect(rc).toBe(2);
    expect(readEvents(log)).toHaveLength(0);
  });

  it("delegates non-plan emit invocations to events cli", () => {
    const root = makeTempRoot("lifecycle-event-delegate-");
    const log = join(root, "events.jsonl");
    const rc = runLifecycleEvent(
      ["emit", "session:interrupted", "--log", log, "--session-id", "s1", "--reason", "probe"],
      { projectRoot: root },
    );
    expect(rc).toBe(0);
    expect(readEvents(log)[0]?.event).toBe("session:interrupted");
  });
});
