import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalHostSessionId } from "./host-session-owner.js";
import {
  applyWorktreeOccupancy,
  formatOccupancyMintRefusal,
  formatReleaseRerunLine,
  formatRerunCommand,
  quoteShellArg,
  releaseOccupancy,
  resolveOccupancySessionClaim,
} from "./occupancy.js";

const CLAUDE_RAW = "3d367ca0-6f5d-4152-82fe-31b3b8ff8de6";
const CLAUDE_OWNER = canonicalHostSessionId("claude", CLAUDE_RAW);

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "occ-6647-"));
  temps.push(root);
  mkdirSync(join(root, ".deft"), { recursive: true });
  return root;
}

describe("quoteShellArg and formatRerunCommand (#6647)", () => {
  it("leaves safe tokens bare and quotes the rest per platform", () => {
    expect(quoteShellArg("--project-root=C:/x/y", "linux")).toBe("--project-root=C:/x/y");
    expect(quoteShellArg("a b", "linux")).toBe("'a b'");
    expect(quoteShellArg("it's", "linux")).toBe("'it'\\''s'");
    expect(quoteShellArg("a b", "win32")).toBe('"a b"');
    expect(quoteShellArg('say "x"', "win32")).toBe('"say \\"x\\""');
    // Backslash runs before a quote or the closing quote double (Windows argv rules).
    expect(quoteShellArg('a\\"b c', "win32")).toBe('"a\\\\\\"b c"');
    expect(quoteShellArg("C:\\my repo\\", "win32")).toBe('"C:\\my repo\\\\"');
    expect(quoteShellArg("C:\\my repo", "win32")).toBe('"C:\\my repo"');
  });

  it("keeps the caller's arguments, drops any --session-id and appends the id", () => {
    const command = formatRerunCommand(
      {
        verb: "session:start",
        args: ["--read-only", "--session-id", "old", "--project-root", "C:/my repo"],
      },
      "host:x:v1:abc",
      "linux",
    );
    expect(command).toBe(
      "deft session:start --read-only --project-root 'C:/my repo' --session-id=host:x:v1:abc",
    );
    const equalsForm = formatRerunCommand(
      { verb: "session:ready", args: ["--session-id=old", "--with-network"] },
      "<host-published-id>",
      "linux",
    );
    expect(equalsForm).toBe("deft session:ready --with-network --session-id=<host-published-id>");
  });
});

describe("refuse-mint prints the full re-run command (#6647)", () => {
  it("fills the suggested id into the caller's own command", () => {
    const claim = resolveOccupancySessionClaim({
      env: { CLAUDE_CODE_SESSION_ID: CLAUDE_RAW },
      newSessionId: () => "minted",
      invocation: { verb: "session:start", args: ["--project-root=C:/repo"] },
    });
    expect(claim.status).toBe("refuse-mint");
    if (claim.status !== "refuse-mint") return;
    expect(claim.message).toContain(
      `deft session:start --project-root=C:/repo --session-id=${CLAUDE_OWNER}`,
    );
    expect(claim.message).not.toContain("template");
  });

  it("marks a template when no id is known", () => {
    const claim = resolveOccupancySessionClaim({
      env: { CLAUDECODE: "1" },
      newSessionId: () => "minted",
      invocation: { verb: "session:ready", args: [] },
    });
    expect(claim.status).toBe("refuse-mint");
    if (claim.status !== "refuse-mint") return;
    expect(claim.message).toContain("template");
    expect(claim.message).toContain("deft session:ready --session-id=<host-published-id>");
  });

  it("treats an unsafe suggested id as a template", () => {
    const message = formatOccupancyMintRefusal({
      hosts: ["claude"],
      suggestedSessionId: "bad id;rm",
      invocation: { verb: "session:start", args: [] },
    });
    expect(message).toContain("template");
    expect(message).toContain("--session-id=<host-published-id>");
  });

  it("keeps the old one-line message without an invocation", () => {
    const message = formatOccupancyMintRefusal({
      hosts: ["claude"],
      suggestedSessionId: CLAUDE_OWNER,
    });
    expect(message).toContain(`Re-run with \`--session-id=${CLAUDE_OWNER}\`.`);
  });
});

describe("occupancy:release refusal prints the caller's command (#6647)", () => {
  it("formats the caller's own id or a marked template", () => {
    expect(formatReleaseRerunLine("my-session")).toContain(
      "`deft occupancy:release --session-id=my-session`",
    );
    const template = formatReleaseRerunLine("");
    expect(template).toContain("`deft occupancy:release --session-id=<your-session-id>`");
    expect(template).toContain("template");
  });

  it("prints a template for a bare release and never names the lease owner as the caller", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner-session", now });
    const denied = releaseOccupancy(root, { env: {}, now });
    expect(denied.action).toBe("denied");
    expect(denied.message).toContain("occupancy:release --session-id=<your-session-id>");
    // The existing remediation tells the occupant its own command; the caller line never does.
    const callerLine = denied.message.split("\n").at(-1) as string;
    expect(callerLine).toContain("Release command (template");
    expect(callerLine).not.toContain("owner-session");
  });

  it("prints the caller's id for a non-owner release", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner-session", now });
    const denied = releaseOccupancy(root, { sessionId: "other-session", now });
    expect(denied.action).toBe("denied");
    expect(denied.message).toContain("occupancy:release --session-id=other-session`");
  });
});
