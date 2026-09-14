import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateObservableScope } from "./evaluate.js";
import { buildObservableScopeRecord } from "./mint.js";
import { OBSERVABLE_SCOPE_REMEDIATION, OBSERVABLE_UI_POLICY_REL } from "./types.js";

const BASE_HTML = `
<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;

const policy = JSON.stringify({
  schema: "deft.observable-ui.policy.v1",
  surfaces: ["ui.html"],
});

const human = {
  kind: "operator" as const,
  actor: "david",
  mintedAt: "2026-09-13T00:00:00Z",
  mintedVia: "scope:record-observable-scope",
};

function record(allowed: { kind: "control"; op: "add"; name: string }[]) {
  const rec = buildObservableScopeRecord({
    planId: "story-1",
    xbriefRelPath: "xbrief/active/story.xbrief.json",
    allowedChanges: allowed,
    humanApproval: human,
  });
  if ("error" in rec) throw new Error(rec.error);
  return rec;
}

function files(headHtml: string) {
  return {
    projectRoot: "/tmp/observable-scope-eval",
    mergeBase: "base",
    changedFiles: ["ui.html"],
    policyTextAtBase: policy,
    recordTextsAtBase: new Map([
      [
        ".deft/observable-scope/story-1.json",
        `${JSON.stringify(
          record([
            { kind: "control", op: "add", name: "email" },
            { kind: "control", op: "add", name: "phone" },
          ]),
          null,
          2,
        )}\n`,
      ],
    ]),
    readAtBase: (rel: string) => (rel === "ui.html" ? BASE_HTML : null),
    readAtHead: (rel: string) => (rel === "ui.html" ? headHtml : null),
  };
}

describe("evaluateObservableScope (#4495)", () => {
  it("emits inferred-defaults-warn when surfaces policy is unset and UI files change", () => {
    const result = evaluateObservableScope({
      projectRoot: "/tmp/x",
      mergeBase: "base",
      changedFiles: ["ui.html"],
      policyTextAtBase: null,
    });
    expect(result.code).toBe(0);
    expect(result.skipped).not.toBe(true);
    expect(result.findings?.some((f) => f.kind === "non-adoption" && f.path === "ui.html")).toBe(
      true,
    );
    expect(result.message).toMatch(/inferred-defaults-warn/);
    expect(result.message).toMatch(/not yet universal UI coverage/);
  });

  it("skips when surfaces policy is unset and no UI file types changed", () => {
    const result = evaluateObservableScope({
      projectRoot: "/tmp/x",
      mergeBase: "base",
      changedFiles: ["src/app.ts"],
      policyTextAtBase: null,
    });
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it("skips unmatched non-UI paths", () => {
    const result = evaluateObservableScope({
      projectRoot: "/tmp/x",
      mergeBase: "base",
      changedFiles: ["src/app.ts"],
      policyTextAtBase: policy,
    });
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it("fails missing mint on a matched UI surface", () => {
    const result = evaluateObservableScope({
      projectRoot: "/tmp/x",
      mergeBase: "base",
      changedFiles: ["ui.html"],
      policyTextAtBase: policy,
      recordTextsAtBase: new Map(),
      readAtBase: () => BASE_HTML,
      readAtHead: () => BASE_HTML,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain(OBSERVABLE_SCOPE_REMEDIATION);
  });

  it("fails unlisted tab/heading/control/column/landmark/container deltas", () => {
    const head = `
<nav><button role="tab">Details</button><button role="tab" aria-selected="true">Overview</button></nav>
<h1>Renamed</h1>
<input name="title" />
<input name="email" />
<input name="phone" />
<button>Save</button>
<button>Delete</button>
<table><tr><th>Name</th><th>Owner</th></tr></table>
<footer></footer>
<section id="card"></section>
<article id="panel"></article>
`;
    const result = evaluateObservableScope(files(head));
    expect(result.code).toBe(1);
    expect(result.message).toContain(OBSERVABLE_SCOPE_REMEDIATION);
    expect(result.message).toMatch(/unlisted structure delta/);
  });

  it("passes when only minted bound-field markup changes", () => {
    const head = `
<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<input name="email" />
<input name="phone" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;
    const result = evaluateObservableScope(files(head));
    expect(result.code).toBe(0);
    expect(result.skipped).not.toBe(true);
  });

  it("fails same-PR mint rewrite", () => {
    const result = evaluateObservableScope({
      ...files(BASE_HTML),
      changedFiles: ["ui.html", ".deft/observable-scope/story-1.json"],
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/same-PR rewrite/);
  });

  it("config-fails undeclared template dialects in a matched surface", () => {
    const result = evaluateObservableScope({
      projectRoot: "/tmp/x",
      mergeBase: "base",
      changedFiles: ["ui.vue"],
      policyTextAtBase: JSON.stringify({
        schema: "deft.observable-ui.policy.v1",
        surfaces: ["ui.vue"],
      }),
    });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/undeclared template dialect/);
  });

  it("skips matched surfaces with no first-ship UI file types", () => {
    const result = evaluateObservableScope({
      projectRoot: "/tmp/x",
      mergeBase: "base",
      changedFiles: ["ui.css"],
      policyTextAtBase: JSON.stringify({
        schema: "deft.observable-ui.policy.v1",
        surfaces: ["ui.css"],
      }),
    });
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it("config-fails invalid policy", () => {
    const result = evaluateObservableScope({
      projectRoot: "/tmp/x",
      mergeBase: "base",
      changedFiles: ["ui.html"],
      policyTextAtBase: "{not json",
    });
    expect(result.code).toBe(2);
  });

  it("passes layout-authorized work when every semantic delta is listed", () => {
    const rec = buildObservableScopeRecord({
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      changeKind: "layout-authorized",
      allowedChanges: [
        { kind: "tab", op: "reorder" },
        { kind: "control", op: "reorder" },
        { kind: "heading", op: "remove", name: "Dashboard" },
        { kind: "heading", op: "add", name: "Renamed" },
      ],
      humanApproval: human,
    });
    if ("error" in rec) throw new Error(rec.error);
    const head = `
<nav><button role="tab">Details</button><button role="tab" aria-selected="true">Overview</button></nav>
<h1>Renamed</h1>
<input name="title" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;
    const result = evaluateObservableScope({
      ...files(head),
      recordTextsAtBase: new Map([
        [".deft/observable-scope/story-1.json", `${JSON.stringify(rec)}\n`],
      ]),
    });
    expect(result.code).toBe(0);
  });

  it("config-fails mixed changeKind", () => {
    const rec = record([{ kind: "control", op: "add", name: "email" }]);
    const result = evaluateObservableScope({
      projectRoot: "/tmp/x",
      mergeBase: "base",
      changedFiles: ["ui.html"],
      policyTextAtBase: policy,
      recordTextsAtBase: new Map([
        [".deft/observable-scope/story-1.json", JSON.stringify({ ...rec, changeKind: "mixed" })],
      ]),
    });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/mixed/);
  });

  it("fails duplicate table-column removal that unique-id collapse would miss", () => {
    const base = `<table><tr><th>Name</th><th>Name</th></tr></table>`;
    const head = `<table><tr><th>Name</th></tr></table>`;
    const rec = buildObservableScopeRecord({
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [],
      humanApproval: human,
    });
    if ("error" in rec) throw new Error(rec.error);
    const result = evaluateObservableScope({
      projectRoot: "/tmp/x",
      mergeBase: "base",
      changedFiles: ["ui.html"],
      policyTextAtBase: policy,
      recordTextsAtBase: new Map([
        [".deft/observable-scope/story-1.json", `${JSON.stringify(rec)}\n`],
      ]),
      readAtBase: (rel: string) => (rel === "ui.html" ? base : null),
      readAtHead: (rel: string) => (rel === "ui.html" ? head : null),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/unlisted structure delta/);
  });

  it("fails markup-visible selection even when the tab name is already allowed", () => {
    const rec = buildObservableScopeRecord({
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [{ kind: "tab", op: "add", name: "Extra" }],
      humanApproval: human,
    });
    if ("error" in rec) throw new Error(rec.error);
    const head = `
<nav><button role="tab">Overview</button><button role="tab" aria-selected="true">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;
    const result = evaluateObservableScope({
      ...files(head),
      recordTextsAtBase: new Map([
        [".deft/observable-scope/story-1.json", `${JSON.stringify(rec)}\n`],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/tab-selected|unlisted structure delta/);
  });

  it("fails mustPreserve even when allowedChanges would cover the delta", () => {
    const rec = buildObservableScopeRecord({
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      mustPreserve: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: human,
    });
    if ("error" in rec) throw new Error(rec.error);
    const head = `
<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<input name="email" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;
    const result = evaluateObservableScope({
      ...files(head),
      recordTextsAtBase: new Map([
        [".deft/observable-scope/story-1.json", `${JSON.stringify(rec)}\n`],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/mustPreserve/);
  });

  it("does not let another story mint authorize this change", () => {
    const other = buildObservableScopeRecord({
      planId: "story-other",
      xbriefRelPath: "xbrief/active/other.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: human,
    });
    const mine = buildObservableScopeRecord({
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [],
      humanApproval: human,
    });
    if ("error" in other || "error" in mine) throw new Error("mint");
    const head = `
<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<input name="email" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;
    const result = evaluateObservableScope({
      ...files(head),
      planId: "story-1",
      recordTextsAtBase: new Map([
        [".deft/observable-scope/story-other.json", `${JSON.stringify(other)}\n`],
        [".deft/observable-scope/story-1.json", `${JSON.stringify(mine)}\n`],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/unlisted structure delta/);
  });

  it("refuses to let a unique minted running story authorize a sibling running story", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-multi-running-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const running = (id: string) => JSON.stringify({ plan: { id, status: "running" } });
    writeFileSync(join(root, "xbrief", "active", "a.xbrief.json"), running("story-1"));
    writeFileSync(join(root, "xbrief", "active", "b.xbrief.json"), running("story-2"));
    const rec = record([{ kind: "control", op: "add", name: "email" }]);
    const head = `
<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<input name="email" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    delete process.env.DEFT_ACTIVE_SCOPE;
    try {
      const result = evaluateObservableScope({
        ...files(head),
        projectRoot: root,
        recordTextsAtBase: new Map([
          [".deft/observable-scope/story-1.json", `${JSON.stringify(rec)}\n`],
        ]),
      });
      expect(result.code).toBe(2);
      expect(result.message).toMatch(/multiple running stories/);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
    }
  });

  it("does not let a single other-story mint authorize via --plan-id bypass", () => {
    const other = buildObservableScopeRecord({
      planId: "story-other",
      xbriefRelPath: "xbrief/active/other.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: human,
    });
    if ("error" in other) throw new Error("mint");
    const head = `
<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<input name="email" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;
    const result = evaluateObservableScope({
      ...files(head),
      planId: "story-1",
      recordTextsAtBase: new Map([
        [".deft/observable-scope/story-other.json", `${JSON.stringify(other)}\n`],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/no merge-base mint record for planId story-1/);
  });

  it("does not apply an allowance bound to a different surface path", () => {
    const rec = buildObservableScopeRecord({
      planId: "story-1",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email", path: "other.html" }],
      humanApproval: human,
    });
    if ("error" in rec) throw new Error(rec.error);
    const head = `
<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<input name="email" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;
    const result = evaluateObservableScope({
      ...files(head),
      recordTextsAtBase: new Map([
        [".deft/observable-scope/story-1.json", `${JSON.stringify(rec)}\n`],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/unlisted structure delta/);
  });

  it("config-fails worker-declared baselineRef on the mint record", () => {
    const rec = record([{ kind: "control", op: "add", name: "email" }]);
    const result = evaluateObservableScope({
      projectRoot: "/tmp/x",
      mergeBase: "base",
      changedFiles: ["ui.html"],
      policyTextAtBase: policy,
      recordTextsAtBase: new Map([
        [
          ".deft/observable-scope/story-1.json",
          JSON.stringify({ ...rec, baselineRef: "origin/dev" }),
        ],
      ]),
    });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/baselineRef/);
  });
});

describe("policy path constant", () => {
  it("is base-pinned under .deft", () => {
    expect(OBSERVABLE_UI_POLICY_REL).toBe(".deft/observable-ui.policy.json");
  });
});
