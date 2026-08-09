import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePreDispatchArgv, preDispatchMain } from "./pre-dispatch-cli.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("parsePreDispatchArgv / preDispatchMain (#3228)", () => {
  it("parses scope, target, action, and flags", () => {
    const p = parsePreDispatchArgv([
      "--scope-id",
      "3228",
      "--target-id",
      "wt",
      "--action",
      "cancel",
      "--json",
      "--project-root",
      "/tmp/x",
    ]);
    expect(p.scopeId).toBe("3228");
    expect(p.targetId).toBe("wt");
    expect(p.action).toBe("cancel");
    expect(p.json).toBe(true);
    expect(p.projectRoot).toBe("/tmp/x");
  });

  it("preDispatchMain exits 2 on missing unit keys", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-dispatch-cli-"));
    temps.push(root);
    expect(preDispatchMain(["--project-root", root])).toBe(2);
  });

  it("preDispatchMain begin then deny then cancel then begin", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-dispatch-cli-flow-"));
    temps.push(root);
    const base = [
      "--project-root",
      root,
      "--scope-id",
      "s1",
      "--target-id",
      "t1",
      "--source-revision",
      "r1",
      "--json",
    ];
    expect(preDispatchMain([...base, "--action", "begin"])).toBe(0);
    expect(preDispatchMain([...base, "--action", "begin"])).toBe(1);
    expect(preDispatchMain([...base, "--action", "cancel"])).toBe(0);
    expect(preDispatchMain([...base, "--action", "begin", "--source-revision", "r2"])).toBe(0);
  });

  it("help exits 2", () => {
    expect(preDispatchMain(["--help"])).toBe(2);
  });
});
