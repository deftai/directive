import {
  formatOriginFreshnessHint,
  formatOriginPreflightUsage,
} from "@deftai/directive-core/preflight";
import { describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "../dispatch.js";
import { routeArgv } from "./route-argv.js";

const PATH = "xbrief/active/2026-11-22-7138-story.xbrief.json";

/** Every `deft <verb> -- <path>` command named in backticks by a printed line. */
function namedCommands(text: string): Array<{ verb: string; path: string }> {
  const out: Array<{ verb: string; path: string }> = [];
  for (const match of text.matchAll(/`deft ([^`\s]+) -- ([^`]+)`/g)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      out.push({ verb: match[1], path: match[2] });
    }
  }
  return out;
}

describe("xbrief:preflight origin recovery commands resolve (#7138)", () => {
  it("prints the deft block/unblock pair and the deft usage line for the path", () => {
    const printed = `${formatOriginPreflightUsage(PATH)}\n${formatOriginFreshnessHint(PATH, "origin body changed")}`;
    expect(namedCommands(printed)).toEqual([
      { verb: "xbrief:preflight", path: PATH },
      { verb: "scope:block", path: PATH },
      { verb: "scope:unblock", path: PATH },
    ]);
  });

  it.each([
    ["xbrief:preflight"],
    ["scope:block"],
    ["scope:unblock"],
  ])("routes the printed `deft %s -- <path>` through the CLI router", (verb) => {
    const printed = `${formatOriginPreflightUsage(PATH)}\n${formatOriginFreshnessHint(PATH)}`;
    const command = namedCommands(printed).find((entry) => entry.verb === verb);
    expect(command).toBeDefined();
    const routed = routeArgv([verb, "--", PATH]);
    expect(routed.kind).toBe("dispatch");
    expect(routed.argv).toContain(PATH);
    expect(resolveCanonicalVerb(String(routed.argv[0]))).not.toBeNull();
  });
});
