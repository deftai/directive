import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1,
  DEFAULT_CHECK_RESUME_LOCAL_STAMP,
  FIELD_CHECK_RESUME,
  FIELD_CHECK_RESUME_CLI_ALIAS,
  formatCheckResumeStatusLine,
  inspectCheckResume,
  isCiTrustsLocalStampAllowed,
  isLocalStampResumeAllowed,
  resolveCheckResume,
  validateCheckResume,
  writeCheckResume,
} from "./check-resume.js";
import {
  applyHatchAwareCoverageCheckResumePreset,
  applyLaterCoverageCheckResumeSkip,
  applyStrictCoverageCheckResumePreset,
  dismissCoverageCheckResume,
  isCoverageCheckResumeUndecided,
} from "./coverage-check-resume-presets.js";
import {
  coverageDebtLedgerRepoIsSelfOnly,
  DEFAULT_COVERAGE_DEBT_MODE,
  FIELD_COVERAGE_DEBT,
  FIELD_COVERAGE_DEBT_CLI_ALIAS,
  formatCoverageDebtStatusLine,
  inspectCoverageDebt,
  isCoverageDebtAutoFileAllowed,
  isCoverageDebtHatchAllowed,
  resolveCoverageDebt,
  validateCoverageDebt,
  writeCoverageDebt,
} from "./coverage-debt.js";
import { inspectOnePolicy } from "./index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(plan?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-coverage-debt-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], ...plan },
    }),
    "utf8",
  );
  return root;
}

describe("validateCoverageDebt / validateCheckResume", () => {
  it("accepts null/undefined", () => {
    expect(validateCoverageDebt(null)).toEqual([]);
    expect(validateCheckResume(undefined)).toEqual([]);
  });

  it("rejects non-objects and bad enums", () => {
    expect(validateCoverageDebt("x")[0]).toContain("must be an object");
    expect(validateCoverageDebt({ status: "maybe" })[0]).toContain("status");
    expect(validateCoverageDebt({ mode: "soft" })[0]).toContain("mode");
    expect(validateCheckResume({ localStamp: "maybe" })[0]).toContain("localStamp");
    expect(validateCheckResume({ ciTrustsLocalStamp: true })[0]).toContain(
      "ciTrustsLocalStamp must be false",
    );
  });
});

describe("fail-closed defaults when unset (#3189)", () => {
  it("missing coverageDebt/checkResume → mode off, localStamp off, CI never trusts", () => {
    const root = makeRepo({ policy: { wipCap: 10 } });
    const debt = resolveCoverageDebt(root);
    const resume = resolveCheckResume(root);
    expect(debt.status).toBe("unset");
    expect(debt.mode).toBe(DEFAULT_COVERAGE_DEBT_MODE);
    expect(debt.autoFile).toBe(false);
    expect(isCoverageDebtHatchAllowed(debt)).toBe(false);
    expect(isCoverageDebtAutoFileAllowed(debt)).toBe(false);
    expect(resume.status).toBe("unset");
    expect(resume.localStamp).toBe(DEFAULT_CHECK_RESUME_LOCAL_STAMP);
    expect(resume.ciTrustsLocalStamp).toBe(false);
    expect(isLocalStampResumeAllowed(resume)).toBe(false);
    expect(isCiTrustsLocalStampAllowed(resume)).toBe(false);
    expect(CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1).toBe(false);
    expect(isCoverageCheckResumeUndecided(root)).toBe(true);
  });

  it("typed status unset still fails closed even if mode=hatch is present", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: { status: "unset", mode: "hatch", autoFile: true },
        checkResume: { status: "unset", localStamp: "on", ciTrustsLocalStamp: false },
      },
    });
    const debt = resolveCoverageDebt(root);
    const resume = resolveCheckResume(root);
    expect(debt.mode).toBe("off");
    expect(debt.autoFile).toBe(false);
    expect(isCoverageDebtHatchAllowed(debt)).toBe(false);
    expect(resume.localStamp).toBe("off");
    expect(isLocalStampResumeAllowed(resume)).toBe(false);
  });

  it("decided-off is quiet for hatch/stamp but not undecided", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: { status: "decided", mode: "off", autoFile: false },
        checkResume: { status: "decided", localStamp: "off", ciTrustsLocalStamp: false },
      },
    });
    expect(isCoverageCheckResumeUndecided(root)).toBe(false);
    expect(isCoverageDebtHatchAllowed(resolveCoverageDebt(root))).toBe(false);
    expect(isLocalStampResumeAllowed(resolveCheckResume(root))).toBe(false);
  });
});

describe("presets write PD and stop nag", () => {
  it("Strict writes mode=off localStamp=off decided", () => {
    const root = makeRepo({ policy: {} });
    const result = applyStrictCoverageCheckResumePreset(root);
    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.preset).toBe("strict");
    const debt = resolveCoverageDebt(root);
    const resume = resolveCheckResume(root);
    expect(debt).toMatchObject({ status: "decided", mode: "off", autoFile: false });
    expect(resume).toMatchObject({ status: "decided", localStamp: "off" });
    expect(isCoverageCheckResumeUndecided(root)).toBe(false);
  });

  it("Hatch-aware writes hatch + localStamp on; autoFile false; CI trust false", () => {
    const root = makeRepo({ policy: {} });
    const result = applyHatchAwareCoverageCheckResumePreset(root);
    expect(result.exitCode).toBe(0);
    const debt = resolveCoverageDebt(root);
    const resume = resolveCheckResume(root);
    expect(debt).toMatchObject({ status: "decided", mode: "hatch", autoFile: false });
    expect(isCoverageDebtHatchAllowed(debt)).toBe(true);
    expect(isCoverageDebtAutoFileAllowed(debt)).toBe(false);
    expect(resume.localStamp).toBe("on");
    expect(isLocalStampResumeAllowed(resume)).toBe(true);
    expect(resume.ciTrustsLocalStamp).toBe(false);
  });

  it("Later does not mark decided", () => {
    const root = makeRepo({ policy: {} });
    const result = applyLaterCoverageCheckResumeSkip();
    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.preset).toBe("later");
    expect(result.stdout).toContain("not decided");
    expect(isCoverageCheckResumeUndecided(root)).toBe(true);
  });

  it("dismiss-with-reason decides fail-closed and records reason", () => {
    const root = makeRepo({ policy: {} });
    const empty = dismissCoverageCheckResume(root, "   ");
    expect(empty.exitCode).toBe(1);
    const result = dismissCoverageCheckResume(root, "defer until Q3");
    expect(result.exitCode).toBe(0);
    expect(result.preset).toBe("dismiss");
    const debt = resolveCoverageDebt(root);
    expect(debt.status).toBe("decided");
    expect(debt.mode).toBe("off");
    expect(debt.dismissReason).toBe("defer until Q3");
    expect(isCoverageCheckResumeUndecided(root)).toBe(false);
  });
});

describe("policy:show surface", () => {
  it("inspectCoverageDebt / inspectCheckResume + CLI aliases", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: { status: "decided", mode: "warn", autoFile: false },
        checkResume: { status: "decided", localStamp: "on", ciTrustsLocalStamp: false },
      },
    });
    const [data] = [
      JSON.parse(
        readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
      ) as Record<string, unknown>,
    ];
    const debtField = inspectCoverageDebt(data, root);
    expect(debtField.name).toBe(FIELD_COVERAGE_DEBT);
    expect(debtField.current).toMatchObject({ status: "decided", mode: "warn" });
    const resumeField = inspectCheckResume(data, root);
    expect(resumeField.name).toBe(FIELD_CHECK_RESUME);
    expect(resumeField.current).toMatchObject({ localStamp: "on", ciTrustsLocalStamp: false });

    const byAliasDebt = inspectOnePolicy(FIELD_COVERAGE_DEBT_CLI_ALIAS, root);
    const byAliasResume = inspectOnePolicy(FIELD_CHECK_RESUME_CLI_ALIAS, root);
    expect(byAliasDebt?.name).toBe(FIELD_COVERAGE_DEBT);
    expect(byAliasResume?.name).toBe(FIELD_CHECK_RESUME);
  });
});

describe("non-goal: consumer never auto-files on deftai/directive ledger", () => {
  it("documents ledger is always self-repo only", () => {
    expect(coverageDebtLedgerRepoIsSelfOnly()).toBe(true);
  });

  it("autoFile never enables hatch targeting another repo via policy", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: { status: "decided", mode: "hatch", autoFile: true },
      },
    });
    // Even with autoFile true, there is no field for foreign ledger repo.
    const debt = resolveCoverageDebt(root);
    expect(isCoverageDebtAutoFileAllowed(debt)).toBe(true);
    expect(coverageDebtLedgerRepoIsSelfOnly()).toBe(true);
    // write path also cannot set a foreign ledger
    const write = writeCoverageDebt(root, { mode: "hatch", autoFile: true });
    expect(write.exitCode).toBe(0);
  });
});

describe("write + resolve branch edges (#3189 coverage)", () => {
  it("writeCoverageDebt / writeCheckResume fail when PROJECT-DEFINITION missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ccr-missing-"));
    temps.push(root);
    const debt = writeCoverageDebt(root, { mode: "off" });
    expect(debt.exitCode).toBe(2);
    expect(debt.stdout).toContain("PROJECT-DEFINITION");
    const resume = writeCheckResume(root, { localStamp: "off" });
    expect(resume.exitCode).toBe(2);
  });

  it("write paths no-op when value already matches", () => {
    const root = makeRepo({ policy: {} });
    applyStrictCoverageCheckResumePreset(root);
    const again = applyStrictCoverageCheckResumePreset(root);
    expect(again.exitCode).toBe(0);
    expect(again.changed).toBe(false);
    expect(again.stdout).toContain("no-op");
  });

  it("writeCoverageDebt creates plan/policy when plan is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ccr-plan-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" } }),
      "utf8",
    );
    const result = writeCoverageDebt(root, { mode: "warn" });
    expect(result.exitCode).toBe(0);
    expect(resolveCoverageDebt(root).mode).toBe("warn");
    const resumeRoot = mkdtempSync(join(tmpdir(), "deft-ccr-plan2-"));
    temps.push(resumeRoot);
    mkdirSync(join(resumeRoot, "xbrief"), { recursive: true });
    writeFileSync(
      join(resumeRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" } }),
      "utf8",
    );
    expect(writeCheckResume(resumeRoot, { localStamp: "on" }).exitCode).toBe(0);
  });

  it("inspect helpers default on null data and format dismiss reason", () => {
    expect(inspectCoverageDebt(null).source).toBe("default");
    expect(inspectCheckResume(null).source).toBe("default");
    const root = makeRepo({
      policy: {
        coverageDebt: {
          status: "decided",
          mode: "off",
          autoFile: false,
          dismissReason: "parked",
        },
        checkResume: {
          status: "decided",
          localStamp: "off",
          ciTrustsLocalStamp: false,
          dismissReason: "parked",
        },
      },
    });
    const debt = resolveCoverageDebt(root);
    const resume = resolveCheckResume(root);
    expect(debt.dismissReason).toBe("parked");
    expect(formatCoverageDebtStatusLine(debt)).toContain("parked");
    expect(formatCheckResumeStatusLine(resume)).toContain("parked");
  });

  it("malformed typed blocks fail closed via default-on-error", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: "nope",
        checkResume: ["x"],
      },
    });
    expect(resolveCoverageDebt(root).source).toBe("default-on-error");
    expect(resolveCheckResume(root).source).toBe("default-on-error");
  });

  it("resolveCoverageDebt / resolveCheckResume when PD missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ccr-empty-"));
    temps.push(root);
    expect(resolveCoverageDebt(root).source).toBe("default-on-error");
    expect(resolveCheckResume(root).source).toBe("default-on-error");
  });

  it("write fails on non-object top-level and non-object plan", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ccr-bad-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(["not", "object"]),
      "utf8",
    );
    expect(writeCoverageDebt(root, { mode: "off" }).exitCode).toBe(2);
    expect(writeCheckResume(root, { localStamp: "off" }).exitCode).toBe(2);

    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: "string-plan" }),
      "utf8",
    );
    expect(writeCoverageDebt(root, { mode: "off" }).stdout).toContain("Config error");
    expect(writeCheckResume(root, { localStamp: "on" }).stdout).toContain("Config error");
  });

  it("write fails when plan.policy is a non-object scalar", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ccr-pol-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", "x-directive/policy": "bad" },
      }),
      "utf8",
    );
    expect(writeCoverageDebt(root, { mode: "hatch", autoFile: true }).exitCode).toBe(2);
    expect(writeCheckResume(root, { localStamp: "on" }).exitCode).toBe(2);
  });

  it("hatch mode without autoFile uses default false; warn mode forces autoFile false", () => {
    const root = makeRepo({ policy: {} });
    expect(writeCoverageDebt(root, { mode: "hatch" }).exitCode).toBe(0);
    expect(resolveCoverageDebt(root)).toMatchObject({ mode: "hatch", autoFile: false });
    expect(writeCoverageDebt(root, { mode: "warn", autoFile: true }).exitCode).toBe(0);
    expect(resolveCoverageDebt(root)).toMatchObject({ mode: "warn", autoFile: false });
  });

  it("inspectCoverageDebt uses projectRoot when block absent", () => {
    const root = makeRepo({ policy: { wipCap: 3 } });
    const [data] = [
      JSON.parse(
        readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
      ) as Record<string, unknown>,
    ];
    expect(inspectCoverageDebt(data, root).source).toBe("default");
    expect(inspectCheckResume(data, root).source).toBe("default");
  });
});
