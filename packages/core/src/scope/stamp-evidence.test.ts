import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCEPTANCE_EVIDENCE_KEY } from "./acceptance-evidence.js";
import { formatBriefJson } from "./brief-io.js";
import { minimalScopeBrief } from "./scope-test-fixtures.test.js";
import {
  STAMP_EVIDENCE_ACTION,
  STAMP_EVIDENCE_VERB,
  stampEvidenceOnBrief,
} from "./stamp-evidence.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "stamp-ev-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  mkdirSync(join(root, "packages", "a"), { recursive: true });
  writeFileSync(join(root, "packages", "a", "index.ts"), "export {}\n", "utf8");
  return root;
}

describe("stampEvidenceOnBrief (#4840)", () => {
  it("exports the evidence-only verb tokens", () => {
    expect(STAMP_EVIDENCE_ACTION).toBe("stamp-evidence");
    expect(STAMP_EVIDENCE_VERB).toBe("scope:stamp-evidence");
  });

  it("stamps a matchAny file and reports skipped null rows", () => {
    const root = repo();
    const file = join(root, "xbrief", "active", "story.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(
        minimalScopeBrief({
          title: "T",
          status: "running",
          items: [],
          acceptance: {
            commands: [],
            none_stated: true,
            clauses: [
              {
                id: 1,
                text: "unit covers packages/a/index.ts",
                artifact_path: "packages/a/index.ts",
                ambiguous: false,
              },
              {
                id: 2,
                text: "behavioral with no file token",
                artifact_path: null,
                ambiguous: false,
              },
            ],
          },
          metadata: { swarm: { file_scope: ["packages/a/**"] } },
        }),
      ),
      "utf8",
    );
    const result = stampEvidenceOnBrief(file, {
      projectRoot: root,
      recorded_at: "2026-09-22T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    expect(result.stampedIds).toEqual(["clause.1"]);
    expect(result.message).toContain(STAMP_EVIDENCE_VERB);
    expect(result.message).toContain("skipped");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      plan: { items: Array<Record<string, unknown>> };
    };
    expect(parsed.plan.items[0]?.[ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({
      kind: "test",
      pointer: "packages/a/index.ts",
      recorded_by: STAMP_EVIDENCE_VERB,
    });
  });

  it("refuses a missing file and a brief without a plan object", () => {
    expect(stampEvidenceOnBrief(join(tmpdir(), "missing-4840.xbrief.json")).ok).toBe(false);
    const root = repo();
    const file = join(root, "xbrief", "active", "no-plan.xbrief.json");
    writeFileSync(file, JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: [] }), "utf8");
    const result = stampEvidenceOnBrief(file, { projectRoot: root });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/lacks a plan object/);
  });

  it("repairs incoherent kind:test markdown and reports repaired= (#5382)", () => {
    const root = repo();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "guide.md"), "# guide\n", "utf8");
    const file = join(root, "xbrief", "active", "md.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(
        minimalScopeBrief({
          title: "T",
          status: "running",
          items: [
            {
              id: "clause.1",
              title: "clause.1",
              status: "pending",
              [ACCEPTANCE_EVIDENCE_KEY]: {
                kind: "test",
                pointer: "docs/guide.md",
                recorded_at: "2026-10-01T00:00:00Z",
                recorded_by: "hand",
              },
            },
          ],
          acceptance: {
            commands: [],
            none_stated: true,
            clauses: [
              {
                id: 1,
                text: "The guide documents the rule.",
                artifact_path: "docs/guide.md",
                ambiguous: false,
              },
            ],
          },
          metadata: { swarm: { file_scope: ["docs/**"] } },
        }),
      ),
      "utf8",
    );
    const result = stampEvidenceOnBrief(file, {
      projectRoot: root,
      recorded_at: "2026-10-07T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("repaired=clause.1");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      plan: { items: Array<Record<string, unknown>> };
    };
    expect(parsed.plan.items[0]?.[ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({
      kind: "review",
      pointer: "docs/guide.md",
      recorded_by: STAMP_EVIDENCE_VERB,
    });
  });
});
