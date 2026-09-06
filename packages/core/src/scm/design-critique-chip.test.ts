import { describe, expect, it } from "vitest";
import { DESIGN_CRITIQUE_CATALOG_CHIPS } from "../design-critique/exclusive-chip.js";
import { ScmLabelError } from "../vbrief-reconcile/labels.js";
import type { LabelClient } from "../vbrief-reconcile/types.js";
import {
  CHIP_ALIASES,
  DESIGN_CRITIQUE_CHIP_USAGE,
  parseDesignCritiqueChipArgs,
  resolveDesignCritiqueChipArg,
  resolveRepoFromGitOrigin,
  runDesignCritiqueChip,
} from "./design-critique-chip.js";

class FakeLabelClient implements LabelClient {
  labels: string[];
  applyCalls: Array<{ add: readonly string[]; remove: readonly string[] }> = [];

  constructor(labels: string[]) {
    this.labels = [...labels];
  }

  fetchLabels(_repo: string, _issueNumber: number): string[] {
    return [...this.labels];
  }

  apply(
    _repo: string,
    _issueNumber: number,
    add: readonly string[],
    remove: readonly string[],
  ): void {
    this.applyCalls.push({ add: [...add], remove: [...remove] });
    const next = new Set(this.labels);
    for (const name of remove) next.delete(name);
    for (const name of add) next.add(name);
    this.labels = [...next];
  }
}

describe("resolveDesignCritiqueChipArg", () => {
  it("CHIP_ALIASES covers every catalog chip short and full name", () => {
    for (const chip of DESIGN_CRITIQUE_CATALOG_CHIPS) {
      expect(CHIP_ALIASES[chip]).toBe(chip);
      const short = chip.slice("design-critique:".length);
      expect(CHIP_ALIASES[short]).toBe(chip);
    }
  });

  it("accepts short and full catalog names", () => {
    expect(resolveDesignCritiqueChipArg("triage-ready")).toBe("design-critique:triage-ready");
    expect(resolveDesignCritiqueChipArg("mechanism-shaped")).toBe(
      "design-critique:mechanism-shaped",
    );
    expect(resolveDesignCritiqueChipArg("recut-needed")).toBe("design-critique:recut-needed");
    expect(resolveDesignCritiqueChipArg("design-critique:triage-ready")).toBe(
      "design-critique:triage-ready",
    );
    expect(resolveDesignCritiqueChipArg("design-critique:recut-needed")).toBe(
      "design-critique:recut-needed",
    );
  });

  it("fails closed on unknown chip names", () => {
    expect(() => resolveDesignCritiqueChipArg("design-critique:halted")).toThrow(
      /unknown design-critique chip/,
    );
    expect(() => resolveDesignCritiqueChipArg("critic-posted")).toThrow(
      /unknown design-critique chip/,
    );
    expect(() => resolveDesignCritiqueChipArg("bug")).toThrow(/unknown design-critique chip/);
    expect(() => resolveDesignCritiqueChipArg("recut")).toThrow(/unknown design-critique chip/);
  });
});

describe("parseDesignCritiqueChipArgs", () => {
  it("parses --issue --chip --repo", () => {
    expect(
      parseDesignCritiqueChipArgs([
        "--issue",
        "3642",
        "--chip",
        "triage-ready",
        "--repo",
        "deftai/directive",
      ]),
    ).toEqual({
      issue: 3642,
      chip: "design-critique:triage-ready",
      repo: "deftai/directive",
      json: false,
    });
  });

  it("accepts positional issue number", () => {
    expect(
      parseDesignCritiqueChipArgs([
        "3637",
        "--chip",
        "mechanism-shaped",
        "--repo",
        "deftai/directive",
        "--json",
      ]),
    ).toEqual({
      issue: 3637,
      chip: "design-critique:mechanism-shaped",
      repo: "deftai/directive",
      json: true,
    });
  });

  it("requires --chip and --issue; --repo may be omitted", () => {
    expect(() => parseDesignCritiqueChipArgs(["--chip", "triage-ready"])).toThrow(
      /missing --issue/,
    );
    expect(parseDesignCritiqueChipArgs(["--issue", "1", "--chip", "triage-ready"])).toEqual({
      issue: 1,
      chip: "design-critique:triage-ready",
      repo: null,
      json: false,
    });
    expect(() =>
      parseDesignCritiqueChipArgs(["--issue", "1", "--repo", "deftai/directive"]),
    ).toThrow(/missing --chip/);
  });

  it("rejects leftover flags and non-integer issue", () => {
    expect(() =>
      parseDesignCritiqueChipArgs([
        "--issue",
        "1",
        "--chip",
        "triage-ready",
        "--repo",
        "deftai/directive",
        "--add-label",
        "bug",
      ]),
    ).toThrow(/unrecognized flags/);
    expect(() =>
      parseDesignCritiqueChipArgs([
        "--issue",
        "1.5",
        "--chip",
        "triage-ready",
        "--repo",
        "deftai/directive",
      ]),
    ).toThrow(/positive integer/);
    expect(() =>
      parseDesignCritiqueChipArgs([
        "1",
        "--issue",
        "2",
        "--chip",
        "triage-ready",
        "--repo",
        "deftai/directive",
      ]),
    ).toThrow(/conflicts with positional/);
    expect(() =>
      parseDesignCritiqueChipArgs([
        "1",
        "2",
        "--chip",
        "triage-ready",
        "--repo",
        "deftai/directive",
      ]),
    ).toThrow(/at most one positional/);
  });
});

describe("runDesignCritiqueChip", () => {
  it("replaces mechanism-shaped with triage-ready in one apply", () => {
    const client = new FakeLabelClient(["bug", "design-critique:mechanism-shaped", "area:cli"]);
    const result = runDesignCritiqueChip(
      ["--issue", "3642", "--chip", "triage-ready", "--repo", "deftai/directive", "--json"],
      { client },
    );
    expect(result.exitCode).toBe(0);
    expect(client.applyCalls).toHaveLength(1);
    expect(client.applyCalls[0]).toEqual({
      add: ["design-critique:triage-ready"],
      remove: ["design-critique:mechanism-shaped"],
    });
    const payload = JSON.parse(result.stdout) as {
      remaining: string[];
      add: string[];
      remove: string[];
    };
    expect(payload.remaining).toEqual(["bug", "area:cli", "design-critique:triage-ready"]);
    expect(payload.add).toEqual(["design-critique:triage-ready"]);
    expect(payload.remove).toEqual(["design-critique:mechanism-shaped"]);
    expect(client.labels.sort()).toEqual(
      ["area:cli", "bug", "design-critique:triage-ready"].sort(),
    );
  });

  it("applies recut-needed in one remaining-set write (#4205)", () => {
    const client = new FakeLabelClient(["bug", "design-critique:mechanism-shaped", "area:cli"]);
    const result = runDesignCritiqueChip(
      ["--issue", "4205", "--chip", "recut-needed", "--repo", "deftai/directive", "--json"],
      { client },
    );
    expect(result.exitCode).toBe(0);
    expect(client.applyCalls).toEqual([
      { add: ["design-critique:recut-needed"], remove: ["design-critique:mechanism-shaped"] },
    ]);
    const payload = JSON.parse(result.stdout) as { remaining: string[] };
    expect(payload.remaining).toEqual(["bug", "area:cli", "design-critique:recut-needed"]);
    expect(payload.remaining).not.toContain("design-critique:triage-ready");
  });

  it("recuts to mechanism-shaped and keeps other facets", () => {
    const client = new FakeLabelClient(["enhancement", "design-critique:triage-ready"]);
    const result = runDesignCritiqueChip(
      ["--issue", "1", "--chip", "mechanism-shaped", "--repo", "o/r"],
      { client },
    );
    expect(result.exitCode).toBe(0);
    expect(client.applyCalls).toEqual([
      { add: ["design-critique:mechanism-shaped"], remove: ["design-critique:triage-ready"] },
    ]);
    expect(result.stdout).toContain("applied design-critique:mechanism-shaped");
    expect(result.stdout).toContain("removed design-critique:triage-ready");
  });

  it("skips write when already exclusive", () => {
    const client = new FakeLabelClient(["process", "design-critique:triage-ready"]);
    const result = runDesignCritiqueChip(
      ["--issue", "3642", "--chip", "triage-ready", "--repo", "deftai/directive"],
      { client },
    );
    expect(result.exitCode).toBe(0);
    expect(client.applyCalls).toHaveLength(0);
    expect(result.stdout).toContain("already exclusive");
  });

  it("fails closed on unknown chip without writing", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runDesignCritiqueChip(
      ["--issue", "1", "--chip", "design-critique:halted", "--repo", "deftai/directive"],
      { client },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/unknown design-critique chip/);
    expect(client.applyCalls).toHaveLength(0);
  });

  it("prints usage on --help", () => {
    const result = runDesignCritiqueChip(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(DESIGN_CRITIQUE_CHIP_USAGE.trim());
  });

  it("prints usage on -h", () => {
    const result = runDesignCritiqueChip(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("scm issue design-critique-chip");
  });

  it("adds the chip when no catalog name is present", () => {
    const client = new FakeLabelClient(["enhancement"]);
    const result = runDesignCritiqueChip(
      ["--issue", "1", "--chip", "mechanism-shaped", "--repo", "o/r"],
      { client },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(added)");
    expect(client.applyCalls).toEqual([{ add: ["design-critique:mechanism-shaped"], remove: [] }]);
  });

  it("fails closed on invalid repo", () => {
    const result = runDesignCritiqueChip([
      "--issue",
      "1",
      "--chip",
      "triage-ready",
      "--repo",
      "not-a-repo",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/invalid --repo value/);
  });

  it("treats fetch LabelClient failure as a non-blocking apply miss (#3806)", () => {
    const client: LabelClient = {
      fetchLabels: () => {
        throw new ScmLabelError("issue view failed");
      },
      apply: () => {
        throw new Error("should not write");
      },
    };
    const result = runDesignCritiqueChip(
      ["--issue", "1", "--chip", "triage-ready", "--repo", "deftai/directive"],
      { client },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("already exclusive");
    expect(result.stderr).toMatch(/chip apply missed \(non-blocking convenience\)/);
    expect(result.stderr).toMatch(/issue view failed/);
    expect(result.stderr).toMatch(/ingest is not blocked/);
  });

  it("parses git origin as OWNER/NAME in this checkout", () => {
    const repo = resolveRepoFromGitOrigin();
    expect(repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  });

  it("resolves omitted --repo from git origin", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runDesignCritiqueChip(["--issue", "1", "--chip", "triage-ready", "--json"], {
      client,
      resolveDefaultRepo: () => "deftai/directive",
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { repo: string };
    expect(payload.repo).toBe("deftai/directive");
    expect(client.applyCalls).toHaveLength(1);
  });

  it("fails closed when --repo is omitted and origin cannot be resolved", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runDesignCritiqueChip(["--issue", "1", "--chip", "triage-ready"], {
      client,
      resolveDefaultRepo: () => null,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/could not resolve from git origin/);
    expect(client.applyCalls).toHaveLength(0);
  });

  it("treats mocked LabelClient.apply failure as a miss, not already exclusive (#3806)", () => {
    const client: LabelClient = {
      fetchLabels: () => ["bug"],
      apply: () => {
        throw new Error("HTTP 403 Forbidden");
      },
    };
    const result = runDesignCritiqueChip(
      ["--issue", "1", "--chip", "triage-ready", "--repo", "deftai/directive", "--json"],
      { client },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("already exclusive");
    const payload = JSON.parse(result.stdout) as {
      applied: boolean;
      miss: boolean;
      blocking: boolean;
      error: string;
    };
    expect(payload).toMatchObject({ applied: false, miss: true, blocking: false });
    expect(payload.error).toMatch(/403/);
  });
});
