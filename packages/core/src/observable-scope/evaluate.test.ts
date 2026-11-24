import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  base64urlEncode,
  buildRecordApprovalPayload,
  canonicalBytes,
} from "../approvers/canonical.js";
import type { Approver, RecordApprovalEntry } from "../approvers/types.js";
import { FLAG_UP, FLAG_UV, spkiOf } from "../approvers/webauthn.js";
import type { SignedLevel } from "../scope-provenance/record-stamp.js";
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
    expect(result.message).toMatch(/#4588/);
    expect(result.message).toMatch(/Parking is not this when/);
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
    const prevPr = process.env.GITHUB_PR_NUMBER;
    delete process.env.DEFT_ACTIVE_SCOPE;
    delete process.env.GITHUB_PR_NUMBER;
    try {
      const result = evaluateObservableScope({
        ...files(head),
        projectRoot: root,
        pr: "",
        recordTextsAtBase: new Map([
          [".deft/observable-scope/story-1.json", `${JSON.stringify(rec)}\n`],
        ]),
      });
      expect(result.code).toBe(2);
      expect(result.message).toMatch(/multiple running stories/);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
      if (prevPr === undefined) delete process.env.GITHUB_PR_NUMBER;
      else process.env.GITHUB_PR_NUMBER = prevPr;
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

  it("adopts plan-id from sole PR deft-story under multi-running (#5782)", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-pr-adopt-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "a.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "story-1",
          status: "running",
          narratives: {
            Origin: "Ingested from https://github.com/deftai/directive/issues/5782",
          },
        },
      }),
    );
    writeFileSync(
      join(root, "xbrief", "active", "b.xbrief.json"),
      JSON.stringify({ plan: { id: "story-2", status: "running" } }),
    );
    const other = buildObservableScopeRecord({
      planId: "story-2",
      xbriefRelPath: "xbrief/active/b.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "phone" }],
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
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    delete process.env.DEFT_ACTIVE_SCOPE;
    try {
      const result = evaluateObservableScope({
        ...files(head),
        projectRoot: root,
        planId: undefined,
        pr: "99",
        repo: "deftai/directive",
        runGh: () => ({
          returncode: 0,
          stdout: JSON.stringify({ body: "Tracking #5782\n\ndeft-story: 5782\n" }),
          stderr: "",
        }),
        recordTextsAtBase: new Map([
          [".deft/observable-scope/story-2.json", `${JSON.stringify(other)}\n`],
          [
            ".deft/observable-scope/story-1.json",
            `${JSON.stringify(record([{ kind: "control", op: "add", name: "email" }]))}\n`,
          ],
        ]),
      });
      expect(result.code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
    }
  });

  it("suppresses PR adoption on bad-pin + PR with named message (#5782)", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-bad-pin-pr-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "a.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "story-1",
          status: "running",
          narratives: {
            Origin: "Ingested from https://github.com/deftai/directive/issues/5782",
          },
        },
      }),
    );
    writeFileSync(
      join(root, "xbrief", "active", "b.xbrief.json"),
      JSON.stringify({ plan: { id: "story-2", status: "running" } }),
    );
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
    process.env.DEFT_ACTIVE_SCOPE = "xbrief/active/missing-pin.xbrief.json";
    try {
      const result = evaluateObservableScope({
        ...files(head),
        projectRoot: root,
        planId: undefined,
        pr: "99",
        repo: "deftai/directive",
        runGh: () => ({
          returncode: 0,
          stdout: JSON.stringify({ body: "deft-story: 5782\n" }),
          stderr: "",
        }),
      });
      expect(result.code).toBe(2);
      expect(result.message).toMatch(/PR deft-story plan-id adoption was suppressed/);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
    }
  });

  it("bad-pin + sole running refuses a different story's sole mint (#5782 P1)", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-bad-pin-sole-mint-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "a.xbrief.json"),
      JSON.stringify({ plan: { id: "story-a", status: "running" } }),
    );
    const other = buildObservableScopeRecord({
      planId: "story-b",
      xbriefRelPath: "xbrief/active/b.xbrief.json",
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
    const prev = process.env.DEFT_ACTIVE_SCOPE;
    process.env.DEFT_ACTIVE_SCOPE = "xbrief/active/missing-pin.xbrief.json";
    try {
      const result = evaluateObservableScope({
        ...files(head),
        projectRoot: root,
        planId: undefined,
        recordTextsAtBase: new Map([
          [".deft/observable-scope/story-b.json", `${JSON.stringify(other)}\n`],
        ]),
      });
      expect(result.code).toBe(1);
      expect(result.message).toMatch(/no merge-base mint record for planId story-a/);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
    }
  });

  it("bad-pin + sole running selects matching mint among several records (#5782 P1)", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-bad-pin-multi-rec-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "a.xbrief.json"),
      JSON.stringify({ plan: { id: "story-a", status: "running" } }),
    );
    const mine = buildObservableScopeRecord({
      planId: "story-a",
      xbriefRelPath: "xbrief/active/a.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: human,
    });
    const other = buildObservableScopeRecord({
      planId: "story-b",
      xbriefRelPath: "xbrief/active/b.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "phone" }],
      humanApproval: human,
    });
    if ("error" in mine || "error" in other) throw new Error("mint");
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
    const prevPr = process.env.GITHUB_PR_NUMBER;
    process.env.DEFT_ACTIVE_SCOPE = "xbrief/active/missing-pin.xbrief.json";
    delete process.env.GITHUB_PR_NUMBER;
    try {
      const result = evaluateObservableScope({
        ...files(head),
        projectRoot: root,
        planId: undefined,
        pr: "",
        recordTextsAtBase: new Map([
          [".deft/observable-scope/story-b.json", `${JSON.stringify(other)}\n`],
          [".deft/observable-scope/story-a.json", `${JSON.stringify(mine)}\n`],
        ]),
      });
      // Multi records + sole running + bad-pin + no PR: sole-running selects A.
      expect(result.code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DEFT_ACTIVE_SCOPE;
      else process.env.DEFT_ACTIVE_SCOPE = prev;
      if (prevPr === undefined) delete process.env.GITHUB_PR_NUMBER;
      else process.env.GITHUB_PR_NUMBER = prevPr;
    }
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

// --- signed level (#6945): soft authenticator, test only ---
const SIGNED_REPO = "deftai/directive";
const SIGNED_RP = { id: "approve.example.com", origins: ["https://approve.example.com"] };
const signedKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const signedApprover: Approver = {
  name: "yubikey",
  credentialId: "Y3JlZC0x",
  publicKey: base64urlEncode(spkiOf(signedKey.publicKey)),
  alg: -7,
  aaguid: "cb69481e-8ff7-4039-93ec-0a2729a154a8",
  backupEligible: false,
};
const signedLevel: SignedLevel = {
  level: "signed",
  ok: true,
  repo: SIGNED_REPO,
  trust: {
    body: { repo: SIGNED_REPO, rp: SIGNED_RP, approvers: [signedApprover] },
    rootKind: "packed",
    epochStart: "0123456789abcdef",
    attested: [signedApprover.credentialId],
  },
};
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

function approveEntries(
  entries: RecordApprovalEntry[],
  privateKey: KeyObject = signedKey.privateKey,
) {
  const payload = buildRecordApprovalPayload(SIGNED_REPO, entries);
  const auth = Buffer.concat([
    sha256(Buffer.from(SIGNED_RP.id)),
    Buffer.from([FLAG_UP | FLAG_UV, 0, 0, 0, 1]),
  ]);
  const client = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: base64urlEncode(sha256(canonicalBytes(payload))),
      origin: SIGNED_RP.origins[0],
    }),
  );
  return {
    payload,
    credentialId: signedApprover.credentialId,
    authenticatorData: base64urlEncode(auth),
    clientDataJSON: base64urlEncode(client),
    signature: base64urlEncode(
      sign("sha256", Buffer.concat([auth, sha256(client)]), {
        key: privateKey,
        dsaEncoding: "der",
      }),
    ),
  };
}

const ALLOWED = [
  { kind: "control" as const, op: "add" as const, name: "email" },
  { kind: "control" as const, op: "add" as const, name: "phone" },
];
const PASS_HEAD = `
<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<input name="email" />
<input name="phone" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;

function declared(
  planId: string,
  allowed: { kind: "control"; op: "add"; name: string }[] = ALLOWED,
) {
  const rec = buildObservableScopeRecord({
    planId,
    xbriefRelPath: `xbrief/active/${planId}.xbrief.json`,
    allowedChanges: allowed,
    humanApproval: {
      kind: "declared",
      actor: "agent",
      mintedAt: "2026-11-23T00:00:00Z",
      mintedVia: "scope:record-observable-scope",
    },
  });
  if ("error" in rec) throw new Error(rec.error);
  return rec;
}

function entryOf(rec: ReturnType<typeof declared>): RecordApprovalEntry {
  return {
    kind: "observable-scope",
    planId: rec.planId,
    xbriefRelPath: rec.xbriefRelPath,
    recordRel: `.deft/observable-scope/${rec.planId}.json`,
    changeKind: rec.changeKind,
    contractDigest: rec.contractDigest,
  };
}

function signedRun(records: object[], planId: string, level: SignedLevel = signedLevel) {
  return evaluateObservableScope({
    projectRoot: "/tmp/x",
    mergeBase: "base",
    changedFiles: ["ui.html"],
    policyTextAtBase: policy,
    planId,
    recordTextsAtBase: new Map(
      records.map((r) => [
        `.deft/observable-scope/${String((r as { planId: string }).planId)}.json`,
        `${JSON.stringify(r, null, 2)}\n`,
      ]),
    ),
    readAtBase: (rel: string) => (rel === "ui.html" ? BASE_HTML : null),
    readAtHead: (rel: string) => (rel === "ui.html" ? PASS_HEAD : null),
    approvalLevel: level,
  });
}

describe("evaluateObservableScope signed level (#6945)", () => {
  it("passes a record whose approval verifies and names the approver from the trust file", () => {
    const rec = declared("story-1");
    const result = signedRun([{ ...rec, approval: approveEntries([entryOf(rec)]) }], "story-1");
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/Signed level: approved by yubikey; root packed/);
  });

  it("refuses an agent-written record without a valid signature, however it was merged", () => {
    const rec = declared("story-1");
    const result = signedRun([rec], "story-1");
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/not approved at the signed level/);
    expect(result.message).toMatch(/treated as absent/);
    expect(result.message).toMatch(/user-verified gesture by an enrolled authenticator/);
    const agentKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const forged = { ...rec, approval: approveEntries([entryOf(rec)], agentKey) };
    expect(signedRun([forged], "story-1").code).toBe(1);
  });

  it("refuses a later records-only widen that keeps the old approval", () => {
    const rec = declared("story-1");
    const approval = approveEntries([entryOf(rec)]);
    const widened = declared("story-1", [...ALLOWED, { kind: "control", op: "add", name: "fax" }]);
    expect(signedRun([{ ...widened, approval }], "story-1").code).toBe(1);
  });

  it("checks only the selected record: a stale plan A record does not fail plan B", () => {
    const a = declared("story-a");
    const b = declared("story-b");
    const records = [a, { ...b, approval: approveEntries([entryOf(b)]) }];
    expect(signedRun(records, "story-b").code).toBe(0);
    expect(signedRun(records, "story-a").code).toBe(1);
  });

  it("refuses when the trust file is broken (1) or the clone is shallow (2)", () => {
    const rec = declared("story-1");
    const ok = { ...rec, approval: approveEntries([entryOf(rec)]) };
    const broken = signedRun([ok], "story-1", {
      level: "signed",
      ok: false,
      code: 1,
      reason: "deleted at abc",
    });
    expect(broken.code).toBe(1);
    expect(broken.message).toMatch(/deleted at abc/);
    const shallow = signedRun([ok], "story-1", {
      level: "signed",
      ok: false,
      code: 2,
      reason: "shallow clone",
    });
    expect(shallow.code).toBe(2);
  });

  it("keeps today's behaviour without a trust file", () => {
    expect(signedRun([declared("story-1")], "story-1", { level: "none" }).code).toBe(0);
  });
});
