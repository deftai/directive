import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentsRefreshArgs, runAgentsRefresh } from "./agents-refresh.js";

describe("agents-refresh CLI (#1996)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshProject(): string {
    const root = mkdtempSync(join(tmpdir(), "agents-refresh-"));
    created.push(root);
    return root;
  }

  it("parseAgentsRefreshArgs rejects unknown flags", () => {
    expect(parseAgentsRefreshArgs(["--nope"]).error).toContain("unrecognized");
  });

  it("creates AGENTS.md when absent", () => {
    const project = freshProject();
    const code = runAgentsRefresh(["--project-root", project]);
    expect(code).toBe(0);
    const text = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(text).toContain("deft:managed-section");
  });

  it("--check exits 0 when current", () => {
    const project = freshProject();
    expect(runAgentsRefresh(["--project-root", project])).toBe(0);
    expect(runAgentsRefresh(["--project-root", project, "--check"])).toBe(0);
  });

  it("--dry-run does not write", () => {
    const project = freshProject();
    writeFileSync(join(project, "AGENTS.md"), "# stale\n", "utf8");
    const code = runAgentsRefresh(["--project-root", project, "--dry-run"]);
    expect(code).toBe(0);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("# stale\n");
  });
});
