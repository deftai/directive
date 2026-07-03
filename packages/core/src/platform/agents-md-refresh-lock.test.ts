import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentsRefreshApplyResult,
  applyAgentsRefresh,
  extractManagedSection,
  parseManagedSectionAttrs,
} from "./agents-md.js";
import { AGENTS_MANAGED_CLOSE } from "./constants.js";

// Regression coverage for the #1329 concurrent-write race: the AGENTS.md
// managed-section read->compute->write must be serialized behind an advisory
// lock and written atomically so N racing refreshers never corrupt the file or
// leave a partially-written / non-input session= value. The concurrency is
// asserted deterministically via the withAppendLock seams (mirroring
// slice/lock.test.ts) rather than a flaky wall-clock multi-process race
// (test-performance discipline, #975).
describe("applyAgentsRefresh serialized + atomic write (#1329)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshProject(): string {
    const root = mkdtempSync(join(tmpdir(), "agents-refresh-lock-"));
    created.push(root);
    return root;
  }

  function onDiskSession(root: string): string | null {
    const section = extractManagedSection(readFileSync(join(root, "AGENTS.md"), "utf8"));
    if (section === null) return null;
    return parseManagedSectionAttrs(section)?.session ?? null;
  }

  function managedBlockCount(root: string): number {
    return (
      readFileSync(join(root, "AGENTS.md"), "utf8").split("<!-- deft:managed-section").length - 1
    );
  }

  function staleAgentsMd(): string {
    return [
      "<!-- deft:managed-section v3 sha=oldoldoldold refreshed=2020-01-01T00:00:00Z session=oldsession01 -->",
      "# Stale managed body that no longer matches the current template.",
      AGENTS_MANAGED_CLOSE,
      "",
    ].join("\n");
  }

  it("N racing writers leave one valid managed section whose session is one of the N inputs", () => {
    const project = freshProject();
    const sessions = [
      "aaaaaaaaaaaa",
      "bbbbbbbbbbbb",
      "cccccccccccc",
      "dddddddddddd",
      "eeeeeeeeeeee",
    ];
    // Each writer computes its plan from a fresh read inside the lock; the winner
    // materializes the section, the rest observe "current" and no-op. Whichever
    // ordering wins, the final on-disk session must be a complete value from the
    // input set -- never a torn / partial / non-input value.
    const results: AgentsRefreshApplyResult[] = sessions.map((sid) =>
      applyAgentsRefresh(project, {}, { newSession: () => sid }),
    );

    expect(results.some((r) => r.wrote)).toBe(true);
    const finalSession = onDiskSession(project);
    expect(finalSession).not.toBeNull();
    expect(sessions).toContain(finalSession);
    expect(managedBlockCount(project)).toBe(1);
    // Atomic temp+rename leaves no temp or lock residue behind.
    const residue = readdirSync(project).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
    expect(residue).toEqual([]);
  });

  it("writes atomically when the section is stale (final session is exactly the writer's input)", () => {
    const project = freshProject();
    writeFileSync(join(project, "AGENTS.md"), staleAgentsMd(), "utf8");
    const result = applyAgentsRefresh(project, {}, { newSession: () => "fedcba987654" });
    expect(result.wrote).toBe(true);
    expect(result.state).toBe("stale");
    expect(onDiskSession(project)).toBe("fedcba987654");
    expect(managedBlockCount(project)).toBe(1);
    const residue = readdirSync(project).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
    expect(residue).toEqual([]);
  });

  it("serializes the RMW: a concurrently-held lock blocks the writer without mutating AGENTS.md", () => {
    const project = freshProject();
    applyAgentsRefresh(project, {}, { newSession: () => "aaaaaaaaaaaa" });
    const before = readFileSync(join(project, "AGENTS.md"), "utf8");

    // Simulate a concurrent holder owning the sidecar lock; the writer must block
    // (and here time out) rather than read-modify-write past the other holder.
    writeFileSync(join(project, "AGENTS.md.lock"), "\0");
    let now = 0;
    expect(() =>
      applyAgentsRefresh(
        project,
        {},
        { newSession: () => "ffffffffffff" },
        {
          now: () => {
            now += 31_000;
            return now;
          },
          sleepMs: () => {
            /* deterministic: no wall-clock spin */
          },
        },
      ),
    ).toThrow(/timed out acquiring lock/);

    // The blocked writer never touched AGENTS.md.
    rmSync(join(project, "AGENTS.md.lock"), { force: true });
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("--check and --dry-run never write and leave no lock residue", () => {
    const project = freshProject();
    applyAgentsRefresh(project, {}, { newSession: () => "aaaaaaaaaaaa" });

    const check = applyAgentsRefresh(project, { check: true });
    expect(check.wrote).toBe(false);
    expect(check.state).toBe("current");

    writeFileSync(join(project, "AGENTS.md"), staleAgentsMd(), "utf8");
    const dry = applyAgentsRefresh(project, { dryRun: true }, { newSession: () => "bbbbbbbbbbbb" });
    expect(dry.wrote).toBe(false);
    expect(dry.writable).toBe(true);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(staleAgentsMd());

    const residue = readdirSync(project).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"));
    expect(residue).toEqual([]);
  });
});
