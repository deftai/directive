import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// chmodSync does not reliably block file reads on Windows; skip chmod-dependent tests there.
const itChmod = it.skipIf(process.platform === "win32");

import { buildIssueVbrief } from "../intake/issue-ingest.js";
import {
  ELIGIBLE_STATUS,
  emitJson,
  evaluate,
  formatActivateHint,
  PREFLIGHT_USAGE_HINT,
} from "./evaluate.js";
import { emitJson as emitJsonFromIndex, evaluate as evaluateFromIndex } from "./index.js";
import {
  INTENDED_PLACEMENT_GRANDFATHER_HINT,
  INTENDED_PLACEMENT_SCHEMA,
  stampIntendedPlacement,
} from "./intended-placement.js";

function underThresholdPlacement(): Record<string, unknown> {
  return {
    intended_placement: {
      schema: INTENDED_PLACEMENT_SCHEMA,
      files: ["src/new-module.ts"],
      module_boundary: "new focused module",
    },
  };
}

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function writeVbrief(folder: string, name: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), "deft-preflight-test-"));
  temps.push(root);
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  const full = join(dir, name);
  writeFileSync(full, content, "utf8");
  return full;
}

describe("evaluate", () => {
  it("returns exit 0 for active/ + running", () => {
    const path = writeVbrief(
      "active",
      "story.xbrief.json",
      JSON.stringify({ plan: { status: "running", metadata: underThresholdPlacement() } }),
    );
    const result = evaluate(path);
    expect(result.exitCode).toBe(0);
    expect(result.message).toBe(`OK ${path} -- ready for implementation.`);
  });

  it("returns exit 0 for xbrief/active/ layout path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-xbrief-"));
    temps.push(root);
    const dir = join(root, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({ plan: { status: "running", metadata: underThresholdPlacement() } }),
      "utf8",
    );
    const result = evaluate(path);
    expect(result.exitCode).toBe(0);
  });

  it("rejects pending/ folder", () => {
    const path = writeVbrief(
      "pending",
      "story.xbrief.json",
      JSON.stringify({ plan: { status: "running" } }),
    );
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("pending/");
    expect(result.message).toContain("xbrief/active/");
    expect(result.message).toContain(PREFLIGHT_USAGE_HINT);
    expect(result.message).toContain(formatActivateHint(path));
  });

  it("rejects proposed/ folder", () => {
    const path = writeVbrief(
      "proposed",
      "story.xbrief.json",
      JSON.stringify({ plan: { status: "running" } }),
    );
    expect(evaluate(path).exitCode).toBe(1);
  });

  it("rejects wrong plan.status", () => {
    const path = writeVbrief(
      "active",
      "story.xbrief.json",
      JSON.stringify({ plan: { status: "pending" } }),
    );
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("plan.status is 'pending'");
    expect(result.message).toContain(ELIGIBLE_STATUS);
  });

  it("rejects missing plan.status", () => {
    const path = writeVbrief("active", "story.xbrief.json", JSON.stringify({ plan: {} }));
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("lacks `plan.status`");
  });

  it("rejects missing plan object", () => {
    const path = writeVbrief("active", "story.xbrief.json", JSON.stringify({}));
    expect(evaluate(path).message).toContain("lacks a `plan` object");
  });

  it("rejects non-object top-level JSON", () => {
    const path = writeVbrief("active", "story.xbrief.json", "[]");
    expect(evaluate(path).message).toContain("top-level value is not a JSON object");
  });

  it("rejects malformed JSON with Python-style msg", () => {
    const path = writeVbrief("active", "story.xbrief.json", "{bad json");
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Expecting property name enclosed in double quotes (line 1).");
  });

  it("rejects missing file", () => {
    const path = join(tmpdir(), "missing-active-story.xbrief.json");
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("vBRIEF not found");
  });

  it("grandfathers a missing intended_placement on a pre-existing brief (#3424)", () => {
    const path = writeVbrief(
      "active",
      "story.xbrief.json",
      JSON.stringify({ plan: { status: "running" } }),
    );
    const result = evaluate(path);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(INTENDED_PLACEMENT_GRANDFATHER_HINT);
  });

  it("preflights a freshly ingested brief end-to-end (#3424)", () => {
    const [vbrief] = buildIssueVbrief(
      {
        number: 3424,
        title: "fresh ingest placement",
        url: "https://github.com/deftai/directive/issues/3424",
        body: "## Acceptance\n- [ ] Record intended placement\n",
        labels: [],
      },
      "active",
      "https://github.com/deftai/directive",
    );
    const plan = vbrief.plan as Record<string, unknown>;
    plan.status = "running";
    stampIntendedPlacement(plan);
    const path = writeVbrief("active", "ingested.xbrief.json", JSON.stringify(vbrief));
    const result = evaluate(path, { skipOriginFreshness: true });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("ready for implementation");
    expect(result.message).not.toContain("lacks plan.metadata.intended_placement");
  });

  it("rejects a directory path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-dir-"));
    temps.push(root);
    mkdirSync(join(root, "active"), { recursive: true });
    const result = evaluate(join(root, "active"));
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not a regular file");
  });
});

describe("parent lineage pre-PR (#3241)", () => {
  it("fails when child omits negative invariant without behavioral_delta", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-lineage-"));
    temps.push(root);
    const pending = join(root, "xbrief", "pending");
    const active = join(root, "xbrief", "active");
    mkdirSync(pending, { recursive: true });
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(pending, "parent.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "epic-preflight-lineage",
          items: [
            { id: "req-a", title: "A" },
            { id: "req-forbid", title: "No A→C", kind: "negative_invariant" },
          ],
        },
      }),
      "utf8",
    );
    const path = join(active, "child.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          status: "running",
          planRef: "pending/parent.xbrief.json",
          metadata: {
            kind: "story",
            parent_lineage: {
              schema: "deft.scope.parent_lineage.v1",
              parent_plan_id: "epic-preflight-lineage",
              coverage_map: {
                "req-a": { disposition: "covered" },
                // req-forbid omitted — parent/child drift
              },
            },
          },
        },
      }),
      "utf8",
    );
    const result = evaluate(path, { projectRoot: root });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/parent lineage|negative invariant|parent\/child drift/i);
    expect(result.parentLineage?.defect_class).toBe("parent_child_drift");
  });

  it("passes when full coverage present", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-lineage-ok-"));
    temps.push(root);
    const pending = join(root, "xbrief", "pending");
    const active = join(root, "xbrief", "active");
    mkdirSync(pending, { recursive: true });
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(pending, "parent.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "epic-preflight-lineage",
          items: [
            { id: "req-a", title: "A" },
            { id: "req-forbid", title: "No A→C", kind: "negative_invariant" },
          ],
        },
      }),
      "utf8",
    );
    const path = join(active, "child.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          status: "running",
          planRef: "pending/parent.xbrief.json",
          metadata: {
            kind: "story",
            ...underThresholdPlacement(),
            parent_lineage: {
              schema: "deft.scope.parent_lineage.v1",
              parent_plan_id: "epic-preflight-lineage",
              coverage_map: {
                "req-a": { disposition: "covered" },
                "req-forbid": { disposition: "covered" },
              },
            },
          },
        },
      }),
      "utf8",
    );
    const result = evaluate(path, { projectRoot: root });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/parent lineage OK/);
    expect(result.parentLineage?.ok).toBe(true);
  });
});

describe("emitJson", () => {
  it("emits sorted keys matching the Python schema", () => {
    const json = emitJson("/x/y.xbrief.json", 0, "OK");
    expect(json).toBe(
      JSON.stringify(
        { ready: true, exit_code: 0, vbrief_path: "/x/y.xbrief.json", message: "OK" },
        ["exit_code", "message", "ready", "vbrief_path"],
      ),
    );
  });

  it("marks ready false for non-zero exit", () => {
    const payload = JSON.parse(emitJson("/p", 1, "nope")) as { ready: boolean; exit_code: number };
    expect(payload.ready).toBe(false);
    expect(payload.exit_code).toBe(1);
  });
});

describe("preflight index barrel", () => {
  it("re-exports evaluate and emitJson", () => {
    expect(evaluateFromIndex).toBe(evaluate);
    expect(emitJsonFromIndex).toBe(emitJson);
  });
});

describe("project invariants preflight (#3425)", () => {
  function writeProjectWithInvariant(root: string, id: string, paths: string[]): void {
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: {
          policy: {
            projectInvariants: [{ id, statement: "must not break", paths }],
          },
        },
      }),
      "utf8",
    );
  }

  it("fails closed when an applicable ID has no disposition", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-inv-"));
    temps.push(root);
    writeProjectWithInvariant(root, "host-load", ["packages/core/src/preflight/**"]);
    const dir = join(root, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          status: "running",
          metadata: { swarm: { file_scope: ["packages/core/src/preflight"] } },
        },
      }),
      "utf8",
    );
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("host-load");
    expect(result.message).toMatch(/coverage_map/);
  });

  it("passes when the applicable ID is covered", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-inv-ok-"));
    temps.push(root);
    writeProjectWithInvariant(root, "host-load", ["packages/core/src/preflight/**"]);
    const dir = join(root, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          status: "running",
          metadata: {
            swarm: { file_scope: ["packages/core/src/preflight"] },
            coverage_map: { "host-load": { disposition: "covered" } },
            ...underThresholdPlacement(),
          },
        },
      }),
      "utf8",
    );
    expect(evaluate(path).exitCode).toBe(0);
  });

  it("honours skipProjectInvariants", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-inv-skip-"));
    temps.push(root);
    writeProjectWithInvariant(root, "host-load", ["packages/core/src/preflight/**"]);
    const dir = join(root, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          status: "running",
          metadata: { swarm: { file_scope: ["packages/core/src/preflight"] } },
        },
      }),
      "utf8",
    );
    expect(
      evaluate(path, { skipProjectInvariants: true, skipIntendedPlacement: true }).exitCode,
    ).toBe(0);
  });
});

describe("origin freshness (#3363)", () => {
  function writeOriginBrief(updated: string): string {
    return writeVbrief(
      "active",
      "3363-origin.xbrief.json",
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", updated },
        plan: {
          status: "running",
          metadata: underThresholdPlacement(),
          references: [
            {
              type: "x-xbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/3363",
            },
          ],
        },
      }),
    );
  }

  it("fails closed when live origin updated_at is newer than the brief", () => {
    const path = writeOriginBrief("2026-08-14T16:00:00Z");
    const result = evaluate(path, {
      fetchOriginUpdatedAt: () => ({ updatedAt: "2026-08-14T17:00:00Z" }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("newer than this xBRIEF");
    expect(result.message).toContain("#2143");
    expect(result.message).toContain("Do not auto-write origin text");
  });

  it("passes after recording divergence / bumping brief updated", () => {
    const path = writeOriginBrief("2026-08-14T17:00:00Z");
    const result = evaluate(path, {
      fetchOriginUpdatedAt: () => ({ updatedAt: "2026-08-14T17:00:00Z" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("ready for implementation");
  });

  it("fails closed when origin fetch errors and skip disables the check", () => {
    const path = writeOriginBrief("2026-08-14T16:00:00Z");
    const failed = evaluate(path, {
      fetchOriginUpdatedAt: () => ({ error: "offline" }),
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.message).toContain("Could not fetch origin");
    const skipped = evaluate(path, { skipOriginFreshness: true });
    expect(skipped.exitCode).toBe(0);
  });

  it("does not auto-apply origin text onto the brief", () => {
    const path = writeOriginBrief("2026-08-14T16:00:00Z");
    const before = readFileSync(path, "utf8");
    evaluate(path, {
      fetchOriginUpdatedAt: () => ({ updatedAt: "2026-08-14T17:00:00Z" }),
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("fails closed when the only origin is a provenance Origin URL", () => {
    const path = writeVbrief(
      "active",
      "3363-origin-text.xbrief.json",
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", updated: "2026-08-14T16:00:00Z" },
        plan: {
          status: "running",
          metadata: underThresholdPlacement(),
          narratives: {
            Origin: "Ingested from https://github.com/deftai/directive/issues/3363",
          },
        },
      }),
    );
    const result = evaluate(path, {
      fetchOriginUpdatedAt: () => ({ updatedAt: "2026-08-14T17:00:00Z" }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("newer than this xBRIEF");
  });
});

describe("evaluate edge branches", () => {
  itChmod("handles unreadable vBRIEF files", () => {
    const path = writeVbrief(
      "active",
      "locked.xbrief.json",
      JSON.stringify({ plan: { status: "running" } }),
    );
    chmodSync(path, 0o000);
    try {
      const result = evaluate(path);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("Could not read vBRIEF");
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("maps unexpected token to Expecting value", () => {
    const path = writeVbrief("active", "story.xbrief.json", "not json");
    expect(evaluate(path).message).toContain("Expecting value (line 1).");
  });

  it("maps Extra data JSON errors", () => {
    const path = writeVbrief("active", "extra.xbrief.json", '{"a":1}{"b":2}');
    expect(evaluate(path).message).toContain("Extra data");
  });

  it("falls back to generic JSON error mapping", () => {
    // Force a message shape not covered by explicit branches.
    const path = writeVbrief("active", "weird.xbrief.json", "\u0000");
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not valid JSON");
  });
});
