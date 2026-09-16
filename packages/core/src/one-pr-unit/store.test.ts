import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { IN_PROCESS_NOT_PRODUCTION, ONE_PR_UNIT_APP_NOT_CONFIGURED } from "./app-store.js";
import { evaluateOnePrUnit } from "./evaluate.js";
import { mintOnePrUnitGrant } from "./mint.js";
import { InProcessAppStore } from "./simulator.js";
import {
  bindExactSetThenResolve,
  DirectiveGitHubAppStore,
  enforceLiveOnePrUnitCheck,
  findReservedExactSetClaim,
  listOnePrUnitGrants,
  loadOnePrUnitGrant,
  resolveProductionAppStore,
  writeOnePrUnitGrant,
} from "./store.js";
import { DISK_STORE_NOT_SOT, type OnePrUnitClaim, type OriginRef } from "./types.js";

const REPO = "deftai/directive";
const TWO: OriginRef[] = [
  { repo: REPO, issueId: 3728 },
  { repo: REPO, issueId: 3804 },
];

describe("one-pr-unit App store facade", () => {
  it("looks up minted claims and refuses disk writes", () => {
    const store = new InProcessAppStore();
    mintOnePrUnitGrant({
      store,
      id: "unit-a",
      actor: "dbcall2",
      approvalRef: "ref",
      rationale: "why",
      origins: [
        { repo: "o/r", issueId: 1 },
        { repo: "o/r", issueId: 2 },
      ],
      repo: "o/r",
    });
    expect(loadOnePrUnitGrant("ignored", "unit-a", store)?.id).toBe("unit-a");
    expect(listOnePrUnitGrants("ignored", store)).toHaveLength(1);
    expect(() => writeOnePrUnitGrant("ignored", store.getById("unit-a") as OnePrUnitClaim)).toThrow(
      DISK_STORE_NOT_SOT,
    );
  });
});
describe("resolveProductionAppStore", () => {
  it("names a deployment/configuration failure when unset", () => {
    const resolved = resolveProductionAppStore({});
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("not-configured");
    expect(resolved.message).toBe(ONE_PR_UNIT_APP_NOT_CONFIGURED);
    expect(resolved.message).not.toMatch(/mint an operator-origin/);
  });

  it("does not select InProcessAppStore when DEFT_ONE_PR_UNIT_APP is a marker", () => {
    for (const value of ["1", "true", "inprocess", "simulator"]) {
      const resolved = resolveProductionAppStore({ DEFT_ONE_PR_UNIT_APP: value });
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.code).toBe("in-process-not-production");
      expect(resolved.message).toBe(IN_PROCESS_NOT_PRODUCTION);
    }
  });

  it("refuses the gitignored disk store path", () => {
    const resolved = resolveProductionAppStore({ DEFT_ONE_PR_UNIT_APP: ".deft/one-pr-unit" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("disk-not-sot");
    expect(resolved.message).toBe(DISK_STORE_NOT_SOT);
  });

  it("constructs DirectiveGitHubAppStore from a store path", () => {
    const dir = mkdtempSync(join(tmpdir(), "opu-app-"));
    const resolved = resolveProductionAppStore({ DEFT_ONE_PR_UNIT_APP: dir });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.store).toBeInstanceOf(DirectiveGitHubAppStore);
    expect(resolved.store).not.toBeInstanceOf(InProcessAppStore);
    rmSync(dir, { recursive: true, force: true });
  });
});
describe("DirectiveGitHubAppStore persist-and-bind", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function mintTwo(store: DirectiveGitHubAppStore) {
    return mintOnePrUnitGrant({
      store,
      id: "unit-two",
      actor: "dbcall2",
      approvalRef: "op",
      rationale: "pair",
      origins: TWO,
      repo: REPO,
    });
  }

  it("persists reserved mint so a later instance can find it", () => {
    const dir = mkdtempSync(join(tmpdir(), "opu-persist-"));
    created.push(dir);
    mintTwo(new DirectiveGitHubAppStore(dir));
    const later = new DirectiveGitHubAppStore(dir);
    const found = findReservedExactSetClaim(later, TWO);
    expect(found?.id).toBe("unit-two");
    expect(found?.state).toBe("reserved");
    expect(later.getByPrNodeId("PR_LEGIT")).toBeNull();
  });

  it("does not bind on a per-origin membership hit", () => {
    const dir = mkdtempSync(join(tmpdir(), "opu-overlap-"));
    created.push(dir);
    const store = new DirectiveGitHubAppStore(dir);
    mintTwo(store);
    const overlap: OriginRef[] = [
      { repo: REPO, issueId: 3728 },
      { repo: REPO, issueId: 9999 },
    ];
    expect(findReservedExactSetClaim(store, overlap)).toBeNull();
    expect(store.membershipOf({ repo: REPO, issueId: 3728 })?.id).toBe("unit-two");
    const grant = bindExactSetThenResolve({
      store,
      closerSet: overlap,
      repo: REPO,
      prNodeId: "PR_ATTACK",
    });
    expect(grant).toBeNull();
    expect(store.getById("unit-two")?.prNodeId).toBeNull();
  });

  it("does not bind when declare.ok is allow-single-origin", () => {
    const dir = mkdtempSync(join(tmpdir(), "opu-single-"));
    created.push(dir);
    const store = new DirectiveGitHubAppStore(dir);
    mintTwo(store);
    const single: OriginRef[] = [{ repo: REPO, issueId: 3728 }];
    const declared = evaluateOnePrUnit({
      closerSet: single,
      grant: store.membershipOf(single[0] as OriginRef),
      phase: "declare",
    });
    expect(declared.ok).toBe(true);
    expect(declared.code).toBe("allow-single-origin");
    const grant = bindExactSetThenResolve({
      store,
      closerSet: single,
      repo: REPO,
      prNodeId: "PR_SINGLE",
    });
    expect(grant).toBeNull();
    expect(store.getById("unit-two")?.prNodeId).toBeNull();
  });

  it("exact-set match then bind then resolve then enforce with prNodeId", () => {
    const dir = mkdtempSync(join(tmpdir(), "opu-bind-"));
    created.push(dir);
    const store = new DirectiveGitHubAppStore(dir);
    mintTwo(store);
    const decision = enforceLiveOnePrUnitCheck({
      store,
      closerSet: TWO,
      repo: REPO,
      prNodeId: "PR_LEGIT",
    });
    expect(decision.code).toBe("allow-granted");
    expect(store.getByPrNodeId("PR_LEGIT")?.id).toBe("unit-two");
    const repoOnly = evaluateOnePrUnit({
      closerSet: TWO,
      grant: store.getByPrNodeId("PR_LEGIT"),
      binding: { repo: REPO },
      phase: "enforce",
    });
    expect(repoOnly.code).toBe("deny-not-bearer");
  });
});
describe("cross-process mint-then-validate", () => {
  it("validates a reserved mint from a separate process", () => {
    const dir = mkdtempSync(join(tmpdir(), "opu-xproc-"));
    const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const mintUrl = pathToFileURL(
      join(process.cwd(), "packages/core/src/one-pr-unit/mint.ts"),
    ).href;
    const storeUrl = pathToFileURL(
      join(process.cwd(), "packages/core/src/one-pr-unit/store.ts"),
    ).href;
    const simUrl = pathToFileURL(
      join(process.cwd(), "packages/core/src/one-pr-unit/simulator.ts"),
    ).href;
    const mintFile = join(dir, "mint.mts");
    const validateFile = join(dir, "validate.mts");
    writeFileSync(
      mintFile,
      [
        `import { mintOnePrUnitGrant } from ${JSON.stringify(mintUrl)};`,
        `import { resolveProductionAppStore } from ${JSON.stringify(storeUrl)};`,
        "const resolved = resolveProductionAppStore(process.env);",
        "if (!resolved.ok) process.exit(2);",
        "mintOnePrUnitGrant({",
        "  store: resolved.store,",
        '  id: "unit-x",',
        '  actor: "dbcall2",',
        '  approvalRef: "op",',
        '  rationale: "pair",',
        "  origins: [",
        '    { repo: "deftai/directive", issueId: 3728 },',
        '    { repo: "deftai/directive", issueId: 3804 },',
        "  ],",
        '  repo: "deftai/directive",',
        "});",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      validateFile,
      [
        `import { InProcessAppStore } from ${JSON.stringify(simUrl)};`,
        `import { enforceLiveOnePrUnitCheck, resolveProductionAppStore } from ${JSON.stringify(storeUrl)};`,
        "const resolved = resolveProductionAppStore(process.env);",
        "if (!resolved.ok) process.exit(2);",
        "if (resolved.store instanceof InProcessAppStore) process.exit(3);",
        "const decision = enforceLiveOnePrUnitCheck({",
        "  store: resolved.store,",
        "  closerSet: [",
        '    { repo: "deftai/directive", issueId: 3728 },',
        '    { repo: "deftai/directive", issueId: 3804 },',
        "  ],",
        '  repo: "deftai/directive",',
        '  prNodeId: "PR_LEGIT",',
        "});",
        'if (decision.code !== "allow-granted") process.exit(4);',
      ].join("\n"),
      "utf8",
    );
    const env = { ...process.env, DEFT_ONE_PR_UNIT_APP: dir };
    const minted = spawnSync(process.execPath, [tsx, mintFile], { env, encoding: "utf8" });
    expect(minted.status, minted.stderr || minted.stdout || "").toBe(0);
    const validated = spawnSync(process.execPath, [tsx, validateFile], { env, encoding: "utf8" });
    expect(validated.status, validated.stderr || validated.stdout || "").toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
