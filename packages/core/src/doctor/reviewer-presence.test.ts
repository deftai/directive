import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkReviewerPresence } from "./checks.js";

function makeProject(policy?: Record<string, unknown>, files: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-reviewer-"));
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: { title: "P", status: "running", policy: policy ?? {} },
    }),
    "utf8",
  );
  for (const rel of files) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{}\n", "utf8");
  }
  return root;
}

describe("checkReviewerPresence (#3630)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("reports explicit empty reviewers with the canonical handback", () => {
    root = makeProject({ review: { reviewers: [] } });
    const check = checkReviewerPresence(root);
    expect(check.name).toBe("reviewer-presence");
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("review_cycle: skipped:no-reviewer-installed");
    expect(check.detail).toContain("deft-directive-pre-pr");
  });

  it("reports unset policy as local none without claiming the wait terminal", () => {
    root = makeProject();
    const check = checkReviewerPresence(root);
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("none detected locally");
    expect(check.detail).toContain("never CLEAN");
  });

  it("reports blank-only reviewers as invalid with remedy (#5165)", () => {
    root = makeProject({ review: { reviewers: ["", "  "] } });
    const check = checkReviewerPresence(root);
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/invalid/i);
    expect(check.detail).toMatch(/blank/i);
    expect(check.detail).toContain("[]");
  });

  it("reports local greptile.json", () => {
    root = makeProject({}, ["greptile.json"]);
    const check = checkReviewerPresence(root);
    expect(check.detail).toContain("greptile.json");
  });
});
