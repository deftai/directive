import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  enableProductSignal,
  formatProductSignalStatusLine,
  inspectProductSignal,
  resolveProductSignal,
  validateProductSignal,
} from "./product-signal.js";

describe("product-signal policy module", () => {
  it("validateProductSignal rejects bad types", () => {
    expect(validateProductSignal({ enabled: "yes" })[0]).toContain("enabled");
    expect(validateProductSignal({ sinkRepo: 1 })[0]).toContain("sinkRepo");
    expect(validateProductSignal(null)).toEqual([]);
    expect(validateProductSignal("bad")[0]).toContain("must be an object");
  });

  it("enableProductSignal persists enabled flag", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-pol-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: {} }),
      "utf8",
    );
    enableProductSignal(root, { confirm: true });
    expect(resolveProductSignal(root).enabled).toBe(true);
    const audit = readFileSync(join(root, "meta", "policy-changes.log"), "utf8");
    expect(audit).toContain("changed=true");
    expect(audit).not.toMatch(/\schanged=false(?:\s|$)/);
    rmSync(root, { recursive: true, force: true });
  });

  it("inspectProductSignal reads typed block and defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-pol-inspect-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    const path = join(xbrief, "PROJECT-DEFINITION.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: { "x-directive/policy": { productSignal: { enabled: true, sinkRepo: "o/r" } } },
      }),
      "utf8",
    );
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const field = inspectProductSignal(data);
    expect(field.current.enabled).toBe(true);
    expect(field.current.sinkRepo).toBe("o/r");
    expect(inspectProductSignal(null).default.enabled).toBe(false);
    expect(inspectProductSignal({ plan: {} }, root).current.enabled).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolveProductSignal handles invalid block as default-on-error", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-pol-bad-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { "x-directive/policy": { productSignal: { enabled: "bad" } } },
      }),
      "utf8",
    );
    const resolved = resolveProductSignal(root);
    expect(resolved.enabled).toBe(false);
    expect(resolved.error).toBeTruthy();
    rmSync(root, { recursive: true, force: true });
  });

  it("formatProductSignalStatusLine includes sink", () => {
    const line = formatProductSignalStatusLine(resolveProductSignal(process.cwd()));
    expect(line).toContain("productSignal");
  });

  it("enableProductSignal no-op leaves the audit log unmodified (#3528)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-pol-noop-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { "x-directive/policy": { productSignal: { enabled: true } } },
      }),
      "utf8",
    );
    mkdirSync(join(root, "meta"), { recursive: true });
    const logPath = join(root, "meta", "policy-changes.log");
    const historical =
      "# meta/policy-changes.log -- historical\n" +
      "2026-07-23T20:23:26Z actor=task product-signal:enable productSignal.enabled=true previous=null\n";
    writeFileSync(logPath, historical, "utf8");
    const result = enableProductSignal(root, { confirm: true, note: "trail" });
    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.stdout).toContain("ledger unchanged");
    expect(readFileSync(logPath, "utf8")).toBe(historical);
    expect(existsSync(logPath)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("enableProductSignal fails when project definition missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-pol-miss-"));
    const result = enableProductSignal(root, { confirm: true });
    expect(result.exitCode).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("enableProductSignal requires confirm disclosure", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-pol-disc-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: {} }),
      "utf8",
    );
    const result = enableProductSignal(root, { confirm: false });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Capability-cost disclosure");
    rmSync(root, { recursive: true, force: true });
  });
});
