import { formatFinalizeOwedReportLine } from "@deftai/directive-core/session";
import { FINALIZE_OWED_COMMAND } from "@deftai/directive-core/swarm";
import { describe, expect, it, vi } from "vitest";
import { dispatch, resolveCanonicalVerb } from "../dispatch.js";
import { routeArgv } from "./route-argv.js";

/** The `deft <verb>` named in backticks by the session:start report line. */
function namedVerb(line: string): string {
  const match = /`deft ([^`\s]+)`/.exec(line);
  if (match?.[1] === undefined) {
    throw new Error(`report line names no deft command: ${line}`);
  }
  return match[1];
}

describe("finalize-owed report command resolves (#6409 / #5914 part 1)", () => {
  it("the report line names FINALIZE_OWED_COMMAND", () => {
    const line = formatFinalizeOwedReportLine(2);
    expect(line).toContain(`\`${FINALIZE_OWED_COMMAND}\``);
    expect(namedVerb(line)).toBe("swarm:finalize-owed");
  });

  it("routes the named command to the swarm-finalize-owed verb", () => {
    const verb = namedVerb(formatFinalizeOwedReportLine(1));
    const routed = routeArgv([verb, "--help"]);
    expect(routed.kind).toBe("dispatch");
    expect(routed.argv[0]).toBe("swarm-finalize-owed");
    expect(resolveCanonicalVerb("swarm-finalize-owed")).toBe("swarm-finalize-owed");
  });

  it("runs the finalize-owed verb (--help exits 0 with its usage)", async () => {
    const verb = namedVerb(formatFinalizeOwedReportLine(1));
    const routed = routeArgv([verb, "--help"]);
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = await dispatch([...routed.argv], {
        writeOut: (text) => written.push(text),
        writeErr: () => undefined,
      });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);
    expect(written.join("")).toContain(`Usage: ${FINALIZE_OWED_COMMAND} [options]`);
  });
});
