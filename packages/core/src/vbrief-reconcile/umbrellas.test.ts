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
