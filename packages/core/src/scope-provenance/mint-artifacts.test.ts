import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintApprovedScopeArtifacts } from "./mint-artifacts.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("mint-artifacts file (#3385)", () => {
  it("writes record and preimage together", () => {
    const root = mkdtempSync(join(tmpdir(), "mint-art-"));
    roots.push(root);
    const payload = {
      plan: { id: "mint-1", title: "T", metadata: { swarm: { file_scope: ["a.ts"] } } },
    };
    const minted = mintApprovedScopeArtifacts({
      xbriefRelPath: "xbrief/active/s.xbrief.json",
      payload,
      rawText: JSON.stringify(payload),
      projectRoot: root,
      extract: { projectRoot: root },
    });
    expect(minted.record.intentDigest).toMatch(/^[0-9a-f]{64}$/);
    const pre = JSON.parse(readFileSync(minted.intentPath, "utf8")) as { algo: string };
    expect(pre.algo).toBe("intent-extract-v1");
  });
});
