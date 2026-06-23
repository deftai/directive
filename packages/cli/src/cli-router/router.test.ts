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
    expect(routeArgv(["scope", "promote", "path.vbrief.json"]).argv).toEqual([
      "scope-lifecycle",
      "promote",
      "path.vbrief.json",
    ]);
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

  it("maps pr merge-ready to pr-merge-readiness", () => {
    expect(routeArgv(["pr", "merge-ready", "--repo", "deftai/directive"]).argv).toEqual([
      "pr-merge-readiness",
      "--repo",
      "deftai/directive",
    ]);
  });

  it("maps verify routing to swarm-routing-verify", () => {
    expect(routeArgv(["verify", "routing"]).argv).toEqual(["swarm-routing-verify"]);
  });

  it("maps scm issue list to scm issue list", () => {
    expect(routeArgv(["scm", "issue", "list"]).argv).toEqual(["scm", "issue", "list"]);
  });

  it("preserves legacy flat verbs", () => {
    expect(routeArgv(["verify:encoding", "--help"]).argv).toEqual(["verify:encoding", "--help"]);
    expect(routeArgv(["verify-encoding"]).argv).toEqual(["verify-encoding"]);
  });

  it("passes meta flags through unchanged", () => {
    expect(routeArgv(["--help"]).argv).toEqual(["--help"]);
    expect(routeArgv(["-h"]).argv).toEqual(["-h"]);
  });

  it("stubs init and update until S4", () => {
    expect(routeArgv(["init"]).kind).toBe("stub");
    expect(routeArgv(["update"]).kind).toBe("stub");
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
  it("mirrors representative task keys from verify/scope/vbrief/triage", () => {
    expect(taskKeyToDispatchArgv("verify:branch")).toEqual(["verify:branch"]);
    expect(taskKeyToDispatchArgv("scope:promote", ["x.vbrief.json"])).toEqual([
      "scope-lifecycle",
      "promote",
      "x.vbrief.json",
    ]);
    expect(taskKeyToDispatchArgv("vbrief:preflight")).toEqual(["vbrief:preflight"]);
    expect(taskKeyToDispatchArgv("triage:welcome")).toEqual(["triage:welcome"]);
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

  it("returns exit code 2 for stubbed init", async () => {
    const err: string[] = [];
    const code = await routeAndDispatch(["init"], {
      writeOut: () => {},
      writeErr: (text) => {
        err.push(text);
      },
    });
    expect(code).toBe(2);
    expect(err.join("")).toContain("deft-install");
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
