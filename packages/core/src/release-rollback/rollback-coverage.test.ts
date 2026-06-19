import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import { ghReleaseDelete, ghReleaseExists, ghReleaseViewJson } from "./gh.js";
import {
  gitDeleteLocalTag,
  gitDeleteRemoteTag,
  gitPushBase,
  gitRevertReleaseCommit,
  gitTagExistsLocal,
  gitTagExistsOrigin,
  resolveReleasePrepSha,
} from "./git.js";
import { computeThreshold, doubleReadDownloads, sumDownloads } from "./guard.js";
import { cmdRollback } from "./main.js";
import {
  detectState,
  runRollback,
  unwindLocal,
  unwindReleased,
  unwindTagPushedNoRelease,
} from "./pipeline.js";
import type { GhReleasePayload, RollbackConfig, RollbackSeams } from "./types.js";

const SHA = "6573335cafef00d000000000000000000000bbbb";

function cfg(overrides: Partial<RollbackConfig> = {}): RollbackConfig {
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

function emitSeams(): RollbackSeams {
  return { emit: () => undefined };
}

describe("release-rollback coverage boost", () => {
  it("covers tag existence helpers", () => {
    const seams: RollbackSeams = {
      spawnText: (_cmd, args) => {
        if (args.includes("ls-remote")) {
          return { status: 0, stdout: "x\trefs/tags/v0.21.0\n", stderr: "" };
        }
        if (args.includes("-l")) {
          return { status: 0, stdout: "v0.21.0\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(gitTagExistsLocal(".", "0.21.0", seams)).toBe(true);
    expect(gitTagExistsOrigin(".", "0.21.0", seams)).toBe(true);
  });

  it("covers tag delete failures", () => {
    const failSeams: RollbackSeams = {
      spawnText: () => ({ status: 1, stdout: "", stderr: "boom" }),
    };
    expect(gitDeleteLocalTag(".", "0.21.0", failSeams)[0]).toBe(false);
    expect(gitDeleteRemoteTag(".", "0.21.0", failSeams)[0]).toBe(false);
  });

  it("covers resolve failure message", () => {
    const seams: RollbackSeams = {
      spawnText: () => ({ status: 1, stdout: "", stderr: "" }),
    };
    const [sha, reason] = resolveReleasePrepSha(".", "0.21.0", seams);
    expect(sha).toBe("");
    expect(reason).toContain("could not resolve");
  });

  it("covers revert abort failure note", () => {
    const seams: RollbackSeams = {
      spawnText: (_cmd, args) => {
        if (args.includes("--abort")) {
          return { status: 1, stdout: "", stderr: "abort failed" };
        }
        return { status: 1, stdout: "", stderr: "conflict" };
      },
    };
    const [, reason] = gitRevertReleaseCommit(".", SHA, seams);
    expect(reason).toContain("git revert --abort");
  });

  it("covers ghReleaseViewJson without gh", () => {
    const [ok, , reason] = ghReleaseViewJson("0.21.0", "deftai/directive", { whichGh: () => null });
    expect(ok).toBe(false);
    expect(reason).toContain("gh CLI not found");
  });

  it("covers ghReleaseDelete success path", () => {
    const seams: RollbackSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const [ok] = ghReleaseDelete("0.21.0", "deftai/directive", seams);
    expect(ok).toBe(true);
  });

  it("covers ghReleaseDelete failure path", () => {
    const seams: RollbackSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 1, stdout: "", stderr: "delete failed" }),
    };
    const [ok] = ghReleaseDelete("0.21.0", "deftai/directive", seams);
    expect(ok).toBe(false);
  });

  it("covers ghReleaseViewJson non-json response", () => {
    const seams: RollbackSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 0, stdout: "not-json", stderr: "" }),
    };
    const [ok, , reason] = ghReleaseViewJson("0.21.0", "deftai/directive", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("non-JSON");
  });

  it("covers unwind tag-pushed happy path and failures", () => {
    const emit = emitSeams();
    const happySeams: RollbackSeams = {
      ...emit,
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        }
        if (args.includes("push") && args.includes("--delete")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("-l")) {
          return { status: 0, stdout: "v0.21.0\n", stderr: "" };
        }
        if (args.includes("tag") && args.includes("-d")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("revert")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("push") && args.includes("origin") && args.includes("master")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindTagPushedNoRelease(cfg(), happySeams)).toBe(EXIT_OK);

    const remoteFail: RollbackSeams = {
      ...emit,
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        }
        if (args.includes("push") && args.includes("--delete")) {
          return { status: 1, stdout: "", stderr: "non-fast-forward" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindTagPushedNoRelease(cfg(), remoteFail)).toBe(EXIT_VIOLATION);

    expect(unwindTagPushedNoRelease(cfg({ dryRun: true }), emit)).toBe(EXIT_OK);
  });

  it("covers unwind released happy path and guard branches", () => {
    const emit = emitSeams();
    const now = new Date();
    const created = new Date(now.getTime() - 2 * 60 * 1000);
    const pl: GhReleasePayload = {
      assets: [{ downloadCount: 0 }],
      createdAt: created.toISOString().replace("+00:00", "Z"),
    };

    const happySeams: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => [true, { assets: [{ downloadCount: 0 }] }, ""],
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        }
        if (args[0] === "release" && args[1] === "delete") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("revert")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("push")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("-l")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindReleased(cfg(), pl, happySeams)).toBe(EXIT_OK);

    const midAge = new Date(now.getTime() - 10 * 60 * 1000);
    const midPayload: GhReleasePayload = {
      assets: [{ downloadCount: 5 }],
      createdAt: midAge.toISOString().replace("+00:00", "Z"),
    };
    const midSeams: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => [true, { assets: [{ downloadCount: 5 }] }, ""],
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        }
        if (args[0] === "release") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      whichGh: () => "/usr/bin/gh",
    };
    expect(unwindReleased(cfg(), midPayload, midSeams)).toBe(EXIT_OK);

    const highDownloads: GhReleasePayload = {
      assets: [{ downloadCount: 15 }],
      createdAt: midAge.toISOString().replace("+00:00", "Z"),
    };
    const highSeams: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => [true, { assets: [{ downloadCount: 15 }] }, ""],
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindReleased(cfg(), highDownloads, highSeams)).toBe(EXIT_VIOLATION);

    const allowLowSeams: RollbackSeams = {
      ...midSeams,
      ghReleaseViewJson: () => [true, { assets: [{ downloadCount: 15 }] }, ""],
    };
    expect(unwindReleased(cfg({ allowLowDownloads: 20 }), highDownloads, allowLowSeams)).toBe(
      EXIT_OK,
    );

    const oldPayload: GhReleasePayload = {
      assets: [{ downloadCount: 100 }],
      createdAt: new Date(now.getTime() - 45 * 60 * 1000).toISOString().replace("+00:00", "Z"),
    };
    const dataLossSeams: RollbackSeams = {
      ...happySeams,
      ghReleaseViewJson: () => [true, { assets: [{ downloadCount: 100 }] }, ""],
    };
    expect(unwindReleased(cfg({ allowDataLoss: true }), oldPayload, dataLossSeams)).toBe(EXIT_OK);

    const strictSeams: RollbackSeams = {
      ...happySeams,
      ghReleaseViewJson: () => [true, { assets: [{ downloadCount: 0 }] }, ""],
    };
    expect(unwindReleased(cfg({ forceStrict0: true }), oldPayload, strictSeams)).toBe(EXIT_OK);
  });

  it("covers race refusal and resolve failure in released unwind", () => {
    const emit = emitSeams();
    const pl: GhReleasePayload = {
      assets: [{ downloadCount: 0 }],
      createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString().replace("+00:00", "Z"),
    };
    let call = 0;
    const raceSeams: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => {
        call += 1;
        if (call === 1) return [true, { assets: [{ downloadCount: 0 }] }, ""];
        return [true, { assets: [{ downloadCount: 1 }] }, ""];
      },
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindReleased(cfg(), pl, raceSeams)).toBe(EXIT_VIOLATION);

    const resolveFail: RollbackSeams = {
      ...emit,
      spawnText: () => ({ status: 1, stdout: "", stderr: "" }),
    };
    expect(unwindReleased(cfg(), pl, resolveFail)).toBe(EXIT_VIOLATION);
  });

  it("covers runRollback state branches", () => {
    const emit = emitSeams();
    const localSeams: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => [false, null, "release not found"],
      spawnText: (_cmd, args) => {
        if (args.includes("ls-remote")) return { status: 0, stdout: "", stderr: "" };
        if (args.includes("-l")) return { status: 0, stdout: "v0.21.0\n", stderr: "" };
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        if (args.includes("revert")) return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(runRollback(cfg(), localSeams)).toBe(EXIT_OK);

    const tagSeams: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => [false, null, "release not found"],
      spawnText: (_cmd, args) => {
        if (args.includes("ls-remote"))
          return { status: 0, stdout: "x\trefs/tags/v0.21.0\n", stderr: "" };
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(runRollback(cfg(), tagSeams)).toBe(EXIT_OK);

    const releasedSeams: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => [
        true,
        {
          assets: [{ downloadCount: 0 }],
          createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString().replace("+00:00", "Z"),
        },
        "",
      ],
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        if (args[0] === "release") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(runRollback(cfg(), releasedSeams)).toBe(EXIT_OK);

    const dryReleased: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => [
        true,
        { assets: [], createdAt: new Date().toISOString().replace("+00:00", "Z") },
        "",
      ],
    };
    expect(runRollback(cfg({ dryRun: true }), dryReleased)).toBe(EXIT_OK);

    const dryError: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => [false, null, "auth required"],
    };
    expect(runRollback(cfg({ dryRun: true }), dryError)).toBe(EXIT_VIOLATION);
  });

  it("covers local unwind tag delete failure and revert failure", () => {
    const emit = emitSeams();
    const tagFail: RollbackSeams = {
      ...emit,
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        if (args.includes("-d")) return { status: 1, stdout: "", stderr: "boom" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindLocal(cfg(), tagFail)).toBe(EXIT_VIOLATION);

    const revertFail: RollbackSeams = {
      ...emit,
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        if (args.includes("-d")) return { status: 0, stdout: "", stderr: "" };
        if (args.includes("revert")) return { status: 1, stdout: "", stderr: "conflict" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindLocal(cfg(), revertFail)).toBe(EXIT_VIOLATION);
  });

  it("covers released unwind delete/push/revert failures and local tag warn", () => {
    const emit = emitSeams();
    const pl: GhReleasePayload = {
      assets: [{ downloadCount: 0 }],
      createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString().replace("+00:00", "Z"),
    };
    const baseSeams: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => [true, { assets: [{ downloadCount: 0 }] }, ""],
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    const deleteFail: RollbackSeams = {
      ...baseSeams,
      spawnText: (_cmd, args) => {
        if (args[0] === "release" && args[1] === "delete") {
          return { status: 1, stdout: "", stderr: "delete failed" };
        }
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindReleased(cfg(), pl, deleteFail)).toBe(EXIT_VIOLATION);

    const localTagWarn: RollbackSeams = {
      ...baseSeams,
      spawnText: (_cmd, args) => {
        if (args[0] === "release" && args[1] === "delete") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("-l")) return { status: 0, stdout: "v0.21.0\n", stderr: "" };
        if (args.includes("-d")) return { status: 1, stdout: "", stderr: "warn" };
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        if (args.includes("revert")) return { status: 0, stdout: "", stderr: "" };
        if (args.includes("push")) return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindReleased(cfg(), pl, localTagWarn)).toBe(EXIT_OK);

    const revertFail: RollbackSeams = {
      ...baseSeams,
      spawnText: (_cmd, args) => {
        if (args[0] === "release") return { status: 0, stdout: "", stderr: "" };
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        if (args.includes("revert")) return { status: 1, stdout: "", stderr: "conflict" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindReleased(cfg(), pl, revertFail)).toBe(EXIT_VIOLATION);

    const pushFail: RollbackSeams = {
      ...baseSeams,
      spawnText: (_cmd, args) => {
        if (args[0] === "release") return { status: 0, stdout: "", stderr: "" };
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        if (args.includes("revert")) return { status: 0, stdout: "", stderr: "" };
        if (args.includes("push")) return { status: 1, stdout: "", stderr: "rejected" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindReleased(cfg(), pl, pushFail)).toBe(EXIT_VIOLATION);
  });

  it("covers cmdRollback unknown args and missing version", () => {
    expect(cmdRollback(["--unknown-flag"])).toBe(2);
    expect(cmdRollback([])).toBe(2);
  });

  it("covers sumDownloads empty assets and compute threshold boundaries", () => {
    expect(sumDownloads({ assets: [] })).toBe(0);
    expect(
      computeThreshold(5 * 60 - 1, {
        allowLowDownloads: 0,
        allowDataLoss: false,
        forceStrict0: false,
      })[0],
    ).toBe(0);
    expect(
      computeThreshold(30 * 60 - 1, {
        allowLowDownloads: 0,
        allowDataLoss: false,
        forceStrict0: false,
      })[0],
    ).toBe(10);
  });

  it("covers doubleReadDownloads with sleep seam", () => {
    let slept = 0;
    const seams: RollbackSeams = {
      sleep: (s) => {
        slept = s;
      },
      ghReleaseViewJson: () => [true, { assets: [{ downloadCount: 0 }] }, ""],
    };
    doubleReadDownloads("0.21.0", "deftai/directive", { sleepSeconds: 2 }, seams);
    expect(slept).toBe(2);
  });

  it("covers detectState via ghReleaseExists error path in gh.ts", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [false, null, "server error"],
    };
    const [state] = ghReleaseExists("0.21.0", "deftai/directive", seams);
    expect(state).toBe("error");
  });

  it("covers gitPushBase success", () => {
    const seams: RollbackSeams = {
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const [ok, reason] = gitPushBase(".", "master", seams);
    expect(ok).toBe(true);
    expect(reason).toContain("no force");
  });

  it("covers ghReleaseViewJson spawn failure catch", () => {
    const seams: RollbackSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => {
        throw new Error("ENOENT");
      },
    };
    const [ok, , reason] = ghReleaseViewJson("0.21.0", "deftai/directive", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("gh CLI not found");
  });

  it("covers ghReleaseDelete spawn throw catch", () => {
    const seams: RollbackSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => {
        throw new Error("ENOENT");
      },
    };
    const [ok, reason] = ghReleaseDelete("0.21.0", "deftai/directive", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("gh CLI not found");
  });

  it("covers ghReleaseViewJson non-zero status", () => {
    const seams: RollbackSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 1, stdout: "", stderr: "auth required" }),
    };
    const [ok, , reason] = ghReleaseViewJson("0.21.0", "deftai/directive", seams);
    expect(ok).toBe(false);
    expect(reason).toBe("auth required");
  });

  it("covers doubleReadDownloads default busy-wait sleep", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [true, { assets: [{ downloadCount: 0 }] }, ""],
    };
    const [ok] = doubleReadDownloads("0.21.0", "deftai/directive", { sleepSeconds: 0.001 }, seams);
    expect(ok).toBe(true);
  });

  it("covers cmdRollback dry-run full path", () => {
    const seams: RollbackSeams = {
      ghReleaseViewJson: () => [false, null, "release not found"],
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    expect(
      cmdRollback(
        ["0.21.0", "--dry-run", "--repo", "deftai/directive", "--project-root", "/tmp"],
        seams,
      ),
    ).toBe(EXIT_OK);
  });

  it("covers pipeline unknown state branch", () => {
    const emit = emitSeams();
    const origDetect = detectState;
    // Force unknown state by patching at module level via custom seam isn't possible;
    // use runRollback with mocked detect via dry-run error fallback - instead test
    // released-null payload path.
    const releasedNullSeams: RollbackSeams = {
      ...emit,
      ghReleaseViewJson: () => [true, null, ""],
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    // ghReleaseExists returns exists with null payload when ok but null - actually
    // ghReleaseViewJson returns [true, payload, ""] - if payload is null, detect returns released with null
    expect(runRollback(cfg(), releasedNullSeams)).toBe(EXIT_VIOLATION);
    void origDetect;
  });

  it("covers tag-pushed revert conflict after resolve", () => {
    const emit = emitSeams();
    const conflictSeams: RollbackSeams = {
      ...emit,
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) return { status: 0, stdout: `${SHA}\n`, stderr: "" };
        if (args.includes("push") && args.includes("--delete"))
          return { status: 0, stdout: "", stderr: "" };
        if (args.includes("-l")) return { status: 0, stdout: "", stderr: "" };
        if (args.includes("revert")) return { status: 1, stdout: "", stderr: "conflict" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindTagPushedNoRelease(cfg(), conflictSeams)).toBe(EXIT_VIOLATION);
  });

  it("covers tag-pushed resolve failure", () => {
    const emit = emitSeams();
    const conflictSeams: RollbackSeams = {
      ...emit,
      spawnText: (_cmd, args) => {
        if (args.includes("rev-parse")) return { status: 1, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(unwindTagPushedNoRelease(cfg(), conflictSeams)).toBe(EXIT_VIOLATION);
  });
});
