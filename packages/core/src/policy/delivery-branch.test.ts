import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  DEFAULT_DELIVERY_BRANCH_FALLBACK,
  FIELD_DELIVERY_BRANCH,
  resolveDeliveryBranch,
  resolveGitDefaultDeliveryBranch,
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
