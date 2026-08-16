import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  FIELD_BASE_BRANCH,
  FIELD_BASE_BRANCH_CLI_ALIAS,
  inspectBaseBranch,
  ORIGIN_DEVELOP_HINT,
  resolveBaseBranch,
} from "./base-branch.js";
import { DEFAULT_DELIVERY_BRANCH_FALLBACK } from "./delivery-branch.js";
import { inspectOnePolicy } from "./index.js";

function makeProject(policy?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "base-branch-"));
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

const silentGit: GitRunner = () => ({ code: 1, stdout: "", stderr: "" });

function gitWithDevelop(exists: boolean): GitRunner {
  return (_cwd, args) => {
    if (exists && args[0] === "show-ref" && args.includes("refs/remotes/origin/develop")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}

describe("resolveBaseBranch (#3388)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("reads typed plan.policy.baseBranch", () => {
    root = makeProject({ baseBranch: "develop", deliveryBranch: "master" });
    const result = resolveBaseBranch(root, silentGit);
    expect(result.branch).toBe("develop");
    expect(result.dest).toBe("master");
    expect(result.source).toBe("typed");
    expect(result.typed).toBe(true);
    expect(result.developHint).toBeNull();
  });

  it("unset baseBranch equals dest", () => {
    root = makeProject({ deliveryBranch: "release" });
    const result = resolveBaseBranch(root, silentGit);
    expect(result.branch).toBe("release");
    expect(result.dest).toBe("release");
    expect(result.source).toBe("equals-dest");
    expect(result.typed).toBe(false);
  });

  it("never uses origin/develop as source when unset", () => {
    root = makeProject({ deliveryBranch: "master" });
    const result = resolveBaseBranch(root, gitWithDevelop(true));
    expect(result.branch).toBe("master");
    expect(result.typed).toBe(false);
    expect(result.developHint).toBe(ORIGIN_DEVELOP_HINT);
  });

  it("omits develop hint when baseBranch is typed", () => {
    root = makeProject({ baseBranch: "integration", deliveryBranch: "master" });
    const result = resolveBaseBranch(root, gitWithDevelop(true));
    expect(result.developHint).toBeNull();
  });

  it("omits develop hint when origin/develop is absent", () => {
    root = makeProject({ deliveryBranch: "master" });
    const result = resolveBaseBranch(root, gitWithDevelop(false));
    expect(result.developHint).toBeNull();
  });

  it("rejects empty typed baseBranch and equals dest", () => {
    root = makeProject({ baseBranch: "   ", deliveryBranch: "main" });
    const result = resolveBaseBranch(root, silentGit);
    expect(result.source).toBe("default-on-error");
    expect(result.branch).toBe("main");
    expect(result.typed).toBe(false);
  });

  it("field constant is plan.policy.baseBranch", () => {
    expect(FIELD_BASE_BRANCH).toBe("plan.policy.baseBranch");
    expect(FIELD_BASE_BRANCH_CLI_ALIAS).toBe("baseBranch");
  });

  it("inspectBaseBranch without projectRoot equals dest fallback", () => {
    const field = inspectBaseBranch(null);
    expect(field.name).toBe(FIELD_BASE_BRANCH);
    expect(field.current).toBe(DEFAULT_DELIVERY_BRANCH_FALLBACK);
    expect(field.source).toBe("equals-dest");
  });

  it("policy:show alias baseBranch resolves", () => {
    root = makeProject({ baseBranch: "develop", deliveryBranch: "master" });
    const field = inspectOnePolicy(FIELD_BASE_BRANCH_CLI_ALIAS, root);
    expect(field?.name).toBe(FIELD_BASE_BRANCH);
    expect(field?.current).toBe("develop");
    expect(field?.source).toBe("typed");
  });

  it("missing project definition equals dest", () => {
    root = mkdtempSync(join(tmpdir(), "base-branch-none-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const result = resolveBaseBranch(root, silentGit);
    expect(result.source).toBe("equals-dest");
    expect(result.branch).toBe(DEFAULT_DELIVERY_BRANCH_FALLBACK);
  });

  it("non-object plan equals dest", () => {
    root = mkdtempSync(join(tmpdir(), "base-branch-badplan-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: "nope" }),
      "utf8",
    );
    const result = resolveBaseBranch(root, silentGit);
    expect(result.source).toBe("equals-dest");
    expect(result.error).toMatch(/not an object/);
  });

  it("inspectBaseBranch with projectRoot uses resolved dest as default", () => {
    root = makeProject({ deliveryBranch: "release" });
    const field = inspectBaseBranch(null, root);
    expect(field.current).toBe("release");
    expect(field.default).toBe("release");
    expect(field.source).toBe("equals-dest");
  });
});
