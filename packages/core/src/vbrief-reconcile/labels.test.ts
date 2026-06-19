import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDesiredLabels, reconcileLabels } from "./labels.js";
import type { LabelClient } from "./types.js";

class FakeLabelClient implements LabelClient {
  labels = new Map<string, string[]>();
  applyCalls: Array<[string, number, string[], string[]]> = [];

  fetchLabels(repo: string, issueNumber: number): string[] {
    return [...(this.labels.get(`${repo}:${issueNumber}`) ?? [])];
  }

  apply(
    repo: string,
    issueNumber: number,
    add: readonly string[],
    remove: readonly string[],
  ): void {
    this.applyCalls.push([repo, issueNumber, [...add], [...remove]]);
    const key = `${repo}:${issueNumber}`;
    const cur = new Set(this.labels.get(key) ?? []);
    for (const a of add) cur.add(a);
    for (const r of remove) cur.delete(r);
    this.labels.set(key, [...cur].sort());
  }
}

describe("computeDesiredLabels", () => {
  it("blocked status adds status:blocked", () => {
    expect(computeDesiredLabels({ status: "blocked", metadata: { kind: "story" } }, false)).toEqual(
      new Set(["status:blocked"]),
    );
  });

  it("epic adds tracker labels", () => {
    expect(computeDesiredLabels({ status: "running", metadata: { kind: "epic" } }, false)).toEqual(
      new Set(["epic", "status:tracker"]),
    );
  });
});

describe("reconcileLabels", () => {
  it("adds blocked label", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-labels-"));
    const dir = join(root, "vbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "story.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "blk",
          status: "blocked",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/10" },
          ],
        },
      })}\n`,
      "utf8",
    );
    const client = new FakeLabelClient();
    const [code, outcome] = reconcileLabels(root, { client });
    expect(code).toBe(0);
    expect(client.applyCalls[0]?.[2]).toEqual(["status:blocked"]);
    expect(outcome.changed.length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns exit 2 without vbrief dir", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-labels-missing-"));
    const [code] = reconcileLabels(root, { client: new FakeLabelClient() });
    expect(code).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });
});
