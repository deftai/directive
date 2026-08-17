import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Child, ForgeIssueState, UmbrellaClient } from "./types.js";
import {
  childrenFromSliceRecord,
  classifyPassType,
  computeChildren,
  computeWaves,
  formatCloseComment,
  isChildOpen,
  parseCurrentShape,
  reconcileBodyChecklist,
  reconcileUmbrellas,
  renderBody,
  renderUmbrellasReport,
  shouldCloseOnAllChildrenMerged,
} from "./umbrellas.js";

class FakeUmbrellaClient implements UmbrellaClient {
  comments = new Map<string, Array<{ id: number; body: string }>>();
  issueBodies = new Map<string, string>();
  issueStates = new Map<string, ForgeIssueState>();
  closedIssues = new Set<string>();
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

  closeIssue(repo: string, issueNumber: number): void {
    const key = `${repo}:${issueNumber}`;
    this.closedIssues.add(key);
    this.issueStates.set(key, "closed");
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

function seedXbriefLayout(root: string): void {
  const active = join(root, "xbrief", "active");
  mkdirSync(active, { recursive: true });
  writeFileSync(
    join(active, "seed.xbrief.json"),
    `${JSON.stringify({ plan: { id: "seed", metadata: { kind: "story" } } })}\n`,
  );
}

function writeSliceRow(root: string, row: Record<string, unknown>): void {
  const dir = join(root, "xbrief", ".triage-cache");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "slices.jsonl"), `${JSON.stringify(row)}\n`, { flag: "a" });
}

function sliceChild(n: number): Record<string, unknown> {
  return {
    n,
    url: `https://github.com/deftai/directive/issues/${n}`,
    wave: 1,
    role: "story",
  };
}

function sliceRow(
  umbrella: number,
  children: readonly number[],
  signal: string,
): Record<string, unknown> {
  return {
    slice_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    umbrella,
    umbrella_url: `https://github.com/deftai/directive/issues/${umbrella}`,
    sliced_at: "2026-08-17T00:00:00Z",
    actor: "manual:operator",
    children: children.map(sliceChild),
    expected_close_signal: signal,
  };
}

describe("childrenFromSliceRecord (#3428)", () => {
  it("reads child numbers and skips duplicates", () => {
    const children = childrenFromSliceRecord({
      children: [{ n: 3388, role: "a" }, { n: 3388, role: "dup" }, { n: 3389 }, { n: 0 }, "bad"],
    });
    expect(children.map((c) => c.issue_number)).toEqual([3388, 3389]);
    expect(children[0]?.folder).toBe("unknown");
  });

  it("returns empty when children is missing", () => {
    expect(childrenFromSliceRecord({})).toEqual([]);
  });
});

describe("shouldCloseOnAllChildrenMerged (#3428)", () => {
  const kids = [child("#1", "unknown", [], 1), child("#2", "unknown", [], 2)];

  it("closes only when every child is forge-closed and the umbrella is open", () => {
    expect(
      shouldCloseOnAllChildrenMerged({
        signal: "all-children-merged",
        children: kids,
        forgeStates: new Map([
          [1, "closed"],
          [2, "closed"],
        ]),
        umbrellaState: "open",
      }),
    ).toBe(true);
  });

  it("refuses manual, wave-1-merged, open children, and already-closed umbrellas", () => {
    const closedKids = new Map<number, ForgeIssueState>([
      [1, "closed"],
      [2, "closed"],
    ]);
    expect(
      shouldCloseOnAllChildrenMerged({
        signal: "manual",
        children: kids,
        forgeStates: closedKids,
        umbrellaState: "open",
      }),
    ).toBe(false);
    expect(
      shouldCloseOnAllChildrenMerged({
        signal: "wave-1-merged",
        children: kids,
        forgeStates: closedKids,
        umbrellaState: "open",
      }),
    ).toBe(false);
    expect(
      shouldCloseOnAllChildrenMerged({
        signal: "all-children-merged",
        children: kids,
        forgeStates: new Map([
          [1, "closed"],
          [2, "open"],
        ]),
        umbrellaState: "open",
      }),
    ).toBe(false);
    expect(
      shouldCloseOnAllChildrenMerged({
        signal: "all-children-merged",
        children: kids,
        forgeStates: closedKids,
        umbrellaState: "closed",
      }),
    ).toBe(false);
    expect(
      shouldCloseOnAllChildrenMerged({
        signal: "all-children-merged",
        children: [],
        forgeStates: closedKids,
        umbrellaState: "open",
      }),
    ).toBe(false);
    expect(
      shouldCloseOnAllChildrenMerged({
        signal: "all-children-merged",
        children: kids,
        forgeStates: null,
        umbrellaState: "open",
      }),
    ).toBe(false);
  });
});

describe("formatCloseComment (#3428)", () => {
  it("names the signal and sorted child numbers", () => {
    expect(
      formatCloseComment("all-children-merged", [
        child("#2", "unknown", [], 3391),
        child("#1", "unknown", [], 3388),
      ]),
    ).toBe("expected_close_signal=all-children-merged; children: #3388, #3391");
  });
});

describe("renderUmbrellasReport close suffix (#3428)", () => {
  it("prints close=closed on changed rows", () => {
    const report = renderUmbrellasReport({
      changed: [
        {
          story_id: "slice-umbrella-3377",
          repo: "deftai/directive",
          issue_number: 3377,
          action: "created",
          pass_n: 1,
          body: "## Current shape (as of pass-1)",
          checklist_action: "edited",
          close_action: "closed",
        },
      ],
      unchanged: [
        {
          story_id: "slice-umbrella-3378",
          repo: "deftai/directive",
          issue_number: 3378,
          action: "unchanged",
          pass_n: 1,
          body: "## Current shape (as of pass-1)",
          close_action: "unchanged",
        },
      ],
      skipped_no_ref: [],
      errors: [],
      dry_run: false,
    });
    expect(report).toContain("close=closed");
    expect(report).toContain("checklist=edited");
    expect(report).toContain("close=unchanged");
  });
});

describe("reconcileUmbrellas slices.jsonl (#3428)", () => {
  it("refreshes current-shape and closes all-children-merged umbrellas", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-3428-"));
    seedXbriefLayout(root);
    writeSliceRow(root, sliceRow(3377, [3388, 3389, 3390, 3391], "all-children-merged"));
    const client = new FakeUmbrellaClient();
    client.issueStates.set("deftai/directive:3377", "open");
    for (const n of [3388, 3389, 3390, 3391]) {
      client.issueStates.set(`deftai/directive:${n}`, "closed");
    }
    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-08-17T12:00:00Z",
      repo: "deftai/directive",
    });
    expect(code).toBe(0);
    expect(outcome.changed).toHaveLength(1);
    expect(outcome.changed[0]?.action).toBe("created");
    expect(outcome.changed[0]?.close_action).toBe("closed");
    expect(outcome.changed[0]?.body).toContain("Child count: 4 (0/4)");
    expect(outcome.changed[0]?.body).toContain("#3388");
    expect(client.closedIssues.has("deftai/directive:3377")).toBe(true);
    const comments = client.fetchComments("deftai/directive", 3377);
    expect(comments.some((c) => c.body.includes("## Current shape"))).toBe(true);
    expect(
      comments.some((c) =>
        c.body.includes(
          "expected_close_signal=all-children-merged; children: #3388, #3389, #3390, #3391",
        ),
      ),
    ).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("updates current-shape and leaves manual and wave-1-merged open", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-3428-noclose-"));
    seedXbriefLayout(root);
    writeSliceRow(root, sliceRow(3378, [3392, 3393], "manual"));
    writeSliceRow(root, {
      ...sliceRow(4001, [4002], "wave-1-merged"),
      slice_id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    const client = new FakeUmbrellaClient();
    client.issueStates.set("deftai/directive:3378", "open");
    client.issueStates.set("deftai/directive:4001", "open");
    client.issueStates.set("deftai/directive:3392", "closed");
    client.issueStates.set("deftai/directive:3393", "closed");
    client.issueStates.set("deftai/directive:4002", "closed");
    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-08-17T12:00:00Z",
      repo: "deftai/directive",
    });
    expect(code).toBe(0);
    expect(outcome.changed).toHaveLength(2);
    expect(outcome.changed.every((c) => c.close_action === "skipped")).toBe(true);
    expect(client.closedIssues.size).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op on re-run after close", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-3428-idemp-"));
    seedXbriefLayout(root);
    writeSliceRow(root, sliceRow(3377, [3388], "all-children-merged"));
    const client = new FakeUmbrellaClient();
    client.issueStates.set("deftai/directive:3377", "open");
    client.issueStates.set("deftai/directive:3388", "closed");
    const first = reconcileUmbrellas(root, {
      client,
      now: "2026-08-17T12:00:00Z",
      repo: "deftai/directive",
    });
    expect(first[1].changed[0]?.close_action).toBe("closed");
    const commentCount = client.fetchComments("deftai/directive", 3377).length;
    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-08-17T12:05:00Z",
      repo: "deftai/directive",
    });
    expect(code).toBe(0);
    expect(outcome.unchanged).toHaveLength(1);
    expect(outcome.unchanged[0]?.close_action).toBe("unchanged");
    expect(outcome.changed).toHaveLength(0);
    expect(client.fetchComments("deftai/directive", 3377)).toHaveLength(commentCount);
    rmSync(root, { recursive: true, force: true });
  });

  it("closes a slices row even when an epic xBRIEF already refreshed the umbrella", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-3428-overlap-"));
    seedXbriefLayout(root);
    writeFileSync(
      join(root, "xbrief", "active", "epic.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "epic-3377",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/3377",
            },
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/3388",
            },
          ],
        },
      })}\n`,
    );
    writeSliceRow(root, sliceRow(3377, [3388], "all-children-merged"));
    const client = new FakeUmbrellaClient();
    client.issueStates.set("deftai/directive:3377", "open");
    client.issueStates.set("deftai/directive:3388", "closed");
    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-08-17T12:00:00Z",
      repo: "deftai/directive",
    });
    expect(code).toBe(0);
    expect(outcome.changed).toHaveLength(1);
    expect(outcome.changed[0]?.story_id).toBe("epic-3377");
    expect(outcome.changed[0]?.close_action).toBe("closed");
    expect(client.closedIssues.has("deftai/directive:3377")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("dry-run reports closed without mutating", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-3428-dry-"));
    seedXbriefLayout(root);
    writeSliceRow(root, sliceRow(3377, [3388], "all-children-merged"));
    const client = new FakeUmbrellaClient();
    client.issueStates.set("deftai/directive:3377", "open");
    client.issueStates.set("deftai/directive:3388", "closed");
    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-08-17T12:00:00Z",
      repo: "deftai/directive",
      dryRun: true,
    });
    expect(code).toBe(0);
    expect(outcome.changed[0]?.close_action).toBe("closed");
    expect(client.closedIssues.size).toBe(0);
    expect(client.fetchComments("deftai/directive", 3377)).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("skips a slices umbrella with no repo", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-3428-norepo-"));
    seedXbriefLayout(root);
    writeSliceRow(root, {
      ...sliceRow(3377, [3388], "all-children-merged"),
      umbrella_url: "https://example.com/not-github/3377",
    });
    const [code, outcome] = reconcileUmbrellas(root, {
      client: new FakeUmbrellaClient(),
      now: "2026-08-17T12:00:00Z",
    });
    expect(code).toBe(0);
    expect(outcome.skipped_no_ref).toContain("slice-umbrella-3377");
    rmSync(root, { recursive: true, force: true });
  });

  it("does not close when a child is still open", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-3428-open-"));
    seedXbriefLayout(root);
    writeSliceRow(root, sliceRow(3377, [3388, 3389], "all-children-merged"));
    const client = new FakeUmbrellaClient();
    client.issueStates.set("deftai/directive:3377", "open");
    client.issueStates.set("deftai/directive:3388", "closed");
    client.issueStates.set("deftai/directive:3389", "open");
    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-08-17T12:00:00Z",
      repo: "deftai/directive",
    });
    expect(code).toBe(0);
    expect(outcome.changed[0]?.close_action).toBe("skipped");
    expect(outcome.changed[0]?.body).toContain("Child count: 2 (1/1)");
    expect(client.closedIssues.size).toBe(0);
    rmSync(root, { recursive: true, force: true });
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
