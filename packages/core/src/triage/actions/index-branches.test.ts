import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScmStubError } from "../../scm/errors.js";
import { createCandidatesLog, resolveAuditLogPath } from "./candidates-log.js";
import {
  accept,
  deferAction,
  formatDecision,
  reject,
  TriageError,
  UpstreamCloseError,
} from "./index.js";
import type { TriageActionsDeps } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps) rmSync(root, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "actions-br-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  return root;
}

function fakeDeps(root: string, overrides: Partial<TriageActionsDeps> = {}): TriageActionsDeps {
  const log = createCandidatesLog(root);
  const path = resolveAuditLogPath(root);
  return {
    candidatesLog: {
      append(entry, options = {}) {
        return log.append(entry, { path: options.path ?? path });
      },
      latestDecision(issueNumber, repo, options = {}) {
        return log.latestDecision(issueNumber, repo, { path: options.path ?? path });
      },
      newDecisionId: () => "11111111-1111-1111-1111-111111111111",
    },
    issueIngest: { ingestSingleForAccept: () => {} },
    scm: {
      call: () => ({ returncode: 0, stdout: "", stderr: "" }),
    },
    nowIso: () => "2026-06-18T12:00:00Z",
    stderr: () => {},
    ...overrides,
  };
}

describe("formatDecision branches", () => {
  it("formats null as no decision", () => {
    expect(formatDecision(null)).toBe("(no decision recorded)");
  });

  it("includes optional reason, linked_to, and prior_decision_id fields", () => {
    const text = formatDecision({
      decision_id: "id",
      timestamp: "t",
      repo: "deftai/directive",
      issue_number: 1,
      decision: "mark-duplicate",
      actor: "agent:test",
      reason: "it's a dupe",
      linked_to: 2,
      prior_decision_id: "prev",
    });
    expect(text).toContain("reason='it\\'s a dupe'");
    expect(text).toContain("linked_to=#2");
    expect(text).toContain("prior_decision_id=prev");
  });
});

describe("reject scm branches", () => {
  it("maps ScmStubError to UpstreamCloseError via default runner path", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    deps.scm = {
      call() {
        throw new ScmStubError("neither ghx nor gh");
      },
    };
    expect(() => reject(1, "deftai/directive", "nope", deps, { projectRoot: root })).toThrow(
      UpstreamCloseError,
    );
  });

  it("wraps generic scm failures with gh prefix", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    deps.scm = {
      call() {
        throw new Error("network down");
      },
    };
    expect(() => reject(1, "deftai/directive", "nope", deps, { projectRoot: root })).toThrow(
      /gh issue close/,
    );
  });
});

describe("accept ingest branches", () => {
  it("rolls back when ingest throws non-Error value", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    deps.issueIngest = {
      ingestSingleForAccept() {
        throw "bad-ingest";
      },
    };
    expect(() => accept(1, "deftai/directive", deps, { projectRoot: root })).toThrow(TriageError);
    expect(existsSync(resolveAuditLogPath(root))).toBe(true);
    expect(readFileSync(resolveAuditLogPath(root), "utf8").trim()).toBe("");
  });
});

describe("deferAction branches", () => {
  it("wraps non-Error resume_on parse failures", () => {
    const root = makeRepo();
    const deps = fakeDeps(root);
    expect(() =>
      deferAction(1, "deftai/directive", "later", deps, {
        resumeOn: "not-valid",
        projectRoot: root,
      }),
    ).toThrow(TriageError);
  });
});
