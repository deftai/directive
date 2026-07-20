import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inspectOnePolicy } from "./index.js";
import {
  DEFAULT_STALENESS_TICKLER_POLICY,
  FIELD_STALENESS_TICKLER,
  FIELD_STALENESS_TICKLER_CLI_ALIAS,
  inspectStalenessTickler,
  resolveStalenessTicklerPolicy,
  validateStalenessTickler,
} from "./staleness-tickler.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(policy?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-staleness-policy-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], policy },
    }),
    "utf8",
  );
  return root;
}

describe("stalenessTickler policy (#2489)", () => {
  it("defaults when unset", () => {
    expect(resolveStalenessTicklerPolicy(null)).toEqual(DEFAULT_STALENESS_TICKLER_POLICY);
  });

  it("validates object shape", () => {
    expect(validateStalenessTickler({ enabled: "no" })[0]).toContain("enabled");
  });

  it("surfaces typed policy via inspectStalenessTickler", () => {
    const field = inspectStalenessTickler({
      plan: { policy: { stalenessTickler: { enabled: false, optOut: true } } },
    });
    expect(field.source).toBe("typed");
    expect(field.current.enabled).toBe(false);
    expect(field.current.optOut).toBe(true);
  });

  it("registers CLI alias in inspectOnePolicy", () => {
    const root = makeRepo({ stalenessTickler: { enabled: false } });
    const field = inspectOnePolicy(FIELD_STALENESS_TICKLER_CLI_ALIAS, root);
    expect(field?.name).toBe(FIELD_STALENESS_TICKLER);
    expect(field?.current).toMatchObject({ enabled: false });
  });
});
