import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_CONFIG_ERROR,
  EXIT_OK,
  EXIT_VIOLATION,
  REHEARSAL_VERSION,
  RELEASE_E2E_HELP,
  RELEASE_ENTRYPOINT_TIMEOUT_SECONDS,
  ROLLBACK_ENTRYPOINT_TIMEOUT_SECONDS,
} from "./constants.js";
import {
  callReleaseEntrypoint,
  callReleaseEntrypointTimed,
  defaultReleaseEntrypoint,
  dispatchTaskRelease,
  dispatchTaskReleaseRollback,
} from "./entrypoint.js";
import { generateRepoSlug, parseE2EFlags } from "./flags.js";
import * as ghOps from "./gh-ops.js";
import { destroyTempRepo, provisionTempRepo, verifyDraftRelease } from "./gh-ops.js";
import * as gitOps from "./git-ops.js";
import { cloneRepoToTemp, pushMirror, setOriginToTempRepo, verifyTag } from "./git-ops.js";
import { cmdReleaseE2e, runE2e } from "./main.js";
import * as npmOps from "./npm-ops.js";
import * as rehearsalModule from "./rehearsal.js";
import { runRehearsal } from "./rehearsal.js";
import type { E2EConfig, E2ESeams } from "./types.js";

function config(overrides: Partial<E2EConfig> = {}): E2EConfig {
  return {
    owner: "deftai",
    projectRoot: ".",
    dryRun: false,
    keepRepo: false,
    skipNpm: false,
    repoSlug: "deftai-release-test-20260428190000-abcdef",
    ...overrides,
  };
}

describe("generateRepoSlug", () => {
  it("matches deftai-release-test pattern", () => {
    const slug = generateRepoSlug({
      now: () => new Date("2026-06-19T11:50:29.000Z"),
      randomUuidHex: () => "abcdef1234567890",
    });
    expect(slug).toMatch(/^deftai-release-test-\d{14}-[0-9a-f]{6}$/);
    expect(slug).toBe("deftai-release-test-20260619115029-abcdef");
  });

  it("produces unique slugs", () => {
    const a = generateRepoSlug();
    const b = generateRepoSlug();
    expect(a).not.toBe(b);
  });
});

describe("provision and destroy temp repo", () => {
  it("provision invokes gh repo create private", () => {
    const captured: string[] = [];
    const seams: E2ESeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd, args) => {
        captured.push(...args);
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const [ok, reason] = provisionTempRepo("deftai", "deftai-release-test-X", seams);
    expect(ok).toBe(true);
    expect(reason).toContain("deftai/deftai-release-test-X");
    expect(captured).toContain("create");
    expect(captured).toContain("--private");
  });

  it("provision surfaces gh failure", () => {
    const seams: E2ESeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 1, stdout: "", stderr: "quota exceeded" }),
    };
    const [ok, reason] = provisionTempRepo("deftai", "x", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("quota exceeded");
  });

  it("provision fails when gh missing", () => {
    const [ok, reason] = provisionTempRepo("deftai", "x", { whichGh: () => null });
    expect(ok).toBe(false);
    expect(reason).toContain("gh CLI not found");
  });

  it("destroy invokes gh repo delete --yes", () => {
    const captured: string[] = [];
    const seams: E2ESeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd, args) => {
        captured.push(...args);
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const [ok, reason] = destroyTempRepo("deftai", "x", seams);
    expect(ok).toBe(true);
    expect(reason).toContain("deleted deftai/x");
    expect(captured).toContain("--yes");
    expect(captured).toContain("delete");
  });

  it("destroy surfaces failure", () => {
    const seams: E2ESeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 1, stdout: "", stderr: "permission denied" }),
    };
    const [ok, reason] = destroyTempRepo("deftai", "x", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("permission denied");
  });

  it("verifyDraftRelease gh failure", () => {
    const seams: E2ESeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 1, stdout: "", stderr: "not found" }),
    };
    const [ok, reason] = verifyDraftRelease("deftai", "x", "0.0.1", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("not found");
  });

  it("verifyDraftRelease invalid json", () => {
    const seams: E2ESeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 0, stdout: "not-json", stderr: "" }),
    };
    const [ok, reason] = verifyDraftRelease("deftai", "x", "0.0.1", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("non-JSON");
  });

  it("destroy fails when gh missing", () => {
    const [ok, reason] = destroyTempRepo("deftai", "x", { whichGh: () => null });
    expect(ok).toBe(false);
    expect(reason).toContain("gh CLI not found");
  });
});

describe("rehearsal step helpers", () => {
  it("cloneRepoToTemp happy path pins env", () => {
    const captured: { env?: NodeJS.ProcessEnv } = {};
    const src = join(tmpdir(), "src");
    const target = join(tmpdir(), "clone");
    const seams: E2ESeams = {
      spawnText: (_cmd, args, opts) => {
        expect(args).toContain("clone");
        captured.env = opts?.env;
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(cloneRepoToTemp(src, target, seams)[0]).toBe(true);
    expect(captured.env?.DEFT_PROJECT_ROOT).toBe(target);
  });

  it("cloneRepoToTemp failure", () => {
    const seams: E2ESeams = {
      spawnText: () => ({ status: 128, stdout: "", stderr: "not a git repository" }),
    };
    const [ok, reason] = cloneRepoToTemp("/src", "/clone", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("not a git repository");
  });

  it("setOriginToTempRepo failure", () => {
    const seams: E2ESeams = {
      runGit: () => ({ status: 128, stdout: "", stderr: "no such remote" }),
    };
    const [ok, reason] = setOriginToTempRepo("/clone", "deftai", "x", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("no such remote");
  });

  it("pushMirror failure mentions refspecs", () => {
    const seams: E2ESeams = {
      runGit: () => ({ status: 1, stdout: "", stderr: "permission denied" }),
    };
    const [ok, reason] = pushMirror("/clone", seams);
    expect(ok).toBe(false);
    expect(reason.toLowerCase()).toMatch(/heads|refspec/);
  });

  it("dispatchTaskRelease argv carries skip flags", () => {
    const captured: string[] = [];
    const seams: E2ESeams = {
      releaseEntrypoint: (argv) => {
        captured.push(...argv);
        return 0;
      },
    };
    expect(dispatchTaskRelease("/clone", "0.0.1", "deftai/temp-x", seams)[0]).toBe(true);
    expect(captured).toContain("--skip-ci");
    expect(captured).toContain("--skip-build");
    expect(captured).toContain("--allow-vbrief-drift");
  });

  it("callReleaseEntrypoint pins DEFT_PROJECT_ROOT", () => {
    const prev = process.env.DEFT_PROJECT_ROOT;
    process.env.DEFT_PROJECT_ROOT = "/operator/real/repo";
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-clone-"));
    const captured: { env?: string; cwd?: string } = {};
    try {
      callReleaseEntrypoint(
        () => {
          captured.env = process.env.DEFT_PROJECT_ROOT;
          captured.cwd = process.cwd();
          return 0;
        },
        ["0.0.1"],
        cloneDir,
      );
      expect(captured.env).toBe(cloneDir);
      expect(captured.cwd).toBe(cloneDir);
      expect(process.env.DEFT_PROJECT_ROOT).toBe("/operator/real/repo");
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.DEFT_PROJECT_ROOT;
      else process.env.DEFT_PROJECT_ROOT = prev;
    }
  });

  it("callReleaseEntrypoint converts exception to failure", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-clone-"));
    try {
      const [code, output] = callReleaseEntrypoint(
        () => {
          throw new Error("boom");
        },
        ["0.0.1"],
        cloneDir,
        1,
      );
      expect(code).toBe(EXIT_VIOLATION);
      expect(output).toContain("Error: boom");
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("callReleaseEntrypointTimed forwards worker result", async () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-clone-"));
    const [code, output] = await callReleaseEntrypointTimed(
      "test",
      ["0.0.1"],
      cloneDir,
      0.2,
      "throw",
    );
    expect(code).toBeGreaterThan(0);
    expect(output.length).toBeGreaterThan(0);
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("verifyDraftRelease happy path", () => {
    const seams: E2ESeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({
        status: 0,
        stdout: JSON.stringify({ isDraft: true, tagName: "v0.0.1", name: "v0.0.1", url: "..." }),
        stderr: "",
      }),
    };
    const [ok, reason] = verifyDraftRelease("deftai", "x", "0.0.1", seams);
    expect(ok).toBe(true);
    expect(reason).toContain("verified draft v0.0.1");
  });

  it("verifyDraftRelease refuses non-draft and tag mismatch", () => {
    const nonDraft: E2ESeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({
        status: 0,
        stdout: JSON.stringify({ isDraft: false, tagName: "v0.0.1" }),
        stderr: "",
      }),
    };
    expect(verifyDraftRelease("deftai", "x", "0.0.1", nonDraft)[0]).toBe(false);

    const mismatch: E2ESeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({
        status: 0,
        stdout: JSON.stringify({ isDraft: true, tagName: "v9.9.9" }),
        stderr: "",
      }),
    };
    const [, reason] = verifyDraftRelease("deftai", "x", "0.0.1", mismatch);
    expect(reason).toContain("v9.9.9");
  });

  it("verifyTag present and absent", () => {
    expect(
      verifyTag("/clone", "0.0.1", {
        runGit: () => ({ status: 0, stdout: "abc123\trefs/tags/v0.0.1\n", stderr: "" }),
      })[0],
    ).toBe(true);
    expect(
      verifyTag("/clone", "0.0.1", { runGit: () => ({ status: 0, stdout: "", stderr: "" }) })[1],
    ).toContain("not present");
  });

  it("verifyTag ls-remote failure", () => {
    const [ok, reason] = verifyTag("/clone", "0.0.1", {
      runGit: () => ({ status: 1, stdout: "", stderr: "network" }),
    });
    expect(ok).toBe(false);
    expect(reason).toContain("git ls-remote failed");
  });

  it("dispatchTaskReleaseRollback argv shape", () => {
    const captured: string[] = [];
    const seams: E2ESeams = {
      rollbackEntrypoint: (argv) => {
        captured.push(...argv);
        return 0;
      },
    };
    expect(dispatchTaskReleaseRollback("/clone", "0.0.1", "deftai/x", seams)[0]).toBe(true);
    expect(captured).toEqual(["0.0.1", "--repo", "deftai/x"]);
  });

  it("dispatch failures surface output", () => {
    expect(
      dispatchTaskRelease("/clone", "0.0.1", "deftai/x", { releaseEntrypoint: () => 1 })[1],
    ).toContain("release.py failed");
    expect(
      dispatchTaskReleaseRollback("/clone", "0.0.1", "deftai/x", {
        rollbackEntrypoint: () => 2,
      })[1],
    ).toContain("release_rollback.py failed");
  });
});

describe("runRehearsal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("walks all seven steps and short-circuits on failure", () => {
    const order: string[] = [];
    vi.spyOn(gitOps, "cloneRepoToTemp").mockImplementation(() => {
      order.push("clone");
      return [true, "ok"];
    });
    vi.spyOn(gitOps, "setOriginToTempRepo").mockImplementation(() => {
      order.push("set-origin");
      return [true, "ok"];
    });
    vi.spyOn(gitOps, "pushMirror").mockImplementation(() => {
      order.push("push");
      return [true, "ok"];
    });
    vi.spyOn(rehearsalModule, "runRehearsal");
    vi.spyOn(ghOps, "verifyDraftRelease").mockImplementation(() => {
      order.push("verify draft");
      return [true, "ok"];
    });
    vi.spyOn(gitOps, "verifyTag").mockImplementation(() => {
      order.push("verify tag");
      return [true, "ok"];
    });
    const seams: E2ESeams = {
      mkdtemp: () => mkdtempSync(join(tmpdir(), "deft-e2e-")),
      releaseEntrypoint: () => {
        order.push("release");
        return 0;
      },
      rollbackEntrypoint: () => {
        order.push("rollback");
        return 0;
      },
    };

    const [ok, reason] = runRehearsal("deftai", "x", "/proj", REHEARSAL_VERSION, seams, true);
    expect(ok).toBe(true);
    expect(reason).toContain("pipeline-mirror rehearsal succeeded");
    expect(order).toEqual([
      "clone",
      "set-origin",
      "push",
      "release",
      "verify draft",
      "verify tag",
      "rollback",
    ]);

    order.length = 0;
    vi.spyOn(gitOps, "cloneRepoToTemp").mockImplementation(() => {
      order.push("clone");
      return [false, "clone failed"];
    });
    const [failOk, failReason] = runRehearsal(
      "deftai",
      "x",
      "/proj",
      REHEARSAL_VERSION,
      seams,
      true,
    );
    expect(failOk).toBe(false);
    expect(failReason).toContain("clone");
    expect(order).toEqual(["clone"]);
  });

  it("includes the npm publish dry-run step by default (#1910)", () => {
    const order: string[] = [];
    vi.spyOn(gitOps, "cloneRepoToTemp").mockImplementation(() => {
      order.push("clone");
      return [true, "ok"];
    });
    vi.spyOn(gitOps, "setOriginToTempRepo").mockReturnValue([true, "ok"]);
    vi.spyOn(gitOps, "pushMirror").mockReturnValue([true, "ok"]);
    vi.spyOn(ghOps, "verifyDraftRelease").mockReturnValue([true, "ok"]);
    vi.spyOn(gitOps, "verifyTag").mockImplementation(() => {
      order.push("verify tag");
      return [true, "ok"];
    });
    vi.spyOn(npmOps, "rehearseNpmPublish").mockImplementation(() => {
      order.push("npm");
      return [true, "ok"];
    });
    const seams: E2ESeams = {
      mkdtemp: () => mkdtempSync(join(tmpdir(), "deft-e2e-")),
      releaseEntrypoint: () => 0,
      rollbackEntrypoint: () => {
        order.push("rollback");
        return 0;
      },
    };
    const [ok, reason] = runRehearsal("deftai", "x", "/proj", REHEARSAL_VERSION, seams);
    expect(ok).toBe(true);
    expect(reason).toContain("npm publish dry-run");
    // npm step lands between verify tag and rollback.
    expect(order).toEqual(["clone", "verify tag", "npm", "rollback"]);
  });

  it("task release failure short-circuits before verify", () => {
    vi.spyOn(gitOps, "cloneRepoToTemp").mockReturnValue([true, "ok"]);
    vi.spyOn(gitOps, "setOriginToTempRepo").mockReturnValue([true, "ok"]);
    vi.spyOn(gitOps, "pushMirror").mockReturnValue([true, "ok"]);
    const seams: E2ESeams = {
      mkdtemp: () => mkdtempSync(join(tmpdir(), "deft-e2e-")),
      releaseEntrypoint: () => 1,
    };
    const [ok, reason] = runRehearsal("deftai", "x", "/proj", REHEARSAL_VERSION, seams);
    expect(ok).toBe(false);
    expect(reason).toContain("task release");
  });
});

describe("runE2e orchestration", () => {
  const errLines: string[] = [];
  let origErr: typeof process.stderr.write;

  beforeEach(() => {
    vi.restoreAllMocks();
    errLines.length = 0;
    origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = origErr;
  });

  it("dry-run emits DRYRUN lines", () => {
    expect(runE2e(config({ dryRun: true, repoSlug: "deftai-release-test-fixed-abcdef" }))).toBe(
      EXIT_OK,
    );
    const err = errLines.join("");
    expect(err).toContain("DRYRUN");
    expect(err).toContain("pipeline-mirror");
  });

  it("happy path provision rehearse destroy", () => {
    const order: string[] = [];
    vi.spyOn(ghOps, "provisionTempRepo").mockImplementation(() => {
      order.push("provision");
      return [true, "created"];
    });
    vi.spyOn(rehearsalModule, "runRehearsal").mockImplementation(() => {
      order.push("rehearsal");
      return [true, "ok"];
    });
    vi.spyOn(ghOps, "destroyTempRepo").mockImplementation(() => {
      order.push("destroy");
      return [true, "deleted"];
    });
    expect(runE2e(config())).toBe(EXIT_OK);
    expect(order).toEqual(["provision", "rehearsal", "destroy"]);
  });

  it("provision failure skips rehearsal", () => {
    vi.spyOn(ghOps, "provisionTempRepo").mockReturnValue([false, "quota exceeded"]);
    expect(runE2e(config())).toBe(EXIT_VIOLATION);
    expect(errLines.join("")).toContain("quota exceeded");
  });

  it("rehearsal failure still destroys", () => {
    const order: string[] = [];
    vi.spyOn(ghOps, "provisionTempRepo").mockReturnValue([true, "created"]);
    vi.spyOn(rehearsalModule, "runRehearsal").mockImplementation(() => {
      order.push("rehearsal");
      return [false, "task release failed"];
    });
    vi.spyOn(ghOps, "destroyTempRepo").mockImplementation(() => {
      order.push("destroy");
      return [true, "deleted"];
    });
    expect(runE2e(config())).toBe(EXIT_VIOLATION);
    expect(order).toEqual(["rehearsal", "destroy"]);
  });

  it("rehearsal exception still destroys", () => {
    const order: string[] = [];
    vi.spyOn(ghOps, "provisionTempRepo").mockReturnValue([true, "created"]);
    vi.spyOn(rehearsalModule, "runRehearsal").mockImplementation(() => {
      order.push("rehearsal");
      throw new Error("network blew up mid-clone");
    });
    vi.spyOn(ghOps, "destroyTempRepo").mockImplementation(() => {
      order.push("destroy");
      return [true, "deleted"];
    });
    expect(() => runE2e(config())).toThrow(/network blew up/);
    expect(order).toEqual(["rehearsal", "destroy"]);
  });

  it("destroy failure warns but preserves success exit", () => {
    vi.spyOn(ghOps, "provisionTempRepo").mockReturnValue([true, "created"]);
    vi.spyOn(rehearsalModule, "runRehearsal").mockReturnValue([true, "ok"]);
    vi.spyOn(ghOps, "destroyTempRepo").mockReturnValue([false, "transient API"]);
    expect(runE2e(config())).toBe(EXIT_OK);
    expect(errLines.join("")).toContain("WARN");
  });

  it("keep-repo skips destroy", () => {
    vi.spyOn(ghOps, "provisionTempRepo").mockReturnValue([true, "created"]);
    vi.spyOn(rehearsalModule, "runRehearsal").mockReturnValue([true, "ok"]);
    expect(runE2e(config({ keepRepo: true }))).toBe(EXIT_OK);
    expect(errLines.join("")).toContain("SKIP (--keep-repo set");
  });
});

describe("cmdReleaseE2e", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prints help", () => {
    const out: string[] = [];
    const prev = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c) => {
      out.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    expect(cmdReleaseE2e(["--help"])).toBe(EXIT_OK);
    process.stdout.write = prev;
    expect(out.join("")).toBe(RELEASE_E2E_HELP);
  });

  it("dry-run config via parse and runE2e", () => {
    const flags = parseE2EFlags(["--dry-run", "--owner", "deftai"]);
    const cfg = config({ dryRun: flags.dryRun, owner: flags.owner });
    expect(runE2e(cfg)).toBe(EXIT_OK);
  });

  it("rejects unknown args", () => {
    expect(cmdReleaseE2e(["--nope"])).toBe(EXIT_CONFIG_ERROR);
  });

  it("parseE2EFlags reads flags", () => {
    const flags = parseE2EFlags([
      "--dry-run",
      "--keep-repo",
      "--owner=acme",
      "--project-root=/tmp/x",
    ]);
    expect(flags.dryRun).toBe(true);
    expect(flags.keepRepo).toBe(true);
    expect(flags.owner).toBe("acme");
    expect(flags.projectRoot).toBe("/tmp/x");
  });
});

describe("constants wiring", () => {
  it("exports release entrypoint timeouts", () => {
    expect(typeof defaultReleaseEntrypoint).toBe("function");
    expect(RELEASE_ENTRYPOINT_TIMEOUT_SECONDS).toBe(600);
    expect(ROLLBACK_ENTRYPOINT_TIMEOUT_SECONDS).toBe(300);
  });
});
