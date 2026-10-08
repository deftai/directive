import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  assertSafeBranchName,
  DEFAULT_DELIVERY_BRANCH_FALLBACK,
  FIELD_DELIVERY_BRANCH,
  InvalidBranchNameError,
  isSafeBranchName,
  privateDestFetchArgv,
  resolveDeliveryBranch,
  resolveGitDefaultDeliveryBranch,
  trackingFetchArgv,
} from "./delivery-branch.js";

function makeProject(policy?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "delivery-branch-"));
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "P",
        status: "running",
        policy: policy ?? {},
      },
    }),
    "utf8",
  );
  return root;
}

describe("resolveDeliveryBranch (#3041)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("reads typed plan.policy.deliveryBranch", () => {
    root = makeProject({ deliveryBranch: "release", wipCap: 5 });
    const result = resolveDeliveryBranch(root, () => ({ code: 1, stdout: "", stderr: "" }));
    expect(result.branch).toBe("release");
    expect(result.source).toBe("typed");
    expect(result.error).toBeNull();
  });

  it("falls back to git default when policy omits deliveryBranch", () => {
    root = makeProject({ wipCap: 5 });
    const runGit: GitRunner = (_cwd, args) => {
      if (args[0] === "symbolic-ref" && args.includes("refs/remotes/origin/HEAD")) {
        return { code: 0, stdout: "origin/main", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = resolveDeliveryBranch(root, runGit);
    expect(result.branch).toBe("main");
    expect(result.source).toBe("git-default");
  });

  it("uses framework fallback when nothing resolves", () => {
    root = makeProject({});
    const result = resolveDeliveryBranch(root, () => ({ code: 1, stdout: "", stderr: "" }));
    expect(result.branch).toBe(DEFAULT_DELIVERY_BRANCH_FALLBACK);
    expect(result.source).toBe("default-fallback");
  });

  it("field constant is plan.policy.deliveryBranch", () => {
    expect(FIELD_DELIVERY_BRANCH).toBe("plan.policy.deliveryBranch");
  });

  it("git dest fallback prefers origin/main then master (#3388)", () => {
    root = makeProject({ deliveryBranch: "ignored-by-git-only" });
    const runGit: GitRunner = (_cwd, args) => {
      if (args.includes("refs/remotes/origin/main")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    expect(resolveGitDefaultDeliveryBranch(root, runGit)).toBe("main");
    expect(resolveGitDefaultDeliveryBranch(root, () => ({ code: 1, stdout: "", stderr: "" }))).toBe(
      DEFAULT_DELIVERY_BRANCH_FALLBACK,
    );
  });

  it("rejects empty typed deliveryBranch and falls back", () => {
    root = makeProject({ deliveryBranch: "   " });
    const result = resolveDeliveryBranch(root, () => ({ code: 1, stdout: "", stderr: "" }));
    expect(result.source).toBe("default-on-error");
    expect(result.error).toMatch(/non-empty string/);
  });

  it("rejects non-string typed deliveryBranch", () => {
    root = makeProject({ deliveryBranch: 12 as unknown as string });
    const result = resolveDeliveryBranch(root, () => ({ code: 1, stdout: "", stderr: "" }));
    expect(result.source).toBe("default-on-error");
  });

  it("handles missing project definition and non-object plan", () => {
    root = mkdtempSync(join(tmpdir(), "delivery-branch-none-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const missing = resolveDeliveryBranch(root, () => ({ code: 1, stdout: "", stderr: "" }));
    expect(missing.branch).toBe(DEFAULT_DELIVERY_BRANCH_FALLBACK);

    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: "nope" }),
      "utf8",
    );
    const badPlan = resolveDeliveryBranch(root, () => ({ code: 1, stdout: "", stderr: "" }));
    expect(badPlan.error).toMatch(/not an object/);
  });

  it("prefers origin main via show-ref when symbolic-ref fails", () => {
    root = makeProject({});
    const runGit: GitRunner = (_cwd, args) => {
      if (args[0] === "symbolic-ref") {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args.includes("refs/remotes/origin/main")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = resolveDeliveryBranch(root, runGit);
    expect(result.branch).toBe("main");
    expect(result.source).toBe("git-default");
  });

  it("inspectDeliveryBranch without projectRoot uses default", async () => {
    const { inspectDeliveryBranch } = await import("./delivery-branch.js");
    const field = inspectDeliveryBranch(null);
    expect(field.name).toBe(FIELD_DELIVERY_BRANCH);
    expect(field.current).toBe(DEFAULT_DELIVERY_BRANCH_FALLBACK);
    expect(field.source).toBe("default");
  });
});

describe("closed branch-name grammar (#5364 Prefer-A)", () => {
  it("accepts happy-path main/master/release/x", () => {
    for (const name of ["main", "master", "release/x"]) {
      expect(isSafeBranchName(name)).toBe(true);
      expect(assertSafeBranchName(name)).toEqual({ ok: true, branch: name });
    }
  });

  it("rejects upload-pack, colon rewrite, leading dash, .., @{}, wildcards, empty/whitespace, .lock", () => {
    const hostile = [
      "--upload-pack=evil",
      "refs/heads/attacker:refs/heads/master",
      "attacker:master",
      "-x",
      "--exec=evil",
      "foo..bar",
      "foo@{upstream}",
      "*",
      "release/*",
      "feat?",
      "br[a]",
      "",
      "   ",
      "has space",
      "ends.lock",
      "\u0001control",
    ];
    for (const name of hostile) {
      expect(isSafeBranchName(name)).toBe(false);
      const checked = assertSafeBranchName(name, FIELD_DELIVERY_BRANCH);
      expect(checked.ok).toBe(false);
      if (!checked.ok) {
        expect(checked.error).toMatch(/Invalid plan\.policy\.deliveryBranch/);
        expect(checked.error).toBe(new InvalidBranchNameError(name, FIELD_DELIVERY_BRANCH).message);
      }
    }
  });

  it("rejects leading-dash names even when check-ref-format refs/heads/<input> exits 0", () => {
    for (const name of ["-x", "--upload-pack=evil"]) {
      const check = execFileSync("git", ["check-ref-format", `refs/heads/${name}`], {
        encoding: "utf8",
      });
      expect(check).toBe("");
      expect(isSafeBranchName(name)).toBe(false);
    }
  });

  it("typed hostile deliveryBranch is a terminal configuration error (no silent default)", () => {
    const root = mkdtempSync(join(tmpdir(), "delivery-branch-hostile-"));
    try {
      mkdirSync(join(root, "xbrief"), { recursive: true });
      writeFileSync(
        join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          plan: {
            title: "P",
            status: "running",
            policy: { deliveryBranch: "--upload-pack=evil" },
          },
        }),
        "utf8",
      );
      const result = resolveDeliveryBranch(root, () => ({ code: 1, stdout: "", stderr: "" }));
      expect(result.branch).toBe("");
      expect(result.source).toBe("typed");
      expect(result.error).toMatch(/Invalid plan\.policy\.deliveryBranch/);
      expect(result.error).toBe(
        new InvalidBranchNameError("--upload-pack=evil", FIELD_DELIVERY_BRANCH).message,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("safe fetch argv places -- before refs/heads/<validated>:<dest> and couples tracking tip", () => {
    expect(trackingFetchArgv("origin", "master")).toEqual({
      ok: true,
      argv: ["fetch", "origin", "--", "refs/heads/master:refs/remotes/origin/master"],
    });
    expect(trackingFetchArgv("origin", "develop", { quiet: true })).toEqual({
      ok: true,
      argv: ["fetch", "--quiet", "origin", "--", "refs/heads/develop:refs/remotes/origin/develop"],
    });
    expect(privateDestFetchArgv("origin", "main", "refs/deft/tip", { force: true })).toEqual({
      ok: true,
      argv: ["fetch", "--force", "origin", "--", "refs/heads/main:refs/deft/tip"],
    });
    const hostileTracking = trackingFetchArgv("origin", "--upload-pack=x");
    expect(hostileTracking.ok).toBe(false);
    if (!hostileTracking.ok) {
      expect(hostileTracking.error).toBe(new InvalidBranchNameError("--upload-pack=x").message);
    }
    const hostilePrivate = privateDestFetchArgv("origin", "attacker:master", "refs/deft/x");
    expect(hostilePrivate.ok).toBe(false);
    if (!hostilePrivate.ok) {
      expect(hostilePrivate.error).toBe(new InvalidBranchNameError("attacker:master").message);
    }
  });

  it("private-dest fetch tip is distinct from origin tracking tip (coupling regression)", () => {
    const tracking = trackingFetchArgv("origin", "master");
    const privateDest = privateDestFetchArgv("origin", "master", "refs/deft/finalize-owed/master", {
      force: true,
    });
    expect(tracking.ok).toBe(true);
    expect(privateDest.ok).toBe(true);
    if (!tracking.ok || !privateDest.ok) return;
    const trackingDest = tracking.argv[tracking.argv.length - 1]!;
    const privateDestRef = privateDest.argv[privateDest.argv.length - 1]!;
    expect(trackingDest).toBe("refs/heads/master:refs/remotes/origin/master");
    expect(privateDestRef).toBe("refs/heads/master:refs/deft/finalize-owed/master");
    expect(trackingDest).not.toBe(privateDestRef);
  });
});
