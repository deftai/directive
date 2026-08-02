import { describe, expect, it } from "vitest";
import {
  assertThinHostEmission,
  emitAllHostCommandFiles,
  emitHostCommandFiles,
  getHostCommandLayout,
  HOST_COMMAND_LAYOUTS,
  hostRelativePath,
  isSlashEmitterHostId,
  listSlashEmitterHosts,
  renderHostFileContents,
  SLASH_EMITTER_HOSTS,
  type SlashEmitterHostId,
} from "./emitters.js";
import { generateThinWrappers, isThinWrapperMarkdown, type ThinWrapperIR } from "./generator.js";
import { listProductCommands, PRODUCT_COMMAND_COUNT, PRODUCT_COMMANDS } from "./product-set.js";

describe("slash per-host emitters (#3053 / #55)", () => {
  const ir = generateThinWrappers();

  it("registers real emitters for claude, cursor, grok, codex (no stubs)", () => {
    expect(listSlashEmitterHosts()).toEqual(["claude", "cursor", "grok", "codex"]);
    expect(SLASH_EMITTER_HOSTS).toHaveLength(4);
    for (const host of SLASH_EMITTER_HOSTS) {
      expect(isSlashEmitterHostId(host)).toBe(true);
      const layout = getHostCommandLayout(host);
      expect(layout.hostId).toBe(host);
      expect(layout.relativeDir.length).toBeGreaterThan(0);
      expect(layout.filePattern).toBe("{stem}.md");
      expect(layout.relativeDir.endsWith("/")).toBe(false);
    }
    expect(isSlashEmitterHostId("gemini")).toBe(false);
  });

  it("documents stable host id → directory mapping", () => {
    expect(HOST_COMMAND_LAYOUTS.claude.relativeDir).toBe(".claude/commands");
    expect(HOST_COMMAND_LAYOUTS.cursor.relativeDir).toBe(".cursor/commands");
    expect(HOST_COMMAND_LAYOUTS.grok.relativeDir).toBe(".grok/commands");
    expect(HOST_COMMAND_LAYOUTS.codex.relativeDir).toBe(".codex/prompts");
    expect(HOST_COMMAND_LAYOUTS.claude.surfaceKind).toBe("commands");
    expect(HOST_COMMAND_LAYOUTS.codex.surfaceKind).toBe("prompts");
  });

  it("emits count === 13 with L4 hyphen filenames under host paths", () => {
    for (const host of SLASH_EMITTER_HOSTS) {
      const files = emitHostCommandFiles(host);
      expect(files).toHaveLength(PRODUCT_COMMAND_COUNT);
      expect(files).toHaveLength(13);

      const layout = getHostCommandLayout(host);
      for (const f of files) {
        expect(f.hostId).toBe(host);
        expect(f.filename).toMatch(/\.md$/);
        expect(f.filename).toBe(`${f.filenameStem}.md`);
        expect(f.filename).not.toContain(":");
        expect(f.relativePath).toBe(`${layout.relativeDir}/${f.filename}`);
        expect(f.relativePath.startsWith(`${layout.relativeDir}/`)).toBe(true);
      }

      // Spot-check known L4 stems
      const interview = files.find((f) => f.logicalId === "/deft:directive:run:interview");
      expect(interview?.filename).toBe("deft-directive-run-interview.md");
      expect(interview?.relativePath).toBe(`${layout.relativeDir}/deft-directive-run-interview.md`);
      const cont = files.find((f) => f.logicalId === "/deft:continue");
      expect(cont?.filename).toBe("deft-continue.md");
    }
  });

  it("consumes shared IR only — same logical ids as product set, no second name table", () => {
    const productIds = listProductCommands().map((c) => c.logicalId);
    const files = emitHostCommandFiles("claude");
    expect(files.map((f) => f.logicalId)).toEqual(productIds);
    expect(files.map((f) => f.logicalId)).toEqual(ir.map((w) => w.logicalId));

    // Emitter does not re-list PRODUCT_COMMANDS body; IR drives contents.
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as (typeof files)[number];
      const w = ir[i] as ThinWrapperIR;
      expect(f.contents).toBe(renderHostFileContents("claude", w));
      expect(f.contents).toBe(w.fileMarkdown);
      expect(f.description).toBe(w.description);
      expect(f.dispatchPath).toBe(w.dispatchPath);
    }

    // Guard: product table is still the single SoT (emitters import IR, not a fork).
    expect(PRODUCT_COMMANDS).toHaveLength(13);
  });

  it("outputs thin wrappers only — no inlined strategy/skill bodies", () => {
    for (const host of SLASH_EMITTER_HOSTS) {
      const files = emitHostCommandFiles(host, ir);
      assertThinHostEmission(files);
      for (const f of files) {
        expect(isThinWrapperMarkdown(f.contents, f.dispatchPath)).toBe(true);
        expect(f.contents).toContain(f.dispatchPath);
        expect(f.contents).not.toMatch(/^##\s+(Phase|Workflow|Steps|Acceptance)\b/m);
        expect(f.contents.split("\n").filter((line) => line.trim().length > 0).length).toBeLessThan(
          20,
        );
      }

      const probe = files.find((f) => f.logicalId === "/deft:directive:run:probe");
      expect(probe?.contents.toLowerCase()).not.toContain("adversarial one-question-per-turn");
      expect(probe?.contents).toContain("skills/deft-directive-probe/SKILL.md");
    }
  });

  it("uses identical external names and body semantics across hosts", () => {
    const byHost = emitAllHostCommandFiles();
    expect(byHost.size).toBe(4);

    const claude = byHost.get("claude");
    expect(claude).toBeDefined();
    for (const host of SLASH_EMITTER_HOSTS) {
      const files = byHost.get(host);
      expect(files).toHaveLength(13);
      expect(files?.map((f) => f.logicalId)).toEqual(claude?.map((f) => f.logicalId));
      expect(files?.map((f) => f.contents)).toEqual(claude?.map((f) => f.contents));
      expect(files?.map((f) => f.filename)).toEqual(claude?.map((f) => f.filename));
      // Paths differ by host layout only
      if (host !== "claude") {
        expect(files?.map((f) => f.relativePath)).not.toEqual(claude?.map((f) => f.relativePath));
      }
    }
  });

  it("hostRelativePath joins layout dir with L4 filename", () => {
    expect(hostRelativePath("claude", "deft-continue.md")).toBe(
      ".claude/commands/deft-continue.md",
    );
    expect(hostRelativePath("codex", "deft-checkpoint.md")).toBe(
      ".codex/prompts/deft-checkpoint.md",
    );
    expect(() => hostRelativePath("claude", "../escape.md")).toThrow(/Invalid command filename/);
    expect(() => hostRelativePath("claude", "a/b.md")).toThrow(/Invalid command filename/);
  });

  it("emitAllHostCommandFiles accepts a subset of hosts", () => {
    const subset: readonly SlashEmitterHostId[] = ["claude", "cursor"];
    const map = emitAllHostCommandFiles(subset);
    expect([...map.keys()]).toEqual(["claude", "cursor"]);
    expect(map.get("claude")).toHaveLength(13);
    expect(map.get("cursor")).toHaveLength(13);
    expect(map.has("grok")).toBe(false);
  });
});
