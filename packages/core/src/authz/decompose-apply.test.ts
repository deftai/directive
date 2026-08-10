/**
 * Structural scope:decompose apply authz (#3239).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintHumanOriginGrant } from "./actions.js";
import {
  evaluateDecomposeStructuralApply,
  mintDecomposeStructuralApplyGrant,
  sha256FileHex,
  sha256Hex,
  toProjectRelativePosix,
} from "./decompose-apply.js";
import { saveGrant } from "./store.js";
import { type HumanOriginGrant, SCOPE_DECOMPOSE_APPLY_STRUCTURAL } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "authz-decompose-"));
  roots.push(root);
  return root;
}

function writeDraft(root: string, body: string = '{"stories":[]}'): string {
  const dir = join(root, "xbrief", ".triage-cache");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "draft.json");
  writeFileSync(path, body, "utf8");
  return path;
}

function writeParent(root: string): string {
  const dir = join(root, "xbrief", "pending");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "parent.xbrief.json");
  writeFileSync(path, '{"plan":{"id":"p"}}', "utf8");
  return path;
}

describe("decompose-apply helpers (#3239)", () => {
  it("sha256Hex is stable for known input", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("toProjectRelativePosix rejects escape", () => {
    const root = tempRoot();
    expect(toProjectRelativePosix(root, join(root, "a", "b.json"))).toBe("a/b.json");
    expect(toProjectRelativePosix(root, join(root, "..", "outside"))).toBeNull();
  });

  it("mint + evaluate allows matching human-origin grant", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root, '{"stories":[1]}');
    const grant = mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      grantId: "g-ok",
    });
    expect(grant.scope.operations).toContain(SCOPE_DECOMPOSE_APPLY_STRUCTURAL);
    expect(grant.scope.contentDigest).toBe(sha256FileHex(draft));
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.humanApprovalRef).toBe("g-ok");
    expect(decision.code).toBe("authz-allow");
  });

  it("missing grant denies", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-missing");
  });

  it("digest mismatch denies", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root, '{"stories":["x"]}');
    mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
    });
    writeFileSync(draft, '{"stories":["y"]}', "utf8");
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-digest-mismatch");
  });

  it("parent mismatch denies", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const otherParent = join(root, "xbrief", "pending", "other.xbrief.json");
    writeFileSync(otherParent, "{}", "utf8");
    const draft = writeDraft(root);
    mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
    });
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: otherParent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-parent-mismatch");
  });

  it("agent-origin grant denies", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    const digest = sha256FileHex(draft);
    const forged: HumanOriginGrant = {
      schemaVersion: 1,
      id: "forged",
      origin: {
        kind: "agent-authored",
        actor: "agent",
        mintedAt: "2026-08-10T00:00:00Z",
        mintedVia: "self",
        eventRef: null,
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: resolve(root),
        surfaces: [],
        operations: [SCOPE_DECOMPOSE_APPLY_STRUCTURAL],
        storyIds: [],
        issueIds: [],
        cohortId: null,
        contentDigest: digest,
        parentPath: toProjectRelativePosix(root, parent),
        targetPath: toProjectRelativePosix(root, draft),
      },
      semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
    };
    saveGrant(root, forged);
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: digest,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-origin-reject");
  });

  it("expired grant denies", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      expiresAt: "2020-01-01T00:00:00Z",
    });
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
      now: new Date("2026-08-10T00:00:00Z"),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-expired");
  });

  it("wrong operation class does not cover structural apply", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      worktree: resolve(root),
      contentDigest: sha256FileHex(draft),
      parentPath: toProjectRelativePosix(root, parent),
      targetPath: toProjectRelativePosix(root, draft),
    });
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-scope-deny");
  });

  it("repo binding mismatch denies when grant pins repo", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      repo: "deftai/directive",
    });
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
      repo: "other/repo",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-project-mismatch");
  });

  it("incomplete binding (no digest) denies", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    mintHumanOriginGrant({
      projectRoot: root,
      operations: [SCOPE_DECOMPOSE_APPLY_STRUCTURAL],
      worktree: resolve(root),
      parentPath: toProjectRelativePosix(root, parent),
      targetPath: toProjectRelativePosix(root, draft),
      // contentDigest intentionally omitted
    });
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-binding-incomplete");
  });
});
