import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLI_MODULE_VERBS,
  CORE_MODULE_VERBS,
  dispatch,
  printHelp,
  registeredVerbs,
  resetHandlerCacheForTests,
  resolveCanonicalVerb,
  VERB_ALIASES,
} from "./dispatch.js";

afterEach(() => {
  resetHandlerCacheForTests();
  vi.restoreAllMocks();
});

describe("registeredVerbs", () => {
  it("includes every CLI module verb, core verb, and alias", () => {
    const verbs = registeredVerbs();
    for (const name of CLI_MODULE_VERBS) {
      expect(verbs).toContain(name);
    }
    for (const name of CORE_MODULE_VERBS) {
      expect(verbs).toContain(name);
    }
    for (const alias of Object.keys(VERB_ALIASES)) {
      expect(verbs).toContain(alias);
    }
    expect(verbs.length).toBe(
      new Set([...CLI_MODULE_VERBS, ...CORE_MODULE_VERBS, ...Object.keys(VERB_ALIASES)]).size,
    );
  });
});

describe("printHelp", () => {
  it("lists all registered verbs", () => {
    const lines: string[] = [];
    printHelp({
      writeOut: (text) => {
        lines.push(text);
      },
      writeErr: () => {},
    });
    const body = lines.join("");
    expect(body).toContain("Usage: deft-ts <verb> [args...]");
    expect(body).toContain("Registered verbs:");
    for (const verb of registeredVerbs()) {
      expect(body).toContain(`  ${verb}\n`);
    }
  });
});

describe("dispatch", () => {
  it("returns 0 for --help and prints the verb list", async () => {
    const out: string[] = [];
    const code = await dispatch(["--help"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("verify-encoding");
  });

  it("prints an error naming an unknown verb and exits non-zero", async () => {
    const err: string[] = [];
    const code = await dispatch(["not-a-real-verb"], {
      writeOut: () => {},
      writeErr: (text) => {
        err.push(text);
      },
    });
    expect(code).toBe(1);
    expect(err.join("")).toBe("deft-ts: unknown verb 'not-a-real-verb'\n");
  });

  it("routes a known verb through its handler and propagates the exit code", async () => {
    const handler = vi.fn(async (argv: string[]) => {
      expect(argv).toEqual(["--quiet", "--project-root", "/tmp/x"]);
      return 7;
    });
    vi.doMock("./verify-encoding.js", () => ({ run: handler }));
    resetHandlerCacheForTests();

    const code = await dispatch(["verify-encoding", "--quiet", "--project-root", "/tmp/x"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(7);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("resolves task-style aliases to the canonical handler", async () => {
    expect(resolveCanonicalVerb("verify:encoding")).toBe("verify-encoding");
    const handler = vi.fn(() => 0);
    vi.doMock("./verify-encoding.js", () => ({ run: handler }));
    resetHandlerCacheForTests();

    await dispatch(["verify:encoding", "--help"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("routes wrapper CLI modules through core helpers", async () => {
    const runCapacityShowCli = vi.fn(() => ({
      exitCode: 3,
      stdout: "ok\n",
      stderr: "",
    }));
    vi.doMock("@deftai/core/capacity", () => ({ runCapacityShowCli }));
    resetHandlerCacheForTests();

    const out: string[] = [];
    const code = await dispatch(["capacity-show", "--project-root", "."], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(3);
    expect(out.join("")).toBe("ok\n");
    expect(runCapacityShowCli).toHaveBeenCalledWith(["--project-root", "."]);
  });

  it("routes core-only verbs such as scm", async () => {
    const main = vi.fn(() => 5);
    vi.doMock("../../core/dist/scm/main.js", () => ({ main }));
    resetHandlerCacheForTests();

    const code = await dispatch(["scm", "issue", "list"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(5);
    expect(main).toHaveBeenCalledWith(["issue", "list"]);
  });

  it("resolveCanonicalVerb returns null for unknown verbs", () => {
    expect(resolveCanonicalVerb("nope")).toBeNull();
    expect(resolveCanonicalVerb("verify-encoding")).toBe("verify-encoding");
    expect(resolveCanonicalVerb("scm")).toBe("scm");
  });
});
