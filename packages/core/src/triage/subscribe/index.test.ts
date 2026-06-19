import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectDefinitionIOError, subscribe, unsubscribe } from "./index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function writePd(root: string, policy: Record<string, unknown> = {}): void {
  const vbrief = join(root, "vbrief");
  mkdirSync(vbrief, { recursive: true });
  writeFileSync(
    join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "x", status: "running", items: [], policy },
    }),
    "utf8",
  );
}

function readRules(root: string): unknown[] {
  const data = JSON.parse(
    readFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "utf8"),
  ) as { plan?: { policy?: { triageScope?: unknown[] } } };
  return data.plan?.policy?.triageScope ?? [];
}

function makeRepo(policy?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-subscribe-test-"));
  temps.push(root);
  writePd(root, policy);
  return root;
}

describe("subscribe", () => {
  it("creates a labels.any-of rule", () => {
    const root = makeRepo();
    const [changed, message] = subscribe(root, { label: "priority:p0" });
    expect(changed).toBe(true);
    expect(readRules(root)).toEqual([{ rule: "labels", "any-of": ["priority:p0"] }]);
    expect(message).toContain("created");
  });

  it("merges into existing any-of", () => {
    const root = makeRepo({ triageScope: [{ rule: "labels", "any-of": ["bug"] }] });
    subscribe(root, { label: "urgent" });
    expect(readRules(root)).toEqual([{ rule: "labels", "any-of": ["bug", "urgent"] }]);
  });

  it("is idempotent for duplicate label", () => {
    const root = makeRepo();
    subscribe(root, { label: "bug" });
    const [changed, message] = subscribe(root, { label: "bug" });
    expect(changed).toBe(false);
    expect(message).toContain("already-subscribed");
  });

  it("requires exactly one selector", () => {
    const root = makeRepo();
    expect(() => subscribe(root, { label: "a", milestone: "b" })).toThrow(/exactly one/);
  });
});

describe("unsubscribe", () => {
  it("removes label from any-of and drops empty rule", () => {
    const root = makeRepo({ triageScope: [{ rule: "labels", "any-of": ["bug"] }] });
    const [changed] = unsubscribe(root, { label: "bug" });
    expect(changed).toBe(true);
    expect(readRules(root)).toEqual([]);
  });

  it("reports not-subscribed for missing label", () => {
    const root = makeRepo();
    const [changed, message] = unsubscribe(root, { label: "ghost" });
    expect(changed).toBe(false);
    expect(message).toContain("not-subscribed");
  });

  it("subscribes milestone and explicit-watch issue", () => {
    const root = makeRepo();
    const [mChanged] = subscribe(root, { milestone: "v1.0" });
    expect(mChanged).toBe(true);
    const [iChanged] = subscribe(root, { issue: 99, issueNote: "watch" });
    expect(iChanged).toBe(true);
    const rules = readRules(root);
    expect(
      rules.some(
        (r) => typeof r === "object" && r !== null && (r as { rule?: string }).rule === "milestone",
      ),
    ).toBe(true);
  });

  it("unsubscribes from all-of label list", () => {
    const root = makeRepo({ triageScope: [{ rule: "labels", "all-of": ["x"] }] });
    const [changed] = unsubscribe(root, { label: "x" });
    expect(changed).toBe(true);
    expect(readRules(root)).toEqual([]);
  });

  it("unsubscribes from any-of label list", () => {
    const root = makeRepo({ triageScope: [{ rule: "labels", "any-of": ["a", "b"] }] });
    const [changed] = unsubscribe(root, { label: "b" });
    expect(changed).toBe(true);
    expect(readRules(root)).toEqual([{ rule: "labels", "any-of": ["a"] }]);
  });

  it("unsubscribes missing milestone", () => {
    const root = makeRepo();
    expect(unsubscribe(root, { milestone: "ghost" })[1]).toContain("not-subscribed");
  });

  it("unsubscribes missing explicit-watch issue", () => {
    const root = makeRepo();
    expect(unsubscribe(root, { issue: 404 })[1]).toContain("not-subscribed");
  });

  it("ignores explicit-watch rules without issues array", () => {
    const root = makeRepo({ triageScope: [{ rule: "explicit-watch" }] });
    expect(unsubscribe(root, { issue: 1 })[1]).toContain("not-subscribed");
  });

  it("unsubscribes milestone and explicit-watch issue", () => {
    const root = makeRepo({
      triageScope: [
        { rule: "milestone", name: "v2" },
        { rule: "explicit-watch", issues: [{ n: 5, note: "watch" }] },
      ],
    });
    expect(unsubscribe(root, { milestone: "v2" })[0]).toBe(true);
    expect(unsubscribe(root, { issue: 5 })[0]).toBe(true);
    expect(readRules(root)).toEqual([]);
  });

  it("writes subscription history on change", () => {
    const root = makeRepo();
    subscribe(root, { label: "tracked", actor: "agent:test" });
    const historyPath = join(root, "vbrief", ".eval", "subscription-history.jsonl");
    expect(existsSync(historyPath)).toBe(true);
  });

  it("rejects multiple selectors", () => {
    const root = makeRepo();
    expect(() => subscribe(root, { label: "a", milestone: "v1" })).toThrow(/exactly one/);
  });

  it("handles any-of label subscribe paths", () => {
    const root = makeRepo({ triageScope: [{ rule: "labels", "any-of": ["a"] }] });
    expect(subscribe(root, { label: "a" })[1]).toContain("already-subscribed");
    expect(subscribe(root, { label: "b" })[0]).toBe(true);
    const root2 = makeRepo();
    expect(subscribe(root2, { label: "fresh" })[1]).toContain("created new");
  });

  it("idempotent milestone and explicit-watch", () => {
    const root = makeRepo({
      triageScope: [
        { rule: "milestone", name: "v1" },
        { rule: "explicit-watch", issues: [{ n: 1, note: "x" }] },
      ],
    });
    expect(subscribe(root, { milestone: "v1" })[0]).toBe(false);
    expect(subscribe(root, { issue: 1 })[0]).toBe(false);
    expect(subscribe(root, { issue: 2 })[0]).toBe(true);
  });

  it("throws when project definition missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-sub-missing-"));
    temps.push(root);
    expect(() => subscribe(root, { label: "x" })).toThrow(ProjectDefinitionIOError);
  });

  it("throws on invalid project definition shape", () => {
    const root = makeRepo();
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: [] }),
      "utf8",
    );
    expect(() => subscribe(root, { label: "x" })).toThrow(/non-object 'plan'/);
  });

  it("initializes missing triageScope on subscribe", () => {
    const root = makeRepo({ wipCap: 10 });
    const [changed] = subscribe(root, { label: "init-scope" });
    expect(changed).toBe(true);
    expect(readRules(root)).toHaveLength(1);
  });

  it("rejects invalid policy and triageScope shapes", () => {
    const root = makeRepo();
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: "bad" } }),
      "utf8",
    );
    expect(() => subscribe(root, { label: "x" })).toThrow(/non-object 'plan.policy'/);
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: { triageScope: "bad" } } }),
      "utf8",
    );
    expect(() => subscribe(root, { label: "x" })).toThrow(/non-list 'plan.policy.triageScope'/);
  });

  it("rejects invalid JSON project definition", () => {
    const root = makeRepo();
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{bad", "utf8");
    expect(() => subscribe(root, { label: "x" })).toThrow(/not valid JSON/);
  });
});
