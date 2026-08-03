import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Child, ForgeIssueState, UmbrellaClient } from "./types.js";
import {
  classifyPassType,
  computeChildren,
  computeWaves,
  isChildOpen,
  parseCurrentShape,
  reconcileBodyChecklist,
  reconcileUmbrellas,
  renderBody,
} from "./umbrellas.js";

class FakeUmbrellaClient implements UmbrellaClient {
  comments = new Map<string, Array<{ id: number; body: string }>>();
  issueBodies = new Map<string, string>();
  issueStates = new Map<string, ForgeIssueState>();
  private nextId = 1000;

  fetchComments(repo: string, issueNumber: number): Array<{ id: number; body: string }> {
    return [...(this.comments.get(`${repo}:${issueNumber}`) ?? [])];
  }

  editComment(_repo: string, commentId: number, body: string): void {
    for (const bucket of this.comments.values()) {
      for (const c of bucket) {
        if (c.id === commentId) c.body = body;
      }
    }
  }

  createComment(repo: string, issueNumber: number, body: string): number {
    const key = `${repo}:${issueNumber}`;
    const id = this.nextId++;
    const bucket = this.comments.get(key) ?? [];
    bucket.push({ id, body });
    this.comments.set(key, bucket);
    return id;
  }

  fetchIssueStates(
    repo: string,
    issueNumbers: readonly number[],
  ): ReadonlyMap<number, ForgeIssueState> {
    const out = new Map<number, ForgeIssueState>();
    for (const n of issueNumbers) {
      const state = this.issueStates.get(`${repo}:${n}`);
      if (state) out.set(n, state);
    }
    return out;
  }

  fetchIssueBody(repo: string, issueNumber: number): string {
    return this.issueBodies.get(`${repo}:${issueNumber}`) ?? "";
  }

  editIssueBody(repo: string, issueNumber: number, body: string): void {
    this.issueBodies.set(`${repo}:${issueNumber}`, body);
  }
}

const child = (
  id: string,
  folder = "active",
  deps: string[] = [],
  issueNumber: number | null = null,
): Child => ({
  story_id: id,
  title: id,
  kind: "story",
  folder,
  depends_on: deps,
  issue_number: issueNumber,
});

describe("computeWaves", () => {
  it("layers dependencies", () => {
    const waves = computeWaves([child("b", "active", ["a"]), child("a")]);
    expect(waves[0]).toEqual(["a"]);
    expect(waves[1]).toEqual(["b"]);
  });

  it("handles cycle as trailing wave", () => {
    const waves = computeWaves([child("a", "active", ["b"]), child("b", "active", ["a"])]);
    expect(waves.length).toBe(1);
  });
});

describe("parseCurrentShape", () => {
  it("parses pass number", () => {
    const body = "## Current shape (as of pass-3)\n\nChild-count history: pass-1: 2, pass-2: 3\n";
    expect(parseCurrentShape(body).passN).toBe(3);
  });

  it("tolerates missing header", () => {
    expect(parseCurrentShape("no header").passN).toBeNull();
  });

  // ReDoS-hardening regression fixtures (#1782 s4 / CodeQL js/polynomial-redos):
  // the `\s*(\S.*|)$` rewrite of HISTORY_RE / LAST_UPDATED_RE / LAST_PASS_TYPE_RE
  // must stay byte-identical to the prior `\s*(.*)$` across these edge inputs.
  it("parses fields at end-of-string with no trailing newline", () => {
    const body =
      "## Current shape (as of pass-2)\n" +
      "Last updated: 2026-06-19T00:00:00Z\n" +
      "Last pass type: additive\n" +
      "Child-count history: pass-1: 1, pass-2: 2";
    const parsed = parseCurrentShape(body);
    expect(parsed.passN).toBe(2);
    expect(parsed.lastUpdated).toBe("2026-06-19T00:00:00Z");
    expect(parsed.lastPassType).toBe("additive");
    expect(parsed.history).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("strips surrounding whitespace identically to the trim-based parse", () => {
    const body =
      "## Current shape (as of pass-1)\n" +
      "Last updated:    2026-06-19T00:00:00Z   \n" +
      "Last pass type:\tverify\t\n" +
      "Child-count history:   pass-1: 5  \n";
    const parsed = parseCurrentShape(body);
    expect(parsed.lastUpdated).toBe("2026-06-19T00:00:00Z");
    expect(parsed.lastPassType).toBe("verify");
    expect(parsed.history).toEqual([[1, 5]]);
  });

  it("returns empty string (not null) for an all-whitespace field tail at end-of-string", () => {
    // Mirrors the frozen Python oracle: `\s*` (which includes newlines) only
    // collapses to an empty capture when no non-whitespace follows, i.e. when
    // the field sits at the very end of the body. Verified against
    // vbrief_reconcile_umbrellas.parse_current_shape.
    const body =
      "## Current shape (as of pass-2)\n" +
      "Last pass type: additive\n" +
      "Child-count history: pass-1: 1\n" +
      "Last updated:     ";
    const parsed = parseCurrentShape(body);
    expect(parsed.lastUpdated).toBe("");
    expect(parsed.lastPassType).toBe("additive");
    expect(parsed.history).toEqual([[1, 1]]);
  });

  it("captures across a whitespace run that spans newlines (Python \\s* semantics)", () => {
    // `\s*` consumes the trailing spaces AND the newline, so the capture is the
    // next non-whitespace line's content -- identical to the old `\s*(.*)$` and
    // to the Python oracle. The rewrite preserves this cross-newline behavior.
    const body = "## Current shape (as of pass-1)\nLast updated:      \nLast pass type: additive\n";
    const parsed = parseCurrentShape(body);
    expect(parsed.lastUpdated).toBe("Last pass type: additive");
  });

  it("stays linear on many-repetition whitespace input", () => {
    const spaces = " ".repeat(50000);
    const body =
      "## Current shape (as of pass-1)\n" +
      `Last updated:${spaces}2026-06-19T00:00:00Z\n` +
      `Last pass type:${spaces}refactor\n` +
      `Child-count history:${spaces}pass-1: 1\n`;
    const start = Date.now();
    const parsed = parseCurrentShape(body);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(parsed.lastUpdated).toBe("2026-06-19T00:00:00Z");
    expect(parsed.lastPassType).toBe("refactor");
    expect(parsed.history).toEqual([[1, 1]]);
  });
});

describe("classifyPassType", () => {
  it("classifies additive", () => {
    expect(classifyPassType(2, 3)).toBe("additive");
  });
});

describe("renderBody", () => {
  it("renders canonical sections", () => {
    const body = renderBody({
      passN: 1,
      lastPassType: "additive",
      lastUpdated: "2026-06-14T20:00:00Z",
      openChildren: [child("a")],
      closedChildren: [],
      waves: [["a"]],
      history: [[1, 1]],
    });
    expect(body).toContain("## Current shape (as of pass-1)");
    expect(body).toContain("### Open children");
  });
});

describe("reconcileUmbrellas", () => {
  it("creates current-shape comment", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "child.xbrief.json"),
      `${JSON.stringify({ plan: { id: "child-a", metadata: { kind: "story", swarm: { depends_on: [] } } } })}\n`,
    );
    writeFileSync(
      join(active, "epic.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "epic-1",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/plan", uri: "active/child.xbrief.json", title: "child-a" },
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/1284",
            },
          ],
        },
      })}\n`,
    );
    const client = new FakeUmbrellaClient();
    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-06-14T20:00:00Z",
      repo: "deftai/directive",
    });
    expect(code).toBe(0);
    expect(outcome.changed[0]?.action).toBe("created");
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses cross-repo comment mutation without allowCrossRepo (#2601)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-cross-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "epic.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "epic-foreign",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/other/victim/issues/42",
            },
          ],
        },
      })}\n`,
    );
    const client = new FakeUmbrellaClient();
    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      repo: "deftai/directive",
    });
    expect(code).toBe(1);
    expect(outcome.errors[0]?.message).toMatch(/refusing cross-repo mutation/);
    expect(client.comments.size).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves github-issue child refs and ticks body checkboxes from forge state (#1649)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-1649-"));
    const active = join(root, "xbrief", "active");
    const completed = join(root, "xbrief", "completed");
    mkdirSync(active, { recursive: true });
    mkdirSync(completed, { recursive: true });
    // Child with local xBRIEF in completed (folder says closed) but forge may differ.
    writeFileSync(
      join(completed, "child-closed.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "child-closed",
          title: "Closed child",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/100",
            },
          ],
        },
      })}\n`,
    );
    // Child still active locally, but forge says closed.
    writeFileSync(
      join(active, "child-stale-folder.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "child-stale",
          title: "Stale open folder",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/101",
            },
          ],
        },
      })}\n`,
    );
    // Epic links children only as github-issue refs (no plan refs) + its own issue.
    writeFileSync(
      join(active, "epic.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "epic-1649",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/1284",
            },
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/100",
              title: "Closed child",
            },
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/101",
              title: "Stale open folder",
            },
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/102",
              title: "Issue-only child",
            },
          ],
        },
      })}\n`,
    );

    const client = new FakeUmbrellaClient();
    client.issueBodies.set(
      "deftai/directive:1284",
      "## Children\n- [ ] #100 Closed child\n- [ ] #101 Stale open folder\n- [ ] #102 Issue-only child\n",
    );
    client.issueStates.set("deftai/directive:100", "closed");
    client.issueStates.set("deftai/directive:101", "closed"); // forge wins over active folder
    client.issueStates.set("deftai/directive:102", "open");

    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-08-03T12:00:00Z",
      repo: "deftai/directive",
    });
    expect(code).toBe(0);
    expect(outcome.changed).toHaveLength(1);
    const change = outcome.changed[0];
    expect(change?.action).toBe("created");
    expect(change?.checklist_action).toBe("edited");
    // Current-shape should list 1 open (#102) and 2 closed (100, 101 via forge).
    expect(change?.body).toContain("Child count: 3 (1/2)");
    expect(change?.body).toContain("#102");
    expect(change?.body).toMatch(/child-closed|Closed child/);
    // Body checkboxes reconciled.
    const body = client.issueBodies.get("deftai/directive:1284") ?? "";
    expect(body).toContain("- [x] #100");
    expect(body).toContain("- [x] #101");
    expect(body).toContain("- [ ] #102");
    rmSync(root, { recursive: true, force: true });
  });

  it("is idempotent on checklist + current-shape when already correct (#1649)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-1649-idemp-"));
    const completed = join(root, "xbrief", "completed");
    mkdirSync(completed, { recursive: true });
    writeFileSync(
      join(completed, "kid.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "kid",
          title: "Kid",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/50" },
          ],
        },
      })}\n`,
    );
    writeFileSync(
      join(completed, "epic.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "epic-idemp",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/49",
            },
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/50",
            },
          ],
        },
      })}\n`,
    );
    const client = new FakeUmbrellaClient();
    client.issueStates.set("deftai/directive:50", "closed");
    client.issueBodies.set("deftai/directive:49", "- [ ] #50 Kid\n");

    // Pass 1: create comment + tick checklist.
    const [code1, outcome1] = reconcileUmbrellas(root, {
      client,
      now: "2026-08-03T12:00:00Z",
      repo: "deftai/directive",
    });
    expect(code1).toBe(0);
    expect(outcome1.changed).toHaveLength(1);
    expect(outcome1.changed[0]?.checklist_action).toBe("edited");
    expect(client.issueBodies.get("deftai/directive:49")).toContain("- [x] #50");

    // Pass 2: no comment or body mutation when state is unchanged.
    const [code2, outcome2] = reconcileUmbrellas(root, {
      client,
      now: "2026-08-03T12:05:00Z",
      repo: "deftai/directive",
    });
    expect(code2).toBe(0);
    expect(outcome2.unchanged).toHaveLength(1);
    expect(outcome2.unchanged[0]?.checklist_action).toBe("unchanged");
    expect(outcome2.unchanged[0]?.pass_n).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("computeChildren github-issue refs (#1649)", () => {
  it("skips epic self-ref and synthesizes issue-only children", () => {
    const index: Record<string, Child> = {
      "kid.xbrief.json": child("kid", "active", [], 10),
    };
    const epic = {
      plan: {
        references: [
          { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/1" },
          { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/10" },
          { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/11", title: "Only" },
          { type: "x-xbrief/plan", uri: "active/kid.xbrief.json" },
        ],
      },
    };
    const children = computeChildren(epic, index, { epicIssueNumber: 1 });
    expect(children.map((c) => c.story_id).sort()).toEqual(["#11", "kid"]);
    const synth = children.find((c) => c.story_id === "#11");
    expect(synth?.folder).toBe("unknown");
    expect(synth?.issue_number).toBe(11);
  });
});

describe("isChildOpen forge vs folder (#1649)", () => {
  it("prefers forge state over lifecycle folder", () => {
    const c = child("x", "active", [], 7);
    expect(isChildOpen(c, new Map([[7, "closed"]]))).toBe(false);
    expect(isChildOpen(c, new Map([[7, "open"]]))).toBe(true);
    expect(isChildOpen(child("y", "completed", [], 8), null)).toBe(false);
    expect(isChildOpen(child("z", "unknown", [], 9), null)).toBe(true);
  });
});

describe("reconcileBodyChecklist (#1649)", () => {
  it("ticks closed children and unticks reopened ones", () => {
    const body = "- [ ] #1 a\n- [x] #2 b\n- [ ] unrelated todo\n- [ ] #3 c\n";
    const { body: next, changed } = reconcileBodyChecklist(
      body,
      new Set([1, 3]),
      new Set([1, 2, 3]),
    );
    expect(changed).toBe(true);
    expect(next).toContain("- [x] #1 a");
    expect(next).toContain("- [ ] #2 b");
    expect(next).toContain("- [ ] unrelated todo");
    expect(next).toContain("- [x] #3 c");
  });

  it("returns unchanged when already correct", () => {
    const body = "- [x] #1 done\n";
    const result = reconcileBodyChecklist(body, new Set([1]), new Set([1]));
    expect(result.changed).toBe(false);
    expect(result.body).toBe(body);
  });
});
