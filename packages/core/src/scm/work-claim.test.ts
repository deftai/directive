import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionStart } from "../session/session-start.js";
import type { LabelClient } from "../vbrief-reconcile/types.js";
import {
  collectLifecycleOriginIssues,
  parseWorkClaimArgs,
  releaseWorkClaimForBrief,
  runWorkClaim,
  scanLifecycleWorkClaims,
  scanWorkClaimForBriefPath,
  WORK_CLAIM_LABEL,
  WORK_CLAIM_USAGE,
  workClaimSessionScanLines,
} from "./work-claim.js";

class FakeLabelClient implements LabelClient {
  labels: string[];
  applyCalls: Array<{ add: readonly string[]; remove: readonly string[] }> = [];
  fetchCalls = 0;

  constructor(labels: string[]) {
    this.labels = [...labels];
  }

  fetchLabels(_repo: string, _issueNumber: number): string[] {
    this.fetchCalls += 1;
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

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "work-claim-"));
  temps.push(root);
  return root;
}

function writeOriginBrief(
  root: string,
  folder: "proposed" | "pending" | "active",
  issue: number,
  repo = "deftai/directive",
): string {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-09-06-${issue}-story.xbrief.json`);
  writeFileSync(
    path,
    JSON.stringify({
      plan: {
        status: folder === "active" ? "running" : folder,
        references: [
          {
            uri: `https://github.com/${repo}/issues/${issue}`,
            type: "x-xbrief/github-issue",
          },
        ],
      },
    }),
    "utf8",
  );
  return path;
}

describe("parseWorkClaimArgs", () => {
  it("parses action --issue --repo", () => {
    expect(
      parseWorkClaimArgs(["show", "--issue", "4200", "--repo", "deftai/directive", "--json"]),
    ).toEqual({
      action: "show",
      issue: 4200,
      repo: "deftai/directive",
      projectRoot: null,
      json: true,
      readOnly: false,
    });
  });

  it("accepts positional issue after action", () => {
    expect(parseWorkClaimArgs(["claim", "4200"])).toEqual({
      action: "claim",
      issue: 4200,
      repo: null,
      projectRoot: null,
      json: false,
      readOnly: false,
    });
  });

  it("requires action and issue", () => {
    expect(() => parseWorkClaimArgs(["--issue", "1"])).toThrow(/missing action/);
    expect(() => parseWorkClaimArgs(["show"])).toThrow(/missing --issue/);
    expect(() => parseWorkClaimArgs(["claim", "--issue", "1.5"])).toThrow(/positive integer/);
  });

  it("rejects leftover flags", () => {
    expect(() => parseWorkClaimArgs(["show", "--issue", "1", "--add-label", "bug"])).toThrow(
      /unrecognized flags/,
    );
  });
});

describe("runWorkClaim", () => {
  it("show warns when claimed and still exits 0", () => {
    const client = new FakeLabelClient(["enhancement", WORK_CLAIM_LABEL]);
    const result = runWorkClaim(["show", "--issue", "4200", "--repo", "deftai/directive"], {
      client,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status:claimed");
    expect(result.stdout).toContain("Warn is success");
    expect(result.stdout).toContain("board can lie about who");
    expect(result.stdout).toContain("does not detect two-issue path overlap");
    expect(client.applyCalls).toHaveLength(0);
  });

  it("show reports free when the tag is absent", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runWorkClaim(["show", "--issue", "4200", "--repo", "deftai/directive"], {
      client,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("is free");
  });

  it("claim adds the catalog label when occupancy is live", () => {
    const client = new FakeLabelClient(["enhancement"]);
    const result = runWorkClaim(["claim", "--issue", "4200", "--repo", "deftai/directive"], {
      client,
      occupancyLive: () => true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`claimed ${WORK_CLAIM_LABEL}`);
    expect(client.applyCalls).toEqual([{ add: [WORK_CLAIM_LABEL], remove: [] }]);
  });

  it("claim is last-write-wins when the tag is already present", () => {
    const client = new FakeLabelClient([WORK_CLAIM_LABEL]);
    const result = runWorkClaim(["claim", "--issue", "4200", "--repo", "deftai/directive"], {
      client,
      occupancyLive: () => true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already claimed");
    expect(client.applyCalls).toHaveLength(0);
  });

  it("claim refuses with no occupancy", () => {
    const client = new FakeLabelClient([]);
    const result = runWorkClaim(["claim", "--issue", "4200", "--repo", "deftai/directive"], {
      client,
      occupancyLive: () => false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no occupancy");
    expect(result.stderr).toContain("must not claim");
    expect(client.applyCalls).toHaveLength(0);
  });

  it("claim refuses --read-only even with occupancy", () => {
    const client = new FakeLabelClient([]);
    const result = runWorkClaim(
      ["claim", "--issue", "4200", "--repo", "deftai/directive", "--read-only"],
      { client, occupancyLive: () => true },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("read-only");
    expect(client.applyCalls).toHaveLength(0);
  });

  it("release removes the catalog label when occupancy is live", () => {
    const client = new FakeLabelClient(["bug", WORK_CLAIM_LABEL]);
    const result = runWorkClaim(["release", "--issue", "4200", "--repo", "deftai/directive"], {
      client,
      occupancyLive: () => true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("released");
    expect(client.applyCalls).toEqual([{ add: [], remove: [WORK_CLAIM_LABEL] }]);
    expect(client.labels).toEqual(["bug"]);
  });

  it("release refuses with no occupancy", () => {
    const client = new FakeLabelClient([WORK_CLAIM_LABEL]);
    const result = runWorkClaim(["release", "--issue", "4200", "--repo", "deftai/directive"], {
      client,
      occupancyLive: () => false,
    });
    expect(result.exitCode).toBe(1);
    expect(client.applyCalls).toHaveLength(0);
  });

  it("prints usage on --help", () => {
    const result = runWorkClaim(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("scm issue work-claim");
    expect(result.stdout).toContain(WORK_CLAIM_USAGE.trim().slice(0, 20));
  });

  it("returns 2 for unknown actions without writing labels", () => {
    const client = new FakeLabelClient([]);
    const result = runWorkClaim(["lock", "--issue", "1", "--repo", "deftai/directive"], {
      client,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing action");
    expect(client.applyCalls).toHaveLength(0);
  });
});

describe("lifecycle origin scan", () => {
  it("collects github-issue origins from proposed/pending/active", () => {
    const root = tempRoot();
    writeOriginBrief(root, "proposed", 4200);
    writeOriginBrief(root, "active", 3785);
    const found = collectLifecycleOriginIssues(root);
    expect(found.map((row) => row.issue).sort()).toEqual([3785, 4200]);
  });

  it("warns when a scanned issue is claimed and stays success-shaped", () => {
    const root = tempRoot();
    writeOriginBrief(root, "active", 4200);
    const client = new FakeLabelClient([WORK_CLAIM_LABEL]);
    const lines = scanLifecycleWorkClaims(root, { client });
    expect(lines.join("\n")).toContain("deftai/directive#4200");
    expect(lines.join("\n")).toContain("Warn is success");
  });

  it("notes a free scan when no origin is tagged", () => {
    const root = tempRoot();
    writeOriginBrief(root, "active", 4200);
    const client = new FakeLabelClient(["enhancement"]);
    const lines = scanLifecycleWorkClaims(root, { client });
    expect(lines.join("\n")).toContain("none tagged");
  });

  it("session-start scan ignores proposed origins", () => {
    const root = tempRoot();
    writeOriginBrief(root, "proposed", 4200);
    const client = new FakeLabelClient([WORK_CLAIM_LABEL]);
    expect(scanLifecycleWorkClaims(root, { client })).toEqual([]);
    expect(client.fetchCalls).toBe(0);
  });

  it("scanWorkClaimForBriefPath warns on the origin without failing", () => {
    const root = tempRoot();
    const path = writeOriginBrief(root, "active", 4200);
    const client = new FakeLabelClient([WORK_CLAIM_LABEL, "status:child"]);
    const lines = scanWorkClaimForBriefPath(path, { client });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Warn is success");
  });

  it("workClaimSessionScanLines fail-open on throw", () => {
    const lines = workClaimSessionScanLines("/nope", () => {
      throw new Error("network down");
    });
    expect(lines.join("\n")).toContain("scan failed");
    expect(lines.join("\n")).toContain("Warn is success");
  });

  it("releaseWorkClaimForBrief removes the tag when occupancy is live", () => {
    const root = tempRoot();
    const path = writeOriginBrief(root, "active", 4200);
    const client = new FakeLabelClient([WORK_CLAIM_LABEL]);
    const outcome = releaseWorkClaimForBrief(path, {
      client,
      occupancyLive: () => true,
      cwd: root,
    });
    expect(outcome.released).toBe(true);
    expect(client.labels).not.toContain(WORK_CLAIM_LABEL);
  });
});

describe("session:start scan", () => {
  it("prints injected work-claim warnings and still exits 0", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      writeHistory: false,
      now: new Date("2026-09-06T12:00:00Z"),
      env: {},
      newSessionId: () => "work-claim-sess",
      runGit: () => ({ code: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stderr: "" }),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      scanWorkClaims: () => [
        "[deft work-claim] warning: deftai/directive#4200 carries status:claimed (busy). Warn is success; this is not a GitHub lock.",
      ],
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("status:claimed");
    expect(result.lines.join("\n")).toContain("Warn is success");
  });
});

describe("catalog pin", () => {
  it("names status:claimed in the maintainer label catalog", () => {
    const catalog = readFileSync(".github/ISSUE_LABELS.md", "utf8");
    expect(catalog).toContain("`status:claimed`");
    expect(catalog).toContain("work-claim");
  });
});
