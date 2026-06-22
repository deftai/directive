import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBPROCESS_MAX_BUFFER } from "../../subprocess/max-buffer.js";
import { runCliCapture } from "./cli.js";
import { coveragePath, writeCoverageDenominator } from "./coverage.js";
import { fetchUpstreamLabelsAndMilestones } from "./mutations.js";

const mockedSpawn = vi.mocked(spawnSync);

describe("mutations gh fetch branches", () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses paginated gh label and milestone responses", () => {
    mockedSpawn
      .mockReturnValueOnce({
        status: 0,
        stdout: '[{"name":"bug"},{"name":"docs"}]',
        stderr: "",
        pid: 1,
        output: [null, "", ""],
        signal: null,
      } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        status: 0,
        stdout: '[{"title":"v1.0"},{"title":"v2.0"}]',
        stderr: "",
        pid: 1,
        output: [null, "", ""],
        signal: null,
      } as ReturnType<typeof spawnSync>);
    const [labels, milestones] = fetchUpstreamLabelsAndMilestones("o/r", "gh");
    expect(labels).toEqual(new Set(["bug", "docs"]));
    expect(milestones).toEqual(new Set(["v1.0", "v2.0"]));
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
  });

  it("throws when gh returns non-zero", () => {
    mockedSpawn.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "rate limit",
      pid: 1,
      output: [null, "", ""],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(() => fetchUpstreamLabelsAndMilestones("o/r", "gh")).toThrow(/failed/);
  });

  it("throws on invalid JSON payload", () => {
    mockedSpawn.mockReturnValue({
      status: 0,
      stdout: "not-json",
      stderr: "",
      pid: 1,
      output: [null, "", ""],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(() => fetchUpstreamLabelsAndMilestones("o/r", "gh")).toThrow(/non-JSON/);
  });

  it("returns empty set for empty gh response", () => {
    mockedSpawn.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [null, "", ""],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    const [labels] = fetchUpstreamLabelsAndMilestones("o/r", "gh");
    expect(labels.size).toBe(0);
  });

  it("parses concatenated paginate arrays", () => {
    mockedSpawn
      .mockReturnValueOnce({
        status: 0,
        stdout: '[{"name":"a"}][{"name":"b"}]',
        stderr: "",
        pid: 1,
        output: [null, "", ""],
        signal: null,
      } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        status: 0,
        stdout: '[{"title":"m1"}]',
        stderr: "",
        pid: 1,
        output: [null, "", ""],
        signal: null,
      } as ReturnType<typeof spawnSync>);
    const [labels, milestones] = fetchUpstreamLabelsAndMilestones("o/r", "gh");
    expect(labels).toEqual(new Set(["a", "b"]));
    expect(milestones).toEqual(new Set(["m1"]));
  });

  it("throws when gh binary missing from PATH", () => {
    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedSpawn.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [null, "", ""],
      signal: null,
      error: err,
    } as ReturnType<typeof spawnSync>);
    expect(() => fetchUpstreamLabelsAndMilestones("o/r", "missing-gh")).toThrow(
      /not found on PATH/,
    );
  });

  it("passes SUBPROCESS_MAX_BUFFER so --paginate responses over 1 MB do not overflow (#1867)", () => {
    mockedSpawn.mockReturnValue({
      status: 0,
      stdout: "[]",
      stderr: "",
      pid: 1,
      output: [null, "", ""],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    fetchUpstreamLabelsAndMilestones("o/r", "gh");
    const options = mockedSpawn.mock.calls[0]?.[2] as { maxBuffer?: number } | undefined;
    expect(options?.maxBuffer).toBe(SUBPROCESS_MAX_BUFFER);
  });

  it("surfaces a non-empty message when the spawn errors with empty stderr (#1867)", () => {
    // ENOBUFS leaves status=null, stderr="", and a populated error -- the
    // failure must carry error.message instead of a blank reason.
    const err = new Error("stdout maxBuffer length exceeded") as NodeJS.ErrnoException;
    err.code = "ENOBUFS";
    mockedSpawn.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [null, "", ""],
      signal: null,
      error: err,
    } as ReturnType<typeof spawnSync>);
    expect(() => fetchUpstreamLabelsAndMilestones("o/r", "gh")).toThrow(/maxBuffer/);
  });

  it("throws when gh returns non-list payload", () => {
    mockedSpawn.mockReturnValue({
      status: 0,
      stdout: '{"not":"list"}',
      stderr: "",
      pid: 1,
      output: [null, "", ""],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(() => fetchUpstreamLabelsAndMilestones("o/r", "gh")).toThrow(/non-list/);
  });
});

describe("coverage write validation branches", () => {
  it("rejects invalid write args", () => {
    const root = mkdtempSync(join(tmpdir(), "covw-"));
    const path = coveragePath("github-issue", "o/r", { cacheRoot: root });
    expect(() => writeCoverageDenominator(path, { count: -1, subscriptionHashValue: "h" })).toThrow(
      /count must be >= 0/,
    );
    expect(() => writeCoverageDenominator(path, { count: 1, subscriptionHashValue: "" })).toThrow(
      /subscription_hash_value/,
    );
  });
});

describe("cli diff-from-upstream error branch", () => {
  it("surfaces gh fetch failure", () => {
    mockedSpawn.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "nope",
      pid: 1,
      output: [null, "", ""],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    const root = mkdtempSync(join(tmpdir(), "clid-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { title: "T", status: "running", items: [] } }),
      "utf8",
    );
    const result = runCliCapture(["--project-root", root, "--diff-from-upstream", "--repo", "o/r"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("diff-from-upstream");
  });
});
