import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FROZEN_PRECUTOVER_MIGRATION_TAG } from "../vbrief-validate/precutover.js";
import {
  checkDocumentModel,
  checkGitClean,
  checkLayout,
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
  opts: { schemas?: boolean; contentNested?: boolean } = {},
): string {
  const { schemas = true, contentNested = false } = opts;
  const deftRoot = join(base, "deft");
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
    expect(formatCheckLine({ name: "layout", status: "PASS", message: "ok" })).toBe(
      "CHECK layout: PASS ok",
    );
  });

  it("evaluate returns exit 1 when any check fails", () => {
    const { exitCode, results } = evaluate("/tmp/deft-empty", "/tmp/project");
    expect(exitCode).toBe(1);
    expect(results.some((r) => r.status === "FAIL")).toBe(true);
  });

  it("evaluate returns exit 0 when checks pass", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const deftRoot = makeFakeDeftRoot(base);
    const project = makeProjectRoot(base);
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(project, "vbrief", folder), { recursive: true });
    }
    initCleanGitRepo(project);
    const { exitCode } = evaluate(deftRoot, project);
    expect(exitCode).toBe(0);
  });

  it("checkDocumentModel fails on legacy SPECIFICATION.md with frozen guidance", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base, { vbrief: false });
    writeFileSync(join(project, "SPECIFICATION.md"), "# legacy spec\n", "utf8");
    const result = checkDocumentModel(project);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain(FROZEN_PRECUTOVER_MIGRATION_TAG);
  });

  it("checkDocumentModel fails on legacy PROJECT.md with frozen guidance", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base, { vbrief: false });
    writeFileSync(join(project, "PROJECT.md"), "# legacy project\n", "utf8");
    const result = checkDocumentModel(project);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("PROJECT.md");
    expect(result.message).toContain(FROZEN_PRECUTOVER_MIGRATION_TAG);
  });

  it("checkDocumentModel passes on current generated SPECIFICATION.md", () => {
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
    expect(result.status).toBe("PASS");
    expect(result.message).toContain("not needed");
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

  it("checkDocumentModel fails for partial vbrief layout", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const project = makeProjectRoot(base);
    const result = checkDocumentModel(project);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("missing lifecycle folder");
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

  it("runMigratePreflight returns config error for missing project root", () => {
    const outcome = runMigratePreflight({
      projectRoot: "/no/such/project",
      deftRoot: "/tmp",
      quiet: false,
    });
    expect(outcome.kind).toBe("config");
  });

  it("emitMigratePreflight prints frozen-path footer on exit 1", () => {
    const err: string[] = [];
    emitMigratePreflight(
      {
        kind: "ready",
        exitCode: 1,
        results: [{ name: "document-model", status: "FAIL", message: "legacy" }],
      },
      { writeOut: () => {}, writeErr: (t) => err.push(t) },
      false,
    );
    expect(err.join("")).toContain("#2068");
  });

  it("runMigratePreflight returns config error for missing deft root", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    const outcome = runMigratePreflight({
      projectRoot: base,
      deftRoot: join(base, "missing-deft"),
      quiet: false,
    });
    expect(outcome.kind).toBe("config");
  });

  it("emitMigratePreflight quiet mode suppresses PASS lines", () => {
    const lines: string[] = [];
    emitMigratePreflight(
      {
        kind: "ready",
        exitCode: 0,
        results: [
          { name: "layout", status: "PASS", message: "ok" },
          { name: "document-model", status: "WARN", message: "warn" },
        ],
      },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
      true,
    );
    expect(lines.join("")).not.toContain("CHECK layout: PASS");
    expect(lines.join("")).toContain("WARN");
  });

  it("checkGitClean warns when directory is not a git repository", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(base);
    mkdirSync(join(base, "project"), { recursive: true });
    const result = checkGitClean(join(base, "project"));
    expect(result.status).toBe("WARN");
    expect(result.message).toContain("Not a git repository");
  });

  it("emitMigratePreflight prints success footer on exit 0", () => {
    const lines: string[] = [];
    const code = emitMigratePreflight(
      {
        kind: "ready",
        exitCode: 0,
        results: [{ name: "document-model", status: "PASS", message: "ok" }],
      },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
      false,
    );
    expect(code).toBe(0);
    expect(lines.join("")).toContain("no pre-v0.20");
  });
});
