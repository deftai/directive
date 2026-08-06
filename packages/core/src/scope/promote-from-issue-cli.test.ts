import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidatesLog, resolveAuditLogPath } from "../triage/actions/candidates-log.js";
import { lifecycleMain } from "./main.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-pfi-cli-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
  mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
  mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
  writeFileSync(join(root, "xbrief", ".layout"), "xbrief\n");
  return root;
}

function writeProposed(root: string, issueNumber: number): void {
  writeFileSync(
    join(root, "xbrief", "proposed", `i${issueNumber}.xbrief.json`),
    JSON.stringify({
      xBRIEFInfo: {
        version: "0.8",
        description: `#${issueNumber}`,
        updated: "2026-08-01T00:00:00Z",
      },
      plan: {
        title: `t${issueNumber}`,
        status: "proposed",
        narratives: {
          Origin: `Ingested from https://github.com/o/r/issues/${issueNumber}`,
        },
        items: [],
        references: [
          {
            type: "x-xbrief/github-issue",
            uri: `https://github.com/o/r/issues/${issueNumber}`,
          },
        ],
        updated: "2026-08-01T00:00:00Z",
      },
    }),
  );
}

describe("lifecycleMain --from-issue (#1136)", () => {
  it("promotes via --from-issue=N --repo", () => {
    const root = makeRoot();
    writeProposed(root, 100);
    const log = createCandidatesLog(root);
    log.append(
      {
        decision_id: log.newDecisionId(),
        timestamp: "2026-08-01T12:00:00Z",
        repo: "o/r",
        issue_number: 100,
        decision: "accept",
        actor: "agent:test",
      },
      { path: resolveAuditLogPath(root) },
    );

    const code = lifecycleMain([
      "promote",
      "--from-issue=100",
      "--repo=o/r",
      "--project-root",
      root,
    ]);
    expect(code).toBe(0);
  });

  it("usage when promote has neither file nor --from-issue/--batch", () => {
    const code = lifecycleMain(["promote"]);
    expect(code).toBe(2);
  });

  it("refuses defer via CLI", () => {
    const root = makeRoot();
    writeProposed(root, 101);
    const log = createCandidatesLog(root);
    log.append(
      {
        decision_id: log.newDecisionId(),
        timestamp: "2026-08-01T12:00:00Z",
        repo: "o/r",
        issue_number: 101,
        decision: "defer",
        actor: "agent:test",
        reason: "later",
        resume_on: "date:2026-09-01",
      },
      { path: resolveAuditLogPath(root) },
    );

    const code = lifecycleMain([
      "promote",
      "--from-issue",
      "101",
      "--repo",
      "o/r",
      "--project-root",
      root,
    ]);
    expect(code).toBe(1);
  });
});
