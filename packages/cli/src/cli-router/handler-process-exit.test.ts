import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "../dispatch.js";
import { HandlerProcessExit, isHandlerProcessExit } from "./handler-process-exit.js";

const prevExit = process.exit;
afterEach(() => {
  process.exit = prevExit;
});

describe("HandlerProcessExit (#4591)", () => {
  it("is recognized by the type guard", () => {
    const err = new HandlerProcessExit(1);
    expect(isHandlerProcessExit(err)).toBe(true);
    expect(isHandlerProcessExit(new Error("boom"))).toBe(false);
    expect(err.code).toBe(1);
  });

  it("dispatch returns process.exit code instead of reclassifying as 2", async () => {
    process.exit = ((code?: number): never => {
      throw new HandlerProcessExit(code ?? 0);
    }) as typeof process.exit;
    const root = mkdtempSync(join(tmpdir(), "hpe-"));
    const specPath = join(root, "spec.json");
    const outPath = join(root, "PRD.md");
    writeFileSync(specPath, "null\n", "utf8");
    const code = await dispatch(["prd-render", "--spec", specPath, "--output", outPath]);
    expect(code).toBe(1);
  });
});
