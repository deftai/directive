import { describe, expect, it } from "vitest";
import { routeAndDispatch } from "./cli-router/index.js";
import { dispatch } from "./dispatch.js";

async function capture(argv: string[]): Promise<{
  code: number;
  out: string;
  err: string;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await dispatch(argv, {
    writeOut: (text) => {
      out.push(text);
    },
    writeErr: (text) => {
      err.push(text);
    },
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("extension-recipe advertised invocation forms (#4091)", () => {
  it("resolves standalone-module help (triage:evaluate --help)", async () => {
    const colon = await capture(["triage:evaluate", "--help"]);
    expect(colon.code).toBe(0);
    expect(colon.out).toContain("task triage:evaluate");
    expect(colon.err).not.toContain("unrecognized argument");

    const stem = await capture(["triage-evaluate", "--help"]);
    expect(stem.code).toBe(0);
    expect(stem.out).toContain("task triage:evaluate");
  });

  it("resolves multiplexed-subcommand help (triage:accept --help)", async () => {
    const colon = await capture(["triage:accept", "--help"]);
    expect(colon.code).toBe(0);
    expect(colon.out).toContain("task triage:accept");
    expect(colon.err).not.toContain("unrecognized argument");

    const forwarded = await capture(["triage-actions", "accept", "--help"]);
    expect(forwarded.code).toBe(0);
    expect(forwarded.out).toContain("task triage:accept");
    expect(forwarded.err).not.toContain("unrecognized argument");
  });

  it("forwards space-form subcommands to the same help (triage accept --help)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await routeAndDispatch(["triage", "accept", "--help"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: (text) => {
        err.push(text);
      },
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("task triage:accept");
    expect(err.join("")).not.toContain("unrecognized argument");
  });
});
