import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containedWrite } from "../fs/contained-write.js";
import { MintPairRollbackError, mintApprovedScopeArtifacts } from "./mint-artifacts.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function payload(id: string, title: string) {
  return {
    plan: { id, title, metadata: { swarm: { file_scope: ["a.ts"] } } },
  };
}

function mint(
  root: string,
  body: ReturnType<typeof payload>,
  publishDest?: Parameters<typeof mintApprovedScopeArtifacts>[0]["publishDest"],
  restoreDest?: Parameters<typeof mintApprovedScopeArtifacts>[0]["restoreDest"],
  removeDest?: Parameters<typeof mintApprovedScopeArtifacts>[0]["removeDest"],
) {
  return mintApprovedScopeArtifacts({
    xbriefRelPath: "xbrief/active/s.xbrief.json",
    payload: body,
    rawText: JSON.stringify(body),
    projectRoot: root,
    extract: { projectRoot: root },
    publishDest,
    restoreDest,
    removeDest,
  });
}

function leftoverTmps(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("mint-artifacts file (#3385)", () => {
  it("writes record and preimage together", () => {
    const root = mkdtempSync(join(tmpdir(), "mint-art-"));
    roots.push(root);
    const minted = mint(root, payload("mint-1", "T"));
    expect(minted.record.intentDigest).toMatch(/^[0-9a-f]{64}$/);
    const pre = JSON.parse(readFileSync(minted.intentPath, "utf8")) as { algo: string };
    expect(pre.algo).toBe("intent-extract-v1");
    expect(existsSync(minted.recordPath)).toBe(true);
  });

  it("first mint: failed record publish leaves neither dest", () => {
    const root = mkdtempSync(join(tmpdir(), "mint-art-first-fail-"));
    roots.push(root);
    let intentPublished = false;
    expect(() =>
      mint(root, payload("mint-fail-1", "New"), ({ root: r, target, data }) => {
        if (target.endsWith(".intent.json")) {
          intentPublished = true;
          containedWrite({ root: r, target, data, mode: "replace" });
          return;
        }
        throw new Error("injected record publish failure");
      }),
    ).toThrow(/injected record publish failure/);
    expect(intentPublished).toBe(true);
    const dir = join(root, ".deft", "approved-scope");
    expect(existsSync(join(dir, "mint-fail-1.intent.json"))).toBe(false);
    expect(existsSync(join(dir, "mint-fail-1.json"))).toBe(false);
    expect(leftoverTmps(dir)).toEqual([]);
  });

  it("remint: failed record publish restores the prior matching pair", () => {
    const root = mkdtempSync(join(tmpdir(), "mint-art-remint-fail-"));
    roots.push(root);
    const first = mint(root, payload("mint-2", "Old"));
    const priorIntent = readFileSync(first.intentPath, "utf8");
    const priorRecord = readFileSync(first.recordPath, "utf8");
    expect(() =>
      mint(root, payload("mint-2", "New"), ({ root: r, target, data }) => {
        if (target.endsWith(".intent.json")) {
          containedWrite({ root: r, target, data, mode: "replace" });
          return;
        }
        throw new Error("injected remint record failure");
      }),
    ).toThrow(/injected remint record failure/);
    expect(readFileSync(first.intentPath, "utf8")).toBe(priorIntent);
    expect(readFileSync(first.recordPath, "utf8")).toBe(priorRecord);
    expect(JSON.parse(priorIntent) as { plan: { title: string } }).toMatchObject({
      plan: expect.objectContaining({ title: "Old" }),
    });
    expect(leftoverTmps(dirname(first.intentPath))).toEqual([]);
  });

  it("dest publish + restore failure clears leftover dests and names both errors", () => {
    const root = mkdtempSync(join(tmpdir(), "mint-art-restore-fail-"));
    roots.push(root);
    const first = mint(root, payload("mint-4", "Old"));
    let caught: unknown;
    try {
      mint(
        root,
        payload("mint-4", "New"),
        ({ root: r, target, data }) => {
          if (target.endsWith(".intent.json")) {
            containedWrite({ root: r, target, data, mode: "replace" });
            return;
          }
          throw new Error("injected remint record failure");
        },
        () => {
          throw new Error("injected restore failure");
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MintPairRollbackError);
    expect((caught as Error).message).toMatch(
      /injected remint record failure[\s\S]*injected restore failure[\s\S]*leftover dests were cleared/,
    );
    expect(existsSync(first.intentPath)).toBe(false);
    expect(existsSync(first.recordPath)).toBe(false);
    expect(leftoverTmps(dirname(first.intentPath))).toEqual([]);
  });

  it("first dest publish throw after a write still restores the prior pair", () => {
    const root = mkdtempSync(join(tmpdir(), "mint-art-first-dest-throw-"));
    roots.push(root);
    const first = mint(root, payload("mint-5", "Old"));
    const priorIntent = readFileSync(first.intentPath, "utf8");
    const priorRecord = readFileSync(first.recordPath, "utf8");
    expect(() =>
      mint(root, payload("mint-5", "New"), ({ root: r, target, data }) => {
        if (target.endsWith(".intent.json")) {
          containedWrite({ root: r, target, data, mode: "replace" });
          throw new Error("injected intent publish failure after write");
        }
        containedWrite({ root: r, target, data, mode: "replace" });
      }),
    ).toThrow(/injected intent publish failure after write/);
    expect(readFileSync(first.intentPath, "utf8")).toBe(priorIntent);
    expect(readFileSync(first.recordPath, "utf8")).toBe(priorRecord);
    expect(leftoverTmps(dirname(first.intentPath))).toEqual([]);
  });

  it("first mint: first dest publish throw after a write leaves neither dest", () => {
    const root = mkdtempSync(join(tmpdir(), "mint-art-first-dest-first-mint-"));
    roots.push(root);
    expect(() =>
      mint(root, payload("mint-6", "New"), ({ root: r, target, data }) => {
        if (target.endsWith(".intent.json")) {
          containedWrite({ root: r, target, data, mode: "replace" });
          throw new Error("injected first-mint intent publish failure after write");
        }
        containedWrite({ root: r, target, data, mode: "replace" });
      }),
    ).toThrow(/injected first-mint intent publish failure after write/);
    const dir = join(root, ".deft", "approved-scope");
    expect(existsSync(join(dir, "mint-6.intent.json"))).toBe(false);
    expect(existsSync(join(dir, "mint-6.json"))).toBe(false);
    expect(leftoverTmps(dir)).toEqual([]);
  });

  it("partial dest cleanup puts removed dests back so authority is not split", () => {
    const root = mkdtempSync(join(tmpdir(), "mint-art-partial-clear-"));
    roots.push(root);
    const first = mint(root, payload("mint-7", "Old"));
    const priorIntent = readFileSync(first.intentPath, "utf8");
    const priorRecord = readFileSync(first.recordPath, "utf8");
    let caught: unknown;
    try {
      mint(
        root,
        payload("mint-7", "New"),
        ({ root: r, target, data }) => {
          if (target.endsWith(".intent.json")) {
            containedWrite({ root: r, target, data, mode: "replace" });
            return;
          }
          throw new Error("injected remint record failure");
        },
        () => {
          throw new Error("injected restore failure");
        },
        ({ target }) => {
          if (target.endsWith(".json") && !target.endsWith(".intent.json")) {
            throw new Error("injected record cleanup failure");
          }
          rmSync(target, { force: true });
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MintPairRollbackError);
    expect((caught as Error).message).toMatch(
      /injected remint record failure[\s\S]*injected restore failure[\s\S]*injected record cleanup failure/,
    );
    expect(readFileSync(first.intentPath, "utf8")).toBe(priorIntent);
    expect(readFileSync(first.recordPath, "utf8")).toBe(priorRecord);
    expect(leftoverTmps(dirname(first.intentPath))).toEqual([]);
  });

  it("names put-back failure when a removed dest cannot be restored", () => {
    const root = mkdtempSync(join(tmpdir(), "mint-art-putback-fail-"));
    roots.push(root);
    const first = mint(root, payload("mint-8", "Old"));
    let caught: unknown;
    try {
      mint(
        root,
        payload("mint-8", "New"),
        ({ root: r, target, data }) => {
          if (target.endsWith(".intent.json")) {
            containedWrite({ root: r, target, data, mode: "replace" });
            return;
          }
          throw new Error("injected remint record failure");
        },
        () => {
          throw new Error("injected restore failure");
        },
        ({ target }) => {
          if (target.endsWith(".json") && !target.endsWith(".intent.json")) {
            throw new Error("injected record cleanup failure");
          }
          rmSync(target, { force: true });
          mkdirSync(target);
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MintPairRollbackError);
    expect((caught as Error).message).toMatch(
      /injected remint record failure[\s\S]*injected restore failure[\s\S]*injected record cleanup failure[\s\S]*removed dests could not be put back/,
    );
    rmSync(first.intentPath, { recursive: true, force: true });
  });

  it("writes both dests on remint when the pair succeeds", () => {
    const root = mkdtempSync(join(tmpdir(), "mint-art-remint-ok-"));
    roots.push(root);
    const first = mint(root, payload("mint-3", "Old"));
    const second = mint(root, payload("mint-3", "New"));
    expect(second.recordPath).toBe(first.recordPath);
    const pre = JSON.parse(readFileSync(second.intentPath, "utf8")) as {
      plan: { title: string };
    };
    expect(pre.plan.title).toBe("New");
    const rec = JSON.parse(readFileSync(second.recordPath, "utf8")) as { intentDigest: string };
    expect(rec.intentDigest).toBe(second.record.intentDigest);
    expect(rec.intentDigest).not.toBe(first.record.intentDigest);
  });
});
