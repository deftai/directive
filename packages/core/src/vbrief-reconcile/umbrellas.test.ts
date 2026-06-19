import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Child, UmbrellaClient } from "./types.js";
import {
  classifyPassType,
  computeWaves,
  parseCurrentShape,
  reconcileUmbrellas,
  renderBody,
} from "./umbrellas.js";

class FakeUmbrellaClient implements UmbrellaClient {
  comments = new Map<string, Array<{ id: number; body: string }>>();
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
}

const child = (id: string, folder = "active", deps: string[] = []): Child => ({
  story_id: id,
  title: id,
  kind: "story",
  folder,
  depends_on: deps,
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
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "child.vbrief.json"),
      `${JSON.stringify({ plan: { id: "child-a", metadata: { kind: "story", swarm: { depends_on: [] } } } })}\n`,
    );
    writeFileSync(
      join(active, "epic.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "epic-1",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/plan", uri: "active/child.vbrief.json", title: "child-a" },
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
    });
    expect(code).toBe(0);
    expect(outcome.changed[0]?.action).toBe("created");
    rmSync(root, { recursive: true, force: true });
  });
});
