/**
 * AC-pass bank / cache reuse decisions (#3387).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { acPassBankPath, maybeBankOnAcPass } from "./ac-pass-banking.js";
import { resolveAcReuse } from "./ac-pass-reuse.js";
import { hashProductState } from "./product-state-hash.js";
import { writeVerifyAcSessionCache } from "./verify-ac-session-cache.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "deft-3387-reuse-"));
}

function snapshot() {
  return {
    ok: true as const,
    code: 0 as const,
    message: "cached",
    commands: [{ command: "true" }],
    runs: [
      { command: "true", cwd: ".", exitCode: 0, stdout: "", stderr: "", ok: true, detail: "" },
    ],
    sourceRung: "derived",
    noneStated: true,
    acceptance: { commands: [{ command: "true" }], none_stated: true, source_rung: "derived" },
    resolution: "verified-pass",
    resolvedCommandCount: 1,
  };
}

describe("resolveAcReuse (#3387)", () => {
  it("misses without scope id or bank", () => {
    const root = tempRoot();
    writeFileSync(join(root, "p.txt"), "x\n", "utf8");
    const noId = resolveAcReuse({
      projectRoot: root,
      plan: { acceptance: { commands: [{ command: "true" }] } },
      productPaths: ["p.txt"],
    });
    expect(noId.kind).toBe("miss");

    const missing = resolveAcReuse({
      projectRoot: root,
      plan: { id: "s", acceptance: { commands: [{ command: "true" }] } },
      productPaths: ["p.txt"],
    });
    expect(missing.kind).toBe("miss");
    expect(missing.reason).toMatch(/no reusable/);
  });

  it("accepts a matching bank and rejects a stale hash", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.txt"), "ok\n", "utf8");
    const plan = {
      id: "bank-scope",
      acceptance: { commands: [{ command: "true" }] },
    };
    const hashed = hashProductState({
      projectRoot: root,
      plan,
      productPaths: ["src/app.txt"],
    });
    maybeBankOnAcPass({
      projectRoot: root,
      scopeId: "bank-scope",
      executableRuns: 1,
      productStateHash: hashed.digest,
    });
    const hit = resolveAcReuse({
      projectRoot: root,
      plan,
      productPaths: ["src/app.txt"],
    });
    expect(hit.kind).toBe("bank");

    writeFileSync(join(root, "src", "app.txt"), "changed\n", "utf8");
    const miss = resolveAcReuse({
      projectRoot: root,
      plan,
      productPaths: ["src/app.txt"],
    });
    expect(miss.kind).toBe("miss");
    expect(miss.reason).toMatch(/mismatch/);
  });

  it("prefers same-session cache over bank", () => {
    const root = tempRoot();
    writeFileSync(join(root, "p.txt"), "x\n", "utf8");
    const plan = { id: "cache-scope", acceptance: { commands: [{ command: "true" }] } };
    const hashed = hashProductState({
      projectRoot: root,
      plan,
      productPaths: ["p.txt"],
    });
    maybeBankOnAcPass({
      projectRoot: root,
      scopeId: "cache-scope",
      executableRuns: 1,
      productStateHash: hashed.digest,
    });
    writeVerifyAcSessionCache({
      projectRoot: root,
      sessionId: "sess-1",
      scopeId: "cache-scope",
      productStateHash: hashed.digest,
      snapshot: snapshot(),
    });
    const hit = resolveAcReuse({
      projectRoot: root,
      plan,
      productPaths: ["p.txt"],
      sessionId: "sess-1",
    });
    expect(hit.kind).toBe("cache");

    const bankOnly = resolveAcReuse({
      projectRoot: root,
      plan,
      productPaths: ["p.txt"],
      sessionId: "sess-1",
      allowCache: false,
    });
    expect(bankOnly.kind).toBe("bank");
  });

  it("serves a bank after git-status failure by walking product files (#3558)", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.txt"), "ok\n", "utf8");
    const plan = {
      id: "gitfail-scope",
      acceptance: { commands: [{ command: "true" }] },
    };
    const runGit = (_cwd: string, args: readonly string[]) => {
      if (args.includes("rev-parse")) {
        return { code: 128, stdout: "", stderr: "no HEAD" };
      }
      return { code: 128, stdout: "", stderr: "status failed" };
    };
    const hashed = hashProductState({ projectRoot: root, plan, runGit });
    expect(hashed.complete).toBe(true);
    maybeBankOnAcPass({
      projectRoot: root,
      scopeId: "gitfail-scope",
      executableRuns: 0,
      verifiedPass: true,
      productStateHash: hashed.digest,
    });
    const hit = resolveAcReuse({ projectRoot: root, plan, runGit });
    expect(hit.kind).toBe("bank");

    writeFileSync(join(root, "src", "app.txt"), "changed\n", "utf8");
    const miss = resolveAcReuse({ projectRoot: root, plan, runGit });
    expect(miss.kind).toBe("miss");
    expect(miss.reason).toMatch(/mismatch/);
  });

  it("misses a matching v1 bank that lacks the runs field (#3993)", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.txt"), "ok\n", "utf8");
    const plan = {
      id: "v1-bank-scope",
      acceptance: { commands: [{ command: "true" }] },
    };
    const hashed = hashProductState({
      projectRoot: root,
      plan,
      productPaths: ["src/app.txt"],
    });
    const path = acPassBankPath(root, "v1-bank-scope");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        scopeId: "v1-bank-scope",
        bankedAt: "2026-09-02T00:00:00Z",
        headSha: null,
        productStateHash: hashed.digest,
        remainingTurns: null,
        remainingBudget: null,
        maxTurns: null,
        maxBudget: null,
        surplusThreshold: 0.2,
        hadSurplus: true,
        nextAction: "finalize_and_ship",
        postBankFindings: [],
      }),
      "utf8",
    );
    const miss = resolveAcReuse({
      projectRoot: root,
      plan,
      productPaths: ["src/app.txt"],
    });
    expect(miss.kind).toBe("miss");
    expect(miss.reason).toMatch(/v1 bank missing runs/);
  });
});
