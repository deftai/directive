import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_FLAG_NAME,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
} from "../policy/no-deft-directive.js";
import { CANONICAL_INSTALL_ROOT } from "./constants.js";
import { runInitDispatchCli } from "./init-dispatch.js";
import { runRefreshDepositCli, UPDATE_REFUSED_EXIT_CODE } from "./refresh.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "init-no-deft-"));
  temps.push(root);
  return root;
}

describe("init/update — .no-deft-directive short-circuit (#2926)", () => {
  it("skips init scaffold when the flag is present", async () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
    const out: string[] = [];
    const code = await runInitDispatchCli({
      projectDir: root,
      jsonOut: false,
      nonInteractive: true,
      dryRun: false,
      writeOut: (t) => out.push(t),
      writeErr: (t) => out.push(t),
      seams: {
        runScaffold: async () => {
          throw new Error("scaffold must not run when opt-out flag is present");
        },
      },
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain(NO_DEFT_DIRECTIVE_DISABLED_MESSAGE);
  });

  it("fails closed on init when flag and deposit are both present", async () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const out: string[] = [];
    const code = await runInitDispatchCli({
      projectDir: root,
      jsonOut: false,
      nonInteractive: true,
      dryRun: false,
      writeOut: (t) => out.push(t),
      writeErr: (t) => out.push(t),
      seams: {
        runRefresh: async () => {
          throw new Error("refresh must not run when opt-out flag is present");
        },
      },
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain(NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE);
  });

  it("refuses update when the flag is present", async () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const out: string[] = [];
    const code = await runRefreshDepositCli({
      projectDir: root,
      jsonOut: false,
      nonInteractive: true,
      upgrade: false,
      dryRun: false,
      writeOut: (t) => out.push(t),
      writeErr: (t) => out.push(t),
    });
    expect(code).toBe(UPDATE_REFUSED_EXIT_CODE);
    expect(out.join("")).toContain(NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE);
  });
});
