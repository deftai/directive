import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGY_DIRECTIVE_HOOK_NAME } from "../hooks/classify/agy-hook-order.js";
import { checkAgyHookOrder } from "./checks.js";

const PRE = { PreToolUse: [{ matcher: "*", hooks: [{ command: "x" }] }] };

function project(config: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "deft-7378-doctor-"));
  if (config !== null) {
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents", "hooks.json"), config);
  }
  return root;
}

describe("doctor agy hook ordering (#7378)", () => {
  it("passes as not applicable without a hook file or a Directive entry", () => {
    for (const config of [null, JSON.stringify({ other: PRE })]) {
      const root = project(config);
      try {
        const result = checkAgyHookOrder(root);
        expect(result.name).toBe("agy-hook-order");
        expect(result.status).toBe("pass");
        expect(result.data).toMatchObject({ applicable: false });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("passes when nothing runs at or after Directive's entry", () => {
    const root = project(JSON.stringify({ [AGY_DIRECTIVE_HOOK_NAME]: PRE, "obs-a": PRE }));
    try {
      expect(checkAgyHookOrder(root).status).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails and names the foreign hook, with the one remediation, without editing the file", () => {
    const text = JSON.stringify({ [AGY_DIRECTIVE_HOOK_NAME]: PRE, zzzzz: PRE });
    const root = project(text);
    try {
      const result = checkAgyHookOrder(root);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain('Hook "zzzzz"');
      expect(result.detail).toContain("deft policy:disable-host-hooks --host agy --confirm");
      expect(readFileSync(join(root, ".agents", "hooks.json"), "utf8")).toBe(text);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an unparseable config that names Directive's entry as a finding", () => {
    const root = project(`{"${AGY_DIRECTIVE_HOOK_NAME}": bad`);
    try {
      const result = checkAgyHookOrder(root);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("not valid JSON");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves another tool's unreadable file at the same path alone", () => {
    const root = project("# not json\n");
    try {
      expect(checkAgyHookOrder(root).status).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
