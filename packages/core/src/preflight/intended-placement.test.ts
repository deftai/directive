import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FILE_SIZE_REVIEW_TRIGGER_LINES } from "../policy/file-size-thresholds.js";
import {
  countFileLines,
  emptyIntendedPlacement,
  evaluateIntendedPlacement,
  INTENDED_PLACEMENT_MISSING_HINT,
  INTENDED_PLACEMENT_OVER_TRIGGER_HINT,
  INTENDED_PLACEMENT_SCHEMA,
  readIntendedPlacement,
  stampIntendedPlacement,
} from "./intended-placement.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "deft-placement-"));
  temps.push(dir);
  return dir;
}

function writeLines(path: string, count: number): void {
  const body = `${Array.from({ length: count }, (_, i) => `line-${i + 1}`).join("\n")}\n`;
  writeFileSync(path, body);
}

function planWith(
  files: readonly string[],
  extra: Partial<{
    module_boundary: string;
    split_plan: string;
    cohesion_exemption: string;
  }> = {},
): Record<string, unknown> {
  return {
    metadata: {
      intended_placement: {
        schema: INTENDED_PLACEMENT_SCHEMA,
        files: [...files],
        module_boundary: extra.module_boundary ?? "focused module",
        ...(extra.split_plan !== undefined ? { split_plan: extra.split_plan } : {}),
        ...(extra.cohesion_exemption !== undefined
          ? { cohesion_exemption: extra.cohesion_exemption }
          : {}),
      },
    },
  };
}

describe("intended-placement field (#3424)", () => {
  it("reads files and module_boundary from plan.metadata", () => {
    const placement = readIntendedPlacement(planWith(["src/a.ts"], { module_boundary: "intake" }));
    expect(placement?.files).toEqual(["src/a.ts"]);
    expect(placement?.module_boundary).toBe("intake");
    expect(placement?.schema).toBe(INTENDED_PLACEMENT_SCHEMA);
  });

  it("stampIntendedPlacement adds a skeleton when missing", () => {
    const plan: Record<string, unknown> = {};
    stampIntendedPlacement(plan);
    expect((plan.metadata as { intended_placement: unknown }).intended_placement).toEqual(
      emptyIntendedPlacement(),
    );
    stampIntendedPlacement(plan);
    expect((plan.metadata as { intended_placement: unknown }).intended_placement).toEqual(
      emptyIntendedPlacement(),
    );
  });

  it("countFileLines does not treat a trailing newline as an extra line", () => {
    expect(countFileLines("")).toBe(0);
    expect(countFileLines("a\nb\n")).toBe(2);
    expect(countFileLines("a\nb")).toBe(2);
  });
});

describe("evaluateIntendedPlacement (#3424)", () => {
  it("rejects a missing placement field", () => {
    const result = evaluateIntendedPlacement({ status: "running" }, { projectRoot: root() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("lacks plan.metadata.intended_placement");
    expect(result.message).toContain(INTENDED_PLACEMENT_MISSING_HINT);
  });

  it("rejects empty files (no declared files to key on)", () => {
    const result = evaluateIntendedPlacement(planWith([]), { projectRoot: root() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("files is empty");
    expect(result.message).toContain(INTENDED_PLACEMENT_MISSING_HINT);
  });

  it("passes a declared file under the review-trigger threshold", () => {
    const dir = root();
    writeLines(join(dir, "small.ts"), 12);
    const result = evaluateIntendedPlacement(planWith(["small.ts"]), { projectRoot: dir });
    expect(result.ok).toBe(true);
  });

  it("passes a declared file that does not exist yet", () => {
    const result = evaluateIntendedPlacement(planWith(["src/new-module.ts"]), {
      projectRoot: root(),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a declared over-trigger file without exemption and hints remediation", () => {
    const dir = root();
    writeLines(join(dir, "god.ts"), FILE_SIZE_REVIEW_TRIGGER_LINES);
    const result = evaluateIntendedPlacement(planWith(["god.ts"]), { projectRoot: dir });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("over the review-trigger threshold");
    expect(result.message).toContain(INTENDED_PLACEMENT_OVER_TRIGGER_HINT);
    expect(result.message).not.toMatch(/must be <\s*1000/i);
    expect(result.message).not.toMatch(/hard cap/i);
  });

  it("passes an over-trigger file when a split plan is recorded", () => {
    const dir = root();
    writeLines(join(dir, "god.ts"), FILE_SIZE_REVIEW_TRIGGER_LINES + 20);
    const result = evaluateIntendedPlacement(
      planWith(["god.ts"], { split_plan: "Extract parse helpers into parse.ts this slice." }),
      { projectRoot: dir },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects mixed malformed files entries instead of dropping them", () => {
    const result = evaluateIntendedPlacement(
      {
        metadata: {
          intended_placement: {
            schema: INTENDED_PLACEMENT_SCHEMA,
            files: ["small.ts", 12, ""],
            module_boundary: "focused module",
          },
        },
      },
      { projectRoot: root() },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("lacks plan.metadata.intended_placement");
  });

  it("rejects a declared path that escapes the project root", () => {
    const result = evaluateIntendedPlacement(planWith(["../outside.ts"]), { projectRoot: root() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("escapes the project root");
  });

  it("rejects a declared path that is a directory", () => {
    const dir = root();
    const nested = join(dir, "pkg");
    mkdirSync(nested);
    const result = evaluateIntendedPlacement(planWith(["pkg"]), { projectRoot: dir });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a regular file");
  });

  it("passes an over-trigger file when a cohesion exemption is recorded", () => {
    const dir = root();
    writeLines(join(dir, "god.ts"), FILE_SIZE_REVIEW_TRIGGER_LINES + 20);
    const result = evaluateIntendedPlacement(
      planWith(["god.ts"], {
        cohesion_exemption: "Generated pack JSON is one document; this slice only edits rule text.",
      }),
      { projectRoot: dir },
    );
    expect(result.ok).toBe(true);
  });
});
