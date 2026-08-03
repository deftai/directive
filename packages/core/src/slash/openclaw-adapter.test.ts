import { describe, expect, it } from "vitest";
import { HOST_COMMAND_LAYOUTS, SLASH_EMITTER_HOSTS } from "./emitters.js";
import { generateThinWrappers } from "./generator.js";
import {
  assertThinOpenClawArtifacts,
  generateOpenClawSkillArtifacts,
  isManagedOpenClawL2Skill,
  isManagedOpenClawRouterSkill,
  isThinOpenClawSkillMarkdown,
  listOpenClawManagedSkillSlugs,
  OPENCLAW_L2_MANAGED_MARKER,
} from "./openclaw-adapter.js";
import { OPENCLAW_ROUTER_SLUG } from "./openclaw-slugs.js";
import { listProductCommands, PRODUCT_COMMAND_COUNT } from "./product-set.js";

describe("OpenClaw L2 skill adapter (#3064 D1/D3)", () => {
  it("emits router + 13 product skills from generateThinWrappers IR", () => {
    const wrappers = generateThinWrappers();
    const artifacts = generateOpenClawSkillArtifacts(wrappers);
    expect(artifacts).toHaveLength(PRODUCT_COMMAND_COUNT + 1);
    expect(artifacts.filter((a) => a.role === "router")).toHaveLength(1);
    expect(artifacts.filter((a) => a.role === "product")).toHaveLength(PRODUCT_COMMAND_COUNT);

    const productLogical = artifacts.filter((a) => a.role === "product").map((a) => a.logicalId);
    expect(productLogical).toEqual(listProductCommands().map((c) => c.logicalId));
    expect(listOpenClawManagedSkillSlugs()).toContain(OPENCLAW_ROUTER_SLUG);
    expect(listOpenClawManagedSkillSlugs()).toHaveLength(PRODUCT_COMMAND_COUNT + 1);
  });

  it("keeps product skills thin (dispatch pointer only)", () => {
    const artifacts = generateOpenClawSkillArtifacts();
    expect(() => assertThinOpenClawArtifacts(artifacts)).not.toThrow();
    for (const a of artifacts.filter((x) => x.role === "product")) {
      expect(a.skillMarkdown).toContain("user-invocable: true");
      expect(a.skillMarkdown).toContain(OPENCLAW_L2_MANAGED_MARKER);
      expect(a.skillMarkdown).toContain(a.dispatchPath as string);
      expect(a.skillMarkdown).toContain("Read and follow");
      expect(a.skillMarkdown).toContain("Do not inline");
      expect(a.skillMarkdown).not.toMatch(/^##\s+(Phase|Workflow|Steps|Acceptance)\b/m);
      expect(
        isThinOpenClawSkillMarkdown(a.skillMarkdown, {
          dispatchPath: a.dispatchPath,
          role: "product",
        }),
      ).toBe(true);
    }
  });

  it("marks router for native-menu-first use", () => {
    const router = generateOpenClawSkillArtifacts().find((a) => a.role === "router");
    expect(router).toBeDefined();
    expect(router?.slug).toBe(OPENCLAW_ROUTER_SLUG);
    expect(isManagedOpenClawRouterSkill(router?.skillMarkdown ?? "")).toBe(true);
    expect(router?.skillMarkdown).toContain("user-invocable: true");
    expect(router?.skillMarkdown).toMatch(/Telegram|native/i);
    // Router documents all 13 slugs without inlining strategy bodies.
    for (const cmd of listProductCommands()) {
      expect(router?.skillMarkdown).toContain(cmd.logicalId);
    }
  });

  it("does not add openclaw to file-emitter host layouts (L6 / non-goal)", () => {
    expect(SLASH_EMITTER_HOSTS).not.toContain("openclaw");
    expect(Object.keys(HOST_COMMAND_LAYOUTS)).not.toContain("openclaw");
    expect((HOST_COMMAND_LAYOUTS as Record<string, unknown>).openclaw).toBeUndefined();
  });

  it("detects managed ownership marker", () => {
    const art = generateOpenClawSkillArtifacts()[1];
    expect(isManagedOpenClawL2Skill(art.skillMarkdown)).toBe(true);
    expect(isManagedOpenClawL2Skill("# custom skill\n")).toBe(false);
  });
});
