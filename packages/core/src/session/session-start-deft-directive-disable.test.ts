import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import {
  DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
  DEFT_DIRECTIVE_DISABLE_STATUS,
} from "../policy/deft-directive-disable.js";
import { NO_DEFT_DIRECTIVE_FLAG_NAME } from "../policy/no-deft-directive.js";
import { runSessionStart } from "./session-start.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-disable-"));
  temps.push(root);
  return root;
}

describe("runSessionStart — .deft-directive-disable short-circuit (#3039)", () => {
  it("skips the session ritual when the kill-switch is present", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    const result = runSessionStart(root, {
      writeHistory: false,
      verifyTools: () => {
        throw new Error("verifyTools must not run when kill-switch is present");
      },
      runTriageWelcome: () => {
        throw new Error("triage welcome must not run when kill-switch is present");
      },
      runGit: () => {
        throw new Error("git must not run when kill-switch is present");
      },
    });
    expect(result.code).toBe(0);
    expect(result.payload.disabled).toBe(true);
    expect(result.payload.disabled_via).toBe(DEFT_DIRECTIVE_DISABLE_FLAG_NAME);
    expect(result.payload.status).toBe(DEFT_DIRECTIVE_DISABLE_STATUS);
    expect(result.payload.ready).toBe(false);
    expect(result.payload.inconsistent).toBe(false);
    expect(String(result.payload.message)).toContain("NEW agent session");
    expect(result.lines.join("\n")).toContain("rm .deft-directive-disable");
  });

  it("allows deposit to remain without dirty exit", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "# A/B\n", "utf8");
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const result = runSessionStart(root, { writeHistory: false });
    expect(result.code).toBe(0);
    expect(result.payload.deposit_present).toBe(true);
    expect(result.payload.inconsistent).toBe(false);
    expect(result.payload.ready).toBe(false);
  });

  it("combines permanent opt-out when both flags present", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
    const result = runSessionStart(root, { writeHistory: false });
    expect(result.code).toBe(0);
    expect(result.payload.disabled_via).toBe(DEFT_DIRECTIVE_DISABLE_FLAG_NAME);
    expect(result.payload.permanent_opt_out_also_present).toBe(true);
    expect(result.lines.join("\n")).toContain(".no-deft-directive");
  });
});
