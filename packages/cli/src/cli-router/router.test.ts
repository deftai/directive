import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch, resetHandlerCacheForTests } from "../dispatch.js";
import {
  PR_VERB_MAP,
  routeAndDispatch,
  routeArgv,
  SCOPE_LIFECYCLE_VERBS,
  TOP_LEVEL_UX_VERBS,
  taskKeyToDispatchArgv,
} from "./index.js";

afterEach(() => {
  resetHandlerCacheForTests();
  vi.restoreAllMocks();
});

describe("routeArgv", () => {
  it("promotes version to --version", () => {
    expect(routeArgv(["version"]).argv).toEqual(["--version"]);
  });

  it("passes check and doctor through as top-level handlers", () => {
    expect(routeArgv(["check", "--project-root", "."]).argv).toEqual([
      "check",
      "--project-root",
      ".",
    ]);
    expect(routeArgv(["doctor", "--help"]).argv).toEqual(["doctor", "--help"]);
  });

  it("maps verify branch to verify:branch", () => {
    expect(routeArgv(["verify", "branch", "--help"]).argv).toEqual(["verify:branch", "--help"]);
  });

  it("maps scope promote to scope-lifecycle promote", () => {
    expect(routeArgv(["scope", "promote", "path.xbrief.json"]).argv).toEqual([
      "scope-lifecycle",
      "promote",
      "path.xbrief.json",
    ]);
  });

  it("maps scope:promote colon alias to scope-lifecycle promote (#2654)", () => {
    expect(routeArgv(["scope:promote", "path.xbrief.json"]).argv).toEqual([
      "scope-lifecycle",
      "promote",
      "path.xbrief.json",
    ]);
    expect(routeArgv(["scope:promote"]).argv).toEqual(["scope-lifecycle", "promote"]);
    expect(routeArgv(["scope:activate", "xbrief/pending/story.xbrief.json"]).argv).toEqual([
      "scope-lifecycle",
      "activate",
      "xbrief/pending/story.xbrief.json",
    ]);
    expect(routeArgv(["scope:complete", "xbrief/active/story.xbrief.json"]).argv).toEqual([
      "scope-lifecycle",
      "complete",
      "xbrief/active/story.xbrief.json",
    ]);
  });

  it("maps scope-promote dash alias to scope-lifecycle promote (#2654)", () => {
    expect(routeArgv(["scope-promote", "path.xbrief.json"]).argv).toEqual([
      "scope-lifecycle",
      "promote",
      "path.xbrief.json",
    ]);
    expect(routeArgv(["scope-activate"]).argv).toEqual(["scope-lifecycle", "activate"]);
    expect(routeArgv(["scope-demote"]).argv).toEqual(["scope-demote"]);
  });

  it("maps triage queue to triage:queue", () => {
    expect(routeArgv(["triage", "queue", "--limit", "5"]).argv).toEqual([
      "triage:queue",
      "--limit",
      "5",
    ]);
  });

  it("maps triage accept to triage-actions accept", () => {
    expect(routeArgv(["triage", "accept", "--issue", "1"]).argv).toEqual([
      "triage-actions",
      "accept",
      "--issue",
      "1",
    ]);
  });

  it("maps vbrief validate to vbrief:validate", () => {
    expect(routeArgv(["vbrief", "validate"]).argv).toEqual(["vbrief:validate"]);
  });

  it("maps xbrief preflight to xbrief:preflight", () => {
    expect(routeArgv(["xbrief", "preflight", "xbrief/active/story.xbrief.json"]).argv).toEqual([
      "xbrief:preflight",
      "xbrief/active/story.xbrief.json",
    ]);
  });

  it("maps xbrief create/verify to xbrief:create / xbrief:verify (#3057)", () => {
    expect(routeArgv(["xbrief", "create", "--format", "json", "--out", "a"]).argv).toEqual([
      "xbrief:create",
      "--format",
      "json",
      "--out",
      "a",
    ]);
    expect(routeArgv(["xbrief:verify", "--format", "both", "--out", "b"]).argv).toEqual([
      "xbrief:verify",
      "--format",
      "both",
      "--out",
      "b",
    ]);
  });

  it("maps pr merge-ready to pr-merge-readiness", () => {
    expect(routeArgv(["pr", "merge-ready", "--repo", "deftai/directive"]).argv).toEqual([
      "pr-merge-readiness",
      "--repo",
      "deftai/directive",
    ]);
  });

  it("maps pr watch to pr-watch", () => {
    expect(routeArgv(["pr", "watch", "1056", "--one-shot"]).argv).toEqual([
      "pr-watch",
      "1056",
      "--one-shot",
    ]);
  });

  it("maps verify routing to swarm-routing-verify", () => {
    expect(routeArgv(["verify", "routing"]).argv).toEqual(["swarm-routing-verify"]);
  });

  it("maps scm issue list to scm issue list", () => {
    expect(routeArgv(["scm", "issue", "list"]).argv).toEqual(["scm", "issue", "list"]);
  });

  it("maps scm:issue:work-claim colon and space forms (#4200)", () => {
    expect(routeArgv(["scm", "issue", "work-claim", "show", "--issue", "4200"]).argv).toEqual([
      "scm",
      "issue",
      "work-claim",
      "show",
      "--issue",
      "4200",
    ]);
    expect(routeArgv(["scm:issue:work-claim", "claim", "--issue", "4200"]).argv).toEqual([
      "scm",
      "issue",
      "work-claim",
      "claim",
      "--issue",
      "4200",
    ]);
  });

  it("maps scm:issue:design-critique-chip colon and space forms (#3642)", () => {
    expect(
      routeArgv([
        "scm",
        "issue",
        "design-critique-chip",
        "--issue",
        "3642",
        "--chip",
        "triage-ready",
      ]).argv,
    ).toEqual([
      "scm",
      "issue",
      "design-critique-chip",
      "--issue",
      "3642",
      "--chip",
      "triage-ready",
    ]);
    expect(
      routeArgv(["scm:issue:design-critique-chip", "--issue", "3642", "--chip", "triage-ready"])
        .argv,
    ).toEqual([
      "scm",
      "issue",
      "design-critique-chip",
      "--issue",
      "3642",
      "--chip",
      "triage-ready",
    ]);
  });

  it("preserves legacy flat verbs", () => {
    expect(routeArgv(["verify:encoding", "--help"]).argv).toEqual(["verify:encoding", "--help"]);
    expect(routeArgv(["verify-encoding"]).argv).toEqual(["verify-encoding"]);
  });

  it("passes meta flags through unchanged", () => {
    expect(routeArgv(["--help"]).argv).toEqual(["--help"]);
    expect(routeArgv(["-h"]).argv).toEqual(["-h"]);
  });

  it("routes init and update to dispatch handlers", () => {
    expect(routeArgv(["init"]).kind).toBe("dispatch");
    expect(routeArgv(["init"]).argv).toEqual(["init"]);
    expect(routeArgv(["update"]).kind).toBe("dispatch");
    expect(routeArgv(["update"]).argv).toEqual(["update"]);
  });

  it("registers every curated top-level UX verb", () => {
    for (const verb of TOP_LEVEL_UX_VERBS) {
      const routed = routeArgv([verb]);
      expect(["dispatch", "stub"]).toContain(routed.kind);
    }
  });

  it("covers every scope lifecycle verb", () => {
    for (const verb of SCOPE_LIFECYCLE_VERBS) {
      expect(routeArgv(["scope", verb]).argv[0]).toBe("scope-lifecycle");
      expect(routeArgv(["scope", verb]).argv[1]).toBe(verb);
    }
  });

  it("covers every pr alias in PR_VERB_MAP", () => {
    for (const [taskVerb, handler] of Object.entries(PR_VERB_MAP)) {
      expect(routeArgv(["pr", taskVerb]).argv).toEqual([handler]);
    }
  });
});

describe("taskKeyToDispatchArgv", () => {
  it("mirrors representative task keys from verify/scope/xbrief/triage", () => {
    expect(taskKeyToDispatchArgv("verify:branch")).toEqual(["verify:branch"]);
    expect(taskKeyToDispatchArgv("scope:promote", ["x.xbrief.json"])).toEqual([
      "scope-lifecycle",
      "promote",
      "x.xbrief.json",
    ]);
    expect(taskKeyToDispatchArgv("vbrief:preflight")).toEqual(["vbrief:preflight"]);
    expect(taskKeyToDispatchArgv("xbrief:preflight")).toEqual(["xbrief:preflight"]);
    expect(taskKeyToDispatchArgv("triage:welcome")).toEqual(["triage:welcome"]);
    expect(taskKeyToDispatchArgv("triage:reset", ["--issue", "1"])).toEqual([
      "triage-actions",
      "reset",
      "--issue",
      "1",
    ]);
    expect(taskKeyToDispatchArgv("triage:needs-ac")).toEqual(["triage-actions", "needs-ac"]);
  });
});

describe("routeAndDispatch", () => {
  it("deft alias parity: same routing path as directive", async () => {
    const out: string[] = [];
    const code = await routeAndDispatch(["version"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("@deftai/directive");
  });

  it("routes init through the TS-native adoption dispatcher (no Go spawn)", async () => {
    // #2265: `init` is now a classify-then-dispatch adoption dispatcher. Pin it
    // at an empty greenfield dir (deterministic `scaffold` decision) and assert
    // it routed to the TS-native dispatcher — it prints the `[directive init]`
    // state summary rather than spawning the Go installer. Exit code depends on
    // the environment's content-package resolution, so only routing is asserted.
    const dir = mkdtempSync(join(tmpdir(), "router-init-"));
    const err: string[] = [];
    try {
      const code = await routeAndDispatch(["init", "--repo-root", dir], {
        writeOut: () => {},
        writeErr: (text) => {
          err.push(text);
        },
      });
      // --json routes the human summary to stderr; the greenfield state label
      // proves the dispatcher classified the temp dir and chose the scaffold
      // path (the TS-native deposit), not a Go spawn. The exit code depends on
      // the environment's content-package resolution, so only routing + the
      // classified decision are asserted.
      expect(err.join("")).toContain("State: empty directory (greenfield)");
      expect(typeof code).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes scope:promote colon alias to scope-lifecycle handler (#2654)", async () => {
    const handler = vi.fn(() => 0);
    vi.doMock("../scope-lifecycle.js", () => ({ run: handler }));
    resetHandlerCacheForTests();

    const helpOut: string[] = [];
    const helpCode = await routeAndDispatch(["scope:promote", "--help"], {
      writeOut: (text) => {
        helpOut.push(text);
      },
      writeErr: () => {},
    });
    expect(helpCode).toBe(0);
    expect(helpOut.join("")).toContain("task scope:promote");
    expect(handler).not.toHaveBeenCalled();

    resetHandlerCacheForTests();
    await routeAndDispatch(["scope:promote", "xbrief/proposed/foo.xbrief.json"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual(["promote", "xbrief/proposed/foo.xbrief.json"]);
  });

  it("routes verify branch to the same handler as verify:branch", async () => {
    const handler = vi.fn(() => 0);
    vi.doMock("../verify-branch.js", () => ({ run: handler }));
    resetHandlerCacheForTests();

    await routeAndDispatch(["verify", "branch", "--help"], {
      writeOut: () => {},
      writeErr: () => {},
    });

    const colonHandler = vi.fn(() => 0);
    vi.doMock("../verify-branch.js", () => ({ run: colonHandler }));
    resetHandlerCacheForTests();

    await dispatch(["verify:branch", "--help"], {
      writeOut: () => {},
      writeErr: () => {},
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(colonHandler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]).toEqual(colonHandler.mock.calls[0]);
  });
});
