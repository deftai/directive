import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateVbriefSchema } from "../vbrief-validate/schema.js";
import { detectLegacyVbriefLayout } from "./detect.js";
import {
  assertFeatureEmissionAllowed,
  assertLayoutAwareWritePath,
  FeatureEmissionRejectedError,
  resolveLayoutAwareRelativePath,
  rewriteEmbeddedTokens,
  SplitLayoutRejectedError,
  TransformError,
  transformArtifactV06ToV08,
  transformArtifactV06ToV08Transactional,
} from "./transforms.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE_V06 = {
  vBRIEFInfo: {
    version: "0.6",
    description: "fixture",
    created: "2026-06-30T00:00:00Z",
    updated: "2026-06-30T00:00:00Z",
  },
  plan: {
    title: "Legacy story",
    status: "running",
    items: [],
    references: [
      {
        uri: "https://github.com/deftai/directive/issues/2108",
        type: "x-vbrief/github-issue",
        title: "Issue #2108",
      },
      {
        uri: "vbrief/active/2026-06-30-child.vbrief.json",
        type: "x-vbrief/plan",
        title: "Child",
      },
    ],
  },
} as const;

/** Hybrid: layout already xbrief / xBRIEFInfo key, envelope still 0.6 (#2970). */
const SAMPLE_HYBRID_V06 = {
  xBRIEFInfo: {
    version: "0.6",
    description: "hybrid fixture",
    created: "2026-06-30T00:00:00Z",
    updated: "2026-06-30T00:00:00Z",
  },
  plan: {
    title: "Hybrid story",
    status: "running",
    items: [],
    references: [
      {
        uri: "https://github.com/deftai/directive/issues/2970",
        type: "x-vbrief/github-issue",
        title: "Issue #2970",
      },
      {
        uri: "xbrief/active/2026-06-30-child.xbrief.json",
        type: "x-vbrief/plan",
        title: "Child",
      },
    ],
  },
} as const;

describe("transformArtifactV06ToV08", () => {
  it("converts v0.6 to valid v0.8 and is idempotent on rerun", () => {
    const first = transformArtifactV06ToV08(structuredClone(SAMPLE_V06) as Record<string, unknown>);
    expect(first).not.toHaveProperty("vBRIEFInfo");
    expect(first).toMatchObject({
      xBRIEFInfo: { version: "0.8", description: "fixture" },
      plan: {
        references: [
          {
            type: "x-xbrief/github-issue",
            uri: "https://github.com/deftai/directive/issues/2108",
          },
          {
            type: "x-xbrief/plan",
            uri: "xbrief/active/2026-06-30-child.xbrief.json",
          },
        ],
      },
    });
    // v0.6 → v0.8 transform rewrites vbrief/ → xbrief/ and x-vbrief/ → x-xbrief/ in references
    expect(validateVbriefSchema(first, "transformed.json")).toEqual([]);

    const second = transformArtifactV06ToV08(first);
    expect(second).toEqual(first);
  });

  it("accepts hybrid xBRIEFInfo@0.6 and emits xBRIEFInfo@0.8", () => {
    const first = transformArtifactV06ToV08(
      structuredClone(SAMPLE_HYBRID_V06) as Record<string, unknown>,
    );
    expect(first).not.toHaveProperty("vBRIEFInfo");
    expect(first).toMatchObject({
      xBRIEFInfo: { version: "0.8", description: "hybrid fixture" },
      plan: {
        references: [
          {
            type: "x-xbrief/github-issue",
            uri: "https://github.com/deftai/directive/issues/2970",
          },
          {
            type: "x-xbrief/plan",
            uri: "xbrief/active/2026-06-30-child.xbrief.json",
          },
        ],
      },
    });
    expect(validateVbriefSchema(first, "hybrid-transformed.json")).toEqual([]);
  });

  it("is idempotent on a second pass of hybrid xBRIEFInfo@0.6 input", () => {
    const input = structuredClone(SAMPLE_HYBRID_V06) as Record<string, unknown>;
    const first = transformArtifactV06ToV08(input);
    const second = transformArtifactV06ToV08(first);
    expect(second).toEqual(first);
    expect(second).toMatchObject({ xBRIEFInfo: { version: "0.8" } });
  });

  it("does not require vBRIEFInfo when hybrid xBRIEFInfo@0.6 is present", () => {
    const input = structuredClone(SAMPLE_HYBRID_V06) as Record<string, unknown>;
    expect(input).not.toHaveProperty("vBRIEFInfo");
    expect(() => transformArtifactV06ToV08(input)).not.toThrow();
  });

  it("rewrites embedded tokens idempotently", () => {
    const input = "x-vbrief/plan vbrief/active/a.xbrief.json";
    expect(rewriteEmbeddedTokens(input)).toBe("x-xbrief/plan xbrief/active/a.xbrief.json");
    expect(rewriteEmbeddedTokens(rewriteEmbeddedTokens(input))).toBe(rewriteEmbeddedTokens(input));
  });

  it("does not rewrite external http(s) uri strings", () => {
    const uri = "https://github.com/deftai/xbrief/blob/main/spec.md";
    expect(rewriteEmbeddedTokens(uri)).toBe(uri);
  });

  it("returns original artifact unchanged on transactional failure", () => {
    const bad = structuredClone(SAMPLE_V06) as Record<string, unknown>;
    (bad.vBRIEFInfo as Record<string, unknown>).version = "0.7";

    const result = transformArtifactV06ToV08Transactional(bad);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.artifact).toBe(bad);
    expect(result.artifact.vBRIEFInfo).toMatchObject({ version: "0.7" });
    expect(() => transformArtifactV06ToV08(bad)).toThrow(TransformError);
  });

  it("does not mutate the input object on success", () => {
    const input = structuredClone(SAMPLE_V06) as Record<string, unknown>;
    const snapshot = structuredClone(input);
    transformArtifactV06ToV08(input);
    expect(input).toEqual(snapshot);
  });
});

describe("assertFeatureEmissionAllowed", () => {
  const v06Target = structuredClone(SAMPLE_V06) as Record<string, unknown>;

  it("rejects xBRIEFInfo emission into a v0.6 artifact", () => {
    expect(() =>
      assertFeatureEmissionAllowed(v06Target, { xBRIEFInfo: { version: "0.8" } }),
    ).toThrow(FeatureEmissionRejectedError);
  });

  it("rejects status auto emission into a v0.6 artifact", () => {
    expect(() =>
      assertFeatureEmissionAllowed(v06Target, {
        plan: { items: [{ id: "1", title: "x", status: "auto" }] },
      }),
    ).toThrow(FeatureEmissionRejectedError);
  });

  it("rejects container type emission into a v0.6 artifact", () => {
    expect(() =>
      assertFeatureEmissionAllowed(v06Target, {
        plan: { items: [{ id: "epic-1", title: "Epic", status: "running", type: "epic" }] },
      }),
    ).toThrow(FeatureEmissionRejectedError);
  });

  it("allows v0.8-only emission once the artifact declares version 0.8", () => {
    const migrated = transformArtifactV06ToV08(
      structuredClone(SAMPLE_V06) as Record<string, unknown>,
    );
    expect(() =>
      assertFeatureEmissionAllowed(migrated, {
        plan: {
          items: [{ id: "epic-1", title: "Epic", status: "auto", type: "epic" }],
        },
      }),
    ).not.toThrow();
  });

  it("rejects v0.8-only emission when the artifact has no declared version", () => {
    expect(() =>
      assertFeatureEmissionAllowed(
        { plan: { title: "No info block", status: "running", items: [] } },
        { xBRIEFInfo: { version: "0.8" } },
      ),
    ).toThrow(FeatureEmissionRejectedError);
  });
});

describe("layout-aware write helpers", () => {
  it("maps migrated relative paths back to legacy vbrief paths", () => {
    expect(resolveLayoutAwareRelativePath(true, "xbrief/active/2026-06-30-story.xbrief.json")).toBe(
      "vbrief/active/2026-06-30-story.vbrief.json",
    );
    expect(
      resolveLayoutAwareRelativePath(false, "xbrief/active/2026-06-30-story.xbrief.json"),
    ).toBe("xbrief/active/2026-06-30-story.xbrief.json");
  });

  it("refuses to target xbrief/ when legacy vbrief/ layout is present", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-migrate-layout-"));
    temps.push(root);
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "story.vbrief.json"),
      JSON.stringify(SAMPLE_V06),
      "utf8",
    );

    const detection = detectLegacyVbriefLayout(root);
    expect(detection.legacyLayout).toBe(true);
    expect(detection.reasons.some((r) => r.includes("vbrief/"))).toBe(true);

    expect(() =>
      assertLayoutAwareWritePath(root, "xbrief/active/story.xbrief.json", detection.legacyLayout),
    ).toThrow(SplitLayoutRejectedError);

    const legacyRelative = assertLayoutAwareWritePath(
      root,
      resolveLayoutAwareRelativePath(true, "xbrief/active/story.xbrief.json"),
      detection.legacyLayout,
    );
    expect(legacyRelative).toBe("vbrief/active/story.vbrief.json");
    expect(existsSync(join(root, "xbrief"))).toBe(false);
  });
});

describe("detectLegacyVbriefLayout", () => {
  it("returns empty reasons on a migrated xbrief tree", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-migrate-detect-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const migrated = transformArtifactV06ToV08(
      structuredClone(SAMPLE_V06) as Record<string, unknown>,
    );
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify(migrated),
      "utf8",
    );

    const detection = detectLegacyVbriefLayout(root);
    expect(detection).toEqual({ legacyLayout: false, reasons: [] });
  });

  it("collects structured reasons across legacy markers", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-migrate-detect-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify(SAMPLE_V06),
      "utf8",
    );

    const detection = detectLegacyVbriefLayout(root);
    expect(detection.legacyLayout).toBe(true);
    expect(detection.reasons.length).toBeGreaterThan(1);
    expect(detection.reasons.some((r) => r.includes("legacy info root key"))).toBe(true);
    expect(detection.reasons.some((r) => r.includes("x-vbrief/"))).toBe(true);
  });

  it("flags v0.6 content inside an xbrief tree", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-migrate-detect-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify(SAMPLE_V06),
      "utf8",
    );

    const detection = detectLegacyVbriefLayout(root);
    expect(detection.legacyLayout).toBe(true);
    expect(detection.reasons.some((r) => r.includes("legacy info root key"))).toBe(true);
  });
});
