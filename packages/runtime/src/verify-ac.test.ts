import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listAcceptanceDispositionGrants,
  mintAcceptanceDispositionTemplateGrant,
  recordAcceptanceDispositionUse,
} from "@deftai/directive-core/policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { destContentionItTimeout } from "../../core/src/vitest-runner/dest-contention-it-timeout.helper.test.js";
import {
  clampVerifyAcExit,
  parseArgs,
  resolveControllerVerifyAc,
  run,
  VERIFY_AC_NO_OBLIGATION_EXIT,
} from "./verify-ac.js";

describe("clampVerifyAcExit (#3449)", () => {
  it("maps a printed pass to exit 0 even when the raw code is 201", () => {
    expect(clampVerifyAcExit(true, 201)).toBe(0);
    expect(clampVerifyAcExit(true, 0)).toBe(0);
  });

  it("keeps fail/config inside 0/1/2 and preserves no-obligation exit 6 (#5855)", () => {
    expect(clampVerifyAcExit(false, 1)).toBe(1);
    expect(clampVerifyAcExit(false, 201)).toBe(1);
    expect(clampVerifyAcExit(false, 2)).toBe(2);
    expect(clampVerifyAcExit(false, VERIFY_AC_NO_OBLIGATION_EXIT)).toBe(
      VERIFY_AC_NO_OBLIGATION_EXIT,
    );
  });
});

describe("verify:ac parseArgs (#3284)", () => {
  it("parses soft-missing, quiet, capture-only, project-root", () => {
    const a = parseArgs([
      "--project-root",
      "/tmp/p",
      "--quiet",
      "--capture-only",
      "--soft-missing-xbrief",
      "xbrief/active/s.xbrief.json",
    ]);
    expect(a.error).toBeUndefined();
    expect(a.projectRoot).toBe("/tmp/p");
    expect(a.quiet).toBe(true);
    expect(a.captureOnly).toBe(true);
    expect(a.softMissingXbrief).toBe(true);
    expect(a.xbriefPath).toBe("xbrief/active/s.xbrief.json");
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized/);
  });
});

describe("verify:ac run (#3284)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("soft-missing exits 0 when no active xbrief", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-soft-"));
    const code = run(["--project-root", root, "--soft-missing-xbrief"]);
    expect(code).toBe(0);
  });

  it("soft-missing with no target emits an acceptance outcome (#3355)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-soft-tlm-"));
    const summary = join(root, "summary.jsonl");
    const prev = process.env.DEFT_RUN_SUMMARY_PATH;
    process.env.DEFT_RUN_SUMMARY_PATH = summary;
    try {
      expect(run(["--project-root", root, "--soft-missing-xbrief", "--quiet"])).toBe(0);
      const lines = readFileSync(summary, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { event: string; payload: { outcome?: string } });
      const acceptance = lines.filter((line) => line.event === "acceptance");
      expect(acceptance).toHaveLength(1);
      expect(acceptance[0]?.payload.outcome).toBe("soft-missing");
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_RUN_SUMMARY_PATH;
      } else {
        process.env.DEFT_RUN_SUMMARY_PATH = prev;
      }
    }
  });

  it("soft-missing targets a same-session completed brief instead of skipping (#3357)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-completed-"));
    const completed = join(root, "xbrief", "completed");
    mkdirSync(completed, { recursive: true });
    writeFileSync(
      join(completed, "done.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "done",
          status: "completed",
          acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
          metadata: {
            completedAt: "2026-08-14T12:00:00Z",
            completedSessionId: "cli-sess-3357",
          },
          items: [],
        },
      }),
      "utf8",
    );
    const prev = process.env.DEFT_SESSION_ID;
    process.env.DEFT_SESSION_ID = "cli-sess-3357";
    try {
      const chunks: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((c) => {
        chunks.push(String(c));
        return true;
      });
      const err: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((c) => {
        err.push(String(c));
        return true;
      });
      // Consumer temp root: empty stamped acceptance is soft_empty, not a skip.
      expect(run(["--project-root", root, "--soft-missing-xbrief"])).toBe(1);
      expect(chunks.join("")).toMatch(/just-completed|#3357/);
      expect(err.join("")).toMatch(/soft_empty|#3334|#3357/);
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_SESSION_ID;
      } else {
        process.env.DEFT_SESSION_ID = prev;
      }
    }
  });

  it("fail-closes soft-missing multi-active without pin (#4285)", () => {
    // #5855: a dispatched worker (spawn marker) with no pin still refuses.
    vi.stubEnv("DEFT_ACTIVE_SCOPE", "");
    vi.stubEnv("DEFT_AGENT_ID", "worker-under-test");
    const root = mkdtempSync(join(tmpdir(), "verify-ac-multi-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const body = JSON.stringify({
      plan: {
        status: "running",
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
        items: [],
        metadata: {
          intended_placement: {
            schema: "deft.scope.intended_placement.v1",
            files: ["src/a.ts"],
            module_boundary: "a",
          },
        },
      },
    });
    writeFileSync(join(active, "a.xbrief.json"), body, "utf8");
    writeFileSync(join(active, "b.xbrief.json"), body, "utf8");
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(run(["--project-root", root, "--soft-missing-xbrief", "--quiet"])).toBe(1);
    expect(err.join("")).toMatch(/DEFT_ACTIVE_SCOPE|#4285/);
    // Standalone without soft-missing still requires an explicit path.
    expect(run(["--project-root", root])).toBe(1);
  });

  it("untied maintainer multi-active soft-skips with distinct no-obligation exit (#5855)", () => {
    vi.stubEnv("DEFT_ACTIVE_SCOPE", "");
    vi.stubEnv("DEFT_AGENT_ID", "");
    vi.stubEnv("DEFT_WORKER_CREDENTIAL_DELIVERY_ID", "");
    const root = mkdtempSync(join(tmpdir(), "verify-ac-untied-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const body = JSON.stringify({
      plan: {
        status: "running",
        acceptance: { commands: ["exit 1"], none_stated: false, source_rung: "stated" },
        items: [],
      },
    });
    writeFileSync(join(active, "a.xbrief.json"), body, "utf8");
    writeFileSync(join(active, "b.xbrief.json"), body, "utf8");
    // Init a git repo so commonDir is non-null; no worker-auth assignment → untied.
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(run(["--project-root", root, "--soft-missing-xbrief"])).toBe(
      VERIFY_AC_NO_OBLIGATION_EXIT,
    );
    expect(out.join("")).toContain("#3284 soft-missing");
    expect(out.join("")).toContain("no story AC executed");
    expect(out.join("")).not.toContain("verify:ac PASS");
  });

  it("capture-only + soft-missing multi-active lists every artifact (#4285)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-capture-multi-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const body = JSON.stringify({
      plan: {
        status: "running",
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
        items: [],
        metadata: {
          intended_placement: {
            schema: "deft.scope.intended_placement.v1",
            files: ["src/a.ts"],
            module_boundary: "a",
          },
        },
      },
    });
    writeFileSync(join(active, "a.xbrief.json"), body, "utf8");
    writeFileSync(join(active, "b.xbrief.json"), body, "utf8");
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    expect(run(["--project-root", root, "--soft-missing-xbrief", "--capture-only"])).toBe(0);
    const out = chunks.join("");
    expect(out).toMatch(/capture-only multi-active: listing 2 scopes/);
    expect(out).toMatch(/a\.xbrief\.json/);
    expect(out).toMatch(/b\.xbrief\.json/);
  });

  it("soft-missing multi-active runs only the pinned story (#4285)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-pin-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const marker = join(root, "FOREIGN_RAN");
    const placement = {
      schema: "deft.scope.intended_placement.v1",
      files: ["src/a.ts"],
      module_boundary: "a",
    };
    const foreignCmd = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'1')"`;
    writeFileSync(
      join(active, "foreign.xbrief.json"),
      JSON.stringify({
        plan: {
          status: "running",
          acceptance: {
            commands: [{ command: foreignCmd }],
            none_stated: false,
            source_rung: "stated",
          },
          items: [],
          metadata: { intended_placement: placement },
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(active, "dispatched.xbrief.json"),
      JSON.stringify({
        plan: {
          status: "running",
          acceptance: {
            commands: [],
            none_stated: true,
            source_rung: "project_floor",
          },
          items: [],
          metadata: { intended_placement: placement },
        },
      }),
      "utf8",
    );
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    process.env.DEFT_ACTIVE_SCOPE = "xbrief/active/dispatched.xbrief.json";
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    try {
      // Pinned empty project_floor fails soft_empty (exit 1); foreign marker never written.
      expect(run(["--project-root", root, "--soft-missing-xbrief"])).toBe(1);
      expect(chunks.join("")).toMatch(/dispatched\.xbrief\.json/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
    }
  });

  it("scans both xbrief and vbrief active roots for multi-active pin ask (#4285)", () => {
    vi.stubEnv("DEFT_ACTIVE_SCOPE", "");
    vi.stubEnv("DEFT_AGENT_ID", "worker-under-test");
    const root = mkdtempSync(join(tmpdir(), "verify-ac-dual-root-"));
    const xa = join(root, "xbrief", "active");
    const va = join(root, "vbrief", "active");
    mkdirSync(xa, { recursive: true });
    mkdirSync(va, { recursive: true });
    const body = JSON.stringify({
      plan: {
        status: "running",
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
        items: [],
        metadata: {
          intended_placement: {
            schema: "deft.scope.intended_placement.v1",
            files: ["src/a.ts"],
            module_boundary: "a",
          },
        },
      },
    });
    writeFileSync(join(xa, "x.xbrief.json"), body, "utf8");
    writeFileSync(join(va, "v.vbrief.json"), body, "utf8");
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    // Dual-root many-active asks for pin rather than evaluating both.
    expect(run(["--project-root", root, "--soft-missing-xbrief", "--quiet"])).toBe(1);
    expect(err.join("")).toMatch(/DEFT_ACTIVE_SCOPE|#4285/);
  });

  it("exits 2 when no xbrief and soft-missing off", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-hard-"));
    expect(run(["--project-root", root])).toBe(2);
  });

  it("runs executable derived acceptance via evaluate path", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-run-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "only.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          acceptance: {
            commands: [],
            none_stated: true,
            source_rung: "project_floor",
          },
          items: [],
        },
      }),
      "utf8",
    );
    expect(run(["--project-root", root, "--quiet"])).toBe(1);
  });

  it("parseArgs supports equals forms and missing values", () => {
    expect(parseArgs(["--xbrief=a.xbrief.json"]).xbriefPath).toBe("a.xbrief.json");
    expect(parseArgs(["--vbrief=b.vbrief.json"]).xbriefPath).toBe("b.vbrief.json");
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--xbrief"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--project-root=."]).projectRoot).toBe(".");
  });

  it("capture-only fails on malformed xBRIEF shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-bad-"));
    const path = join(root, "bad.json");
    writeFileSync(path, "[1]", "utf8");
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(run(["--project-root", root, "--capture-only", path])).toBe(2);
    writeFileSync(path, JSON.stringify({ plan: null }), "utf8");
    expect(run(["--project-root", root, "--capture-only", path])).toBe(2);
  });

  it("capture-only lists the shared record list with cwd warnings and refused records (#6886)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-cap-6886-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const path = join(active, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          acceptance: {
            commands: [{ command: "npx vitest run src/app.test.ts", cwd: "/abs/web" }],
            none_stated: false,
            source_rung: "stated",
          },
          metadata: {
            literal_acceptance_commands: [
              { command: "task check", source: "explicit" },
              { command: "task web:deploy", source: "explicit" },
            ],
          },
          items: [],
        },
      }),
      "utf8",
    );
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(run(["--project-root", root, "--capture-only", path])).toBe(0);
    const report = JSON.parse(out.join("")) as {
      count: number;
      rejected: { command: string }[];
      cwd_warnings: { command: string; cwd: string }[];
    };
    expect(report.count).toBe(2);
    expect(report.rejected.map((r) => r.command)).toEqual(["task web:deploy"]);
    expect(report.cwd_warnings).toEqual([
      expect.objectContaining({ command: "npx vitest run src/app.test.ts", cwd: "/abs/web" }),
    ]);
    expect(err.join("")).toContain("deft gate acceptance-cwd-grammar ");
  });

  it("capture-only includes source_rung from plan.acceptance", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-cap-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const path = join(active, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          acceptance: {
            commands: [{ command: "task check" }],
            none_stated: false,
            source_rung: "stated",
          },
          metadata: {
            literal_acceptance_commands: [{ command: "task check", source: "explicit" }],
          },
          items: [],
        },
      }),
      "utf8",
    );
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    const code = run(["--project-root", root, "--capture-only", path]);
    expect(code).toBe(0);
    const joined = chunks.join("");
    expect(joined).toMatch(/source_rung/);
    expect(joined).toMatch(/stated/);
    expect(joined).toMatch(/task check/);
  });

  it("capture-only reports executor commands from plan.acceptance when the ledger is empty (#3449)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-cap-empty-ledger-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const path = join(active, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          acceptance: {
            commands: [{ command: "pnpm --version" }],
            none_stated: false,
            source_rung: "stated",
          },
          metadata: {},
          items: [],
        },
      }),
      "utf8",
    );
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    expect(run(["--project-root", root, "--capture-only", path])).toBe(0);
    const parsed = JSON.parse(chunks.join("")) as {
      count: number;
      commands: { command: string }[];
      acceptance_commands: { command: string }[];
    };
    expect(parsed.acceptance_commands).toHaveLength(1);
    expect(parsed.count).toBe(1);
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0]?.command).toBe("pnpm --version");
  });

  it(
    "runs stated plan.acceptance.commands and exits 0 on pass (#3449)",
    destContentionItTimeout(),
    () => {
      const root = mkdtempSync(join(tmpdir(), "verify-ac-stated-run-"));
      const active = join(root, "xbrief", "active");
      mkdirSync(active, { recursive: true });
      writeFileSync(
        join(active, "story.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "t",
            acceptance: {
              commands: [{ command: "pnpm --version" }],
              none_stated: false,
              source_rung: "stated",
            },
            metadata: {},
            items: [],
          },
        }),
        "utf8",
      );
      const prevSummary = process.env.DEFT_RUN_SUMMARY_PATH;
      delete process.env.DEFT_RUN_SUMMARY_PATH;
      try {
        expect(run(["--project-root", root, "--quiet"])).toBe(0);
      } finally {
        if (prevSummary === undefined) {
          delete process.env.DEFT_RUN_SUMMARY_PATH;
        } else {
          process.env.DEFT_RUN_SUMMARY_PATH = prevSummary;
        }
      }
    },
  );

  it("targets the brief this change set moves to completed/ as lands-with-product (#6277)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-lwp-"));
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t.test",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t.test",
        },
      });
    const brief = (folder: string, name: string, plan: Record<string, unknown>) => {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
      writeFileSync(join(root, "xbrief", folder, name), JSON.stringify({ plan }), "utf8");
    };
    const acceptance = { commands: [], none_stated: true, source_rung: "project_floor" };
    git(["init", "-q", "-b", "main"]);
    brief("active", "other.xbrief.json", { status: "running", acceptance, items: [] });
    brief("active", "story.xbrief.json", { status: "running", acceptance, items: [] });
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(["rm", "-q", "xbrief/active/story.xbrief.json"]);
    brief("completed", "story.xbrief.json", {
      status: "completed",
      acceptance,
      items: [],
      metadata: {
        lifecycleWrite: {
          action: "complete",
          writtenAt: "2026-11-16T00:00:00Z",
          completionDisposition: "lands-with-product",
        },
      },
    });
    vi.stubEnv("DEFT_BASE_REF", "origin/main");
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    run(["--project-root", root, "--soft-missing-xbrief"]);
    expect(chunks.join("")).toContain(
      "verify:ac targeting lands-with-product brief(s) of this change set (#6277): xbrief/completed/story.xbrief.json",
    );
    // A pin to the moved brief follows it; a pin to another story keeps priority.
    chunks.length = 0;
    vi.stubEnv("DEFT_ACTIVE_SCOPE", "xbrief/active/story.xbrief.json");
    run(["--project-root", root, "--soft-missing-xbrief"]);
    expect(chunks.join("")).toContain("targeting lands-with-product brief(s)");
    chunks.length = 0;
    vi.stubEnv("DEFT_ACTIVE_SCOPE", "xbrief/active/other.xbrief.json");
    run(["--project-root", root, "--soft-missing-xbrief"]);
    expect(chunks.join("")).not.toContain("targeting lands-with-product brief(s)");
  });
});

describe("resolveControllerVerifyAc: the verify:ac run pre-pr:run --complete owns (#6888)", () => {
  const NOW = new Date("2026-11-20T10:00:00Z");
  const PLAN_ID = "github.issue.6888";
  const CLAUSE_2 = 'The file contains "ABSENT_NEEDLE_TOKEN" after the change.';

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function gitRepo(prefix: string, branch = "main"): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git(["init", "-q", "-b", branch]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(root, "README.md"), "x\n", "utf8");
    git(["add", "README.md"]);
    git(["commit", "-q", "-m", "init"]);
    return root;
  }

  /** Clause 1 verifies (token present in src/a.ts); clause 2 fails (token absent). */
  function storyPlan(id: string, clause2 = CLAUSE_2): Record<string, unknown> {
    return {
      id,
      title: "controller verify:ac fixture",
      status: "running",
      acceptance: {
        commands: [],
        none_stated: true,
        source_rung: "derived",
        ambiguity_attestation: "none_found",
        clauses: [
          {
            id: 1,
            text: 'The file contains "PRESENT_TOKEN" after the change.',
            artifact_path: "src/a.ts",
            ambiguous: false,
          },
          { id: 2, text: clause2, artifact_path: "src/a.ts", ambiguous: false },
        ],
      },
      metadata: { swarm: { file_scope: ["src/a.ts"] } },
      items: [],
    };
  }

  function writeBrief(root: string, name: string, plan: Record<string, unknown>): string {
    const dir = join(root, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`);
    return path;
  }

  function storyRepo(): { root: string; brief: string } {
    const root = gitRepo("verify-ac-6888-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const PRESENT_TOKEN = 1;\n", "utf8");
    return { root, brief: writeBrief(root, "story.xbrief.json", storyPlan(PLAN_ID)) };
  }

  function mintClause2(root: string): string {
    const minted = mintAcceptanceDispositionTemplateGrant({
      projectRoot: root,
      planRef: PLAN_ID,
      storyIds: ["clause.2"],
      disposition: "not_applicable",
      reason: "operator dropped clause 2",
      now: NOW,
    });
    if (!minted.ok) throw new Error(minted.reason);
    return minted.grant.id;
  }

  function grantUsedAt(root: string, grantId: string): string | null {
    const listed = listAcceptanceDispositionGrants(root);
    if (!listed.ok) throw new Error(listed.reason);
    const row = listed.grants.find((g) => g.id === grantId);
    if (row === undefined) throw new Error(`grant ${grantId} not listed`);
    return row.semantics.usedAt;
  }

  it("no selected brief is no-target and says so", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-6888-none-"));
    const result = resolveControllerVerifyAc({ projectRoot: root, now: NOW });
    expect(result.kind).toBe("no-target");
    expect(result.output).toContain("no active xBRIEF");
  });

  it("an untied multi-active branch is untied-no-obligation", () => {
    vi.stubEnv("DEFT_ACTIVE_SCOPE", "");
    vi.stubEnv("DEFT_AGENT_ID", "");
    vi.stubEnv("DEFT_WORKER_CREDENTIAL_DELIVERY_ID", "");
    const root = gitRepo("verify-ac-6888-untied-");
    writeBrief(root, "a.xbrief.json", storyPlan("github.issue.1"));
    writeBrief(root, "b.xbrief.json", storyPlan("github.issue.2"));
    const result = resolveControllerVerifyAc({ projectRoot: root, now: NOW });
    expect(result.kind).toBe("untied-no-obligation");
  });

  it("a failing clause with no grant fails and carries the verify:ac output", () => {
    const { root } = storyRepo();
    const result = resolveControllerVerifyAc({ projectRoot: root, now: NOW });
    expect(result.kind).toBe("fail");
    expect(result.output).toContain("clause 2");
  });

  it("multi-active selection binds the branch to its brief", () => {
    vi.stubEnv("DEFT_ACTIVE_SCOPE", "");
    const root = gitRepo("verify-ac-6888-branch-", `story/${PLAN_ID}`);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const PRESENT_TOKEN = 1;\n", "utf8");
    writeBrief(root, "story.xbrief.json", storyPlan(PLAN_ID));
    writeBrief(root, "other.xbrief.json", storyPlan("github.issue.1"));
    const result = resolveControllerVerifyAc({ projectRoot: root, now: NOW });
    expect(result.output).toContain("selected");
    expect(result.output).toContain("story.xbrief.json");
    expect(result.output).not.toContain("other.xbrief.json");
  });

  it("a grant-covered clause with no clause-keyed item passes and writes nothing", () => {
    const { root, brief } = storyRepo();
    const grantId = mintClause2(root);
    const before = readFileSync(brief, "utf8");
    const result = resolveControllerVerifyAc({ projectRoot: root, now: NOW });
    expect(result.kind).toBe("evaluated-pass");
    expect(readFileSync(brief, "utf8")).toBe(before);
    expect(grantUsedAt(root, grantId)).toBeNull();
  });

  it("a used grant (in-PR completion recorded its use) still covers the clause", () => {
    const { root } = storyRepo();
    const grantId = mintClause2(root);
    const used = recordAcceptanceDispositionUse({
      projectRoot: root,
      grantIds: [grantId],
      now: NOW,
    });
    expect(used.ok).toBe(true);
    const later = new Date(NOW.getTime() + 48 * 60 * 60 * 1000);
    const result = resolveControllerVerifyAc({ projectRoot: root, now: later });
    expect(result.kind).toBe("evaluated-pass");
  });

  it("a grant the resolver refuses (changed clause text) fails with the resolver's message", () => {
    const { root, brief } = storyRepo();
    mintClause2(root);
    writeFileSync(
      brief,
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: storyPlan(PLAN_ID, 'The file contains "OTHER_ABSENT_TOKEN" after the change.') }, null, 2)}\n`,
    );
    const result = resolveControllerVerifyAc({ projectRoot: root, now: NOW });
    expect(result.kind).toBe("fail");
    expect(result.output).toContain("changed after grant");
    expect(result.output).toContain("re-mint");
  });
});
