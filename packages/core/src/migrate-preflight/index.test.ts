import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDocumentModel,
  checkGitClean,
  checkLayout,
  checkUv,
  emitMigratePreflight,
  evaluate,
  formatCheckLine,
  runMigratePreflight,
} from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function initCleanGitRepo(project: string): void {
  writeFileSync(join(project, "README.md"), "seed\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync("git", ["-c", "user.email=ci@test", "-c", "user.name=ci", "add", "-A"], {
    cwd: project,
  });
  execFileSync(
    "git",
    ["-c", "user.email=ci@test", "-c", "user.name=ci", "commit", "-q", "-m", "seed"],
    {
      cwd: project,
    },
  );
}

function makeFakeDeftRoot(
  base: string,
  opts: { migrator?: boolean; schemas?: boolean; contentNested?: boolean } = {},
): string {
  const { migrator = true, schemas = true, contentNested = false } = opts;
  const deftRoot = join(base, "deft");
  mkdirSync(join(deftRoot, "scripts"), { recursive: true });
  if (migrator) {
    writeFileSync(join(deftRoot, "scripts", "migrate_vbrief.py"), "# test migrator\n", "utf8");
  }
  const schemaRoot = contentNested
    ? join(deftRoot, "content", "vbrief", "schemas")
    : join(deftRoot, "vbrief", "schemas");
  if (schemas) {
    mkdirSync(schemaRoot, { recursive: true });
  }
  return deftRoot;
}

function makeProjectRoot(base: string, opts: { vbrief?: boolean } = {}): string {
  const project = join(base, "project");
  mkdirSync(project, { recursive: true });
  if (opts.vbrief !== false) {
    mkdirSync(join(project, "vbrief"), { recursive: true });
  }
  return project;
}

describe("migrate-preflight", () => {
  it("checkUv passes when uv is present", () => {
    expect(checkUv(() => "/usr/bin/uv").status).toBe("PASS");
  });

  it("checkUv fails when uv is missing", () => {
    const result = checkUv(() => null);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("https://docs.astral.sh/uv/");
  });

  it("checkLayout fails when migrator script is absent", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const deftRoot = makeFakeDeftRoot(base, { migrator: false });
    const project = makeProjectRoot(base);
    const result = checkLayout(deftRoot, project);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("migrate_vbrief.py");
  });

  it("checkLayout fails when schemas dir is absent", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const deftRoot = makeFakeDeftRoot(base, { schemas: false });
    const project = makeProjectRoot(base);
    const result = checkLayout(deftRoot, project);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("schemas");
  });

  it("checkLayout warns when project vbrief/ is missing", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const deftRoot = makeFakeDeftRoot(base);
    const project = makeProjectRoot(base, { vbrief: false });
    const result = checkLayout(deftRoot, project);
    expect(result.status).toBe("WARN");
  });

  it("checkLayout passes with nested content/ schemas layout", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const deftRoot = makeFakeDeftRoot(base, { contentNested: true });
    const project = makeProjectRoot(base);
    const result = checkLayout(deftRoot, project);
    expect(result.status).toBe("PASS");
  });

  it("formatCheckLine mirrors Python surface", () => {
    expect(formatCheckLine({ name: "uv", status: "PASS", message: "ok" })).toBe(
      "CHECK uv: PASS ok",
    );
  });

  it("evaluate returns exit 1 when any check fails", () => {
    const { exitCode, results } = evaluate("/tmp/deft-empty", "/tmp/project", () => null);
    expect(exitCode).toBe(1);
    expect(results.some((r) => r.status === "FAIL")).toBe(true);
  });

  it("evaluate returns exit 0 when checks pass", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const deftRoot = makeFakeDeftRoot(base);
    const project = makeProjectRoot(base);
    initCleanGitRepo(project);
    const { exitCode } = evaluate(deftRoot, project, () => "/usr/bin/uv");
    expect(exitCode).toBe(0);
  });

  it("checkDocumentModel detects legacy SPECIFICATION.md", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base, { vbrief: false });
    writeFileSync(join(project, "SPECIFICATION.md"), "# legacy spec\n", "utf8");
    const result = checkDocumentModel(project);
    expect(result.status).toBe("PASS");
    expect(result.message).toContain("SPECIFICATION.md");
  });

  it("checkDocumentModel fails on current generated SPECIFICATION.md", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base);
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(project, "vbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(project, "vbrief", "specification.vbrief.json"),
      '{"vBRIEFInfo":{"version":"0.6"},"plan":{"title":"x","status":"running","narratives":{},"items":[]}}',
      "utf8",
    );
    writeFileSync(
      join(project, "SPECIFICATION.md"),
      "<!-- Purpose: rendered specification -->\n<!-- Source of truth: vbrief/specification.vbrief.json -->\n",
      "utf8",
    );
    const result = checkDocumentModel(project);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("not needed");
  });

  it("checkDocumentModel warns when no legacy artifacts", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base, { vbrief: false });
    const result = checkDocumentModel(project);
    expect(result.status).toBe("WARN");
  });

  it("checkGitClean warns on dirty tree", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base);
    initCleanGitRepo(project);
    writeFileSync(join(project, "dirty.txt"), "x", "utf8");
    const result = checkGitClean(project);
    expect(result.status).toBe("WARN");
    expect(result.message).toContain("dirty");
  });

  it("checkGitClean passes on clean tree", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base);
    initCleanGitRepo(project);
    expect(checkGitClean(project).status).toBe("PASS");
  });

  it("checkGitClean warns when project is not a git repository", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base);
    const result = checkGitClean(project);
    expect(result.status).toBe("WARN");
    expect(result.message).toContain("Not a git repository");
  });

  it("checkDocumentModel fails when generated spec lacks lifecycle folders", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base, { vbrief: false });
    mkdirSync(join(project, "vbrief"), { recursive: true });
    writeFileSync(
      join(project, "vbrief", "specification.vbrief.json"),
      '{"vBRIEFInfo":{"version":"0.6"},"plan":{"title":"x","status":"running","narratives":{},"items":[]}}',
      "utf8",
    );
    writeFileSync(
      join(project, "SPECIFICATION.md"),
      "<!-- Purpose: rendered specification -->\n<!-- Source of truth: vbrief/specification.vbrief.json -->\n",
      "utf8",
    );
    const result = checkDocumentModel(project);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("repair missing lifecycle folder");
  });

  it("checkDocumentModel passes for partial vbrief layout", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base);
    const result = checkDocumentModel(project);
    expect(result.status).toBe("PASS");
    expect(result.message).toContain("missing lifecycle folder");
  });

  it("checkDocumentModel detects legacy PROJECT.md", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base, { vbrief: false });
    writeFileSync(join(project, "PROJECT.md"), "# legacy project\n", "utf8");
    const result = checkDocumentModel(project);
    expect(result.status).toBe("PASS");
    expect(result.message).toContain("PROJECT.md");
  });

  it("runMigratePreflight returns config error for missing project root", () => {
    const outcome = runMigratePreflight({
      projectRoot: "/no/such/project",
      deftRoot: "/tmp",
      quiet: false,
    });
    expect(outcome.kind).toBe("config");
  });

  it("runMigratePreflight returns config error for missing deft root", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base);
    const outcome = runMigratePreflight({
      projectRoot: project,
      deftRoot: "/no/such/deft",
      quiet: false,
    });
    expect(outcome.kind).toBe("config");
  });

  it("emitMigratePreflight suppresses PASS lines in quiet mode", () => {
    const lines: string[] = [];
    const code = emitMigratePreflight(
      {
        kind: "ready",
        exitCode: 0,
        results: [
          { name: "uv", status: "PASS", message: "ok" },
          { name: "layout", status: "WARN", message: "warn" },
        ],
      },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
      true,
    );
    expect(code).toBe(0);
    expect(lines.join("")).not.toContain("CHECK uv");
    expect(lines.join("")).toContain("WARN");
  });

  it("emitMigratePreflight writes FAIL lines to stderr", () => {
    const out: string[] = [];
    const err: string[] = [];
    emitMigratePreflight(
      {
        kind: "ready",
        exitCode: 1,
        results: [{ name: "uv", status: "FAIL", message: "missing" }],
      },
      { writeOut: (t) => out.push(t), writeErr: (t) => err.push(t) },
      false,
    );
    expect(err.join("")).toContain("FAIL");
    expect(out.join("")).toBe("");
  });

  it("emitMigratePreflight prints success footer on exit 0", () => {
    const lines: string[] = [];
    const code = emitMigratePreflight(
      {
        kind: "ready",
        exitCode: 0,
        results: [{ name: "uv", status: "PASS", message: "ok" }],
      },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
      false,
    );
    expect(code).toBe(0);
    expect(lines.join("")).toContain("migrate:preflight OK");
  });
});
