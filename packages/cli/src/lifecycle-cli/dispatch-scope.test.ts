import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runDispatch } from "./helpers.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeVbriefRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-lc-scope-"));
  temps.push(root);
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "vbrief", folder), { recursive: true });
  }
  return root;
}

describe("deft-ts scope lifecycle verb (#1838 s3)", () => {
  it("scope-lifecycle returns usage error for incomplete argv", async () => {
    const result = await runDispatch(["scope-lifecycle", "promote"]);
    expect(result.exitCode).toBe(2);
  });

  it("scope-lifecycle rejects unknown subcommand", async () => {
    const root = makeVbriefRoot();
    const result = await runDispatch([
      "scope-lifecycle",
      "not-a-verb",
      join(root, "vbrief", "pending", "x.vbrief.json"),
      "--project-root",
      root,
    ]);
    expect(result.exitCode).toBe(2);
  });

  it("scope-lifecycle promote rejects missing vbrief path", async () => {
    const root = makeVbriefRoot();
    const result = await runDispatch(["scope-lifecycle", "promote", "--project-root", root]);
    expect(result.exitCode).toBe(2);
  });

  it("triage-scope alias routes to triage-scope handler", async () => {
    const root = makeVbriefRoot();
    const result = await runDispatch(["triage:scope", "--project-root", root, "--help"]);
    expect(result.exitCode).toBe(0);
  });
});
