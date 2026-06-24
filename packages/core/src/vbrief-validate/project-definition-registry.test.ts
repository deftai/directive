import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateProjectDefinition } from "./project-definition.js";

function writeScope(vbrief: string, folder: string, filename: string, status: string): void {
  mkdirSync(join(vbrief, folder), { recursive: true });
  writeFileSync(
    join(vbrief, folder, filename),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "Scope", status, items: [] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("validateProjectDefinition D3 registry-status", () => {
  it("flags mismatch via source_path even when metadata omits scope links", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-d3-"));
    const vbrief = join(root, "vbrief");
    writeScope(vbrief, "active", "2026-01-01-scope.vbrief.json", "blocked");

    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    const errors = validateProjectDefinition(
      fp,
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", "tech stack": "T" },
          items: [
            {
              id: "2026-01-01-scope",
              title: "Scope",
              status: "running",
              metadata: {
                source_path: "active/2026-01-01-scope.vbrief.json",
              },
            },
          ],
        },
      },
      vbrief,
    );

    expect(errors.some((e) => e.includes("registry-status"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("allows cancelled umbrella item when only github-issue refs remain in metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-decompose-"));
    const vbrief = join(root, "vbrief");
    writeScope(vbrief, "cancelled", "2026-06-16-umbrella.vbrief.json", "cancelled");
    writeScope(vbrief, "completed", "2026-06-16-story.vbrief.json", "completed");

    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    const errors = validateProjectDefinition(
      fp,
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", "tech stack": "T" },
          items: [
            {
              id: "2026-06-16-umbrella",
              title: "Umbrella",
              status: "cancelled",
              metadata: {
                source_path: "cancelled/2026-06-16-umbrella.vbrief.json",
                references: [
                  {
                    type: "x-vbrief/github-issue",
                    uri: "https://github.com/deftai/directive/issues/1696",
                  },
                ],
              },
            },
            {
              id: "2026-06-16-story",
              title: "Story",
              status: "completed",
              metadata: {
                source_path: "completed/2026-06-16-story.vbrief.json",
              },
            },
          ],
        },
      },
      vbrief,
    );

    expect(errors.filter((e) => e.includes("registry-status"))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
