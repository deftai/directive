import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENV_ALLOW_BOT_MERGE,
  evaluateAgentMerge,
  humanMergeDisclosureLine,
  resolveHumanMergePolicy,
  setRequireHumanMerge,
} from "./require-human-merge.js";

function writePd(
  root: string,
  policy: Record<string, unknown>,
  narratives?: Record<string, unknown>,
): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  const plan: Record<string, unknown> = {
    title: "t",
    status: "running",
    "x-directive/policy": policy,
  };
  if (narratives) plan.narratives = narratives;
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan,
    }),
    "utf8",
  );
}

const roots: string[] = [];
afterEach(() => {
  // leave temp dirs; OS cleans tmp
  roots.length = 0;
});

function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "deft-hm-"));
  roots.push(r);
  return r;
}

describe("resolveHumanMergePolicy", () => {
  it("defaults false when no auto-deploy and no typed flag", () => {
    const r = tempRoot();
    writePd(r, {});
    const p = resolveHumanMergePolicy(r, {});
    expect(p.requireHumanMerge).toBe(false);
    expect(p.source).toBe("default");
  });

  it("defaults true when autoDeployOnMerge is true", () => {
    const r = tempRoot();
    writePd(r, { autoDeployOnMerge: true });
    const p = resolveHumanMergePolicy(r, {});
    expect(p.requireHumanMerge).toBe(true);
    expect(p.source).toBe("auto-deploy-default");
  });

  it("honors typed requireHumanMerge", () => {
    const r = tempRoot();
    writePd(r, { requireHumanMerge: true, autoDeployOnMerge: false });
    const p = resolveHumanMergePolicy(r, {});
    expect(p.requireHumanMerge).toBe(true);
    expect(p.source).toBe("typed");
  });

  it("env bypass DEFT_ALLOW_BOT_MERGE=1", () => {
    const r = tempRoot();
    writePd(r, { requireHumanMerge: true });
    const p = resolveHumanMergePolicy(r, { [ENV_ALLOW_BOT_MERGE]: "1" });
    expect(p.requireHumanMerge).toBe(false);
    expect(p.source).toBe("env-bypass");
  });
});

describe("evaluateAgentMerge", () => {
  it("refuses when requireHumanMerge is true", () => {
    const r = tempRoot();
    writePd(r, { requireHumanMerge: true });
    const e = evaluateAgentMerge(r, {});
    expect(e.allowed).toBe(false);
    expect(e.exitCode).toBe(1);
    expect(e.message).toContain("#1193");
    expect(e.message).toContain("allow-bot-merge");
  });

  it("allows when requireHumanMerge is false", () => {
    const r = tempRoot();
    writePd(r, { requireHumanMerge: false });
    const e = evaluateAgentMerge(r, {});
    expect(e.allowed).toBe(true);
    expect(e.exitCode).toBe(0);
  });
});

describe("humanMergeDisclosureLine", () => {
  it("emits ON line when gate is active", () => {
    const line = humanMergeDisclosureLine({
      requireHumanMerge: true,
      source: "typed",
      deprecationWarning: null,
      error: null,
      autoDeployOnMerge: false,
    });
    expect(line).toContain("Human merge gate is ON");
    expect(line).toContain("source: typed");
  });

  it("returns null when off", () => {
    expect(
      humanMergeDisclosureLine({
        requireHumanMerge: false,
        source: "default",
        deprecationWarning: null,
        error: null,
        autoDeployOnMerge: false,
      }),
    ).toBeNull();
  });
});

describe("setRequireHumanMerge", () => {
  it("writes typed false and audits", () => {
    const r = tempRoot();
    writePd(r, { requireHumanMerge: true });
    const { changed } = setRequireHumanMerge(r, {
      requireHumanMerge: false,
      actor: "test",
      note: "allow bot",
    });
    expect(changed).toBe(true);
    const p = resolveHumanMergePolicy(r, {});
    expect(p.requireHumanMerge).toBe(false);
    expect(p.source).toBe("typed");
  });
});
