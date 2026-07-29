import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import {
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_FLAG_NAME,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
} from "../policy/no-deft-directive.js";
import { runSessionStart } from "./session-start.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-no-deft-"));
  temps.push(root);
  return root;
}

describe("runSessionStart — .no-deft-directive short-circuit (#2926)", () => {
  it("skips the session ritual when the root flag is present", () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
    const result = runSessionStart(root, {
      writeHistory: false,
      verifyTools: () => {
        throw new Error("verifyTools must not run when opt-out flag is present");
      },
      runTriageWelcome: () => {
        throw new Error("triage welcome must not run when opt-out flag is present");
      },
      runGit: () => {
        throw new Error("git must not run when opt-out flag is present");
      },
    });
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([NO_DEFT_DIRECTIVE_DISABLED_MESSAGE]);
    expect(result.payload.disabled).toBe(true);
    expect(result.payload.disabled_via).toBe(NO_DEFT_DIRECTIVE_FLAG_NAME);
    expect(result.payload.inconsistent).toBe(false);
    // Fail-closed for automation: opt-out skips ritual and is not "ready for work".
    expect(result.payload.ready).toBe(false);
    expect(result.payload.message).toBe(NO_DEFT_DIRECTIVE_DISABLED_MESSAGE);
  });

  it("warns and exits dirty when flag and deposit are both present", () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "# opt out\n", "utf8");
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const result = runSessionStart(root, { writeHistory: false });
    expect(result.code).toBe(1);
    expect(result.lines).toContain(NO_DEFT_DIRECTIVE_DISABLED_MESSAGE);
    expect(result.lines).toContain(NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE);
    expect(result.payload.inconsistent).toBe(true);
    expect(result.payload.deposit_present).toBe(true);
    expect(result.payload.ready).toBe(false);
  });
});
