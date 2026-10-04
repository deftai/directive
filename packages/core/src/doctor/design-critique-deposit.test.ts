import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDesignCritiqueDeposit,
  DESIGN_CRITIQUE_DEPOSIT_CHECK,
} from "./design-critique-deposit.js";

function writePd(root: string, policy: Record<string, unknown>): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ plan: { title: "t", status: "running", policy } }),
    "utf8",
  );
}

describe("checkDesignCritiqueDeposit (#5326)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("skips when design-critique is not deposited", () => {
    root = mkdtempSync(join(tmpdir(), "doc-dc-"));
    writePd(root, {});
    const check = checkDesignCritiqueDeposit(root);
    expect(check.name).toBe(DESIGN_CRITIQUE_DEPOSIT_CHECK);
    expect(check.status).toBe("skip");
    expect(check.data?.deposited).toBe(false);
  });

  it("fails advisory when deposited and judgmentGates design-critique is missing", () => {
    root = mkdtempSync(join(tmpdir(), "doc-dc-"));
    writePd(root, {});
    const contractDir = join(root, "content", "contracts");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "design-critique.md"), "# c\n", "utf8");
    const check = checkDesignCritiqueDeposit(root);
    expect(check.status).toBe("fail");
    expect(check.data?.advisory).toBe(true);
    expect(check.detail).toMatch(/judgmentGates/);
    expect(check.detail).toMatch(/design-critique:mechanism-shaped/);
    expect(check.detail).toMatch(/ensure/);
  });

  it("passes when deposited and typed gate is present", () => {
    root = mkdtempSync(join(tmpdir(), "doc-dc-"));
    writePd(root, {
      judgmentGates: [
        {
          id: "design-critique",
          class: "declared",
          tier: "review",
          reason: "ADR-005",
          match: { labels: { "any-of": ["design-critique:mechanism-shaped"] } },
        },
      ],
    });
    const contractDir = join(root, "content", "contracts");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "design-critique.md"), "# c\n", "utf8");
    const check = checkDesignCritiqueDeposit(root);
    expect(check.status).toBe("pass");
    expect(check.data?.judgmentGatePresent).toBe(true);
  });
});
