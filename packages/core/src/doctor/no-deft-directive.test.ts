import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import {
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_FLAG_NAME,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
  NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY,
} from "../policy/no-deft-directive.js";
import { cmdDoctor } from "./main.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-no-deft-"));
  temps.push(root);
  return root;
}

describe("cmdDoctor — .no-deft-directive short-circuit (#2926)", () => {
  it("exits 0 with the disabled message when the flag is present", () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
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
    expect(stdout.join("")).toContain(NO_DEFT_DIRECTIVE_DISABLED_MESSAGE);
  });

  it("emits JSON disabled status when --json is set", () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
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
      disabled_via: string;
    };
    expect(payload.status).toBe("disabled");
    expect(payload.disabled).toBe(true);
    expect(payload.disabled_via).toBe(NO_DEFT_DIRECTIVE_FLAG_NAME);
  });

  it("diagnoses flag+deposit inconsistency as dirty with warning", () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const code = cmdDoctor(["--project-root", root, "--full"]);
    stderrSpy.mockRestore();
    expect(code).toBe(1);
    expect(stderr.join("")).toContain(NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE);
    expect(stderr.join("")).toContain(NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY);
  });

  it("surfaces inconsistent_policy in JSON when flag+deposit conflict", () => {
    const root = tempRoot();
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
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
    expect(code).toBe(1);
    const payload = JSON.parse(stdout.join("")) as {
      status: string;
      inconsistent_policy: string;
      findings: Array<{ policy?: string }>;
    };
    expect(payload.status).toBe("disabled-inconsistent");
    expect(payload.inconsistent_policy).toBe(NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY);
    expect(payload.findings[0]?.policy).toBe(NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY);
  });
});
