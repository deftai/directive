import { describe, expect, it } from "vitest";
import { parseArgs } from "./triage-evaluate.js";

describe("triage-evaluate parseArgs", () => {
  it("defaults concurrency to 4 and collects issue numbers", () => {
    const parsed = parseArgs(["42", "--issue", "7", "--repo", "deftai/directive"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.issues).toEqual([42, 7]);
    expect(parsed.concurrency).toBe(4);
    expect(parsed.repo).toBe("deftai/directive");
  });

  it("parses --concurrency N", () => {
    expect(parseArgs(["1", "--concurrency=2"]).concurrency).toBe(2);
    expect(parseArgs(["1", "--concurrency", "0"]).error).toMatch(/concurrency/);
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["1", "--nope"]).error).toMatch(/unrecognized/);
  });

  it("rejects flags that consume a value when none remains", () => {
    expect(parseArgs(["1", "--repo"]).error).toMatch(/--repo requires/);
    expect(parseArgs(["1", "--project-root"]).error).toMatch(/--project-root requires/);
    expect(parseArgs(["1", "--concurrency"]).error).toMatch(/--concurrency requires/);
    expect(parseArgs(["--issue"]).error).toMatch(/--issue requires/);
  });

  it("parses --json and #prefixed issues", () => {
    const parsed = parseArgs(["#3", "--json", "--project-root", "/tmp/p"]);
    expect(parsed.json).toBe(true);
    expect(parsed.issues).toEqual([3]);
    expect(parsed.projectRoot).toBe("/tmp/p");
  });
});
