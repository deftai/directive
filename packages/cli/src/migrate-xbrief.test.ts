import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./migrate-xbrief.js";

describe("migrate-xbrief CLI", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses --force and project/framework roots", () => {
    const args = parseArgs([
      "--project-root",
      "/tmp/project",
      "--framework-root",
      "/tmp/deft",
      "--force",
    ]);
    expect(args.error).toBeUndefined();
    expect(args.projectRoot).toBe("/tmp/project");
    expect(args.frameworkRoot).toBe("/tmp/deft");
    expect(args.force).toBe(true);
    expect(args.keepLegacy).toBe(false);
  });

  it("parses --keep-legacy (#2270)", () => {
    const args = parseArgs(["--project-root", "/tmp/project", "--keep-legacy"]);
    expect(args.error).toBeUndefined();
    expect(args.keepLegacy).toBe(true);
  });

  it("returns 2 for unknown flags", () => {
    expect(run(["--not-real"])).toBe(2);
  });

  it("resolves the consumer .deft/core deposit when --framework-root is omitted (#2146)", () => {
    const project = mkdtempSync(join(tmpdir(), "migrate-xbrief-cli-"));
    created.push(project);
    const deposit = join(project, ".deft", "core");
    mkdirSync(deposit, { recursive: true });
    const args = parseArgs(["--project-root", project]);
    expect(args.error).toBeUndefined();
    expect(args.frameworkRoot).toBe(deposit);
  });
});
