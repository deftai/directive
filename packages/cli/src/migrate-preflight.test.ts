import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLayout } from "@deftai/directive-core/migrate-preflight";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "./migrate-preflight.js";

describe("migrate-preflight CLI (#2146)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the consumer .deft/core deposit when --deft-root is omitted", () => {
    const project = mkdtempSync(join(tmpdir(), "migrate-preflight-cli-"));
    created.push(project);
    const deposit = join(project, ".deft", "core");
    mkdirSync(join(deposit, "xbrief", "schemas"), { recursive: true });
    mkdirSync(join(project, "xbrief"), { recursive: true });

    const args = parseArgs(["--project-root", project]);
    expect(args.error).toBeUndefined();
    expect(args.deftRoot).toBe(deposit);
    expect(checkLayout(args.deftRoot, project).status).toBe("PASS");
  });

  it("honors an explicit --deft-root override", () => {
    const args = parseArgs(["--deft-root", "/tmp/custom-deft"]);
    expect(args.deftRoot).toBe("/tmp/custom-deft");
  });
});
