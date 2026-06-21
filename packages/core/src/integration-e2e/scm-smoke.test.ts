import { describe, expect, it, vi } from "vitest";
import { main as scmMain } from "../scm/main.js";
import * as restDispatch from "../scm/rest-dispatch.js";
import { probeRateLimit } from "./helpers.js";

describe("integration-e2e scm smoke (mirrors test_scm_smoke.py)", () => {
  it("probeRateLimit returns null for malformed payloads", () => {
    for (const payload of [
      "null",
      "[1, 2, 3]",
      '"a string"',
      '{"resources": null}',
      '{"resources": [1, 2]}',
      '{"resources": {"core": null, "graphql": {"remaining": 5000}}}',
      '{"resources": {"core": {"remaining": 5000}, "graphql": null}}',
      '{"resources": "string"}',
      '{"resources": {"core": [1, 2], "graphql": {"remaining": 5000}}}',
    ]) {
      expect(probeRateLimit(() => ({ returncode: 0, stdout: payload }))).toBeNull();
    }
    expect(
      probeRateLimit(() => ({
        returncode: 0,
        stdout: '{"resources": {"core": {"remaining": "NaN"}, "graphql": {"remaining": 5000}}}',
      })),
    ).toBeNull();
  });

  it("probeRateLimit parses well-formed payloads", () => {
    expect(
      probeRateLimit(() => ({
        returncode: 0,
        stdout: '{"resources": {"core": {"remaining": 4998}, "graphql": {"remaining": 4500}}}',
      })),
    ).toEqual({ core: 4998, graphql: 4500 });
  });

  it("probeRateLimit defaults missing remaining to zero", () => {
    expect(
      probeRateLimit(() => ({
        returncode: 0,
        stdout: '{"resources": {"core": {}, "graphql": {}}}',
      })),
    ).toEqual({ core: 0, graphql: 0 });
  });

  it("probeRateLimit returns null on non-zero returncode or invalid json", () => {
    expect(probeRateLimit(() => ({ returncode: 4, stdout: "unauthenticated" }))).toBeNull();
    expect(probeRateLimit(() => ({ returncode: 0, stdout: "not-json{{" }))).toBeNull();
  });

  it("scm issue view --rest returns populated JSON via TS main()", () => {
    const viewSpy = vi.spyOn(restDispatch, "runRestView").mockReturnValue({
      exitCode: 0,
      stdout: `${JSON.stringify({ number: 1, title: "Seed issue" })}\n`,
      stderr: "",
    });

    const stdout: string[] = [];
    const prevOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = scmMain([
        "issue",
        "view",
        "--rest",
        "1",
        "--repo",
        "deftai/directive",
        "--json",
        "number,title",
      ]);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout.join("").trim()) as { number: number; title: string };
      expect(parsed.number).toBe(1);
      expect(typeof parsed.title).toBe("string");
      expect(parsed.title.length).toBeGreaterThan(0);
    } finally {
      process.stdout.write = prevOut;
      viewSpy.mockRestore();
    }
  });
});
