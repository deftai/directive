import { engineInfo } from "@deftai/directive-core";
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

const engineVersion = engineInfo().version;
const VERSION_BANNER = `@deftai/directive (engine: @deftai/directive-core@${engineVersion})\n`;

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
    expect(body).toContain("Usage: directive <verb> [args...]");
    expect(body).toContain("Registered verbs:");
    for (const verb of registeredVerbs()) {
      expect(body).toContain(`  ${verb}\n`);
    }
  });
});

describe("dispatch", () => {
  it("returns 0 for --version and prints the engine banner", async () => {
    const out: string[] = [];
    const code = await dispatch(["--version"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toBe(VERSION_BANNER);
  });

  it("returns 0 for -V and prints the engine banner", async () => {
    const out: string[] = [];
    const code = await dispatch(["-V"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toBe(VERSION_BANNER);
  });

  it("returns 0 for empty argv and prints help", async () => {
    const out: string[] = [];
    const code = await dispatch([], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Usage: directive");
  });

  it("returns 0 for -h and prints help", async () => {
    const out: string[] = [];
    const code = await dispatch(["-h"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("verify-encoding");
  });

  it("returns 0 for help and prints help", async () => {
    const out: string[] = [];
    const code = await dispatch(["help"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("verify-encoding");
  });

  it("coerces non-number handler return to exit code 0", async () => {
    vi.doMock("./verify-encoding.js", () => ({
      run: () => "not-a-number",
    }));
    resetHandlerCacheForTests();

    const code = await dispatch(["verify-encoding"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(0);
  });

  it("coerces async void handler return to exit code 0", async () => {
    vi.doMock("./verify-encoding.js", () => ({
      run: async () => undefined,
    }));
    resetHandlerCacheForTests();

    const code = await dispatch(["verify-encoding"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(0);
  });

  it("coerces a void handler return to exit code 0", async () => {
    vi.doMock("./verify-encoding.js", () => ({
      run: () => undefined,
    }));
    resetHandlerCacheForTests();

    const code = await dispatch(["verify-encoding"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(0);
  });

  it("returns exit code 2 when a handler throws", async () => {
    vi.doMock("./verify-encoding.js", () => ({
      run: () => {
        throw new Error("boom");
      },
    }));
    resetHandlerCacheForTests();

    const err: string[] = [];
    const code = await dispatch(["verify-encoding"], {
      writeOut: () => {},
      writeErr: (text) => {
        err.push(text);
      },
    });
    expect(code).toBe(2);
    expect(err.join("")).toBe("directive: boom\n");
  });

  it("stringifies non-Error handler throws", async () => {
    vi.doMock("./verify-encoding.js", () => ({
      run: () => {
        throw "plain";
      },
    }));
    resetHandlerCacheForTests();

    const err: string[] = [];
    const code = await dispatch(["verify-encoding"], {
      writeOut: () => {},
      writeErr: (text) => {
        err.push(text);
      },
    });
    expect(code).toBe(2);
    expect(err.join("")).toBe("directive: plain\n");
  });

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
    expect(err.join("")).toBe("directive: unknown verb 'not-a-real-verb'\n");
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
    vi.doMock("@deftai/directive-core/capacity", () => ({ runCapacityShowCli }));
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
    vi.doMock("@deftai/directive-core/dist/scm/main.js", () => ({ main }));
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

  it("resolves every task-style alias in VERB_ALIASES", () => {
    for (const [alias, canonical] of Object.entries(VERB_ALIASES)) {
      expect(resolveCanonicalVerb(alias)).toBe(canonical);
    }
  });
});
