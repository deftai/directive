import { describe, expect, it } from "vitest";
import { evaluateMintLevelRecord } from "../policy/one-pr-scope-proof.js";
import { buildApprovedScopeRecord } from "../scope-provenance/digest.js";
import { extractIntentFromRaw } from "../scope-provenance/extract-intent.js";
import { computeAuthHashV1 } from "../scope-provenance/forge-approval.js";
import { computeIntentDigest } from "../scope-provenance/intent-digest.js";
import { isDeclaredArtifactPath, isFileShapedPointer } from "../verify-ac/clauses.js";
import { hasGlobMagic, isConcreteScopePath, matchPath } from "./pathspec.js";

const ROUTE = "web/src/app/crm/pipeline/[id]/page.tsx";
const GLOB_DENY = "head brief file_scope has a glob entry";

describe("isConcreteScopePath (#6936)", () => {
  it("treats brackets as literal and only * and ? as glob magic", () => {
    for (const entry of [
      ROUTE,
      "web/src/pages/[slug].tsx",
      "web/src/app/[...slug]/page.tsx",
      "web/src/app/[[...slug]]/page.tsx",
      "src/[a-z].ts",
      "src/a.ts",
    ]) {
      expect(isConcreteScopePath(entry)).toBe(true);
      expect(hasGlobMagic(entry)).toBe(false);
    }
    for (const entry of ["src/*.ts", "src/?.ts", "src/**", "", "   "]) {
      expect(isConcreteScopePath(entry)).toBe(false);
    }
    expect(hasGlobMagic("src/*.ts")).toBe(true);
    expect(hasGlobMagic("src/?.ts")).toBe(true);
  });

  it("matches a bracket entry only against the literal path, never a sibling", () => {
    expect(matchPath(ROUTE, ROUTE)).toBe(true);
    expect(matchPath(ROUTE, "web/src/app/crm/pipeline/i/page.tsx")).toBe(false);
    expect(matchPath(ROUTE, "web/src/app/crm/pipeline/d/page.tsx")).toBe(false);
  });

  it("lets verify-ac accept a bracket artifact pointer inside the declared scope", () => {
    expect(isFileShapedPointer(ROUTE)).toBe(true);
    expect(isDeclaredArtifactPath(ROUTE, [ROUTE])).toBe(true);
    expect(isDeclaredArtifactPath(ROUTE, ["web/src/app/"])).toBe(true);
    expect(isDeclaredArtifactPath("web/src/app/crm/pipeline/i/page.tsx", [ROUTE])).toBe(false);
    expect(isDeclaredArtifactPath("src/*.ts", ["src/"])).toBe(false);
  });
});

describe("one-PR scope proof with a bracket entry (#6936)", () => {
  const REL = "xbrief/active/s.xbrief.json";

  function mintInput(scope: readonly string[]) {
    const payload = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "s-1",
        title: "S",
        status: "running",
        metadata: { swarm: { file_scope: scope } },
      },
    };
    const raw = JSON.stringify(payload);
    const extracted = extractIntentFromRaw(raw, {});
    if (!extracted.ok) throw new Error(extracted.error);
    const record = {
      ...buildApprovedScopeRecord({
        xbriefRelPath: REL,
        payload,
        humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-11-13T00:00:00Z" },
        intentDigest: computeIntentDigest(extracted.preimage),
        digestAlgo: "intent-extract-v1",
      }),
      authHashV1: computeAuthHashV1(payload, REL) ?? "",
    };
    return {
      record,
      intentRaw: JSON.stringify(extracted.preimage),
      xbriefRelPath: REL,
      headPayload: payload,
      headRaw: raw,
    };
  }

  it("does not deny a bracket entry as a glob entry, and still denies a * entry", () => {
    const bracket = evaluateMintLevelRecord(mintInput(["src/a.ts", ROUTE]));
    expect(bracket).not.toMatchObject({ reason: GLOB_DENY });
    expect(bracket.kind).toBe("admit");
    expect(evaluateMintLevelRecord(mintInput(["src/a.ts", "src/*.ts"]))).toMatchObject({
      kind: "reject",
      reason: "head brief file_scope has a glob entry",
    });
  });
});
