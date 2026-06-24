import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateProjectDefinition } from "../vbrief-validate/project-definition.js";
import { renderProjectDefinition } from "./project-render.js";

const ISSUE_REF = {
  type: "x-vbrief/github-issue",
  uri: "https://github.com/deftai/directive/issues/1696",
  title: "Issue #1696",
};

function writeScope(
  vbriefDir: string,
  folder: string,
  filename: string,
  plan: Record<string, unknown>,
): void {
  const dir = join(vbriefDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    `${JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan }, null, 2)}\n`,
    "utf8",
  );
}

function writeProjectDefinition(vbriefDir: string): void {
  writeFileSync(
    join(vbriefDir, "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6", created: "2026-06-01T00:00:00Z" },
        plan: {
          title: "PROJECT-DEFINITION",
          status: "running",
          narratives: { Overview: "Test", "tech stack": "TS" },
          items: [],
          metadata: { staleness_flags: [] },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("project-render decompose round-trip", () => {
  it("render then validate passes for cancelled umbrella + completed stories (#1696)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-1696-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });

    writeScope(vbrief, "cancelled", "2026-06-16-umbrella.vbrief.json", {
      title: "Umbrella epic",
      status: "cancelled",
      items: [],
      metadata: { kind: "epic" },
      references: [
        ISSUE_REF,
        {
          type: "x-vbrief/plan",
          uri: "completed/2026-06-16-story-a.vbrief.json",
          title: "Story A",
        },
        {
          type: "x-vbrief/plan",
          uri: "completed/2026-06-16-story-b.vbrief.json",
          title: "Story B",
        },
      ],
    });
    writeScope(vbrief, "completed", "2026-06-16-story-a.vbrief.json", {
      title: "Story A",
      status: "completed",
      items: [],
      metadata: { kind: "story" },
      references: [ISSUE_REF],
      planRef: "cancelled/2026-06-16-umbrella.vbrief.json",
    });
    writeScope(vbrief, "completed", "2026-06-16-story-b.vbrief.json", {
      title: "Story B",
      status: "completed",
      items: [],
      metadata: { kind: "story" },
      references: [ISSUE_REF],
      planRef: "cancelled/2026-06-16-umbrella.vbrief.json",
    });

    writeProjectDefinition(vbrief);

    const [ok, message] = renderProjectDefinition(vbrief, {
      now: new Date("2026-06-24T12:00:00Z"),
    });
    expect(ok).toBe(true);
    expect(message).toContain("3 scope items");

    const parsed: unknown = JSON.parse(
      readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"),
    );
    expect(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)).toBe(true);
    const projectDef = parsed as {
      plan: { items: Array<{ metadata?: { references?: unknown[] } }> };
    };

    const umbrella = projectDef.plan.items.find(
      (item) =>
        (item as { metadata?: { source_path?: string } }).metadata?.source_path ===
        "cancelled/2026-06-16-umbrella.vbrief.json",
    );
    expect(umbrella).toBeDefined();
    const umbrellaRefs = (umbrella as { metadata?: { references?: unknown[] } }).metadata
      ?.references;
    expect(Array.isArray(umbrellaRefs)).toBe(true);
    expect(umbrellaRefs?.some((ref) => (ref as { type?: string }).type === "x-vbrief/plan")).toBe(
      false,
    );
    expect(
      umbrellaRefs?.some((ref) => (ref as { type?: string }).type === "x-vbrief/github-issue"),
    ).toBe(true);

    const errors = validateProjectDefinition(
      "vbrief/PROJECT-DEFINITION.vbrief.json",
      projectDef as Record<string, unknown>,
      vbrief,
    );
    expect(errors.filter((e) => e.includes("registry-status"))).toEqual([]);

    rmSync(root, { recursive: true, force: true });
  });
});
