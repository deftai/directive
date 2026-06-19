import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BOT_THRESHOLD, EXIT_CONFIG_ERROR, EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import { ghReleaseDelete, ghReleaseExists } from "./gh.js";
import { gitPushBase, gitRevertReleaseCommit, resolveReleasePrepSha } from "./git.js";
import { computeThreshold, doubleReadDownloads, releaseAgeSeconds, sumDownloads } from "./guard.js";
import { cmdRollback } from "./main.js";
import { detectState, runRollback, unwindLocal, unwindReleased } from "./pipeline.js";
import type { GhReleasePayload, RollbackConfig, RollbackSeams } from "./types.js";

const RELEASE_PREP_SHA = "6573335cafef00d000000000000000000000bbbb";
const INTERVENING_SHA = "94d1aa5deadbeef0000000000000000000aaaaa1";

function config(overrides: Partial<RollbackConfig> = {}): RollbackConfig {
  return {
    version: "0.21.0",
    repo: "deftai/directive",
    baseBranch: "master",
    projectRoot: ".",
    dryRun: false,
    allowLowDownloads: 0,
    allowDataLoss: false,
    forceStrict0: false,
    skipSleep: true,
    ...overrides,
  };
}

function captureEmit(): { lines: string[]; seams: RollbackSeams } {
  const lines: string[] = [];
  return {
    lines,
    seams: {
      emit: (label, status) => {
        lines.push(`[rollback] ${label}... ${status}`);
      },
    },
  };
}

describe("computeThreshold", () => {
  it("returns 0 under five minutes", () => {
    const [threshold, reason] = computeThreshold(60, {
      allowLowDownloads: 0,
      allowDataLoss: false,
      forceStrict0: false,
    });
    expect(threshold).toBe(0);
    expect(reason).toContain("< 5 min");
  });

  it("returns default bot threshold between 5-30 min", () => {
    const [threshold] = computeThreshold(10 * 60, {
      allowLowDownloads: 0,
      allowDataLoss: false,
      forceStrict0: false,
    });
    expect(threshold).toBe(DEFAULT_BOT_THRESHOLD);
  });

  it("uses max of allow-low-downloads and default", () => {
    const [high] = computeThreshold(10 * 60, {
      allowLowDownloads: 20,
      allowDataLoss: false,
      forceStrict0: false,
    });
    expect(high).toBe(20);
    const [low] = computeThreshold(10 * 60, {
      allowLowDownloads: 5,
      allowDataLoss: false,
      forceStrict0: false,
    });
    expect(low).toBe(DEFAULT_BOT_THRESHOLD);
  });

  it("refuses over thirty minutes without data-loss", () => {
    const [threshold, reason] = computeThreshold(45 * 60, {
      allowLowDownloads: 999,
      allowDataLoss: false,
      forceStrict0: false,
    });
    expect(threshold).toBeNull();
    expect(reason).toContain("30 min");
  });

  it("accepts any count with allow-data-loss", () => {
    const [threshold, reason] = computeThreshold(45 * 60, {
      allowLowDownloads: 0,
      allowDataLoss: true,
      forceStrict0: false,
    });
    expect(threshold).toBeGreaterThan(1_000_000);
    expect(reason).toContain("allow-data-loss");
  });

  it("force-strict-0 short-circuits", () => {
    const [threshold, reason] = computeThreshold(45 * 60, {
      allowLowDownloads: 0,
      allowDataLoss: false,
      forceStrict0: true,
    });
    expect(threshold).toBe(0);
    expect(reason).toContain("force-strict-0");
  });

  it("force-strict-0 overrides data-loss", () => {
    const [threshold] = computeThreshold(10 * 60, {
      allowLowDownloads: 999,
      allowDataLoss: true,
      forceStrict0: true,
    });
    expect(threshold).toBe(0);
  });
});

describe("releaseAgeSeconds", () => {
  it("parses ISO with trailing Z", () => {
    const now = new Date("2026-04-28T19:00:00.000Z");
    expect(releaseAgeSeconds({ createdAt: "2026-04-28T18:50:00Z" }, now)).toBe(600);
  });

  it("parses ISO with explicit offset", () => {
    const now = new Date("2026-04-28T19:00:00.000Z");
    expect(releaseAgeSeconds({ createdAt: "2026-04-28T18:30:00+00:00" }, now)).toBe(1800);
  });

  it("falls back to publishedAt", () => {
    const now = new Date("2026-04-28T19:00:00.000Z");
    expect(releaseAgeSeconds({ publishedAt: "2026-04-28T18:55:00Z" }, now)).toBe(300);
  });

  it("returns zero when missing or malformed", () => {
    expect(releaseAgeSeconds({})).toBe(0);
    expect(releaseAgeSeconds({ createdAt: "not-a-date" })).toBe(0);
  });
});

describe("sumDownloads", () => {
  it("aggregates across assets", () => {
    expect(
      sumDownloads({
        assets: [{ downloadCount: 3 }, { downloadCount: 7 }, { downloadCount: 0 }],
      }),
    ).toBe(10);
  });

  it("ignores non-int values", () => {
    expect(
      sumDownloads({
        assets: [
          { downloadCount: 3 },
          { downloadCount: null },
          { downloadCount: "abc" },
          { downloadCount: 5 },
        ],
      }),
    ).toBe(8);
  });
});

describe("doubleReadDownloads", () => {
  it("agrees when counts match", () => {
    const sequence = [
      [true, { assets: [{ downloadCount: 3 }] }, ""] as const,
      [true, { assets: [{ downloadCount: 3 }] }, ""] as const,
    ];
    let idx = 0;
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => {
        const next = sequence[idx];
        idx += 1;
        return next ?? [false, null, "exhausted"];
      },
    };
    const [ok, c1, c2, reason] = doubleReadDownloads(
      "0.21.0",
      "deftai/directive",
      { sleepSeconds: 0 },
      seams,
    );
    expect(ok).toBe(true);
    expect(c1).toBe(3);
    expect(c2).toBe(3);
    expect(reason).toBe("");
  });

  it("detects race when count grows", () => {
    const sequence = [
      [true, { assets: [{ downloadCount: 3 }] }, ""] as const,
      [true, { assets: [{ downloadCount: 5 }] }, ""] as const,
    ];
    let idx = 0;
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => {
        const next = sequence[idx];
        idx += 1;
        return next ?? [false, null, "exhausted"];
      },
    };
    const [ok, c1, c2, reason] = doubleReadDownloads(
      "0.21.0",
      "deftai/directive",
      { sleepSeconds: 0 },
      seams,
    );
    expect(ok).toBe(false);
    expect(c1).toBe(3);
    expect(c2).toBe(5);
    expect(reason).toContain("grew between reads");
  });

  it("fails on first read error", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [false, null, "auth required"],
    };
    const [ok, , , reason] = doubleReadDownloads(
      "0.21.0",
      "deftai/directive",
      { sleepSeconds: 0 },
      seams,
    );
    expect(ok).toBe(false);
    expect(reason).toContain("first read failed");
  });

  it("fails on second read error", () => {
    const sequence = [
      [true, { assets: [{ downloadCount: 3 }] }, ""] as const,
      [false, null, "503"] as const,
    ];
    let idx = 0;
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => {
        const next = sequence[idx];
        idx += 1;
        return next ?? [false, null, "exhausted"];
      },
    };
    const [ok, , , reason] = doubleReadDownloads(
      "0.21.0",
      "deftai/directive",
      { sleepSeconds: 0 },
      seams,
    );
    expect(ok).toBe(false);
    expect(reason).toContain("second read failed");
  });
});

describe("detectState", () => {
  it("returns released when gh release exists", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [true, { isDraft: false, assets: [] }, ""],
    };
    const [state, payload] = detectState(config(), seams);
    expect(state).toBe("released");
    expect(payload).not.toBeNull();
  });

  it("returns tag-pushed-no-release", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [false, null, "release not found"],
      spawnText: (_cmd, args) => {
        if (args.includes("ls-remote")) {
          return { status: 0, stdout: "abc\trefs/tags/v0.21.0\n", stderr: "" };
        }
        if (args.includes("tag") && args.includes("-l")) {
          return { status: 0, stdout: "v0.21.0\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const [state] = detectState(config(), seams);
    expect(state).toBe("tag-pushed-no-release");
  });

  it("returns local-only", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [false, null, "release not found"],
      spawnText: (_cmd, args) => {
        if (args.includes("ls-remote")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("tag") && args.includes("-l")) {
          return { status: 0, stdout: "v0.21.0\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const [state] = detectState(config(), seams);
    expect(state).toBe("local-only");
  });

  it("returns absent", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [false, null, "release not found"],
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const [state] = detectState(config(), seams);
    expect(state).toBe("absent");
  });

  it("returns error on gh probe failure", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [false, null, "auth required"],
    };
    const [state, , reason] = detectState(config(), seams);
    expect(state).toBe("error");
    expect(reason).toContain("auth required");
  });
});

describe("runRollback branches", () => {
  it("dry-run absent is no-op", () => {
    const { seams } = captureEmit();
    const seamsWithDetect: RollbackSeams = {
      ...seams,
      ghReleaseViewJson: () => [false, null, "release not found"],
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const rc = runRollback(config({ dryRun: true }), seamsWithDetect);
    expect(rc).toBe(EXIT_OK);
  });

  it("absent state is noop", () => {
    const { lines, seams } = captureEmit();
    const seamsWithDetect: RollbackSeams = {
      ...seams,
      ghReleaseViewJson: () => [false, null, "release not found"],
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const rc = runRollback(config(), seamsWithDetect);
    expect(rc).toBe(EXIT_OK);
    expect(lines.some((l) => l.includes("NOOP"))).toBe(true);
  });

  it("error state exits violation", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [false, null, "gh probe failed"],
    };
    expect(runRollback(config(), seams)).toBe(EXIT_VIOLATION);
  });
});

describe("unwindLocal", () => {
  it("happy path reverts resolved sha", () => {
    const { seams } = captureEmit();
    const captured: { sha?: string } = {};
    const fullSeams: RollbackSeams = {
      ...seams,
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: `${RELEASE_PREP_SHA}\n`, stderr: "" };
        }
        if (args.includes("tag") && args.includes("-d")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("revert") && !args.includes("--abort")) {
          captured.sha = args[args.indexOf("revert") + 1];
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindLocal(config(), fullSeams)).toBe(EXIT_OK);
    expect(captured.sha).toBe(RELEASE_PREP_SHA);
    expect(captured.sha).not.toBe(INTERVENING_SHA);
  });

  it("refuses when resolve fails", () => {
    const { seams } = captureEmit();
    const fullSeams: RollbackSeams = {
      ...seams,
      spawnText: () => ({ status: 1, stdout: "", stderr: "fail" }),
    };
    expect(unwindLocal(config(), fullSeams)).toBe(EXIT_VIOLATION);
  });

  it("dry-run does not invoke side effects", () => {
    const boom = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const { seams } = captureEmit();
    expect(unwindLocal(config({ dryRun: true }), { ...seams, spawnText: boom })).toBe(EXIT_OK);
    expect(boom).not.toHaveBeenCalled();
  });
});

describe("unwindReleased guard paths", () => {
  function payload(ageMinutes: number, downloads: number): GhReleasePayload {
    const now = new Date();
    const created = new Date(now.getTime() - ageMinutes * 60 * 1000);
    return {
      assets: [{ downloadCount: downloads }],
      createdAt: created.toISOString().replace("+00:00", "Z"),
    };
  }

  it("refuses over 30 min without data-loss", () => {
    const { seams } = captureEmit();
    expect(unwindReleased(config(), payload(45, 0), seams)).toBe(EXIT_VIOLATION);
  });

  it("refuses when downloads exceed threshold under 5 min", () => {
    const { seams } = captureEmit();
    const fullSeams: RollbackSeams = {
      ...seams,
      ghReleaseViewJson: () => [true, { assets: [{ downloadCount: 1 }] }, ""],
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: `${RELEASE_PREP_SHA}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindReleased(config(), payload(2, 1), fullSeams)).toBe(EXIT_VIOLATION);
  });

  it("dry-run does not invoke side effects", () => {
    const boom = vi.fn();
    const { seams } = captureEmit();
    expect(
      unwindReleased(config({ dryRun: true }), payload(2, 0), {
        ...seams,
        ghReleaseViewJson: boom,
      }),
    ).toBe(EXIT_OK);
    expect(boom).not.toHaveBeenCalled();
  });
});

describe("cmdRollback", () => {
  it("invalid version exits 2", () => {
    const stderr: string[] = [];
    const _orig = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    expect(cmdRollback(["not-a-version"])).toBe(EXIT_CONFIG_ERROR);
    expect(stderr.join("")).toContain("Invalid version");
    vi.restoreAllMocks();
  });

  it("negative allow-low-downloads exits 2", () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    expect(cmdRollback(["0.21.0", "--allow-low-downloads", "-1"])).toBe(EXIT_CONFIG_ERROR);
    expect(stderr.join("")).toContain("must be >= 0");
    vi.restoreAllMocks();
  });

  it("help exits 0", () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    expect(cmdRollback(["--help"])).toBe(0);
    expect(stdout.join("")).toContain("usage: release_rollback");
    vi.restoreAllMocks();
  });

  it("parse error for allow-low-downloads missing value exits 2", () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    expect(cmdRollback(["0.21.0", "--allow-low-downloads", "--dry-run"])).toBe(EXIT_CONFIG_ERROR);
    const out = stderr.join("");
    expect(out).toContain("expected one argument");
    expect(out).toContain("usage: release_rollback");
    expect(out).not.toContain("State-aware release unwind");
    vi.restoreAllMocks();
  });
});

describe("git helpers", () => {
  it("resolveReleasePrepSha uses rev-parse first", () => {
    const seams: RollbackSeams = {
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: `${RELEASE_PREP_SHA}\n`, stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      },
    };
    const [sha] = resolveReleasePrepSha(".", "0.21.0", seams);
    expect(sha).toBe(RELEASE_PREP_SHA);
  });

  it("resolveReleasePrepSha falls back to grep", () => {
    const seams: RollbackSeams = {
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 1, stdout: "", stderr: "" };
        }
        if (args.includes("log")) {
          return { status: 0, stdout: `${RELEASE_PREP_SHA}\n`, stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      },
    };
    const [sha] = resolveReleasePrepSha(".", "0.21.0", seams);
    expect(sha).toBe(RELEASE_PREP_SHA);
  });

  it("gitRevertReleaseCommit handles conflict with abort", () => {
    const seams: RollbackSeams = {
      spawnText: (_cmd, args) => {
        if (args.includes("--abort")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("revert")) {
          return { status: 1, stdout: "", stderr: "CONFLICT" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const [ok, reason] = gitRevertReleaseCommit(".", RELEASE_PREP_SHA, seams);
    expect(ok).toBe(false);
    expect(reason).toContain("Manual recovery");
  });

  it("gitPushBase reports failure", () => {
    const seams: RollbackSeams = {
      spawnText: () => ({ status: 1, stdout: "", stderr: "rejected" }),
    };
    const [ok] = gitPushBase(".", "master", seams);
    expect(ok).toBe(false);
  });
});

describe("gh helpers", () => {
  it("ghReleaseExists classifies not-found", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [false, null, "release not found"],
    };
    const [state] = ghReleaseExists("0.21.0", "deftai/directive", seams);
    expect(state).toBe("not-found");
  });

  it("ghReleaseDelete requires gh", () => {
    const seams: RollbackSeams = { whichGh: () => null };
    const [ok, reason] = ghReleaseDelete("0.21.0", "deftai/directive", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("gh CLI not found");
  });
});
