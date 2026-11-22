/**
 * #6934 Bound items 3-4: `swarm:readiness` and `xbrief:preflight` warn when two
 * open story briefs share one completion issue, and keep their exit codes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluate } from "../preflight/evaluate.js";
import { readinessReport } from "./readiness.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-readiness-shared-"));
  temps.push(root);
  return root;
}

function writeBrief(
  root: string,
  folder: string,
  name: string,
  issue: number,
  kind = "story",
): string {
  mkdirSync(join(root, "xbrief", folder), { recursive: true });
  const rel = `xbrief/${folder}/${name}`;
  writeFileSync(
    join(root, rel),
    JSON.stringify({
      plan: {
        id: name.replace(/\.xbrief\.json$/, ""),
        title: name,
        status: folder === "active" ? "running" : folder,
        references: [
          {
            uri: `https://github.com/deftai/directive/issues/${String(issue)}`,
            type: "x-xbrief/github-issue",
          },
        ],
        metadata: {
          kind,
          intended_placement: {
            schema: "deft.scope.intended_placement.v1",
            files: ["src/x.ts"],
            module_boundary: "x",
          },
        },
      },
    }),
    "utf8",
  );
  return rel;
}

function sharedSection(report: string): string {
  const start = report.indexOf("Shared story issues:");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = report.indexOf("\n\n", start);
  return report.slice(start, end < 0 ? undefined : end);
}

describe("swarm:readiness Shared story issues (#6934)", () => {
  it("lists both sharing briefs and keeps the exit code", () => {
    const shared = makeRoot();
    const a = writeBrief(shared, "active", "a.xbrief.json", 1840);
    const b = writeBrief(shared, "active", "b.xbrief.json", 1840);
    const apart = makeRoot();
    const c = writeBrief(apart, "active", "a.xbrief.json", 1840);
    writeBrief(apart, "active", "b.xbrief.json", 1841);

    for (const target of [a, b]) {
      const result = readinessReport(shared, [join(shared, target)]);
      const section = sharedSection(result.report);
      expect(section).toContain(a);
      expect(section).toContain(b);
      expect(section).toContain("shares completion issue deftai/directive#1840");
      expect(result.exitCode).toBe(readinessReport(apart, [join(apart, c)]).exitCode);
    }
    expect(sharedSection(readinessReport(apart, [join(apart, c)]).report)).toBe(
      "Shared story issues:\n- none",
    );
  });

  it("prints none for an epic and a story with the same issue", () => {
    const root = makeRoot();
    writeBrief(root, "active", "epic.xbrief.json", 9, "epic");
    const story = writeBrief(root, "active", "story.xbrief.json", 9);
    expect(sharedSection(readinessReport(root, [join(root, story)]).report)).toBe(
      "Shared story issues:\n- none",
    );
  });
});

describe("xbrief:preflight shared-issue warning (#6934)", () => {
  const opts = { skipOriginFreshness: true, skipParentLineage: true } as const;

  it("exits 0 and names the other brief", () => {
    const root = makeRoot();
    const a = writeBrief(root, "active", "a.xbrief.json", 1840);
    const b = writeBrief(root, "pending", "b.xbrief.json", 1840);
    const result = evaluate(join(root, a), opts);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("lifecycle-ready");
    expect(result.message).toContain(`WARN: ${a} shares completion issue deftai/directive#1840`);
    expect(result.message).toContain(b);
  });

  it("warns when the brief path is relative to a cwd outside the project", () => {
    const root = makeRoot();
    const a = writeBrief(root, "active", "a.xbrief.json", 1840);
    writeBrief(root, "active", "b.xbrief.json", 1840);
    const result = evaluate(relative(process.cwd(), join(root, a)), opts);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`WARN: ${a} shares completion issue deftai/directive#1840`);
  });

  it("prints no warning for an epic sharer, another repository or a completed brief", () => {
    const root = makeRoot();
    const a = writeBrief(root, "active", "a.xbrief.json", 1840);
    writeBrief(root, "active", "epic.xbrief.json", 1840, "epic");
    writeBrief(root, "completed", "done.xbrief.json", 1840);
    const result = evaluate(join(root, a), opts);
    expect(result.exitCode).toBe(0);
    expect(result.message).not.toContain("WARN:");
  });
});
