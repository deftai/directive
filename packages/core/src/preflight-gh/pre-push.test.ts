import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBackedPrePrStore } from "../pre-pr-controller/store.js";
import { PRE_PR_EXECUTION_SCHEMA, PRE_PR_PUSH_STAGE_MARKER } from "../pre-pr-controller/types.js";
import { DEFAULT_BRANCHES, ENV_BYPASS } from "./classifier.js";
import {
  computeCommittedObservedHash,
  evaluateEnrolledBoundPrePrPush,
  evaluatePrePush,
  outgoingChangedPaths,
  parsePrePushStdin,
} from "./pre-push.js";

const ZERO = "0000000000000000000000000000000000000000";
const LIVE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function writePd(root: string, policy: Record<string, unknown>): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "t", status: "running", "x-directive/policy": policy },
    }),
    "utf8",
  );
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "deft-prepush-"));
}

function createMasterLine(remote = "master"): string {
  return `refs/heads/${remote} ${LIVE} refs/heads/${remote} ${ZERO}`;
}

describe("parsePrePushStdin", () => {
  it("parses four-field ref lines and skips junk", () => {
    const refs = parsePrePushStdin(`${createMasterLine()}\nnot-a-ref\n`);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.remoteRef).toBe("refs/heads/master");
    expect(refs[0]?.remoteOid).toBe(ZERO);
  });

  it("treats empty stdin as no refs", () => {
    expect(parsePrePushStdin("")).toEqual([]);
  });
});

describe("evaluatePrePush enrolled bound pre-PR (#5804)", () => {
  it("denies empty stdin when enrolled", () => {
    const [code, msg] = evaluatePrePush([], {
      enrolledBoundPrePr: true,
      rawStdin: "",
      projectRoot: tempRoot(),
    });
    expect(code).toBe(1);
    expect(msg).toContain("empty or malformed");
  });

  it("denies junk-only stdin when enrolled", () => {
    const [code, msg] = evaluatePrePush([], {
      enrolledBoundPrePr: true,
      rawStdin: "not-a-ref-line\n",
      projectRoot: tempRoot(),
    });
    expect(code).toBe(1);
    expect(msg.toLowerCase()).toMatch(/empty or malformed|no parseable/);
  });

  it("docs-only helper admits markdown paths", async () => {
    const { isDocsOnlyOutgoing } = await import("./pre-push.js");
    expect(isDocsOnlyOutgoing(["docs/a.md", "CHANGELOG.md"])).toBe(true);
    expect(isDocsOnlyOutgoing(["packages/core/src/x.ts"])).toBe(false);
  });

  it("docs-only helper refuses executable docs paths (#5804 Greptile)", async () => {
    const { isDocsOnlyOutgoing, isDocsOnlyPath } = await import("./pre-push.js");
    expect(isDocsOnlyPath("docs/conf.py")).toBe(false);
    expect(isDocsOnlyOutgoing(["docs/conf.py"])).toBe(false);
    expect(isDocsOnlyOutgoing(["docs/guide.md", "content/docs/a.md"])).toBe(true);
  });

  it("honors requireBoundPrePrPush:false over enrolled hook default (#5804)", () => {
    const r = tempRoot();
    writePd(r, { requireBoundPrePrPush: false });
    const refs = parsePrePushStdin(
      `refs/heads/feat/core-engine ${LIVE} refs/heads/feat/core-engine ${ZERO}`,
    );
    const [code] = evaluatePrePush(refs, {
      enrolledBoundPrePr: true,
      projectRoot: r,
      rawStdin: `refs/heads/feat/core-engine ${LIVE} refs/heads/feat/core-engine ${ZERO}\n`,
    });
    expect(code).toBe(0);
  });
});

describe("evaluatePrePush stdin policy fixtures", () => {
  it("allows empty stdin", () => {
    const [code, msg] = evaluatePrePush([]);
    expect(code).toBe(0);
    expect(msg).toContain("no refs");
  });

  it("refuses create of master and names the policy verb", () => {
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs);
    expect(code).toBe(1);
    expect(msg).toContain("create master");
    expect(msg).toContain("deft policy:allow-destructive-gh-verbs -- --confirm");
    expect(msg).toContain(`${ENV_BYPASS}=1`);
  });

  it("refuses create of main", () => {
    const refs = parsePrePushStdin(createMasterLine("main"));
    const [code, msg] = evaluatePrePush(refs);
    expect(code).toBe(1);
    expect(msg).toContain("create main");
  });

  it("does not treat zero-OID create of master as empty-remote relief", () => {
    const r = tempRoot();
    writePd(r, {});
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code] = evaluatePrePush(refs, { projectRoot: r });
    expect(code).toBe(1);
  });

  it("refuses update and delete of default branches", () => {
    const update = parsePrePushStdin(`refs/heads/master ${LIVE} refs/heads/master ${LIVE}`);
    const del = parsePrePushStdin(`refs/heads/master ${ZERO} refs/heads/master ${LIVE}`);
    expect(evaluatePrePush(update)[0]).toBe(1);
    expect(evaluatePrePush(update)[1]).toContain("update master");
    expect(evaluatePrePush(del)[0]).toBe(1);
    expect(evaluatePrePush(del)[1]).toContain("delete master");
  });

  it("allows create of a feature branch", () => {
    const refs = parsePrePushStdin(
      `refs/heads/feat/core-engine ${LIVE} refs/heads/feat/core-engine ${ZERO}`,
    );
    const [code] = evaluatePrePush(refs);
    expect(code).toBe(0);
  });

  it("consults allowDestructiveGhVerbs through projectRoot", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: true });
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs, { projectRoot: r });
    expect(code).toBe(0);
    expect(msg).toContain("allowDestructiveGhVerbs=true");
  });

  it("still refuses when projectRoot policy is false", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: false });
    const refs = parsePrePushStdin(createMasterLine("master"));
    expect(evaluatePrePush(refs, { projectRoot: r })[0]).toBe(1);
  });

  it("env-var override allows create without the typed flag", () => {
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs, { env: { [ENV_BYPASS]: "1" } });
    expect(code).toBe(0);
    expect(msg).toContain("policy bypassed for this invocation");
  });

  it("fail-closes a missing PROJECT-DEFINITION with exit 2", () => {
    const r = tempRoot();
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs, { projectRoot: r });
    expect(code).toBe(2);
    expect(msg).toContain("cannot be resolved");
    expect(msg).toContain("not found");
  });

  it("fail-closes a non-object plan with exit 2", () => {
    const r = tempRoot();
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: [] }),
      "utf8",
    );
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs, { projectRoot: r });
    expect(code).toBe(2);
    expect(msg).toContain("'plan' is not an object");
  });

  it("fail-closes malformed typed policy with exit 2", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: "yes" });
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs, { projectRoot: r });
    expect(code).toBe(2);
    expect(msg).toContain("must be a boolean");
  });

  it("mixed default-branch refs stay refused", () => {
    const text = [
      createMasterLine("master"),
      `refs/heads/main ${LIVE} refs/heads/main ${LIVE}`,
    ].join("\n");
    const [code, msg] = evaluatePrePush(parsePrePushStdin(text));
    expect(code).toBe(1);
    expect(msg).toContain("create master");
    expect(msg).toContain("update main");
  });

  it("refuses stdin push to develop when typed deliveryBranch=develop (#5520)", () => {
    const r = tempRoot();
    writePd(r, { deliveryBranch: "develop", allowDestructiveGhVerbs: false });
    const refs = parsePrePushStdin(`refs/heads/feat/x ${LIVE} refs/heads/develop ${LIVE}`);
    const [code, msg] = evaluatePrePush(refs, {
      projectRoot: r,
      branches: new Set(DEFAULT_BRANCHES),
    });
    expect(code).toBe(1);
    expect(msg).toContain("update develop");
  });

  it("allows develop push when policy omits deliveryBranch (#5520)", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: false });
    const refs = parsePrePushStdin(`refs/heads/feat/x ${LIVE} refs/heads/develop ${LIVE}`);
    expect(evaluatePrePush(refs, { projectRoot: r })[0]).toBe(0);
  });

  it("skips hostile typed deliveryBranch for pre-push (#5520)", () => {
    const r = tempRoot();
    writePd(r, { deliveryBranch: "--upload-pack=evil", allowDestructiveGhVerbs: false });
    const refs = parsePrePushStdin(
      `refs/heads/feat/x ${LIVE} refs/heads/--upload-pack=evil ${LIVE}`,
    );
    expect(evaluatePrePush(refs, { projectRoot: r })[0]).toBe(0);
  });

  it("preserves --default-branch additions with typed delivery (#5520)", () => {
    const r = tempRoot();
    writePd(r, { deliveryBranch: "develop", allowDestructiveGhVerbs: false });
    const trunk = parsePrePushStdin(`refs/heads/feat/x ${LIVE} refs/heads/trunk ${LIVE}`);
    expect(
      evaluatePrePush(trunk, {
        projectRoot: r,
        branches: new Set([...DEFAULT_BRANCHES, "trunk"]),
      })[0],
    ).toBe(1);
  });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFileAt(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
}

/**
 * Bare origin + clone with master tip, then feature branch + delivery advance.
 * Models the #6172 rebase/merge case: remoteOid..localOid invents delivery-only paths.
 */
function fixtureRebaseFromDelivery(opts?: {
  readonly mergeInsteadOfRebase?: boolean;
  readonly withDeletion?: boolean;
}): {
  readonly root: string;
  readonly remoteOid: string;
  readonly localOid: string;
  readonly deliveryOnly: string;
  readonly featurePath: string;
  readonly deletedPath: string | null;
} {
  const bare = mkdtempSync(join(tmpdir(), "deft-prepush-origin-"));
  const root = mkdtempSync(join(tmpdir(), "deft-prepush-work-"));
  git(bare, ["init", "--bare", "-b", "master"]);
  git(root, ["init", "-b", "master"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["remote", "add", "origin", bare]);
  writeFileAt(root, "README.md", "base\n");
  writeFileAt(root, "shared/keep.ts", "export const keep = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["push", "-u", "origin", "master"]);

  git(root, ["checkout", "-b", "feat/a"]);
  writeFileAt(root, "src/a.ts", "export const a = 1;\n");
  const deletedPath = opts?.withDeletion === true ? "shared/keep.ts" : null;
  if (deletedPath !== null) {
    rmSync(join(root, deletedPath));
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "feat a"]);
  git(root, ["push", "-u", "origin", "feat/a"]);
  const remoteOid = git(root, ["rev-parse", "refs/remotes/origin/feat/a"]);

  git(root, ["checkout", "master"]);
  writeFileAt(root, "src/b.ts", "export const b = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "delivery only"]);
  git(root, ["push", "origin", "master"]);

  git(root, ["checkout", "feat/a"]);
  if (opts?.mergeInsteadOfRebase === true) {
    git(root, ["merge", "--no-edit", "origin/master"]);
  } else {
    git(root, ["rebase", "origin/master"]);
  }
  const localOid = git(root, ["rev-parse", "HEAD"]);
  writePd(root, {});
  return {
    root,
    remoteOid,
    localOid,
    deliveryOnly: "src/b.ts",
    featurePath: "src/a.ts",
    deletedPath,
  };
}

describe("outgoingChangedPaths merge-base delivery (#6172)", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) {
      try {
        rmSync(t, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("after rebase from delivery, omits delivery-only paths that remoteOid..localOid invents", () => {
    const fx = fixtureRebaseFromDelivery();
    temps.push(fx.root);
    const remoteTipDiff = git(fx.root, ["diff", "--name-only", `${fx.remoteOid}..${fx.localOid}`])
      .split("\n")
      .filter((p) => p.length > 0);
    expect(remoteTipDiff).toContain(fx.deliveryOnly);

    const listed = outgoingChangedPaths(fx.root, fx.remoteOid, fx.localOid);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.paths).toContain(fx.featurePath);
    expect(listed.paths).not.toContain(fx.deliveryOnly);
  });

  it("after merge from delivery, still uses merge-base and omits delivery-only paths", () => {
    const fx = fixtureRebaseFromDelivery({ mergeInsteadOfRebase: true });
    temps.push(fx.root);
    const listed = outgoingChangedPaths(fx.root, fx.remoteOid, fx.localOid);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.paths).toContain(fx.featurePath);
    expect(listed.paths).not.toContain(fx.deliveryOnly);
  });

  it("keeps feature deletions in the merge-base outgoing set", () => {
    const fx = fixtureRebaseFromDelivery({ withDeletion: true });
    temps.push(fx.root);
    const listed = outgoingChangedPaths(fx.root, fx.remoteOid, fx.localOid);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.paths).toContain(fx.featurePath);
    expect(listed.paths).toContain("shared/keep.ts");
    expect(listed.paths).not.toContain(fx.deliveryOnly);
  });

  it("refuses when origin/<delivery> tip is missing (no unrelated local master fallback)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-prepush-nodelivery-"));
    temps.push(root);
    git(root, ["init", "-b", "master"]);
    git(root, ["config", "user.email", "t@t.dev"]);
    git(root, ["config", "user.name", "t"]);
    writeFileAt(root, "a.ts", "1\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "local"]);
    const localOid = git(root, ["rev-parse", "HEAD"]);
    writePd(root, { deliveryBranch: "master" });
    // Local master exists; refs/remotes/origin/master does not.
    const listed = outgoingChangedPaths(root, ZERO, localOid);
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error).toMatch(/merge-base|refs\/remotes\/origin\/master/i);
  });

  it("refuses hostile typed deliveryBranch with empty resolved name", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-prepush-hostile-"));
    temps.push(root);
    git(root, ["init", "-b", "master"]);
    git(root, ["config", "user.email", "t@t.dev"]);
    git(root, ["config", "user.name", "t"]);
    writeFileAt(root, "a.ts", "1\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "local"]);
    const localOid = git(root, ["rev-parse", "HEAD"]);
    writePd(root, { deliveryBranch: "--upload-pack=evil" });
    const listed = outgoingChangedPaths(root, ZERO, localOid);
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error).toMatch(/delivery branch/i);
  });

  it("zero local OID returns empty paths", () => {
    const root = tempRoot();
    temps.push(root);
    expect(outgoingChangedPaths(root, LIVE, ZERO)).toEqual({ ok: true, paths: [] });
  });

  it("enrolled push admits rebase tip when pushBinding covers PR-vs-delivery paths only (#6172)", () => {
    const fx = fixtureRebaseFromDelivery({ withDeletion: true });
    temps.push(fx.root);
    const reviewed = [fx.featurePath];
    const deleted = fx.deletedPath !== null ? [fx.deletedPath] : [];
    const observed = computeCommittedObservedHash(fx.root, fx.localOid, reviewed);
    expect(observed).not.toBeNull();

    const store = new FileBackedPrePrStore(fx.root);
    const now = "2026-11-10T12:00:00.000Z";
    store.put({
      schema: PRE_PR_EXECUTION_SCHEMA,
      id: "ppr_6172_rebase",
      state: "complete",
      outcome: "pass",
      repo: "deftai/directive",
      baseSha: "base",
      headSha: fx.localOid,
      treeHash: "tree",
      inputHash: "input",
      prNodeId: null,
      prBodyHash: "body",
      criteria: {
        digest: "crit",
        generation: 1,
        sourceRevisionSha: "base",
        scopeDigest: "scope",
        acceptanceDigest: "ac",
      },
      skillVersion: "0",
      policyVersion: "0",
      controllerVersion: "0",
      workflowVersion: "0",
      approvedRevisionSha: "base",
      evaluationGeneration: 1,
      phaseEvidence: { commands: [], semantic: [] },
      reviewedFileManifest: reviewed,
      reviewReportRef: "r",
      finalNoChange: false,
      pushBinding: {
        reviewedFileManifest: reviewed,
        controllerObservedHash: observed as string,
        pushStageMarker: PRE_PR_PUSH_STAGE_MARKER,
        reviewedDeletedPaths: deleted,
      },
      startedAt: now,
      completedAt: now,
      interruptedAt: null,
      failedAt: null,
      publishedAt: now,
    });

    const [code, msg] = evaluateEnrolledBoundPrePrPush(
      [
        {
          localRef: "refs/heads/feat/a",
          localOid: fx.localOid,
          remoteRef: "refs/heads/feat/a",
          remoteOid: fx.remoteOid,
        },
      ],
      { projectRoot: fx.root },
    );
    expect(code).toBe(0);
    expect(msg).toMatch(/outgoing ⊆ reviewed pushBinding/i);
  });
});
