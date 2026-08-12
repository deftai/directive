import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CHECK_RESUME_LOCAL_STAMP,
  FIELD_CHECK_RESUME,
  FIELD_CHECK_RESUME_CLI_ALIAS,
  formatCheckResumeStatusLine,
  inspectCheckResume,
  isLocalStampResumeAllowed,
  resolveCheckResume,
  validateCheckResume,
} from "./check-resume.js";
import {
  coverageCheckResumeDisclosureLine,
  DEFAULT_COVERAGE_DEBT_MODE,
  FIELD_COVERAGE_DEBT,
  FIELD_COVERAGE_DEBT_CLI_ALIAS,
  formatCoverageDebtStatusLine,
  inspectCoverageDebt,
  isCoverageDebtAutoFileAllowed,
  isCoverageDebtHatchAllowed,
  maybeFormatCoverageCheckResumeDisclosure,
  resolveCoverageDebt,
  validateCoverageDebt,
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
    expect(validateCoverageDebt({ mode: "soft" })[0]).toContain("mode");
    expect(validateCoverageDebt({ autoFile: "yes" })[0]).toContain("autoFile");
    expect(validateCheckResume({ localStamp: "maybe" })[0]).toContain("localStamp");
  });

  it("ignores leftover ritual fields instead of rejecting them", () => {
    expect(validateCoverageDebt({ status: "unset", mode: "off", dismissReason: "x" })).toEqual([]);
    expect(
      validateCheckResume({
        status: "decided",
        localStamp: "off",
        ciTrustsLocalStamp: true,
        dismissReason: "x",
      }),
    ).toEqual([]);
  });
});

describe("fail-closed resolution (#3314)", () => {
  it("missing coverageDebt/checkResume → mode off, localStamp off", () => {
    const root = makeRepo({ policy: { wipCap: 10 } });
    const debt = resolveCoverageDebt(root);
    const resume = resolveCheckResume(root);
    expect(debt.mode).toBe(DEFAULT_COVERAGE_DEBT_MODE);
    expect(debt.autoFile).toBe(false);
    expect(debt.source).toBe("default");
    expect(isCoverageDebtHatchAllowed(debt)).toBe(false);
    expect(isCoverageDebtAutoFileAllowed(debt)).toBe(false);
    expect(resume.localStamp).toBe(DEFAULT_CHECK_RESUME_LOCAL_STAMP);
    expect(resume.source).toBe("default");
    expect(isLocalStampResumeAllowed(resume)).toBe(false);
  });

  it("typed mode=hatch / localStamp=on resolve as written (no status gate)", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: { mode: "hatch", autoFile: true },
        checkResume: { localStamp: "on" },
      },
    });
    const debt = resolveCoverageDebt(root);
    const resume = resolveCheckResume(root);
    expect(debt.mode).toBe("hatch");
    expect(debt.autoFile).toBe(true);
    expect(isCoverageDebtHatchAllowed(debt)).toBe(true);
    expect(isCoverageDebtAutoFileAllowed(debt)).toBe(true);
    expect(resume.localStamp).toBe("on");
    expect(isLocalStampResumeAllowed(resume)).toBe(true);
  });

  it("typed mode=off / localStamp=off stay fail-closed", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: { mode: "off", autoFile: false },
        checkResume: { localStamp: "off" },
      },
    });
    expect(isCoverageDebtHatchAllowed(resolveCoverageDebt(root))).toBe(false);
    expect(isLocalStampResumeAllowed(resolveCheckResume(root))).toBe(false);
  });

  it("warn mode is non-hatch and forces autoFile false", () => {
    const root = makeRepo({
      policy: { coverageDebt: { mode: "warn", autoFile: true } },
    });
    const debt = resolveCoverageDebt(root);
    expect(debt.mode).toBe("warn");
    expect(debt.autoFile).toBe(false);
    expect(isCoverageDebtHatchAllowed(debt)).toBe(false);
  });

  it("malformed typed blocks fail closed via default-on-error", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: "nope",
        checkResume: ["x"],
      },
    });
    expect(resolveCoverageDebt(root).source).toBe("default-on-error");
    expect(resolveCoverageDebt(root).mode).toBe("off");
    expect(resolveCheckResume(root).source).toBe("default-on-error");
    expect(resolveCheckResume(root).localStamp).toBe("off");
    expect(isCoverageDebtHatchAllowed(resolveCoverageDebt(root))).toBe(false);
    expect(isLocalStampResumeAllowed(resolveCheckResume(root))).toBe(false);
  });

  it("resolveCoverageDebt / resolveCheckResume when PD missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ccr-empty-"));
    temps.push(root);
    expect(resolveCoverageDebt(root).source).toBe("default-on-error");
    expect(resolveCheckResume(root).source).toBe("default-on-error");
  });
});

describe("policy:show surface", () => {
  it("inspectCoverageDebt / inspectCheckResume + CLI aliases", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: { mode: "warn", autoFile: false },
        checkResume: { localStamp: "on" },
      },
    });
    const data = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as Record<string, unknown>;
    const debtField = inspectCoverageDebt(data, root);
    expect(debtField.name).toBe(FIELD_COVERAGE_DEBT);
    expect(debtField.current).toMatchObject({ mode: "warn" });
    const resumeField = inspectCheckResume(data, root);
    expect(resumeField.name).toBe(FIELD_CHECK_RESUME);
    expect(resumeField.current).toMatchObject({ localStamp: "on" });

    const byAliasDebt = inspectOnePolicy(FIELD_COVERAGE_DEBT_CLI_ALIAS, root);
    const byAliasResume = inspectOnePolicy(FIELD_CHECK_RESUME_CLI_ALIAS, root);
    expect(byAliasDebt?.name).toBe(FIELD_COVERAGE_DEBT);
    expect(byAliasResume?.name).toBe(FIELD_CHECK_RESUME);
  });

  it("inspect helpers default on null data and format status lines", () => {
    expect(inspectCoverageDebt(null).source).toBe("default");
    expect(inspectCheckResume(null).source).toBe("default");
    const root = makeRepo({
      policy: {
        coverageDebt: { mode: "off", autoFile: false },
        checkResume: { localStamp: "off" },
      },
    });
    expect(formatCoverageDebtStatusLine(resolveCoverageDebt(root))).toContain("mode=off");
    expect(formatCheckResumeStatusLine(resolveCheckResume(root))).toContain("localStamp=off");
  });

  it("inspectCoverageDebt uses projectRoot when block absent", () => {
    const root = makeRepo({ policy: { wipCap: 3 } });
    const data = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(inspectCoverageDebt(data, root).source).toBe("default");
    expect(inspectCheckResume(data, root).source).toBe("default");
  });
});

describe("standing disclosure (#3314)", () => {
  it("is silent when both fields are default", () => {
    const root = makeRepo({ policy: {} });
    expect(maybeFormatCoverageCheckResumeDisclosure(root)).toBeNull();
    expect(
      coverageCheckResumeDisclosureLine(resolveCoverageDebt(root), resolveCheckResume(root)),
    ).toBeNull();
  });

  it("is silent when both fields are typed off", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: { mode: "off" },
        checkResume: { localStamp: "off" },
      },
    });
    expect(maybeFormatCoverageCheckResumeDisclosure(root)).toBeNull();
  });

  it("fires when coverageDebt.mode is non-default", () => {
    const root = makeRepo({ policy: { coverageDebt: { mode: "hatch" } } });
    const line = maybeFormatCoverageCheckResumeDisclosure(root);
    expect(line).toContain("coverageDebt.mode=hatch");
    expect(line).not.toContain("localStamp");
    expect(line).toContain("reserved");
  });

  it("fires when checkResume.localStamp is on", () => {
    const root = makeRepo({ policy: { checkResume: { localStamp: "on" } } });
    const line = maybeFormatCoverageCheckResumeDisclosure(root);
    expect(line).toContain("checkResume.localStamp=on");
    expect(line).not.toContain("coverageDebt");
  });

  it("fires once when both are non-default", () => {
    const root = makeRepo({
      policy: {
        coverageDebt: { mode: "warn" },
        checkResume: { localStamp: "on" },
      },
    });
    const line = maybeFormatCoverageCheckResumeDisclosure(root);
    expect(line).toContain("coverageDebt.mode=warn");
    expect(line).toContain("checkResume.localStamp=on");
  });

  it("is silent on invalid typed blocks (fail-closed off)", () => {
    const root = makeRepo({
      policy: { coverageDebt: "nope", checkResume: ["x"] },
    });
    expect(maybeFormatCoverageCheckResumeDisclosure(root)).toBeNull();
  });
});
