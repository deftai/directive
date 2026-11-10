import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyingHostPath,
  applyWorktreeOccupancy,
  canonicalHostSessionId,
  publishApplyingHost,
  readApplyingHost,
} from "@deftai/directive-core/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatApplyingHostReleaseHelp, parseArgs, run } from "./applying-host-release.js";

const RAW = "dcd6d34c-5e07-4e3c-89dd-83471ee80fdf";
const CURSOR_OWNER = canonicalHostSessionId("cursor", RAW);
const CLAUDE_OWNER = canonicalHostSessionId("claude", RAW);

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length > 0) {
    const root = temps.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("applying-host:release (#6143)", () => {
  it("prints help", () => {
    expect(formatApplyingHostReleaseHelp()).toContain("applying-host:release");
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("clears an abandoned no-lease soft claim for any presented caller", () => {
    const root = mkdtempSync(join(tmpdir(), "ahr-clear-"));
    temps.push(root);
    publishApplyingHost(root, { provider: "cursor", rawSessionId: RAW });
    expect(readApplyingHost(root).status).toBe("ok");
    const code = run([`--project-root=${root}`, `--session-id=${CLAUDE_OWNER}`]);
    expect(code).toBe(0);
    expect(readApplyingHost(root).status).toBe("missing");
  });

  it("refuses clear while a live foreign occupant holds the lease", () => {
    const root = mkdtempSync(join(tmpdir(), "ahr-deny-"));
    temps.push(root);
    const now = new Date();
    const claimed = applyWorktreeOccupancy(root, {
      sessionId: CURSOR_OWNER,
      now,
      intent: "mutation",
    });
    expect(claimed.code).toBe(0);
    publishApplyingHost(root, { provider: "cursor", rawSessionId: RAW, claimedAt: now });
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const code = run([`--project-root=${root}`, `--session-id=${CLAUDE_OWNER}`]);
    expect(code).toBe(1);
    expect(err.join("")).toContain("Live occupant");
    expect(err.join("")).toContain(CLAUDE_OWNER);
    expect(readApplyingHost(root).status).toBe("ok");
    expect(applyingHostPath(root)).toContain("applying-host.json");
  });
});
