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
  formatDecomposeStructuralMintCommand,
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

  it("case-variant parent path does not match bound parent (case-sensitive)", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    const bound = toProjectRelativePosix(root, parent) ?? "xbrief/pending/parent.xbrief.json";
    const flipped = bound.includes("pending")
      ? bound.replace("pending", "PENDING")
      : bound.replace(/xbrief/, "XBRIEF");
    expect(flipped).not.toBe(bound);
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
      grants: [
        {
          schemaVersion: 1,
          id: "case-only",
          origin: {
            kind: "operator-cli",
            actor: "op",
            mintedAt: "2026-08-10T00:00:00Z",
            mintedVia: "test",
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
            contentDigest: sha256FileHex(draft),
            parentPath: flipped,
            targetPath: toProjectRelativePosix(root, draft),
          },
          semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
        },
      ],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-parent-mismatch");
  });

  it("formatDecomposeStructuralMintCommand is the exact operator path (#3291)", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    const cmd = formatDecomposeStructuralMintCommand(parent, draft, {
      projectRoot: root,
      repo: "deftai/directive",
    });
    expect(cmd).toBe(
      "deft authz:grant -- --parent xbrief/pending/parent.xbrief.json " +
        "--draft xbrief/.triage-cache/draft.json --repo deftai/directive --confirm",
    );
    // Without projectRoot / repo: keep raw paths and omit --repo
    const bare = formatDecomposeStructuralMintCommand("a/parent.json", "b/draft.json");
    expect(bare).toBe("deft authz:grant -- --parent a/parent.json --draft b/draft.json --confirm");
    // Escape paths fall back to provided path form when relativize fails (parent and draft).
    const escaped = formatDecomposeStructuralMintCommand(
      join(root, "..", "out-p.json"),
      join(root, "..", "out-d.json"),
      { projectRoot: root },
    );
    expect(escaped).toContain("--parent");
    expect(escaped).toContain("--draft");
    expect(escaped).toContain("--confirm");
    expect(escaped).not.toContain("--repo");
    // Empty / whitespace repo is omitted
    expect(formatDecomposeStructuralMintCommand("p.json", "d.json", { repo: "  " })).toBe(
      "deft authz:grant -- --parent p.json --draft d.json --confirm",
    );
  });

  it("missing-grant deny includes exact mint command with paths (#3291)", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
      repo: "owner/name",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-missing");
    expect(decision.reason).toContain("deft authz:grant -- --parent");
    expect(decision.reason).toContain("xbrief/pending/parent.xbrief.json");
    expect(decision.reason).toContain("--draft");
    expect(decision.reason).toContain("--repo owner/name");
    expect(decision.reason).toContain("--confirm");
  });

  it("matching repo allows; mismatch denies before writes (#3291)", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      repo: "deftai/directive",
      grantId: "repo-bound",
    });
    const ok = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
      repo: "deftai/directive",
    });
    expect(ok.allowed).toBe(true);
    const bad = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
      repo: "other/repo",
    });
    expect(bad.allowed).toBe(false);
    expect(bad.code).toBe("authz-grant-project-mismatch");
    expect(bad.reason).toContain("deft authz:grant -- --parent");
  });

  it("single-use spent deny includes mint command", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    const grant = mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      singleUse: true,
      grantId: "spent-once",
    });
    // Mark spent
    saveGrant(root, {
      ...grant,
      semantics: {
        ...grant.semantics,
        usedAt: "2026-08-10T12:00:00Z",
      },
    });
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("authz-grant-single-use-spent");
    expect(decision.reason).toContain("deft authz:grant -- --parent");
  });

  it("target mismatch and worktree mismatch include mint command (#3291)", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root, '{"stories":[1]}');
    mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      grantId: "target-bound",
    });
    const otherDraft = join(root, "xbrief", ".triage-cache", "other.json");
    writeFileSync(otherDraft, '{"stories":[1]}', "utf8");
    const targetMiss = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: otherDraft,
      draftDigest: sha256FileHex(otherDraft),
    });
    expect(targetMiss.allowed).toBe(false);
    expect(targetMiss.code).toBe("authz-grant-target-mismatch");
    expect(targetMiss.reason).toContain("deft authz:grant -- --parent");

    const wtRoot = tempRoot();
    const wtParent = writeParent(wtRoot);
    const wtDraft = writeDraft(wtRoot);
    const digest = sha256FileHex(wtDraft);
    saveGrant(wtRoot, {
      schemaVersion: 1,
      id: "wt-mismatch",
      origin: {
        kind: "operator-cli",
        actor: "op",
        mintedAt: "2026-08-10T00:00:00Z",
        mintedVia: "test",
        eventRef: null,
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: resolve(root), // different worktree
        surfaces: [],
        operations: [SCOPE_DECOMPOSE_APPLY_STRUCTURAL],
        storyIds: [],
        issueIds: [],
        cohortId: null,
        contentDigest: digest,
        parentPath: toProjectRelativePosix(wtRoot, wtParent),
        targetPath: toProjectRelativePosix(wtRoot, wtDraft),
      },
      semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
    });
    const wtMiss = evaluateDecomposeStructuralApply({
      projectRoot: wtRoot,
      parentPath: wtParent,
      draftPath: wtDraft,
      draftDigest: digest,
    });
    expect(wtMiss.allowed).toBe(false);
    expect(wtMiss.code).toBe("authz-grant-project-mismatch");
    expect(wtMiss.reason).toContain("deft authz:grant -- --parent");
  });

  it("path outside project root deny includes mint command", () => {
    const root = tempRoot();
    const draft = writeDraft(root);
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: join(root, "..", "escape.json"),
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/outside the project root/);
    expect(decision.reason).toContain("deft authz:grant -- --parent");
  });

  it("unknown origin kind and unknown non-rejected origin both deny with mint command", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    const digest = sha256FileHex(draft);
    saveGrant(root, {
      schemaVersion: 1,
      id: "unknown-kind",
      origin: {
        kind: "not-a-known-kind" as "operator-cli",
        actor: "someone",
        mintedAt: "2026-08-10T00:00:00Z",
        mintedVia: "test",
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
    });
    const d = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: digest,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("authz-grant-origin-reject");
    expect(d.reason).toContain("deft authz:grant -- --parent");
  });

  it("operator-cli with empty or agent-shaped actor fails human-origin gate", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    const digest = sha256FileHex(draft);
    for (const actor of ["", "agent", "agent:bot", "self"]) {
      saveGrant(root, {
        schemaVersion: 1,
        id: `bad-actor-${actor || "empty"}`,
        origin: {
          kind: "operator-cli",
          actor,
          mintedAt: "2026-08-10T00:00:00Z",
          mintedVia: "test",
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
      });
    }
    const decision = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: digest,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("deft authz:grant -- --parent");
  });

  it("empty and undefined digest normalize to deny; absolute draft mint works", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    const missEmpty = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: "   ",
    });
    expect(missEmpty.allowed).toBe(false);
    // Mint with absolute draft path (exercises isAbsolute branch in mint helper)
    const grant = mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: resolve(draft),
      grantId: "abs-draft",
    });
    expect(grant.scope.contentDigest).toBe(sha256FileHex(draft));
    // Explicit contentDigest path on mint
    const g2 = mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      contentDigest: sha256FileHex(draft),
      grantId: "explicit-digest",
    });
    expect(g2.scope.contentDigest).toBe(sha256FileHex(draft));
  });

  it("revoked grant denies; sha256: prefix digest matches; mint guards fire", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root, '{"stories":[]}');
    const digest = sha256FileHex(draft);
    // sha256: prefix accepted on evaluate
    mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      contentDigest: `sha256:${digest}`,
      grantId: "prefixed",
    });
    const ok = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: digest,
    });
    expect(ok.allowed).toBe(true);

    const root2 = tempRoot();
    const p2 = writeParent(root2);
    const d2 = writeDraft(root2);
    const g = mintDecomposeStructuralApplyGrant({
      projectRoot: root2,
      parentPath: p2,
      draftPath: d2,
      grantId: "revoked-g",
    });
    saveGrant(root2, {
      ...g,
      semantics: { ...g.semantics, revokedAt: "2026-08-01T00:00:00Z" },
    });
    const revoked = evaluateDecomposeStructuralApply({
      projectRoot: root2,
      parentPath: p2,
      draftPath: d2,
      draftDigest: sha256FileHex(d2),
    });
    expect(revoked.allowed).toBe(false);
    expect(revoked.code).toBe("authz-grant-revoked");

    expect(() =>
      mintDecomposeStructuralApplyGrant({
        projectRoot: root2,
        parentPath: join(root2, "..", "escape.json"),
        draftPath: d2,
      }),
    ).toThrow(/inside projectRoot/);
    expect(() =>
      mintDecomposeStructuralApplyGrant({
        projectRoot: root2,
        parentPath: p2,
        draftPath: d2,
        contentDigest: "   ",
      }),
    ).toThrow(/contentDigest must be non-empty/);
  });

  it("expired, wrong-op, incomplete-binding denies include mint command (#3291)", () => {
    const root = tempRoot();
    const parent = writeParent(root);
    const draft = writeDraft(root);
    mintDecomposeStructuralApplyGrant({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      expiresAt: "2020-01-01T00:00:00Z",
      grantId: "exp-mint",
    });
    const expired = evaluateDecomposeStructuralApply({
      projectRoot: root,
      parentPath: parent,
      draftPath: draft,
      draftDigest: sha256FileHex(draft),
      now: new Date("2026-08-11T00:00:00Z"),
    });
    expect(expired.code).toBe("authz-grant-expired");
    expect(expired.reason).toContain("deft authz:grant -- --parent");

    const root2 = tempRoot();
    const p2 = writeParent(root2);
    const d2 = writeDraft(root2);
    mintHumanOriginGrant({
      projectRoot: root2,
      operations: ["edit"],
      worktree: resolve(root2),
      contentDigest: sha256FileHex(d2),
      parentPath: toProjectRelativePosix(root2, p2),
      targetPath: toProjectRelativePosix(root2, d2),
    });
    const wrongOp = evaluateDecomposeStructuralApply({
      projectRoot: root2,
      parentPath: p2,
      draftPath: d2,
      draftDigest: sha256FileHex(d2),
    });
    expect(wrongOp.code).toBe("authz-grant-scope-deny");
    expect(wrongOp.reason).toContain("deft authz:grant -- --parent");

    const root3 = tempRoot();
    const p3 = writeParent(root3);
    const d3 = writeDraft(root3);
    mintHumanOriginGrant({
      projectRoot: root3,
      operations: [SCOPE_DECOMPOSE_APPLY_STRUCTURAL],
      // no worktree, no repo → incomplete project identity
      contentDigest: sha256FileHex(d3),
      parentPath: toProjectRelativePosix(root3, p3),
      targetPath: toProjectRelativePosix(root3, d3),
    });
    const incomplete = evaluateDecomposeStructuralApply({
      projectRoot: root3,
      parentPath: p3,
      draftPath: d3,
      draftDigest: sha256FileHex(d3),
    });
    expect(incomplete.code).toBe("authz-grant-binding-incomplete");
    expect(incomplete.reason).toContain("deft authz:grant -- --parent");
  });
});
