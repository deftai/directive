import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCreatedUpdatedChronology } from "./chronology.js";
import { evaluateConformance } from "./conformance.js";
import { validateAll } from "./validate-all.js";

const CREATED = "2026-06-01T12:03:00Z";
const UPDATED_BEFORE = "2026-06-01T12:00:43Z";
const UPDATED_AFTER = "2026-06-01T12:05:00Z";

describe("validateCreatedUpdatedChronology (#4423)", () => {
  it("warns when envelope updated predates created", () => {
    const warnings = validateCreatedUpdatedChronology(
      {
        xBRIEFInfo: { version: "0.8", created: CREATED, updated: UPDATED_BEFORE },
        plan: { title: "T", status: "pending", items: [] },
      },
      "xbrief/pending/story.xbrief.json",
    );
    expect(warnings).toEqual([
      "xbrief/pending/story.xbrief.json: xBRIEFInfo.updated " +
        `(${UPDATED_BEFORE}) predates xBRIEFInfo.created (${CREATED})`,
    ]);
  });

  it("warns when plan updated predates created", () => {
    const warnings = validateCreatedUpdatedChronology(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "pending",
          created: CREATED,
          updated: UPDATED_BEFORE,
          items: [],
        },
      },
      "xbrief/pending/story.xbrief.json",
    );
    expect(warnings.some((w) => w.includes("plan.updated"))).toBe(true);
  });

  it("is silent when created is absent or updated is later", () => {
    expect(
      validateCreatedUpdatedChronology(
        {
          xBRIEFInfo: { version: "0.8", updated: UPDATED_BEFORE },
          plan: { title: "T", status: "pending", items: [] },
        },
        "x.json",
      ),
    ).toEqual([]);
    expect(
      validateCreatedUpdatedChronology(
        {
          xBRIEFInfo: { version: "0.8", created: CREATED, updated: UPDATED_AFTER },
          plan: {
            title: "T",
            status: "pending",
            created: CREATED,
            updated: UPDATED_AFTER,
            items: [],
          },
        },
        "x.json",
      ),
    ).toEqual([]);
  });

  it("does not lint item completed/created/updated", () => {
    const warnings = validateCreatedUpdatedChronology(
      {
        xBRIEFInfo: { version: "0.8", created: CREATED, updated: UPDATED_AFTER },
        plan: {
          title: "T",
          status: "pending",
          items: [
            {
              title: "item",
              status: "completed",
              created: CREATED,
              completed: UPDATED_BEFORE,
              updated: UPDATED_BEFORE,
            },
          ],
        },
      },
      "x.json",
    );
    expect(warnings).toEqual([]);
  });

  it("skips unparseable timestamps", () => {
    expect(
      validateCreatedUpdatedChronology(
        {
          xBRIEFInfo: { version: "0.8", created: "not-a-date", updated: UPDATED_BEFORE },
          plan: { title: "T", status: "pending", items: [] },
        },
        "x.json",
      ),
    ).toEqual([]);
  });

  it("warns on a legacy vBRIEFInfo envelope and ignores non-object envelopes", () => {
    const warnings = validateCreatedUpdatedChronology(
      {
        vBRIEFInfo: { version: "0.6", created: CREATED, updated: UPDATED_BEFORE },
        xBRIEFInfo: "not-an-object",
        plan: null,
      },
      "legacy.vbrief.json",
    );
    expect(warnings).toEqual([
      "legacy.vbrief.json: vBRIEFInfo.updated " +
        `(${UPDATED_BEFORE}) predates vBRIEFInfo.created (${CREATED})`,
    ]);
  });

  it("skips empty created/updated strings", () => {
    expect(
      validateCreatedUpdatedChronology(
        {
          xBRIEFInfo: { version: "0.8", created: "", updated: UPDATED_BEFORE },
          plan: { title: "T", status: "pending", created: CREATED, updated: "" },
        },
        "x.json",
      ),
    ).toEqual([]);
  });
});

describe("validateAll chronology channel (#4423)", () => {
  let root: string;
  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces reversed pairs as warnings, not errors", () => {
    root = mkdtempSync(join(tmpdir(), "vb-chrono-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    writeFileSync(
      join(vbrief, "pending", "2026-06-01-reversed.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", created: CREATED, updated: UPDATED_BEFORE },
        plan: {
          title: "Reversed",
          status: "pending",
          created: CREATED,
          updated: UPDATED_BEFORE,
          items: [],
        },
      }),
      "utf8",
    );
    const { errors, warnings } = validateAll(vbrief);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("predates") && w.includes("xBRIEFInfo"))).toBe(true);
  });
});

describe("verify:vbrief-conformance chronology channel (#4423)", () => {
  let root: string;
  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports chronology warnings without failing the gate", () => {
    root = mkdtempSync(join(tmpdir(), "vb-conf-chrono-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "pending", "2026-06-01-reversed.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", created: CREATED, updated: UPDATED_BEFORE },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );
    execSync("git init", { cwd: root, stdio: "ignore" });
    execSync("git add -A", { cwd: root, stdio: "ignore" });
    const result = evaluateConformance(root);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("chronology warning");
    expect(result.message).toContain("predates");
  });

  it("keeps chronology warnings on the bare-key fail path", () => {
    root = mkdtempSync(join(tmpdir(), "vb-conf-chrono-fail-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "pending", "2026-06-01-reversed.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", created: CREATED, updated: UPDATED_BEFORE },
        plan: { title: "T", status: "pending", items: [], bareField: true },
      }),
      "utf8",
    );
    execSync("git init", { cwd: root, stdio: "ignore" });
    execSync("git add -A", { cwd: root, stdio: "ignore" });
    const result = evaluateConformance(root);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("bare key");
    expect(result.message).toContain("chronology warning");
  });
});
