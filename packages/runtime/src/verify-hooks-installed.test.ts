import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-hooks-installed.js";

const ok = { code: 0 as const, message: "ok", stream: "stdout" as const };

describe("verify-hooks-installed --live", () => {
  it("keeps the default scope git-only", () => {
    expect(parseArgs([])).toMatchObject({ scope: "git", live: false });
  });

  it("rejects --live without an agent scope", () => {
    const writes: string[] = [];
    const code = run(["--live"], {
      writeErr: (text) => writes.push(text),
    });

    expect(code).toBe(2);
    expect(writes.join("")).toContain("--live requires --scope=agent or --scope=all");
  });

  it("uses functional readiness for --scope=agent --live", () => {
    const evaluateGit = vi.fn(() => ok);
    const evaluateAgent = vi.fn(() => ({ ...ok, registrations: [] }));
    const evaluateReadiness = vi.fn(() => ({
      ...ok,
      skipped: false,
      liveStatus: "functional" as const,
      hosts: [],
      registrations: [],
      liveProbe: null,
    }));

    const code = run(["--scope=agent", "--live", "--quiet"], {
      evaluateGit,
      evaluateAgent,
      evaluateReadiness,
    });

    expect(code).toBe(0);
    expect(evaluateReadiness).toHaveBeenCalledTimes(1);
    expect(evaluateAgent).not.toHaveBeenCalled();
    expect(evaluateGit).not.toHaveBeenCalled();
  });

  it("combines git and live agent exit codes for --scope=all", () => {
    const code = run(["--scope=all", "--live", "--quiet"], {
      evaluateGit: () => ok,
      evaluateReadiness: () => ({
        code: 1,
        message: "non-functional",
        stream: "stderr",
        skipped: false,
        liveStatus: "non-functional",
        hosts: [],
        registrations: [],
        liveProbe: null,
      }),
    });

    expect(code).toBe(1);
  });

  it.each([
    [["--project-root"], "--project-root: expected one argument"],
    [["--scope"], "--scope: expected one argument"],
    [["--scope", "bogus"], "--scope: invalid choice"],
    [["--scope=bogus"], "--scope: invalid choice"],
    [["--bogus"], "unrecognized arguments"],
  ])("rejects malformed arguments %j", (argv, expected) => {
    expect(parseArgs(argv)).toMatchObject({ error: expect.stringContaining(expected) });
  });

  it("parses separated and inline project roots plus a separated scope", () => {
    expect(parseArgs(["--project-root", "/one", "--scope", "agent"])).toMatchObject({
      projectRoot: "/one",
      scope: "agent",
    });
    expect(parseArgs(["--project-root=/two", "--scope=all"])).toMatchObject({
      projectRoot: "/two",
      scope: "all",
    });
  });

  it("uses structural agent verification without --live and writes its stderr message", () => {
    const errors: string[] = [];
    const evaluateReadiness = vi.fn();
    const code = run(["--scope=agent"], {
      evaluateAgent: () => ({
        code: 1,
        message: "registration drifted",
        stream: "stderr",
        registrations: [],
      }),
      evaluateReadiness,
      writeErr: (text) => errors.push(text),
    });

    expect(code).toBe(1);
    expect(errors).toEqual(["registration drifted\n"]);
    expect(evaluateReadiness).not.toHaveBeenCalled();
  });

  it("writes successful git verification to stdout", () => {
    const output: string[] = [];
    const code = run([], {
      evaluateGit: () => ok,
      writeOut: (text) => output.push(text),
    });

    expect(code).toBe(0);
    expect(output).toEqual(["ok\n"]);
  });

  it("uses process output streams when writer seams are omitted", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = run(["--scope=all"], {
      evaluateGit: () => ok,
      evaluateAgent: () => ({
        code: 1,
        message: "agent drifted",
        stream: "stderr",
        registrations: [],
      }),
    });

    expect(code).toBe(1);
    expect(stdout).toHaveBeenCalledWith("ok\n");
    expect(stderr).toHaveBeenCalledWith("agent drifted\n");
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("fails closed when an injected readiness evaluator throws", () => {
    const errors: string[] = [];
    const code = run(["--scope=agent", "--live"], {
      evaluateReadiness: () => {
        throw "readiness exploded";
      },
      writeErr: (text) => errors.push(text),
    });

    expect(code).toBe(2);
    expect(errors.join("")).toContain("readiness exploded");
  });
});

describe("verify-hooks-installed --repair (#4711)", () => {
  it("rejects --repair without an agent scope", () => {
    const writes: string[] = [];
    const code = run(["--repair"], { writeErr: (text) => writes.push(text) });
    expect(code).toBe(2);
    expect(writes.join("")).toContain("--repair requires --scope=agent or --scope=all");
  });

  it("parses --repair with --scope=agent", () => {
    expect(parseArgs(["--scope=agent", "--repair"])).toMatchObject({
      scope: "agent",
      repair: true,
    });
  });

  it("rewrites via writeAgentHookDeposit seam, prints changedPaths, and live-rechecks", () => {
    const output: string[] = [];
    const repairRegistrations = vi.fn(
      (_root: string, options?: { reevaluate?: (projectRoot: string) => { code: 0 | 1 | 2 } }) => {
        const after = options?.reevaluate?.("/project") ?? { code: 0 as const };
        return {
          written: { changed: true, changedPaths: [".claude/settings.json", ".cursor/hooks.json"] },
          after,
        };
      },
    );
    const evaluateReadiness = vi.fn(() => ({
      code: 0 as const,
      message: "live green",
      stream: "stdout" as const,
      skipped: false,
      liveStatus: "functional" as const,
      hosts: [],
      registrations: [],
      liveProbe: null,
    }));
    const code = run(["--scope=agent", "--repair"], {
      repairRegistrations,
      evaluateReadiness,
      writeOut: (text) => output.push(text),
    });
    expect(code).toBe(0);
    expect(repairRegistrations).toHaveBeenCalledTimes(1);
    expect(evaluateReadiness).toHaveBeenCalledTimes(1);
    expect(output.join("")).toContain("changedPaths: .claude/settings.json, .cursor/hooks.json");
    expect(output.join("")).toContain("may now be dirty");
    expect(output.join("")).toContain("stays denied");
    expect(output.join("")).toContain("Relaunch or reload host matchers");
    expect(output.join("")).toContain("live green");
  });

  it("refuses malformed hook config without claiming live green", () => {
    const errors: string[] = [];
    const evaluateReadiness = vi.fn();
    const code = run(["--scope=agent", "--repair"], {
      repairRegistrations: () => {
        throw new Error(
          ".claude/settings.json is not valid JSON; refusing to overwrite user configuration",
        );
      },
      evaluateReadiness,
      writeErr: (text) => errors.push(text),
    });
    expect(code).toBe(2);
    expect(errors.join("")).toContain("not valid JSON");
    expect(evaluateReadiness).not.toHaveBeenCalled();
  });

  it("returns the live recheck exit code after a successful write", () => {
    const code = run(["--scope=agent", "--repair", "--quiet"], {
      repairRegistrations: (_root, options) => ({
        written: { changed: true, changedPaths: [".grok/hooks/deft.json"] },
        after: options?.reevaluate?.("/project") ?? { code: 0 as const },
      }),
      evaluateReadiness: () => ({
        code: 1 as const,
        message: "still drifted",
        stream: "stderr" as const,
        skipped: false,
        liveStatus: "non-functional" as const,
        hosts: [],
        registrations: [],
        liveProbe: null,
      }),
    });
    expect(code).toBe(1);
  });
});
