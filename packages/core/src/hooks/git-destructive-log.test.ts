import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendGitDestructiveRecord,
  GIT_DESTRUCTIVE_LOG_ENV,
  type GitDestructiveRecord,
  resolveGitDestructiveLogPath,
} from "./git-destructive-log.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function sample(over: Partial<GitDestructiveRecord> = {}): GitDestructiveRecord {
  return {
    ts: "2026-08-30T16:00:00.000Z",
    kind: "git-reset-hard",
    disposition: "deny",
    command: "git reset --hard origin/master",
    projectRoot: "/project",
    host: "grok",
    toolName: "Bash",
    actor: "host:grok:v1:abc",
    pid: 1,
    relocators: [],
    unprovable: false,
    ...over,
  };
}

describe("git-destructive log (#3917)", () => {
  it("resolves under the platform user-config dir, not the repository", () => {
    const posix = resolveGitDestructiveLogPath({}, "linux", "/home/t").replace(/\\/g, "/");
    expect(posix).toContain("deft/logs/git-destructive.jsonl");
    expect(posix).toContain("/home/t/.config/deft/");
    expect(posix).not.toContain("/project/");
  });

  it("honors DEFT_GIT_DESTRUCTIVE_LOG over the platform default", () => {
    const path = resolveGitDestructiveLogPath(
      { [GIT_DESTRUCTIVE_LOG_ENV]: "/tmp/custom-git-destructive.jsonl" },
      "linux",
      "/home/t",
    );
    expect(path.replace(/\\/g, "/")).toMatch(/\/tmp\/custom-git-destructive\.jsonl$/);
  });

  it("appends a JSONL record that names actor, command, and disposition", () => {
    const dir = mkdtempSync(join(tmpdir(), "gdl-"));
    temps.push(dir);
    const logPath = join(dir, "git-destructive.jsonl");
    appendGitDestructiveRecord(sample(), { logPath });
    appendGitDestructiveRecord(sample({ disposition: "allow-fixture", actor: "sess-2" }), {
      logPath,
    });
    const lines = readFileSync(logPath, "utf8").trimEnd().split(/\n/u);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}") as GitDestructiveRecord;
    expect(first.actor).toBe("host:grok:v1:abc");
    expect(first.command).toContain("reset --hard");
    expect(first.disposition).toBe("deny");
    expect(first.host).toBe("grok");
    const second = JSON.parse(lines[1] ?? "{}") as GitDestructiveRecord;
    expect(second.disposition).toBe("allow-fixture");
  });

  it("swallows append failures so a deny cannot be blocked by the log", () => {
    expect(() =>
      appendGitDestructiveRecord(sample(), {
        append: () => {
          throw new Error("disk full");
        },
      }),
    ).not.toThrow();
  });
});
