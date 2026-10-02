import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAcceptanceClauses } from "./clauses.js";
import {
  evaluateRequirementSourcesStaleness,
  hashRequirementContent,
  REQUIREMENT_SOURCE_COMPLETED_CONFLICT_REMEDIATION,
  REQUIREMENT_SOURCE_MALFORMED_REMEDIATION,
  REQUIREMENT_SOURCE_MISSING_REMEDIATION,
  REQUIREMENT_SOURCE_POST_COMPLETE_REMEDIATION,
  REQUIREMENT_SOURCE_UNPARSEABLE_REMEDIATION,
  readRequirementSources,
  stampRequirementSources,
  writeRequirementSourcesAutofixToXbrief,
} from "./requirement-sources.js";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "req-sources-"));
  temps.push(dir);
  return dir;
}

function basePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "demo",
    status: "running",
    narratives: {
      AcceptanceCriteria: "- keep the ship green\n- report the delta",
    },
    acceptance: {
      commands: [],
      none_stated: true,
      source_rung: "derived",
      clauses: [
        { id: 1, text: "keep the ship green", artifact_path: null, ambiguous: false },
        { id: 2, text: "report the delta", artifact_path: null, ambiguous: false },
      ],
      ambiguity_attestation: "none_found",
    },
    items: [
      { id: "clause.1", title: "keep the ship green", status: "proposed" },
      { id: "clause.2", title: "report the delta", status: "proposed" },
    ],
    metadata: {},
    ...overrides,
  };
}

describe("requirement_sources stamp + staleness (#3920)", () => {
  it("stamps path+sha256+recorded_at for already-read workspace sources", () => {
    const root = tempRoot();
    const reqPath = join(root, "REQUIREMENTS.md");
    const content = "# Acceptance\n\n- keep the ship green\n- report the delta\n";
    writeFileSync(reqPath, content, "utf8");
    const stamped = stampRequirementSources(
      basePlan(),
      root,
      [{ path: "REQUIREMENTS.md", content }],
      { now: () => "2026-10-02T00:00:00.000Z" },
    );
    const sources = readRequirementSources(stamped);
    expect(sources).toEqual([
      {
        path: "REQUIREMENTS.md",
        content_sha256: hashRequirementContent(content),
        recorded_at: "2026-10-02T00:00:00.000Z",
      },
    ]);
  });

  it("stamp then mutate then evaluate autofixes with delta and zero refusals", () => {
    const root = tempRoot();
    const reqPath = join(root, "REQUIREMENTS.md");
    const original = "## Acceptance Criteria\n\n- keep the ship green\n- report the delta\n";
    writeFileSync(reqPath, original, "utf8");
    let plan = stampRequirementSources(basePlan(), root, [{ path: reqPath }], {
      now: () => "2026-10-02T00:00:00.000Z",
    });
    const revised =
      "## Acceptance Criteria\n\n- keep the ship green\n- report the delta\n- also cover telemetry\n";
    writeFileSync(reqPath, revised, "utf8");
    const writes: Record<string, unknown>[] = [];
    const verdict = evaluateRequirementSourcesStaleness(plan, root, {
      writePlan: (next) => {
        writes.push(next);
        plan = next;
      },
      now: () => "2026-10-02T01:00:00.000Z",
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.kind).toBe("autofixed");
    expect(verdict.sources_rechecked).toBe(1);
    expect(verdict.sources_changed).toBe(1);
    expect(verdict.deltas[0]?.previous_sha256).toBe(hashRequirementContent(original));
    expect(verdict.deltas[0]?.current_sha256).toBe(hashRequirementContent(revised));
    expect(verdict.message).toMatch(/autofix/);
    expect(writes).toHaveLength(1);
    expect(readRequirementSources(plan)[0]?.content_sha256).toBe(hashRequirementContent(revised));
  });

  it("fails closed with remediation when a recorded source is deleted", () => {
    const root = tempRoot();
    const reqPath = join(root, "REQUIREMENTS.md");
    writeFileSync(reqPath, "must exist\n", "utf8");
    const plan = stampRequirementSources(basePlan(), root, [{ path: "REQUIREMENTS.md" }]);
    unlinkSync(reqPath);
    const verdict = evaluateRequirementSourcesStaleness(plan, root);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("missing");
    expect(verdict.remediation).toBe(REQUIREMENT_SOURCE_MISSING_REMEDIATION);
    expect(verdict.message).toMatch(/missing on disk/);
  });

  it("unchanged sources do no re-derivation work", () => {
    const root = tempRoot();
    const reqPath = join(root, "REQUIREMENTS.md");
    writeFileSync(reqPath, "stable\n", "utf8");
    const plan = stampRequirementSources(basePlan(), root, [{ path: "REQUIREMENTS.md" }]);
    let wrote = false;
    const verdict = evaluateRequirementSourcesStaleness(plan, root, {
      writePlan: () => {
        wrote = true;
      },
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.kind).toBe("unchanged");
    expect(verdict.sources_rechecked).toBe(1);
    expect(verdict.sources_changed).toBe(0);
    expect(verdict.message).toBe("");
    expect(wrote).toBe(false);
    expect(verdict.plan).toBe(plan);
  });

  it("fails closed when digest changes after scope:complete", () => {
    const root = tempRoot();
    const reqPath = join(root, "REQUIREMENTS.md");
    writeFileSync(reqPath, "v1\n", "utf8");
    const plan = stampRequirementSources(basePlan({ status: "completed" }), root, [
      { path: "REQUIREMENTS.md" },
    ]);
    writeFileSync(reqPath, "v2\n", "utf8");
    const verdict = evaluateRequirementSourcesStaleness(plan, root);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("post_complete");
    expect(verdict.remediation).toBe(REQUIREMENT_SOURCE_POST_COMPLETE_REMEDIATION);
  });

  it("fails closed when re-derivation conflicts with completed plan items", () => {
    const root = tempRoot();
    const reqPath = join(root, "REQUIREMENTS.md");
    const original = "## Acceptance Criteria\n\n- keep the ship green\n- report the delta\n";
    writeFileSync(reqPath, original, "utf8");
    // No plan narratives / items surface: clause set comes from the requirements file.
    const plan = stampRequirementSources(
      {
        title: "demo",
        status: "running",
        narratives: {},
        acceptance: {
          commands: [],
          none_stated: true,
          source_rung: "derived",
          clauses: [
            { id: 1, text: "keep the ship green", artifact_path: null, ambiguous: false },
            { id: 2, text: "report the delta", artifact_path: null, ambiguous: false },
          ],
          ambiguity_attestation: "none_found",
        },
        items: [
          { id: "clause.1", title: "keep the ship green", status: "completed" },
          { id: "clause.2", title: "report the delta", status: "proposed" },
        ],
        metadata: {},
      },
      root,
      [{ path: "REQUIREMENTS.md" }],
    );
    writeFileSync(
      reqPath,
      "## Acceptance Criteria\n\n- keep the ship green\n- a different completed contract\n",
      "utf8",
    );
    const verdict = evaluateRequirementSourcesStaleness(plan, root);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("completed_conflict");
    expect(verdict.remediation).toBe(REQUIREMENT_SOURCE_COMPLETED_CONFLICT_REMEDIATION);
  });

  it("absent requirement_sources is a no-op", () => {
    const verdict = evaluateRequirementSourcesStaleness(basePlan(), tempRoot());
    expect(verdict).toMatchObject({
      ok: true,
      kind: "absent",
      sources_rechecked: 0,
      sources_changed: 0,
    });
  });

  it("writeRequirementSourcesAutofixToXbrief merges sources without clobbering plan edits", () => {
    const root = tempRoot();
    const brief = join(root, "story.xbrief.json");
    const plan = stampRequirementSources(basePlan(), root, [
      { path: "REQUIREMENTS.md", content: "v1\n" },
    ]);
    writeFileSync(brief, `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`);
    // Intervening edit on disk after the in-memory autofix plan was prepared.
    const disk = JSON.parse(readFileSync(brief, "utf8")) as {
      plan: Record<string, unknown>;
    };
    disk.plan.title = "edited-on-disk";
    writeFileSync(brief, `${JSON.stringify(disk, null, 2)}\n`);
    const next = stampRequirementSources(basePlan({ title: "restamped" }), root, [
      { path: "REQUIREMENTS.md", content: "v2\n" },
    ]);
    writeRequirementSourcesAutofixToXbrief(brief, next, root);
    const saved = JSON.parse(readFileSync(brief, "utf8")) as {
      plan: Record<string, unknown>;
    };
    expect(saved.plan.title).toBe("edited-on-disk");
    expect(readRequirementSources(saved.plan)[0]?.content_sha256).toBe(
      hashRequirementContent("v2\n"),
    );
  });

  it("fails closed when a recorded source is missing recorded_at", () => {
    const root = tempRoot();
    const plan = basePlan({
      metadata: {
        requirement_sources: [{ path: "REQUIREMENTS.md", content_sha256: "abc" }],
      },
    });
    const verdict = evaluateRequirementSourcesStaleness(plan, root);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("malformed");
    expect(verdict.remediation).toBe(REQUIREMENT_SOURCE_MALFORMED_REMEDIATION);
  });

  it("autofix preserves artifact_path bindings for matching clause text", () => {
    const root = tempRoot();
    const reqPath = join(root, "REQUIREMENTS.md");
    const original = "## Acceptance Criteria\n\n- keep the ship green\n- report the delta\n";
    writeFileSync(reqPath, original, "utf8");
    let plan = stampRequirementSources(
      basePlan({
        narratives: {},
        acceptance: {
          commands: [],
          none_stated: true,
          source_rung: "derived",
          clauses: [
            {
              id: 1,
              text: "keep the ship green",
              artifact_path: "src/ship.ts",
              ambiguous: false,
            },
            {
              id: 2,
              text: "report the delta",
              artifact_path: "src/delta.ts",
              ambiguous: false,
            },
          ],
          ambiguity_attestation: "none_found",
        },
        items: [
          { id: "clause.1", title: "keep the ship green", status: "proposed" },
          { id: "clause.2", title: "report the delta", status: "proposed" },
        ],
      }),
      root,
      [{ path: "REQUIREMENTS.md" }],
    );
    writeFileSync(
      reqPath,
      "## Acceptance Criteria\n\n- keep the ship green\n- report the delta\n- also cover telemetry\n",
      "utf8",
    );
    const verdict = evaluateRequirementSourcesStaleness(plan, root, {
      writePlan: (next) => {
        plan = next;
      },
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.kind).toBe("autofixed");
    const clauses = readAcceptanceClauses(plan.acceptance);
    const ship = clauses.find((c) => /keep the ship green/i.test(c.text));
    const delta = clauses.find((c) => /report the delta/i.test(c.text));
    expect(ship?.artifact_path).toBe("src/ship.ts");
    expect(delta?.artifact_path).toBe("src/delta.ts");
  });

  it("fails closed when digest changes but re-derivation yields no clauses", () => {
    const root = tempRoot();
    const reqPath = join(root, "REQUIREMENTS.md");
    writeFileSync(
      reqPath,
      "## Acceptance Criteria\n\n- keep the ship green\n- report the delta\n",
      "utf8",
    );
    const plan = stampRequirementSources(basePlan({ narratives: {} }), root, [
      { path: "REQUIREMENTS.md" },
    ]);
    writeFileSync(reqPath, "totally blank rewritten contract with no list items\n", "utf8");
    const verdict = evaluateRequirementSourcesStaleness(plan, root);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("unparseable");
    expect(verdict.remediation).toBe(REQUIREMENT_SOURCE_UNPARSEABLE_REMEDIATION);
  });
});
