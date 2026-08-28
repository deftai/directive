import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pythonJsonPretty } from "./json.js";
import {
  CONFIGURED_PROJECT_DEFINITION_LABEL,
  type MutationLockDeps,
  ProjectDefinitionLockError,
  projectDefinitionArtifactLabel,
  projectDefinitionMutationLock,
  projectDefinitionPath,
} from "./project-definition-io.js";

const roots: string[] = [];

function seedProject(prefix: string): { root: string; path: string; lockPath: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  const path = projectDefinitionPath(root);
  writeFileSync(
    path,
    pythonJsonPretty({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [] },
    }),
    "utf8",
  );
  return { root, path, lockPath: `${path}.lock` };
}

function ownerEntryName(pid: number): string {
  return `${pid}-${randomBytes(16).toString("hex")}`;
}

/** A well-formed directory lock owned by `pid`, as acquisition would publish it. */
function publishDirectoryLock(lockPath: string, pid: number): string {
  const entry = ownerEntryName(pid);
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, entry), `${JSON.stringify({ pid, token: entry })}\n`, "utf8");
  return entry;
}

/** Instant-timeout deps: every blocked branch resolves on the first budget check. */
function instantBudget(extra: MutationLockDeps = {}): MutationLockDeps {
  return { sleepMs: () => undefined, acquisitionBudgetMs: 0, ...extra };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy file sidecar is never reclaimed automatically (#3796 AC1)", () => {
  it("preserves a legacy file at the public lock pathname and fails closed", () => {
    const { root, lockPath } = seedProject("pd-legacy-live-");
    const body = `${JSON.stringify({ pid: process.pid, token: "legacy" })}\n`;
    writeFileSync(lockPath, body, "utf8");

    let error: unknown;
    try {
      projectDefinitionMutationLock(root, () => "unreachable", instantBudget());
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ProjectDefinitionLockError);
    expect((error as ProjectDefinitionLockError).reason).toBe("legacy-file-sidecar");
    expect(statSync(lockPath).isFile()).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(body);
  });

  it("preserves the legacy file even when its recorded owner is dead", () => {
    const { root, lockPath } = seedProject("pd-legacy-dead-");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 999_999, token: "stale" })}\n`, "utf8");

    expect(() =>
      projectDefinitionMutationLock(
        root,
        () => "unreachable",
        instantBudget({ probeProcess: () => "dead" }),
      ),
    ).toThrow(ProjectDefinitionLockError);

    // A demonstrably stale legacy sidecar is still not evidence that removing
    // the public pathname is safe: the displaced holder's descriptor and
    // critical section can outlive the name.
    expect(statSync(lockPath).isFile()).toBe(true);
  });

  it("does not quarantine or move the legacy sidecar", () => {
    const { root, path, lockPath } = seedProject("pd-legacy-quarantine-");
    writeFileSync(lockPath, "1\n", "utf8");
    const before = readdirSync(join(root, "xbrief")).sort();

    expect(() => projectDefinitionMutationLock(root, () => "unreachable", instantBudget())).toThrow(
      ProjectDefinitionLockError,
    );

    expect(readdirSync(join(root, "xbrief")).sort()).toEqual(before);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("names constant-label manual recovery steps in the diagnostic", () => {
    const { root, lockPath } = seedProject("pd-legacy-diag-");
    writeFileSync(lockPath, "1\n", "utf8");

    let message = "";
    try {
      projectDefinitionMutationLock(root, () => "unreachable", instantBudget());
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("Manual recovery:");
    expect(message).toContain("Stop every legacy deft client");
    expect(message).toContain("Confirm no PROJECT-DEFINITION mutation is running");
    expect(message).toContain("PROJECT-DEFINITION.xbrief.json.lock");
  });
});

describe("current-version directory lock (#3796 AC2)", () => {
  it("publishes a non-empty directory holding one unique owner entry", () => {
    const { root, lockPath } = seedProject("pd-dir-publish-");
    let observed: string[] = [];
    projectDefinitionMutationLock(root, () => {
      observed = readdirSync(lockPath);
      return null;
    });

    expect(statSync(join(lockPath, "..")).isDirectory()).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatch(/^[1-9]\d*-[a-f0-9]{32}$/);
    // Release removes the owner entry and then the directory.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a delayed rmdir cannot remove a published replacement generation", () => {
    const { root, lockPath } = seedProject("pd-dir-barrier-");
    publishDirectoryLock(lockPath, 999_999);
    const replacementPid = 888_888;
    let replacementEntry = "";
    let published = false;

    let error: unknown;
    try {
      projectDefinitionMutationLock(
        root,
        () => "unreachable",
        instantBudget({
          probeProcess: (pid) => (pid === replacementPid ? "alive" : "dead"),
          beforeLockDirRemove: (observedLockPath) => {
            if (published) return;
            published = true;
            // Publish a fresh generation the way a real contender does: the
            // rename can only land while the public pathname is free, so the
            // replacement is non-empty at the instant it becomes visible.
            rmdirSync(observedLockPath);
            const prepared = `${observedLockPath}.replacement`;
            mkdirSync(prepared);
            replacementEntry = ownerEntryName(replacementPid);
            writeFileSync(join(prepared, replacementEntry), "{}", "utf8");
            renameSync(prepared, observedLockPath);
          },
        }),
      );
    } catch (err) {
      error = err;
    }

    expect(published).toBe(true);
    expect(error).toBeInstanceOf(ProjectDefinitionLockError);
    // The reaper's delayed rmdir ran against the replacement and failed: the
    // published generation is intact and still owned by its own entry.
    expect(readdirSync(lockPath)).toEqual([replacementEntry]);
  });

  it("reaps a directory whose owner is unambiguously dead", () => {
    const { root, lockPath } = seedProject("pd-dir-reap-");
    publishDirectoryLock(lockPath, 999_999);

    const result = projectDefinitionMutationLock(root, () => "acquired", {
      sleepMs: () => undefined,
      probeProcess: () => "dead",
    });

    expect(result).toBe("acquired");
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("reap requires an unambiguously dead owner (#3796 AC3)", () => {
  it("fails closed while the recorded owner probes alive", () => {
    const { root, lockPath } = seedProject("pd-pid-alive-");
    const entry = publishDirectoryLock(lockPath, 999_999);

    let error: unknown;
    try {
      projectDefinitionMutationLock(
        root,
        () => "unreachable",
        instantBudget({ probeProcess: () => "alive" }),
      );
    } catch (err) {
      error = err;
    }

    expect((error as ProjectDefinitionLockError).reason).toBe("owner-alive");
    expect(readdirSync(lockPath)).toEqual([entry]);
  });

  it("fails closed when liveness is unknown", () => {
    const { root, lockPath } = seedProject("pd-pid-unknown-");
    const entry = publishDirectoryLock(lockPath, 999_999);

    let error: unknown;
    try {
      projectDefinitionMutationLock(
        root,
        () => "unreachable",
        instantBudget({ probeProcess: () => "unknown" }),
      );
    } catch (err) {
      error = err;
    }

    expect((error as ProjectDefinitionLockError).reason).toBe("owner-liveness-unknown");
    expect(readdirSync(lockPath)).toEqual([entry]);
  });

  it("never recovers a malformed lock directory, however old", () => {
    const { root, lockPath } = seedProject("pd-dir-malformed-");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "debris"), "x", "utf8");
    writeFileSync(join(lockPath, ownerEntryName(999_999)), "{}", "utf8");
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(lockPath, longAgo, longAgo);

    let error: unknown;
    try {
      projectDefinitionMutationLock(
        root,
        () => "unreachable",
        instantBudget({ probeProcess: () => "dead" }),
      );
    } catch (err) {
      error = err;
    }

    expect((error as ProjectDefinitionLockError).reason).toBe("malformed-lock-directory");
    // Age is not evidence of safety, so nothing was removed.
    expect(readdirSync(lockPath)).toHaveLength(2);
  });

  it("uses the default oracle to hold off a lock owned by a live process", () => {
    const { root, lockPath } = seedProject("pd-pid-default-");
    // The current process is unambiguously alive, so the shipped oracle -- not a
    // test double -- must refuse to reap this directory.
    const entry = publishDirectoryLock(lockPath, process.pid);

    let error: unknown;
    try {
      projectDefinitionMutationLock(root, () => "unreachable", instantBudget());
    } catch (err) {
      error = err;
    }

    expect((error as ProjectDefinitionLockError).reason).toBe("owner-alive");
    expect(readdirSync(lockPath)).toEqual([entry]);
  });

  it("treats a lost race for the owner entry as contention, not a reap", () => {
    const { root, lockPath } = seedProject("pd-reap-race-");
    const entry = publishDirectoryLock(lockPath, 999_999);

    let error: unknown;
    try {
      projectDefinitionMutationLock(
        root,
        () => "unreachable",
        instantBudget({
          probeProcess: () => {
            // A competing reaper wins the owner-entry unlink first. Only that
            // winner may remove the directory, so this attempt must stand down.
            rmSync(join(lockPath, entry), { force: true });
            return "dead";
          },
        }),
      );
    } catch (err) {
      error = err;
    }

    expect((error as ProjectDefinitionLockError).reason).toBe("contended");
    expect(existsSync(lockPath)).toBe(true);
  });

  it("never reaps an empty lock directory, on either platform", () => {
    const { root, lockPath } = seedProject("pd-dir-empty-");
    mkdirSync(lockPath);

    let error: unknown;
    let result: string | undefined;
    try {
      result = projectDefinitionMutationLock(
        root,
        () => {
          // Whoever holds the lock holds a non-empty directory with its own
          // owner entry -- the barrier property still holds.
          expect(readdirSync(lockPath)).toHaveLength(1);
          return "acquired";
        },
        instantBudget({ probeProcess: () => "dead" }),
      );
    } catch (err) {
      error = err;
    }

    // The platforms diverge here, and both outcomes are safe. POSIX `rename`
    // may replace an empty directory, so publication wins the pathname outright
    // -- no reap, and any old generation's delayed rmdir then fails against the
    // non-empty replacement. Windows `MoveFileEx` refuses a directory
    // destination, so the state stays unattributable and fails closed to manual
    // recovery. Neither path removes a directory it cannot attribute to a dead
    // owner, which is the invariant that matters.
    if (process.platform === "win32") {
      expect((error as ProjectDefinitionLockError).reason).toBe("malformed-lock-directory");
      expect(existsSync(lockPath)).toBe(true);
    } else {
      expect(error).toBeUndefined();
      expect(result).toBe("acquired");
    }
  });
});

describe("single injected monotonic acquisition budget (#3796 AC6)", () => {
  it("reads the acquisition deadline only from the injected monotonic clock", () => {
    const { root, lockPath } = seedProject("pd-budget-clock-");
    publishDirectoryLock(lockPath, 999_999);
    let ticks = 0;
    let elapsed = 0;

    expect(() =>
      projectDefinitionMutationLock(root, () => "unreachable", {
        sleepMs: () => {
          elapsed += 40;
        },
        acquisitionBudgetMs: 100,
        monotonicNowMs: () => {
          ticks += 1;
          return elapsed;
        },
        probeProcess: () => "alive",
      }),
    ).toThrow(/after 100ms/);

    // One reading to open the budget plus one per retry branch -- no branch
    // reaches for a second clock.
    expect(ticks).toBeGreaterThan(1);
  });

  it("shares one budget across retry and recovery branches", () => {
    const { root, lockPath } = seedProject("pd-budget-shared-");
    publishDirectoryLock(lockPath, 999_999);
    let elapsed = 0;
    let sleeps = 0;

    expect(() =>
      projectDefinitionMutationLock(root, () => "unreachable", {
        sleepMs: () => {
          sleeps += 1;
          elapsed += 25;
        },
        acquisitionBudgetMs: 100,
        monotonicNowMs: () => elapsed,
        probeProcess: () => "alive",
      }),
    ).toThrow(ProjectDefinitionLockError);

    // 100ms budget consumed in 25ms sleeps: the budget is not restarted by the
    // recovery detour on each iteration.
    expect(sleeps).toBe(4);
  });

  it("refuses to publish a lock whose owner record was short-written", () => {
    const { root, lockPath } = seedProject("pd-owner-shortwrite-");

    expect(() =>
      projectDefinitionMutationLock(root, () => "unreachable", {
        sleepMs: () => undefined,
        writeOwner: () => 1,
      }),
    ).toThrow(/short write/);

    // Nothing was published, and the prepared claim was cleaned up.
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(join(root, "xbrief")).some((name) => name.includes(".claim-"))).toBe(false);
  });

  it("runs the critical section outside the acquisition budget", () => {
    const { root } = seedProject("pd-budget-callback-");
    let elapsed = 0;

    const result = projectDefinitionMutationLock(
      root,
      () => {
        // A long critical section must not be retro-actively timed out.
        elapsed += 10_000;
        return "completed";
      },
      { sleepMs: () => undefined, acquisitionBudgetMs: 5, monotonicNowMs: () => elapsed },
    );

    expect(result).toBe("completed");
  });
});

describe("constant artifact label in diagnostics (#3796 AC5)", () => {
  it("collapses a configured artifact to the constant label", () => {
    const previous = process.env.DEFT_PROJECT_PATH;
    process.env.DEFT_PROJECT_PATH = join("config", "custom-project.xbrief.json");
    try {
      expect(projectDefinitionArtifactLabel("/anywhere/custom-project.xbrief.json")).toBe(
        CONFIGURED_PROJECT_DEFINITION_LABEL,
      );
    } finally {
      if (previous === undefined) delete process.env.DEFT_PROJECT_PATH;
      else process.env.DEFT_PROJECT_PATH = previous;
    }
  });

  it("keeps the layout-resolved path for a canonical artifact", () => {
    const previous = process.env.DEFT_PROJECT_PATH;
    delete process.env.DEFT_PROJECT_PATH;
    try {
      expect(projectDefinitionArtifactLabel("/repo/xbrief/PROJECT-DEFINITION.xbrief.json")).toBe(
        "/repo/xbrief/PROJECT-DEFINITION.xbrief.json",
      );
    } finally {
      if (previous !== undefined) process.env.DEFT_PROJECT_PATH = previous;
    }
  });

  it("never interpolates a configured path into a lock timeout diagnostic", () => {
    const root = mkdtempSync(join(tmpdir(), "pd-label-lock-"));
    roots.push(root);
    const previous = process.env.DEFT_PROJECT_PATH;
    process.env.DEFT_PROJECT_PATH = join("secrets", "configured-project.xbrief.json");
    try {
      mkdirSync(join(root, "secrets"), { recursive: true });
      const configured = join(root, "secrets", "configured-project.xbrief.json");
      writeFileSync(configured, "{}", "utf8");
      writeFileSync(`${configured}.lock`, "1\n", "utf8");

      let message = "";
      try {
        projectDefinitionMutationLock(root, () => "unreachable", instantBudget());
      } catch (err) {
        message = (err as Error).message;
      }

      expect(message).toContain(CONFIGURED_PROJECT_DEFINITION_LABEL);
      expect(message).not.toContain("secrets");
      // Not even the configured filename, which the sidecar name is derived from.
      expect(message).not.toContain("configured-project");
    } finally {
      if (previous === undefined) delete process.env.DEFT_PROJECT_PATH;
      else process.env.DEFT_PROJECT_PATH = previous;
    }
  });
});
