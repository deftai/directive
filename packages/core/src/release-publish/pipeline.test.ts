import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_OK, EXIT_VIOLATION } from "../release/constants.js";
import { emit, runPublish } from "./pipeline.js";
import type { PublishConfig } from "./types.js";

const baseConfig: PublishConfig = {
  version: "0.21.0",
  repo: "deftai/directive",
  projectRoot: ".",
  dryRun: false,
};

describe("emit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes publish prefix to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    emit("View v0.21.0", "OK");
    expect(spy).toHaveBeenCalledWith("[publish] View v0.21.0... OK\n");
  });
});

describe("runPublish", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dry-run emits REST plan without gh calls", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const rc = runPublish({ ...baseConfig, dryRun: true });
    expect(rc).toBe(EXIT_OK);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("DRYRUN");
    expect(out).toContain("--paginate");
    expect(out).toContain("repos/deftai/directive/releases?per_page=100");
    expect(out).toContain("tag_name == v0.21.0");
    expect(out).toContain("-X PATCH");
    expect(out).toContain("draft=false");
    expect(out).not.toContain("release view");
    expect(out).not.toContain("/releases/tags/");
  });

  it("happy path draft to published", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let viewCalls = 0;
    const seams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd: string, args: readonly string[]) => {
        if (args.includes("--paginate")) {
          viewCalls += 1;
          const draft = viewCalls === 1;
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 42,
                draft,
                tag_name: "v0.21.0",
                html_url: "https://example.com/r",
              },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    };
    const rc = runPublish(baseConfig, seams);
    expect(rc).toBe(EXIT_OK);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("draft found");
    expect(out).toContain("is now public");
    expect(out).toContain("published successfully");
  });

  it("not-found exits violation", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 0, stdout: "[]", stderr: "" }),
    };
    expect(runPublish(baseConfig, seams)).toBe(EXIT_VIOLATION);
  });

  it("already published no-op", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({
        status: 0,
        stdout: JSON.stringify([
          { id: 1, draft: false, tag_name: "v0.21.0", html_url: "https://example.com/r" },
        ]),
        stderr: "",
      }),
    };
    expect(runPublish(baseConfig, seams)).toBe(EXIT_OK);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("NOOP");
    expect(out).toContain("already published");
  });

  it("gh-error on view exits violation", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 4, stdout: "", stderr: "auth required" }),
    };
    const rc = runPublish(baseConfig, seams);
    expect(rc).toBe(EXIT_VIOLATION);
  });

  it("edit failure exits violation", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let n = 0;
    const seams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => {
        n += 1;
        if (n === 1) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 7, draft: true, tag_name: "v0.21.0", html_url: "https://example.com/r" },
            ]),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: "gh release edit failed: 404" };
      },
    };
    const rc = runPublish(baseConfig, seams);
    expect(rc).toBe(EXIT_VIOLATION);
  });

  it("post-edit verification mismatch exits violation", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd: string, args: readonly string[]) => {
        if (args.includes("--paginate")) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 9, draft: true, tag_name: "v0.21.0", html_url: "https://example.com/r" },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    };
    const rc = runPublish(baseConfig, seams);
    expect(rc).toBe(EXIT_VIOLATION);
  });

  it("uses no url fallback when payload url missing", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let viewCalls = 0;
    const seams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd: string, args: readonly string[]) => {
        if (args.includes("--paginate")) {
          viewCalls += 1;
          const draft = viewCalls === 1;
          return {
            status: 0,
            stdout: JSON.stringify([{ id: 42, draft, tag_name: "v0.21.0" }]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    };
    runPublish(baseConfig, seams);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("<no url>");
  });
});
