import { describe, expect, it } from "vitest";
import { parseArgs as parseGrant, run as runGrant } from "./occupancy-grant.js";
import { parseArgs as parseHeartbeat, run as runHeartbeat } from "./occupancy-heartbeat.js";
import { parseArgs as parseRelease, run as runRelease } from "./occupancy-release.js";
import { parseArgs as parseSteal, run as runSteal } from "./occupancy-steal.js";
import { occupancyUnrecognizedArgument } from "./occupancy-unrecognized.js";

describe("occupancy-namespace unrecognized arguments (#4411)", () => {
  it("names deft help and deft commands", () => {
    expect(occupancyUnrecognizedArgument("--help")).toBe(
      "unrecognized argument: --help. See `deft help` or `deft commands`.",
    );
  });

  it.each([
    ["grant", parseGrant, runGrant],
    ["heartbeat", parseHeartbeat, runHeartbeat],
    ["release", parseRelease, runRelease],
    ["steal", parseSteal, runSteal],
  ] as const)("%s --help names deft help / deft commands and exits 2", (_verb, parse, run) => {
    const error = parse(["--help"]).error;
    expect(error).toContain("unrecognized argument: --help");
    expect(error).toContain("deft help");
    expect(error).toContain("deft commands");
    expect(run(["--help"])).toBe(2);
  });
});
