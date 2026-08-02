import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import {
  DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
  DEFT_DIRECTIVE_DISABLE_STATUS,
} from "../policy/deft-directive-disable.js";
import { cmdDoctor } from "./main.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-disable-"));
  temps.push(root);
  return root;
}

describe("cmdDoctor — .deft-directive-disable short-circuit (#3039)", () => {
  it("exits 0 with recovery message when the kill-switch is present", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const code = cmdDoctor(["--project-root", root, "--full"]);
    stdoutSpy.mockRestore();
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain(".deft-directive-disable");
    expect(out).toContain("NEW agent session");
    expect(out).toContain("rm .deft-directive-disable");
  });

  it("allows deposit to remain without #2926 inconsistent dirty path", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const code = cmdDoctor(["--project-root", root, "--json"]);
    stdoutSpy.mockRestore();
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join("")) as {
      status: string;
      disabled: boolean;
      kill_switch: boolean;
      inconsistent: boolean;
      deposit_present: boolean;
      disabled_via: string;
    };
    expect(payload.status).toBe(DEFT_DIRECTIVE_DISABLE_STATUS);
    expect(payload.disabled).toBe(true);
    expect(payload.kill_switch).toBe(true);
    expect(payload.inconsistent).toBe(false);
    expect(payload.deposit_present).toBe(true);
    expect(payload.disabled_via).toBe(DEFT_DIRECTIVE_DISABLE_FLAG_NAME);
  });

  it("emits JSON disabled-test-kill-switch status", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "# test\n", "utf8");
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const code = cmdDoctor(["--project-root", root, "--json"]);
    stdoutSpy.mockRestore();
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join("")) as {
      status: string;
      message: string;
    };
    expect(payload.status).toBe(DEFT_DIRECTIVE_DISABLE_STATUS);
    expect(payload.message).toContain("Deposit may still be present");
  });
});
