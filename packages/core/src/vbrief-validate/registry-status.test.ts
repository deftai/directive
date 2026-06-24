import { describe, expect, it } from "vitest";
import {
  deriveRegistryItemStatus,
  formatRegistryStatusMismatch,
  registryMetadataReferencesFromScope,
  registryStatusScopeUris,
} from "./registry-status.js";

describe("deriveRegistryItemStatus", () => {
  it("prefers plan.status over lifecycle folder", () => {
    expect(deriveRegistryItemStatus("cancelled", "completed")).toBe("cancelled");
  });

  it("falls back to lifecycle folder when plan.status is absent", () => {
    expect(deriveRegistryItemStatus(undefined, "pending")).toBe("pending");
  });
});

describe("registryMetadataReferencesFromScope", () => {
  it("keeps origin refs and drops local x-vbrief/plan links", () => {
    const refs = [
      {
        type: "x-vbrief/github-issue",
        uri: "https://github.com/deftai/directive/issues/1696",
      },
      {
        type: "x-vbrief/plan",
        uri: "completed/2026-06-16-story-a.vbrief.json",
        title: "Story A",
      },
    ];
    expect(registryMetadataReferencesFromScope(refs)).toEqual([refs[0]]);
  });
});

describe("registryStatusScopeUris", () => {
  it("uses source_path and explicit item refs, not metadata scope links", () => {
    const item = {
      id: "umbrella",
      title: "Umbrella epic",
      status: "cancelled",
      metadata: {
        source_path: "cancelled/2026-06-16-umbrella.vbrief.json",
        references: [
          {
            type: "x-vbrief/github-issue",
            uri: "https://github.com/deftai/directive/issues/99",
          },
          {
            type: "x-vbrief/plan",
            uri: "completed/2026-06-16-story-a.vbrief.json",
          },
        ],
      },
    };
    expect(registryStatusScopeUris(item, { references: [] })).toEqual([
      "cancelled/2026-06-16-umbrella.vbrief.json",
    ]);
  });

  it("includes plan-level refs matched by title", () => {
    const item = { title: "Feature X", status: "running" };
    const plan = {
      references: [
        {
          type: "x-vbrief/plan",
          uri: "active/2026-01-01-feature-x.vbrief.json",
          title: "Feature X",
        },
      ],
    };
    expect(registryStatusScopeUris(item, plan)).toEqual([
      "active/2026-01-01-feature-x.vbrief.json",
    ]);
  });
});

describe("formatRegistryStatusMismatch", () => {
  it("formats the D3 diagnostic", () => {
    expect(
      formatRegistryStatusMismatch(
        "vbrief/PROJECT-DEFINITION.vbrief.json",
        2,
        "cancelled",
        "completed/story.vbrief.json",
        "completed",
      ),
    ).toContain("(D3 registry-status)");
  });
});
