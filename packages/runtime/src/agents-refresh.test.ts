import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFT_REPO_POSITIVE_MARKERS } from "@deftai/directive-core/doctor";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("emits runtime .agents/skills paths not legacy stubs (#1404)", () => {
    const project = freshProject();
    expect(runAgentsRefresh(["--project-root", project])).toBe(0);
    const text = readFileSync(join(project, "AGENTS.md"), "utf8");
    // #2535: Session routing no longer embeds setup-skill path; swarm skill still
    // exercises the runtime `.agents/skills/` path format in managed AGENTS.md.
    expect(text).toContain(
      "node_modules/@deftai/directive-runtime/.agents/skills/deft-directive-swarm/SKILL.md",
    );
    expect(text).not.toMatch(/`\.deft\/core\/skills\/deft-directive-/);
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

  it("a source checkout whose own template is newer is refreshed, not sha-match (#6507)", () => {
    const project = freshProject();
    const put = (rel: string, body: string) => {
      mkdirSync(dirname(join(project, rel)), { recursive: true });
      writeFileSync(join(project, rel), body, "utf8");
    };
    put("main.md", "# main\n");
    for (const marker of DEFT_REPO_POSITIVE_MARKERS) put(marker, "marker\n");
    put(
      "content/templates/agents-entry.md",
      "<!-- deft:managed-section v3 -->\n# Rules\n! Newer checkout rule (#6507 fixture).\n<!-- /deft:managed-section -->\n",
    );
    put(
      "AGENTS.md",
      "# Header\n\n<!-- deft:managed-section v3 sha=0.0.0 refreshed=2026-01-01T00:00:00Z session=abc123abc123 -->\n# Rules\n<!-- /deft:managed-section -->\n",
    );
    const saved = process.env.DEFT_ROOT;
    delete process.env.DEFT_ROOT;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(runAgentsRefresh(["--project-root", project])).toBe(0);
      const printed = out.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("AGENTS.md updated (state=stale)");
      expect(printed).not.toContain("unchanged - sha match");
    } finally {
      out.mockRestore();
      if (saved !== undefined) process.env.DEFT_ROOT = saved;
    }
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain(
      "! Newer checkout rule (#6507 fixture).",
    );
  });
});
