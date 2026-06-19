import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyIssue,
  DEFAULT_HOLD_MARKERS,
  extractReferencedIssues,
  listProject,
  renderList,
  resolveClassifyRules,
  resolveHoldMarkers,
  UNIVERSAL_RULES,
  validateClassifyRules,
  validateHoldMarkers,
  validateProject,
  validateTriageAutoClassifyOnPlan,
  validateTriageHoldMarkersOnPlan,
} from "./index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function issue(
  n: number,
  opts: {
    state?: string;
    body?: string;
    labels?: string[];
    updatedAt?: string;
    createdAt?: string;
  } = {},
) {
  return {
    number: n,
    state: opts.state ?? "open",
    body: opts.body ?? "",
    labels: (opts.labels ?? []).map((label) => ({ name: label })),
    updated_at: opts.updatedAt ?? "2026-05-17T00:00:00Z",
    created_at: opts.createdAt ?? "2026-05-17T00:00:00Z",
  };
}

function now(): Date {
  return new Date("2026-05-17T21:00:00.000Z");
}

function writeProjectDefinition(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan }),
    "utf8",
  );
}

function makeRepo(plan?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-classify-"));
  temps.push(root);
  if (plan !== undefined) {
    writeProjectDefinition(root, plan);
  }
  return root;
}

describe("universal hold-marker rule", () => {
  it.each([
    "do not implement",
    "DO NOT IMPLEMENT",
    "BLOCKED",
    "blocked: waiting on legal",
    "HOLDING",
    "Holding / capture only",
    "holding / capture only -- ignore for now",
  ])("fires on marker %s", (markerText) => {
    const result = classifyIssue(
      issue(1, { body: `Some preamble. ${markerText}\nMore details.` }),
      {
        now: now(),
      },
    );
    expect(result).not.toBeNull();
    expect(result?.action).toBe("defer");
    expect(result?.reason).toBe("hold marker in body");
    expect(result?.ruleSource).toBe("framework");
    expect(result?.ruleKind).toBe("universal:hold-marker");
  });

  it("does not fire on clean body", () => {
    expect(
      classifyIssue(issue(1, { body: "A normal feature request with acceptance criteria." }), {
        now: now(),
      }),
    ).toBeNull();
  });

  it("uses configured hold phrases", () => {
    const blocked = issue(1, { body: "WONTFIX upstream" });
    expect(classifyIssue(blocked, { now: now() })).toBeNull();
    const result = classifyIssue(blocked, { holdMarkers: ["WONTFIX"], now: now() });
    expect(result?.ruleKind).toBe("universal:hold-marker");
  });

  it("silences when hold markers empty", () => {
    const blocked = issue(1, { body: "BLOCKED upstream" });
    expect(classifyIssue(blocked, { now: now() })).not.toBeNull();
    expect(classifyIssue(blocked, { holdMarkers: [], now: now() })).toBeNull();
  });
});

describe("universal closed-never-triaged rule", () => {
  it("archives closed issues without triage decision", () => {
    const result = classifyIssue(issue(2, { state: "closed", body: "Was a duplicate" }), {
      hasTriageDecision: false,
      now: now(),
    });
    expect(result?.action).toBe("archive");
    expect(result?.ruleKind).toBe("universal:closed-never-triaged");
  });

  it("skips when prior triage decision exists", () => {
    expect(
      classifyIssue(issue(2, { state: "closed", body: "Has prior decision" }), {
        hasTriageDecision: true,
        now: now(),
      }),
    ).toBeNull();
  });
});

describe("universal dormant-thin-body rule", () => {
  it("defers stale thin-body open issues", () => {
    const stale = "2026-01-18T00:00:00Z";
    const result = classifyIssue(
      issue(3, { body: "too short", updatedAt: stale, createdAt: stale }),
      {
        now: now(),
      },
    );
    expect(result?.action).toBe("defer");
    expect(result?.reason).toBe("dormant; needs AC refresh");
    expect(result?.ruleKind).toBe("universal:dormant-thin-body");
  });

  it("skips recent issues", () => {
    const recent = "2026-04-17T00:00:00Z";
    expect(
      classifyIssue(issue(3, { body: "too short", updatedAt: recent, createdAt: recent }), {
        now: now(),
      }),
    ).toBeNull();
  });

  it("skips when body is full", () => {
    const stale = "2026-01-18T00:00:00Z";
    expect(
      classifyIssue(issue(3, { body: "x".repeat(60), updatedAt: stale, createdAt: stale }), {
        now: now(),
      }),
    ).toBeNull();
  });
});

describe("universal vbrief-referenced rule", () => {
  it("accepts referenced issues", () => {
    const result = classifyIssue(issue(42, { body: "Issue 42 details" }), {
      vbriefReferenced: new Set([42, 99]),
      now: now(),
    });
    expect(result?.action).toBe("accept");
    expect(result?.ruleKind).toBe("universal:vbrief-referenced");
  });

  it("skips unreferenced issues", () => {
    expect(
      classifyIssue(issue(42, { body: "Standalone" }), {
        vbriefReferenced: new Set([99]),
        now: now(),
      }),
    ).toBeNull();
  });
});

describe("consumer rule layering", () => {
  it("appends consumer rules after universal rules", () => {
    const rules = resolveClassifyRules({
      projectDefinition: {
        plan: {
          policy: {
            triageAutoClassify: [
              {
                match: { labels: { "any-of": ["wontfix"] } },
                action: "defer",
                reason: "wontfix",
              },
            ],
          },
        },
      },
    });
    expect(rules).toHaveLength(5);
    expect(rules[0]?.rule?.startsWith("universal:")).toBe(true);
    expect(rules[4]?.reason).toBe("wontfix");
  });

  it("first match wins for universal over consumer", () => {
    const rules = [
      ...UNIVERSAL_RULES.map((r) => ({ ...r })),
      {
        match: { labels: { "any-of": ["wontfix"] } },
        action: "defer",
        reason: "wontfix per consumer rule",
      },
    ];
    const result = classifyIssue(issue(1, { body: "BLOCKED upstream", labels: ["wontfix"] }), {
      rules,
      now: now(),
    });
    expect(result?.ruleIndex).toBe(0);
    expect(result?.ruleKind).toBe("universal:hold-marker");
  });

  it("evaluates consumer rules in declared order", () => {
    const rules = [
      ...UNIVERSAL_RULES.map((r) => ({ ...r })),
      {
        match: { labels: { "any-of": ["bug"] } },
        action: "escalate",
        reason: "fires first",
      },
      {
        match: { labels: { "any-of": ["rfc"] } },
        action: "defer",
        reason: "would fire second but never",
      },
    ];
    const result = classifyIssue(issue(3, { body: "OK feature.", labels: ["bug", "rfc"] }), {
      rules,
      now: now(),
    });
    expect(result?.reason).toBe("fires first");
    expect(result?.ruleIndex).toBe(4);
  });
});

describe("consumer match predicates", () => {
  it("labels all-of requires all labels", () => {
    const rules = [
      {
        match: { labels: { "all-of": ["bug", "regression"] } },
        action: "escalate",
        reason: "p0 bug",
      },
    ];
    expect(
      classifyIssue(issue(1, { body: "x".repeat(80), labels: ["bug"] }), { rules, now: now() }),
    ).toBeNull();
    const result = classifyIssue(
      issue(1, { body: "x".repeat(80), labels: ["bug", "regression"] }),
      { rules, now: now() },
    );
    expect(result?.action).toBe("escalate");
  });

  it("body-text match is case-insensitive", () => {
    const rules = [
      {
        match: { "body-text": { "any-of": ["exploratory"] } },
        action: "defer",
        reason: "exploratory",
      },
    ];
    const result = classifyIssue(issue(1, { body: "This is exploratory; just a thought." }), {
      rules,
      now: now(),
    });
    expect(result?.action).toBe("defer");
  });

  it("age-days match respects threshold", () => {
    const stale = "2026-03-18T00:00:00Z";
    const rules = [
      {
        match: { "age-days": { gt: 30 }, state: "open" },
        action: "defer",
        reason: "stale",
      },
    ];
    const result = classifyIssue(
      issue(1, { body: "x".repeat(80), updatedAt: stale, createdAt: stale }),
      { rules, now: now() },
    );
    expect(result?.action).toBe("defer");
  });

  it("surfaces resume-on in result", () => {
    const rules = [
      {
        match: { labels: { "any-of": ["fixed-pending-merge"] } },
        action: "defer",
        reason: "fixed pending merge",
        "resume-on": "label-removed",
      },
    ];
    const result = classifyIssue(
      issue(1, { body: "x".repeat(80), labels: ["fixed-pending-merge"] }),
      {
        rules,
        now: now(),
      },
    );
    expect(result?.resumeOn).toBe("label-removed");
  });
});

describe("resolve helpers", () => {
  it("returns only universal rules when unset", () => {
    const root = makeRepo({ title: "x", status: "running", items: [] });
    const rules = resolveClassifyRules({ projectRoot: root });
    expect(rules).toHaveLength(4);
    for (const r of rules) {
      expect(r.rule?.startsWith("universal:")).toBe(true);
    }
  });

  it("returns default hold markers", () => {
    expect(resolveHoldMarkers({ projectDefinition: null })).toEqual([...DEFAULT_HOLD_MARKERS]);
  });

  it("respects hold marker override", () => {
    const root = makeRepo({
      title: "x",
      status: "running",
      items: [],
      policy: { triageHoldMarkers: ["WONTFIX", "PARKED"] },
    });
    expect(resolveHoldMarkers({ projectRoot: root })).toEqual(["WONTFIX", "PARKED"]);
  });

  it("empty hold marker list silences defaults", () => {
    const root = makeRepo({
      title: "x",
      status: "running",
      items: [],
      policy: { triageHoldMarkers: [] },
    });
    expect(resolveHoldMarkers({ projectRoot: root })).toEqual([]);
  });
});

describe("schema validation", () => {
  it("accepts null and empty list", () => {
    expect(validateClassifyRules(null).errors).toEqual([]);
    expect(validateClassifyRules([]).errors).toEqual([]);
    expect(validateHoldMarkers(null).errors).toEqual([]);
    expect(validateHoldMarkers([]).errors).toEqual([]);
  });

  it("rejects non-list classify rules", () => {
    const { errors } = validateClassifyRules({ oops: true });
    expect(errors[0]).toContain("must be a list");
  });

  it("rejects unknown action", () => {
    const { errors } = validateClassifyRules([
      {
        match: { labels: { "any-of": ["x"] } },
        action: "delete-the-issue",
        reason: "evil",
      },
    ]);
    expect(errors.some((e) => e.includes("action"))).toBe(true);
  });

  it("rejects empty match block", () => {
    const { errors } = validateClassifyRules([{ match: {}, action: "defer", reason: "??" }]);
    expect(errors.some((e) => e.includes("at least one of"))).toBe(true);
  });

  it("rejects universal rule rebinding", () => {
    const { errors } = validateClassifyRules([
      {
        rule: "universal:hold-marker",
        match: { labels: { "any-of": ["x"] } },
        action: "defer",
        reason: "trying to override",
      },
    ]);
    expect(errors.some((e) => e.includes("reserved"))).toBe(true);
  });

  it("warns on extra match predicates", () => {
    const { warnings } = validateClassifyRules([
      {
        match: { labels: { "any-of": ["x"] }, "made-up-key": true },
        action: "defer",
        reason: "??",
      },
    ]);
    expect(warnings.some((w) => w.includes("unrecognised predicate"))).toBe(true);
  });
});

describe("vbrief_validate hooks", () => {
  it("returns empty when unset", () => {
    expect(validateTriageAutoClassifyOnPlan({ title: "x", status: "running" }, "x.json")).toEqual(
      [],
    );
    expect(validateTriageHoldMarkersOnPlan({ title: "x", status: "running" }, "x.json")).toEqual(
      [],
    );
  });

  it("surfaces classify errors with #1129 pointer", () => {
    const out = validateTriageAutoClassifyOnPlan(
      { policy: { triageAutoClassify: [{ match: {}, action: "defer", reason: "??" }] } },
      "x.json",
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => e.includes("(#1129)"))).toBe(true);
  });
});

describe("extractReferencedIssues", () => {
  it("pulls from pending and active only", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-triage-classify-refs-"));
    temps.push(root);
    const vbriefDir = join(root, "vbrief");
    for (const folder of ["pending", "active", "completed"]) {
      mkdirSync(join(vbriefDir, folder), { recursive: true });
    }
    const writeVbrief = (folder: string, name: string, issueN: number) => {
      writeFileSync(
        join(vbriefDir, folder, `2026-05-17-${name}.vbrief.json`),
        JSON.stringify({
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: name,
            status: "running",
            items: [],
            references: [
              {
                uri: `https://github.com/o/r/issues/${issueN}`,
                type: "x-vbrief/github-issue",
              },
            ],
          },
        }),
        "utf8",
      );
    };
    writeVbrief("pending", "a", 11);
    writeVbrief("active", "b", 22);
    writeVbrief("completed", "c", 33);
    expect(extractReferencedIssues(root)).toEqual(new Set([11, 22]));
  });
});

describe("renderList", () => {
  it("includes universal and consumer rules", () => {
    const rules = [
      ...UNIVERSAL_RULES.map((r) => ({ ...r })),
      {
        match: { labels: { "any-of": ["bug"] } },
        action: "escalate",
        reason: "p0",
      },
    ];
    const out = renderList(rules, { holdMarkers: ["BLOCKED"] });
    expect(out).toContain("universal:hold-marker");
    expect(out).toContain("consumer rule");
    expect(out).toContain("BLOCKED");
  });
});

describe("framework boundary", () => {
  it("defaults do not reference deft-specific labels", () => {
    const blob = JSON.stringify([UNIVERSAL_RULES, DEFAULT_HOLD_MARKERS]);
    for (const forbidden of [
      "status:superseded-pending",
      "rfc",
      "type:research",
      "wontfix",
      "duplicate",
      "fixed-pending-merge",
    ]) {
      expect(blob.includes(forbidden)).toBe(false);
    }
  });
});

describe("validateProject and listProject", () => {
  it("validateProject ok when project definition missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-triage-classify-val-"));
    temps.push(root);
    mkdirSync(join(root, "vbrief"), { recursive: true });
    const result = validateProject(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no PROJECT-DEFINITION");
  });

  it("validateProject fails on malformed plan", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-triage-classify-val-"));
    temps.push(root);
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: null }),
      "utf8",
    );
    const result = validateProject(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("plan is not an object");
  });

  it("validateProject ok on valid consumer config", () => {
    const root = makeRepo({
      title: "x",
      status: "running",
      items: [],
      policy: {
        triageAutoClassify: [
          {
            match: { labels: { "any-of": ["bug"] } },
            action: "escalate",
            reason: "p0",
          },
        ],
      },
    });
    const result = validateProject(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("valid");
  });

  it("listProject renders newline-terminated output", () => {
    const root = makeRepo({ title: "x", status: "running", items: [] });
    const out = listProject(root);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("universal:hold-marker");
  });
});

describe("additional validation branches", () => {
  it("rejects missing reason and bad resume-on", () => {
    expect(
      validateClassifyRules([
        { match: { labels: { "any-of": ["x"] } }, action: "defer" },
      ]).errors.some((e) => e.includes("reason")),
    ).toBe(true);
    expect(
      validateClassifyRules([
        {
          match: { labels: { "any-of": ["x"] } },
          action: "defer",
          reason: "??",
          "resume-on": "",
        },
      ]).errors.some((e) => e.includes("resume-on")),
    ).toBe(true);
  });

  it("rejects label predicate shape errors", () => {
    const { errors } = validateClassifyRules([
      {
        match: { labels: { "any-of": ["a"], "all-of": ["b"] } },
        action: "defer",
        reason: "??",
      },
    ]);
    expect(errors.some((e) => e.includes("mutually exclusive"))).toBe(true);
  });

  it("rejects bad state and age-days", () => {
    expect(
      validateClassifyRules([
        {
          match: { state: "mystery", labels: { "any-of": ["x"] } },
          action: "defer",
          reason: "??",
        },
      ]).errors.some((e) => e.includes("state")),
    ).toBe(true);
    expect(
      validateClassifyRules([
        { match: { "age-days": { gt: -5 } }, action: "defer", reason: "??" },
      ]).errors.some((e) => e.includes("age-days")),
    ).toBe(true);
  });

  it("hold marker validation rejects non-list and empty strings", () => {
    expect(validateHoldMarkers("BLOCKED").errors[0]).toContain("must be a list");
    expect(validateHoldMarkers(["", "BLOCKED"]).errors.length).toBeGreaterThan(0);
  });

  it("hook surfaces hold marker errors", () => {
    const out = validateTriageHoldMarkersOnPlan({ policy: { triageHoldMarkers: "" } }, "x.json");
    expect(out.length).toBeGreaterThan(0);
  });

  it("closed state with consumer rule uses universal first", () => {
    const rules = [
      ...UNIVERSAL_RULES.map((r) => ({ ...r })),
      { match: { state: "closed" }, action: "archive", reason: "closed" },
    ];
    const result = classifyIssue(issue(1, { state: "closed", body: "x".repeat(80) }), {
      rules,
      now: now(),
    });
    expect(result?.ruleKind).toBe("universal:closed-never-triaged");
  });

  it("renderList uses default markers", () => {
    expect(renderList(UNIVERSAL_RULES)).toContain("do not implement");
  });

  it("renderList formats consumer rule parts", () => {
    const out = renderList([
      {
        match: {
          labels: { "all-of": ["bug", "reg"] },
          "body-text": { "any-of": ["explore"] },
          state: "open",
          "age-days": { gt: 10 },
        },
        action: "defer",
        reason: "combo",
        "resume-on": "label-removed",
      },
    ]);
    expect(out).toContain("labels.all-of");
    expect(out).toContain("body-text.any-of");
    expect(out).toContain("age-days.gt");
    expect(out).toContain("resume-on");
  });

  it("consumer rule match rejects malformed predicates", () => {
    const stale = "2026-01-18T00:00:00Z";
    const base = issue(1, { body: "x".repeat(80), updatedAt: stale, createdAt: stale });
    expect(
      classifyIssue(base, {
        rules: [{ match: { labels: {} }, action: "defer", reason: "x" }],
        now: now(),
      }),
    ).toBeNull();
    expect(
      classifyIssue(base, {
        rules: [{ match: { "body-text": {} }, action: "defer", reason: "x" }],
        now: now(),
      }),
    ).toBeNull();
    expect(
      classifyIssue(base, {
        rules: [{ match: { "age-days": { gt: "bad" } }, action: "defer", reason: "x" }],
        now: now(),
      }),
    ).toBeNull();
  });

  it("dormant rule skips when timestamps missing", () => {
    expect(
      classifyIssue({ number: 1, state: "open", body: "short", labels: [] }, { now: now() }),
    ).toBeNull();
  });

  it("resolve classify rules from empty consumer list", () => {
    const root = makeRepo({
      title: "x",
      status: "running",
      items: [],
      policy: { triageAutoClassify: [] },
    });
    expect(resolveClassifyRules({ projectRoot: root })).toHaveLength(4);
  });

  it("resolve classify rules with missing project definition dir", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-triage-classify-missing-"));
    temps.push(root);
    expect(resolveClassifyRules({ projectRoot: root })).toHaveLength(4);
  });

  it("extractReferencedIssues skips malformed vbrief files", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-triage-classify-bad-"));
    temps.push(root);
    const pending = join(root, "vbrief", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, "bad.vbrief.json"), "not json", "utf8");
    writeFileSync(
      join(pending, "good.vbrief.json"),
      JSON.stringify({
        plan: {
          references: [{ type: "other", uri: "https://github.com/o/r/issues/5" }],
        },
      }),
      "utf8",
    );
    expect(extractReferencedIssues(root)).toEqual(new Set());
  });
});

describe("python-compatible validation messages", () => {
  it("uses python type names in errors", () => {
    expect(validateClassifyRules({ oops: true }).errors[0]).toContain("got dict");
    expect(validateHoldMarkers("BLOCKED").errors[0]).toContain("got str");
  });
});
