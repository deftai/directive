import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { approach1RemediationForUnarmedPrs } from "./approach1-babysitter.js";
import {
  cohortInventorySatisfiedByReviewClean,
  extractRepoScopedPullNumber,
  hasMergePathExplicitFinishAttestation,
  parsePrsCsv,
  prsFromLaunchManifest,
  resolveCohortPrSet,
  verifyCohortReviewMonitors,
  writeMergePathExplicitFinishAttestation,
} from "./cohort-review-monitors.js";
import {
  parseCohortReviewMonitorsArgv,
  verifyCohortReviewMonitorsMain,
} from "./cohort-review-monitors-cli.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "cohort-rm-"));
}

describe("parsePrsCsv", () => {
  it("rejects empty and malformed", () => {
    expect(parsePrsCsv("").ok).toBe(false);
    expect(parsePrsCsv(null).ok).toBe(false);
    expect(parsePrsCsv("1,x,2").ok).toBe(false);
  });

  it("parses csv and dedupes", () => {
    const parsed = parsePrsCsv("10, 20,10");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.prs).toEqual([10, 20]);
  });
});

describe("resolveCohortPrSet", () => {
  it("unions operator with resolver and reports shrink attempt", () => {
    const resolved = resolveCohortPrSet({
      operatorPrs: [1],
      launchManifestPrs: [1, 2],
      openTrackingPrs: [3],
    });
    expect(resolved.prs).toEqual([1, 2, 3]);
    expect(resolved.expandedFromResolver).toBe(true);
    expect(resolved.omittedFromOperator).toEqual([2, 3]);
  });
});

describe("verifyCohortReviewMonitors (#5318)", () => {
  it("exit 2 on empty/malformed --prs", () => {
    const root = tempRoot();
    expect(verifyCohortReviewMonitors({ projectRoot: root, prsCsv: "" }).exitCode).toBe(2);
    expect(verifyCohortReviewMonitors({ projectRoot: root, prsCsv: "nope" }).exitCode).toBe(2);
  });

  it("N=2 with only one armed-live → exit 1; arming second → exit 0", () => {
    const root = tempRoot();
    const oneArmed = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [101, 102],
      liveArmByPr: { 101: true, 102: false },
      explicitFinishByPr: { 101: false, 102: false },
    });
    expect(oneArmed.exitCode).toBe(1);
    expect(oneArmed.unarmed).toEqual([102]);
    expect(oneArmed.stderr).toMatch(/COHORT UNARMED/);
    expect(oneArmed.stderr).toMatch(/Approach 1/);

    const both = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [101, 102],
      liveArmByPr: { 101: true, 102: true },
      explicitFinishByPr: { 101: false, 102: false },
    });
    expect(both.exitCode).toBe(0);
    expect(both.unarmed).toEqual([]);
    expect(both.stdout).toMatch(/COHORT ARMED/);
  });

  it("halted-explicit requires durable attestation; prose-only dual-stop stays unarmed", () => {
    const root = tempRoot();
    const proseOnly = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [201],
      liveArmByPr: { 201: false },
      explicitFinishByPr: { 201: false },
    });
    expect(proseOnly.exitCode).toBe(1);
    expect(proseOnly.classifications[0]?.classification).toBe("unarmed");

    const written = writeMergePathExplicitFinishAttestation(root, 202, {
      reason: "option-C BLOCKED",
    });
    expect(written.ok).toBe(true);
    expect(hasMergePathExplicitFinishAttestation(root, 202)).toBe(true);

    const halted = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [202],
      liveArmByPr: { 202: false },
    });
    expect(halted.exitCode).toBe(0);
    expect(halted.classifications[0]?.classification).toBe("halted-explicit");
  });

  it("does not silently shrink below launch-manifest ∪ open Tracking", () => {
    const root = tempRoot();
    const result = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [1],
      launchManifestPrs: [1, 2],
      openTrackingPrs: [3],
      liveArmByPr: { 1: true, 2: true, 3: true },
      explicitFinishByPr: { 1: false, 2: false, 3: false },
    });
    expect(result.prs).toEqual([1, 2, 3]);
    expect(result.expandedFromResolver).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("anti-substitute: CLEAN cohort verifier does not satisfy inventory", () => {
    expect(cohortInventorySatisfiedByReviewClean()).toBe(false);
    const root = tempRoot();
    const inventoryRed = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [7, 8],
      liveArmByPr: { 7: true, 8: false },
      explicitFinishByPr: { 7: false, 8: false },
      emitJson: true,
    });
    expect(inventoryRed.exitCode).toBe(1);
    const payload = JSON.parse(inventoryRed.stdout) as {
      anti_substitute: { swarm_verify_review_clean_satisfies_inventory: boolean };
    };
    expect(payload.anti_substitute.swarm_verify_review_clean_satisfies_inventory).toBe(false);
  });

  it("reads PR refs from launch-manifest xbriefs", () => {
    const root = tempRoot();
    const briefDir = join(root, "xbrief", "active");
    mkdirSync(briefDir, { recursive: true });
    const briefPath = join(briefDir, "story.xbrief.json");
    writeFileSync(
      briefPath,
      JSON.stringify({
        plan: {
          references: [
            { uri: "https://github.com/deftai/directive/pull/4242", type: "x-xbrief/github-pr" },
          ],
        },
      }),
      "utf8",
    );
    const deft = join(root, ".deft");
    mkdirSync(deft, { recursive: true });
    writeFileSync(
      join(deft, "swarm-launch-manifest.json"),
      JSON.stringify([{ story_id: "s1", vbrief_path: "xbrief/active/story.xbrief.json" }]),
      "utf8",
    );
    const result = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [],
      liveArmByPr: { 4242: true },
      explicitFinishByPr: { 4242: false },
    });
    expect(result.prs).toEqual([4242]);
    expect(result.exitCode).toBe(0);
  });

  it("omitted --prs uses launch-manifest resolver (not exit 2 when set non-empty)", () => {
    const root = tempRoot();
    const briefDir = join(root, "xbrief", "active");
    mkdirSync(briefDir, { recursive: true });
    const briefPath = join(briefDir, "story.xbrief.json");
    writeFileSync(
      briefPath,
      JSON.stringify({
        plan: {
          references: [
            { uri: "https://github.com/deftai/directive/pull/4242", type: "x-xbrief/github-pr" },
          ],
        },
      }),
      "utf8",
    );
    const deft = join(root, ".deft");
    mkdirSync(deft, { recursive: true });
    writeFileSync(
      join(deft, "swarm-launch-manifest.json"),
      JSON.stringify([{ story_id: "s1", vbrief_path: "xbrief/active/story.xbrief.json" }]),
      "utf8",
    );
    const result = verifyCohortReviewMonitors({
      projectRoot: root,
      liveArmByPr: { 4242: true },
      explicitFinishByPr: { 4242: false },
      openTrackingPrs: [],
      openPrNumbers: new Set([4242]),
      expectedRepo: "deftai/directive",
    });
    expect(result.prs).toEqual([4242]);
    expect(result.exitCode).toBe(0);
  });

  it("partial launch-manifest (brief without PR refs) fails closed", () => {
    const root = tempRoot();
    const briefDir = join(root, "xbrief", "active");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(
      join(briefDir, "no-pr.xbrief.json"),
      JSON.stringify({ plan: { references: [] } }),
      "utf8",
    );
    const deft = join(root, ".deft");
    mkdirSync(deft, { recursive: true });
    writeFileSync(
      join(deft, "swarm-launch-manifest.json"),
      JSON.stringify([{ story_id: "s1", vbrief_path: "xbrief/active/no-pr.xbrief.json" }]),
      "utf8",
    );
    const fromManifest = prsFromLaunchManifest(root);
    expect(fromManifest.ok).toBe(false);
    const result = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [],
      openTrackingPrs: [],
      openPrNumbers: new Set(),
    });
    expect(result.exitCode).toBe(2);
  });

  it("omitted openTrackingPrs soft-discovers active brief PR refs", () => {
    const root = tempRoot();
    const briefDir = join(root, "xbrief", "active");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(
      join(briefDir, "sib.xbrief.json"),
      JSON.stringify({
        plan: {
          references: [
            { uri: "https://github.com/deftai/directive/pull/7777", type: "x-xbrief/github-pr" },
          ],
        },
      }),
      "utf8",
    );
    const result = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [1],
      launchManifestPrs: [1],
      openPrNumbers: new Set([7777]),
      expectedRepo: "deftai/directive",
      liveArmByPr: { 1: true, 7777: true },
      explicitFinishByPr: { 1: false, 7777: false },
    });
    expect(result.prs).toEqual([1, 7777]);
    expect(result.exitCode).toBe(0);
  });

  it("supplied openTrackingPrs still unions active-brief discovery", () => {
    const root = tempRoot();
    const briefDir = join(root, "xbrief", "active");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(
      join(briefDir, "sib.xbrief.json"),
      JSON.stringify({
        plan: {
          references: [
            { uri: "https://github.com/deftai/directive/pull/8888", type: "x-xbrief/github-pr" },
          ],
        },
      }),
      "utf8",
    );
    const result = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [1],
      launchManifestPrs: [1],
      openTrackingPrs: [3],
      openPrNumbers: new Set([8888]),
      expectedRepo: "deftai/directive",
      liveArmByPr: { 1: true, 3: true, 8888: true },
      explicitFinishByPr: { 1: false, 3: false, 8888: false },
    });
    expect(result.prs).toEqual([1, 3, 8888]);
    expect(result.exitCode).toBe(0);
  });

  it("closed / filtered active-brief PRs do not enter inventory", () => {
    const root = tempRoot();
    const briefDir = join(root, "xbrief", "active");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(
      join(briefDir, "closed.xbrief.json"),
      JSON.stringify({
        plan: {
          references: [
            { uri: "https://github.com/deftai/directive/pull/9999", type: "x-xbrief/github-pr" },
          ],
        },
      }),
      "utf8",
    );
    const result = verifyCohortReviewMonitors({
      projectRoot: root,
      operatorPrs: [1],
      launchManifestPrs: [1],
      openTrackingPrs: [],
      openPrNumbers: new Set(),
      expectedRepo: "deftai/directive",
      liveArmByPr: { 1: true },
      explicitFinishByPr: { 1: false },
    });
    expect(result.prs).toEqual([1]);
    expect(result.exitCode).toBe(0);
  });
});

describe("extractRepoScopedPullNumber", () => {
  it("accepts github.com and host-matched enterprise paths for the expected repo", () => {
    expect(
      extractRepoScopedPullNumber(
        "https://github.com/deftai/directive/pull/12",
        "deftai/directive",
      ),
    ).toBe(12);
    expect(
      extractRepoScopedPullNumber(
        "https://ghe.example.com/deftai/directive/pull/34",
        "deftai/directive",
        "ghe.example.com",
      ),
    ).toBe(34);
    expect(
      extractRepoScopedPullNumber("https://github.com/other/other/pull/56", "deftai/directive"),
    ).toBeNull();
    // Foreign GHE with same owner/repo must not enter local inventory without host match.
    expect(
      extractRepoScopedPullNumber(
        "https://other-ghe.example.com/deftai/directive/pull/78",
        "deftai/directive",
        "ghe.example.com",
      ),
    ).toBeNull();
    expect(
      extractRepoScopedPullNumber(
        "https://ghe.example.com/deftai/directive/pull/90",
        "deftai/directive",
        null,
      ),
    ).toBeNull();
  });
});

describe("CLI argv + remediation", () => {
  it("parse help and --prs=", () => {
    expect(parseCohortReviewMonitorsArgv(["--help"]).help).toBe(true);
    expect(parseCohortReviewMonitorsArgv(["--prs=9,10"]).prsCsv).toBe("9,10");
  });

  it("main exit 2 without --prs", () => {
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(verifyCohortReviewMonitorsMain([])).toBe(2);
    spy.mockRestore();
    expect(err.join("")).toMatch(/empty|--prs|Error/i);
  });

  it("approach1 remediation lists register+watch+verify per PR", () => {
    const cmds = approach1RemediationForUnarmedPrs([11, 12]);
    expect(cmds.length).toBe(6);
    expect(cmds[0]).toContain("review-monitor:register");
    expect(cmds[2]).toContain("verify:review-monitor");
  });
});
