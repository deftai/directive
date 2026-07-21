import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as productSignalPolicy from "../policy/product-signal.js";
import { grantProductSignalConsent } from "./consent.js";
import { classifySinkError, evaluateProductSignalGates } from "./gates.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function writeProjectDef(root: string, policy: Record<string, unknown>): void {
  const dir = join(root, "xbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ plan: { "x-directive/policy": policy } }, null, 2),
    "utf8",
  );
}

describe("evaluateProductSignalGates", () => {
  it("soft-skips when disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-gates-"));
    roots.push(root);
    writeProjectDef(root, {});
    expect(evaluateProductSignalGates({ projectRoot: root }).outcome).toBe("disabled");
  });

  it("soft-skips on DEFT_NO_NETWORK", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-gates-net-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    expect(
      evaluateProductSignalGates({ projectRoot: root, env: { DEFT_NO_NETWORK: "1" } }).outcome,
    ).toBe("no-network");
  });

  it("soft-skips without consent", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-gates-consent-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    expect(evaluateProductSignalGates({ projectRoot: root }).outcome).toBe("no-consent");
  });

  it("passes when enabled and consented", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-gates-pass-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    const home = mkdtempSync(join(tmpdir(), "deft-ps-gates-home-"));
    roots.push(home);
    grantProductSignalConsent({ platform: "win32", homeDir: home, env: { APPDATA: home } });
    expect(
      evaluateProductSignalGates({
        projectRoot: root,
        env: { APPDATA: home },
      }).allowed,
    ).toBe(true);
  });

  it("soft-skips headless without consent", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-gates-headless-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    expect(
      evaluateProductSignalGates({
        projectRoot: root,
        env: { CI: "true" },
        stdinIsTTY: false,
      }).outcome,
    ).toBe("non-interactive");
  });

  it("allows headless when consent on file", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-gates-hconsent-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    const home = mkdtempSync(join(tmpdir(), "deft-ps-gates-hhome-"));
    roots.push(home);
    grantProductSignalConsent({ platform: "win32", homeDir: home, env: { APPDATA: home } });
    expect(
      evaluateProductSignalGates({
        projectRoot: root,
        env: { CI: "true", APPDATA: home },
      }).allowed,
    ).toBe(true);
  });

  it("allows when requireConsent is false", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-gates-skip-consent-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    expect(evaluateProductSignalGates({ projectRoot: root, requireConsent: false }).allowed).toBe(
      true,
    );
    expect(
      evaluateProductSignalGates({
        projectRoot: root,
        env: { CI: "true" },
        requireConsent: false,
        stdinIsTTY: false,
      }).allowed,
    ).toBe(true);
  });

  it("reports policy error when enabled with config error", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-gates-err-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    const home = mkdtempSync(join(tmpdir(), "deft-ps-gates-errhome-"));
    roots.push(home);
    grantProductSignalConsent({ platform: "win32", homeDir: home, env: { APPDATA: home } });
    vi.spyOn(productSignalPolicy, "resolveProductSignal").mockReturnValue({
      enabled: true,
      sinkRepo: "deftai/product-signal",
      source: "default-on-error",
      error: "invalid sink",
    });
    expect(
      evaluateProductSignalGates({
        projectRoot: root,
        env: { APPDATA: home },
      }).outcome,
    ).toBe("error-config");
  });
});

describe("classifySinkError", () => {
  it("maps auth errors", () => {
    expect(classifySinkError("403", 1)).toBe("sink-unauthorized");
    expect(classifySinkError("401 unauthorized", 1)).toBe("sink-unauthorized");
    expect(classifySinkError("404 not found", 1)).toBe("sink-unauthorized");
    expect(classifySinkError("permission denied", 1)).toBe("sink-unauthorized");
  });

  it("maps generic failure to sink-unreachable", () => {
    expect(classifySinkError("timeout", 1)).toBe("sink-unreachable");
    expect(classifySinkError("", 0)).toBe("sink-unreachable");
  });
});
