import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectAgentHookDeposit, writeAgentHookDeposit } from "../init-deposit/agent-hooks.js";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import {
  DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
  DEFT_DIRECTIVE_DISABLE_STATUS,
} from "../policy/deft-directive-disable.js";
import { cmdDoctor } from "./main.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    // Windows suite-load can leave AV/handles briefly locking temp trees (#5089).
    rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  vi.restoreAllMocks();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-disable-"));
  temps.push(root);
  return root;
}

describe("cmdDoctor — .deft-directive-disable short-circuit (#3039)", () => {
  it("exits 0 with recovery message when an untracked kill-switch is present", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    // Temp dirs are not a git worktree → ls-files empty → active kill-switch.
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
    expect(out).toContain("The flag is present: stop Directive process load");
    expect(out).toContain("claude: agent notice via SessionStart not registered");
    expect(out).toContain("grok: agent notice via SessionStart not registered");
    expect(out).toContain("cursor: agent notice via SessionStart not registered");
    expect(out).toContain(
      "codex: agent notice via SessionStart not registered (docs-best-effort; no compact re-fire)",
    );
  });

  it("reports SessionStart registered from per-host SessionStart inspection on DISABLED (#4884)", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const code = cmdDoctor(["--project-root", root, "--full"], {
      inspectSessionStartNotice: () => [
        { host: "claude", registered: true },
        { host: "grok", registered: false },
        { host: "cursor", registered: true },
        { host: "codex", registered: true },
      ],
    });
    stdoutSpy.mockRestore();
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("claude: agent notice via SessionStart registered");
    expect(out).toContain("grok: agent notice via SessionStart not registered");
    expect(out).toContain("cursor: agent notice via SessionStart registered");
    expect(out).toContain(
      "codex: agent notice via SessionStart registered (docs-best-effort; no compact re-fire)",
    );
  });

  it("keeps SessionStart registered when PreToolUse or compact has drifted (#4884)", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    writeAgentHookDeposit(root);
    const claudePath = join(root, ".claude/settings.json");
    const claude = JSON.parse(readFileSync(claudePath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    delete claude.hooks.PreToolUse;
    delete claude.hooks.PreCompact;
    delete claude.hooks.PostCompact;
    writeFileSync(claudePath, `${JSON.stringify(claude, null, 2)}\n`, "utf8");
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "claude")?.status).toBe(
      "drifted",
    );
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
    expect(out).toContain("claude: agent notice via SessionStart registered");
    expect(out).toContain("grok: agent notice via SessionStart registered");
    expect(out).toContain("cursor: agent notice via SessionStart registered");
    expect(out).toContain(
      "codex: agent notice via SessionStart registered (docs-best-effort; no compact re-fire)",
    );
  });

  it("reports SessionStart not registered when only that event is missing (#4884)", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    writeAgentHookDeposit(root);
    const claudePath = join(root, ".claude/settings.json");
    const claude = JSON.parse(readFileSync(claudePath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    delete claude.hooks.SessionStart;
    writeFileSync(claudePath, `${JSON.stringify(claude, null, 2)}\n`, "utf8");
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
    expect(stdout.join("")).toContain("claude: agent notice via SessionStart not registered");
  });

  it("stays DISABLED when SessionStart registration probe throws (#4884)", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const code = cmdDoctor(["--project-root", root], {
      inspectSessionStartNotice: () => {
        throw new Error("registration probe failed");
      },
    });
    stdoutSpy.mockRestore();
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("NEW agent session");
    expect(out).not.toContain("agent notice via SessionStart");
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
      message: string;
    };
    expect(payload.message).toContain("agent notice via SessionStart");
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
