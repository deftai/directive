import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  classifyStoredDeliveryDisposition,
  evaluateDeliveryGate,
  isCodeBearingScope,
  NON_DELIVERY_DISPOSITIONS,
  resolveCompletionSessionId,
} from "./delivery-evidence.js";
import { runTransition } from "./transition.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "delivery-ev-"));
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "P",
        status: "running",
        policy: { deliveryBranch: "master", wipCap: 20 },
      },
    }),
    "utf8",
  );
  return root;
}

function writeCodeBearing(root: string, name = "story.xbrief.json"): string {
  const path = join(root, "xbrief", "active", name);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "code story",
        status: "running",
        references: [
          {
            uri: "https://github.com/deftai/directive/issues/3041",
            type: "x-xbrief/github-issue",
          },
        ],
        metadata: {
          kind: "story",
          swarm: { file_scope: ["packages/core/src/scope/transition.ts"] },
        },
        // Empty items: delivery gate isolation; acceptance evidence is #3240.
        items: [],
      },
    }),
    "utf8",
  );
  return path;
}

function gitOk(opts?: { fetchFail?: boolean; notAncestor?: boolean; tip?: string }): GitRunner {
  return (_root, args) => {
    const joined = args.join(" ");
    if (joined.startsWith("fetch ") && opts?.fetchFail) {
      return { code: 1, stdout: "", stderr: "could not resolve host" };
    }
    if (joined.includes("merge-base") && joined.includes("--is-ancestor")) {
      return { code: opts?.notAncestor ? 1 : 0, stdout: "", stderr: "" };
    }
    if (joined.includes("rev-parse") && joined.includes("origin/")) {
      return { code: 0, stdout: opts?.tip ?? "deliverytipsha", stderr: "" };
    }
    if (joined.includes("symbolic-ref")) {
      return { code: 0, stdout: "origin/master", stderr: "" };
    }
    if (joined.includes("show-ref")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

describe("delivery evidence (#3041)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("classifies code-bearing scopes via issue ref / file_scope", () => {
    expect(
      isCodeBearingScope({
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      }),
    ).toBe(true);
    expect(
      isCodeBearingScope({
        metadata: { swarm: { file_scope: ["a.ts"] } },
      }),
    ).toBe(true);
    expect(isCodeBearingScope({ title: "minimal" })).toBe(false);
    expect(
      isCodeBearingScope({
        tags: ["docs-only"],
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      }),
    ).toBe(false);
  });

  it("legacy completed records without provenance are unverified", () => {
    expect(
      classifyStoredDeliveryDisposition({ metadata: { completedAt: "2026-01-01T00:00:00Z" } }),
    ).toBe("unverified");
    expect(classifyStoredDeliveryDisposition({})).toBe("unknown");
    expect(
      classifyStoredDeliveryDisposition({
        metadata: {
          completionProvenance: { disposition: "delivered", handoffState: "delivered" },
        },
      }),
    ).toBe("delivered");
  });

  it("fails closed on code-bearing complete without evidence", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const result = runTransition("complete", file, new Date(), { runGit: gitOk() });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Delivery evidence required|#3041/);
    expect(result.message).toMatch(/--merge-commit/);
    expect(result.message).toMatch(/policy:show --field=deliveryBranch/);
    expect(result.message).toMatch(/Do not use --non-delivery for work that shipped/);
    expect(readFileSync(file, "utf8")).toContain("running");
  });

  it("accepts explicit non-delivery disposition", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      nonDeliveryDisposition: "accepted_not_delivered",
      runGit: gitOk(),
    });
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: {
        metadata: {
          completionProvenance: { disposition: string; handoffState: string; deployed: null };
        };
      };
    };
    expect(data.plan.metadata.completionProvenance.disposition).toBe("accepted_not_delivered");
    expect(data.plan.metadata.completionProvenance.deployed).toBeNull();
    expect(NON_DELIVERY_DISPOSITIONS).toContain("accepted_not_delivered");
  });

  it("accepts direct delivery merge with ancestry", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      deliveryEvidence: {
        repository: "deftai/directive",
        prNumber: 42,
        prBase: "master",
        mergeCommit: "mergecommitsha",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
    });
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: {
        metadata: {
          completionProvenance: {
            disposition: string;
            handoffState: string;
            mergeCommit: string;
            deliveryBranch: string;
            uatVerified: null;
          };
        };
      };
    };
    expect(data.plan.metadata.completionProvenance.disposition).toBe("delivered");
    expect(data.plan.metadata.completionProvenance.handoffState).toBe("delivered");
    expect(data.plan.metadata.completionProvenance.mergeCommit).toBe("mergecommitsha");
    expect(data.plan.metadata.completionProvenance.deliveryBranch).toBe("master");
    expect(data.plan.metadata.completionProvenance.uatVerified).toBeNull();
  });

  it("treats intermediate-branch PR base as delivered when ancestry passes (#3380)", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      deliveryEvidence: {
        prNumber: 7,
        prBase: "feature/integration",
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
    });
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: {
        metadata: {
          completionProvenance: {
            disposition: string;
            handoffState: string;
            prBase: string;
          };
        };
      };
    };
    expect(data.plan.metadata.completionProvenance.disposition).toBe("delivered");
    expect(data.plan.metadata.completionProvenance.handoffState).toBe("delivered");
    expect(data.plan.metadata.completionProvenance.prBase).toBe("feature/integration");
  });

  it("records merged_to_integration when intermediate PR base fails ancestry (#3380)", () => {
    root = makeRepo();
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 7,
        prBase: "develop",
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      runGit: gitOk({ notAncestor: true }),
    });
    expect(gate.ok).toBe(false);
    expect(gate.provenance?.disposition).toBe("merged_to_integration");
    expect(gate.provenance?.handoffState).toBe("merged_to_integration");
    expect(gate.provenance?.prBase).toBe("develop");
    expect(gate.message).toMatch(/--merge-commit/);
    expect(gate.message).toMatch(/policy:show --field=deliveryBranch/);
    expect(gate.message).not.toMatch(/never shipped|did not ship|work never/i);
  });

  it("rejects when remote refresh fails", () => {
    root = makeRepo();
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prBase: "master",
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      runGit: gitOk({ fetchFail: true }),
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/fetch|resolve host|failed/i);
  });

  it("rejects when merge commit is not an ancestor of delivery ref", () => {
    root = makeRepo();
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prBase: "master",
        mergeCommit: "stranded",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      runGit: gitOk({ notAncestor: true }),
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/not an ancestor|delivery/i);
    expect(gate.message).toMatch(/--merge-commit/);
    expect(gate.provenance?.disposition).toBe("not_delivered");
  });

  it("resolveCompletionSessionId prefers DEFT_SESSION_ID then ritual-state (#3357)", () => {
    root = makeRepo();
    expect(resolveCompletionSessionId(root, { DEFT_SESSION_ID: "env-sess" })).toBe("env-sess");
    expect(resolveCompletionSessionId(root, {})).toBeNull();
  });

  it("stamps completedSessionId onto metadata on complete (#3357)", () => {
    root = makeRepo();
    const path = join(root, "xbrief", "active", "docs.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "docs", status: "running", items: [] },
      }),
      "utf8",
    );
    const prev = process.env.DEFT_SESSION_ID;
    process.env.DEFT_SESSION_ID = "stamp-sess-3357";
    try {
      const result = runTransition("complete", path);
      expect(result.ok).toBe(true);
      const dest = join(root, "xbrief", "completed", "docs.xbrief.json");
      const data = JSON.parse(readFileSync(dest, "utf8")) as {
        plan: { metadata: { completedSessionId?: string } };
      };
      expect(data.plan.metadata.completedSessionId).toBe("stamp-sess-3357");
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_SESSION_ID;
      } else {
        process.env.DEFT_SESSION_ID = prev;
      }
    }
  });

  it("allows non-code-bearing complete without evidence", () => {
    root = makeRepo();
    const path = join(root, "xbrief", "active", "docs.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "docs", status: "running", items: [] },
      }),
      "utf8",
    );
    const result = runTransition("complete", path);
    expect(result.ok).toBe(true);
  });

  it("honors delivery.required and kind/process-only carve-outs", () => {
    expect(
      isCodeBearingScope({
        metadata: { delivery: { required: true } },
      }),
    ).toBe(true);
    expect(
      isCodeBearingScope({
        metadata: { delivery: { required: false }, kind: "story" },
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      }),
    ).toBe(false);
    expect(isCodeBearingScope({ metadata: { kind: "docs" } })).toBe(false);
    expect(isCodeBearingScope({ metadata: { kind: "process" } })).toBe(false);
    expect(isCodeBearingScope({ metadata: { kind: "research" } })).toBe(false);
    expect(isCodeBearingScope({ tags: ["process-only"] })).toBe(false);
    expect(isCodeBearingScope({ tags: ["non-code"] })).toBe(false);
    expect(isCodeBearingScope({ tags: [1, "feature"] as unknown as string[] })).toBe(false);
  });

  it("rejects invalid non-delivery disposition and missing merge data", () => {
    root = makeRepo();
    const bad = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      // @ts-expect-error intentional invalid disposition
      nonDeliveryDisposition: "shipped_anyway",
      runGit: gitOk(),
    });
    expect(bad.ok).toBe(false);

    const missing = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: { prBase: "master", deliveryBranch: "master" },
      runGit: gitOk(),
    });
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/missing/i);
  });

  it("accepts assumeEvidenceValidated without remote ancestry", () => {
    root = makeRepo();
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prBase: "master",
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
        repository: "o/r",
        prNumber: 9,
      },
      assumeEvidenceValidated: true,
      runGit: gitOk({ fetchFail: true }),
    });
    expect(gate.ok).toBe(true);
    expect(gate.provenance?.disposition).toBe("delivered");
    expect(gate.provenance?.deployed).toBeNull();
  });

  it("evidenceFromPrPayload and refresh tip failures", async () => {
    root = makeRepo();
    const { evidenceFromPrPayload, refreshRemoteDeliveryRef, verifyDeliveryAncestry } =
      await import("./delivery-evidence.js");
    const evidence = evidenceFromPrPayload(
      {
        merged_at: "2026-08-02T11:00:00Z",
        base: { ref: "master" },
        head: { sha: "head1" },
        merge_commit_sha: "merge1",
      },
      5,
      "o/r",
      "master",
    );
    expect(evidence.prBase).toBe("master");
    expect(evidence.mergeCommit).toBe("merge1");
    expect(evidence.implementationCommit).toBe("head1");

    const nullMerged = evidenceFromPrPayload(
      { merged_at: null, base: {}, head: {}, merge_commit_sha: "" },
      6,
      null,
    );
    expect(nullMerged.mergedAt).toBeNull();
    expect(nullMerged.mergeCommit).toBeNull();

    const failTip: GitRunner = (_r, args) => {
      const j = args.join(" ");
      if (j.startsWith("fetch ")) return { code: 0, stdout: "", stderr: "" };
      if (j.includes("rev-parse")) return { code: 1, stdout: "", stderr: "missing" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const refresh = refreshRemoteDeliveryRef(root, "master", failTip);
    expect(refresh.ok).toBe(false);

    const ancestryTip = verifyDeliveryAncestry(root, "abc", "master", failTip);
    expect(ancestryTip.ok).toBe(false);

    const failAncestorLookup: GitRunner = (_r, args) => {
      const j = args.join(" ");
      if (j.startsWith("fetch ")) return { code: 0, stdout: "", stderr: "" };
      if (j.includes("rev-parse") && j.includes("origin/")) {
        return { code: 0, stdout: "tipsha", stderr: "" };
      }
      if (j.includes("merge-base")) return { code: 128, stdout: "", stderr: "fatal" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const anc = verifyDeliveryAncestry(root, "abc", "master", failAncestorLookup);
    expect(anc.ok).toBe(false);
    expect(anc.error).toBeTruthy();
  });
});
