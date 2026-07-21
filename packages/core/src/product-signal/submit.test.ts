import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyIsolatedConsentEnv } from "./consent-env.test.js";
import { GitHubPrivateSinkAdapter } from "./github-private-sink-adapter.js";
import * as headless from "./headless.js";
import * as payloadModule from "./payload.js";
import {
  assembleProductSignalPayload,
  mainEntry,
  PRODUCT_SIGNAL_LAST_SUBMIT_REL,
  parseProductSignalSubmitArgs,
  productSignalMain,
  runProductSignalConsent,
  runProductSignalEnable,
  runProductSignalStatus,
  submitProductSignal,
} from "./submit.js";

const roots: string[] = [];
const envBackup = {
  APPDATA: process.env.APPDATA,
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  CI: process.env.CI,
  GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  process.env.APPDATA = envBackup.APPDATA;
  process.env.HOME = envBackup.HOME;
  process.env.XDG_CONFIG_HOME = envBackup.XDG_CONFIG_HOME;
  process.env.CI = envBackup.CI;
  process.env.GITHUB_ACTIONS = envBackup.GITHUB_ACTIONS;
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

function setupEnabledConsented(root: string): void {
  writeProjectDef(root, { productSignal: { enabled: true } });
  applyIsolatedConsentEnv(roots, true);
}

describe("submitProductSignal", () => {
  it("skips when disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-submit-"));
    roots.push(root);
    writeProjectDef(root, {});
    const result = await submitProductSignal({ projectRoot: root, surface: "pulse" });
    expect(result.outcome).toBe("disabled");
  });

  it("skips when no consent", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-submit-noconsent-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    applyIsolatedConsentEnv(roots, false);
    vi.spyOn(headless, "isHeadlessSession").mockReturnValue(false);
    const result = await submitProductSignal({ projectRoot: root, surface: "pulse" });
    expect(result.outcome).toBe("no-consent");
  });

  it("skips on DEFT_NO_NETWORK gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-submit-net-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    const prev = process.env.DEFT_NO_NETWORK;
    process.env.DEFT_NO_NETWORK = "1";
    const result = await submitProductSignal({ projectRoot: root, surface: "pulse" });
    if (prev === undefined) {
      delete process.env.DEFT_NO_NETWORK;
    } else {
      process.env.DEFT_NO_NETWORK = prev;
    }
    expect(result.outcome).toBe("no-network");
  });

  it("does not record last submit on sink soft-skip", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-submit-skip-"));
    roots.push(root);
    setupEnabledConsented(root);
    vi.spyOn(GitHubPrivateSinkAdapter.prototype, "submit").mockResolvedValue({
      outcome: "sink-unauthorized",
      message: "soft skip",
    });
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      skipGates: true,
    });
    expect(result.outcome).toBe("sink-unauthorized");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(root, PRODUCT_SIGNAL_LAST_SUBMIT_REL))).toBe(false);
  });

  it("returns error-config when project root missing", async () => {
    const result = await submitProductSignal({
      projectRoot: "/nonexistent/deft-ps-root",
      surface: "pulse",
      skipGates: true,
    });
    expect(result.outcome).toBe("error-config");
    expect(result.exitCode).toBe(2);
  });

  it("dry-run when enabled+consent", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-submit2-"));
    roots.push(root);
    setupEnabledConsented(root);
    const result = await submitProductSignal({ projectRoot: root, surface: "pulse", dryRun: true });
    expect(result.outcome).toBe("dry-run");
    expect(result.payload?.surface).toBe("pulse");
  });

  it("submits via adapter and records last submit", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-submit-adapt-"));
    roots.push(root);
    setupEnabledConsented(root);
    vi.spyOn(GitHubPrivateSinkAdapter.prototype, "submit").mockResolvedValue({
      outcome: "submitted",
      message: "pulse submitted",
      issueUrl: "https://github.com/deftai/product-signal/issues/1",
      issueNumber: 1,
    });
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      skipGates: true,
    });
    expect(result.outcome).toBe("submitted");
    expect(result.issueUrl).toContain("issues/1");
    const { readFileSync } = await import("node:fs");
    const lastPath = join(root, PRODUCT_SIGNAL_LAST_SUBMIT_REL);
    expect(readFileSync(lastPath, "utf8")).toContain("submitted");
  });

  it("appends gap comment when gapText provided", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-submit-gap-"));
    roots.push(root);
    setupEnabledConsented(root);
    const submitSpy = vi.spyOn(GitHubPrivateSinkAdapter.prototype, "submit").mockResolvedValue({
      outcome: "submitted",
      message: "pulse submitted",
      issueUrl: "https://github.com/deftai/product-signal/issues/1",
      issueNumber: 1,
    });
    await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      skipGates: true,
      gapText: "hook blocked write",
    });
    expect(submitSpy).toHaveBeenCalledWith(expect.objectContaining({ surface: "pulse" }), {
      gapText: "hook blocked write",
    });
  });
});

describe("assembleProductSignalPayload", () => {
  it("includes consent tier when granted", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-assemble-"));
    roots.push(root);
    writeProjectDef(root, {});
    applyIsolatedConsentEnv(roots, true);
    const payload = assembleProductSignalPayload(root, {
      surface: "portrait",
      human: { nps: 7, answers: [{ q: "q", a: "a" }], freeText: "note" },
      agentNotes: "agent",
    });
    expect(payload.surface).toBe("portrait");
    expect(payload.consentTier).toBe("product-signal");
    expect(payload.human.nps).toBe(7);
    expect(payload.agentNotes).toBe("agent");
  });
});

describe("parseProductSignalSubmitArgs", () => {
  it("parses surface flag", () => {
    const parsed = parseProductSignalSubmitArgs(["--surface", "portrait"]);
    expect(parsed.surface).toBe("portrait");
  });

  it("parses surface= form and nps", () => {
    const parsed = parseProductSignalSubmitArgs([
      "--surface=portrait",
      "--dry-run",
      "--json",
      "--nps",
      "10",
      "--project-root=/tmp/x",
    ]);
    expect(parsed.surface).toBe("portrait");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.nps).toBe(10);
    expect(parsed.projectRoot).toBe("/tmp/x");
  });

  it("rejects invalid surface", () => {
    expect(parseProductSignalSubmitArgs(["--surface", "bad"]).error).toBe("invalid --surface");
    expect(parseProductSignalSubmitArgs(["--surface=bad"]).error).toBe("invalid --surface");
  });

  it("rejects invalid nps", () => {
    expect(parseProductSignalSubmitArgs(["--nps", "11"]).error).toBe("invalid --nps");
  });

  it("parses --project-root= form", () => {
    expect(parseProductSignalSubmitArgs(["--project-root=./x"]).projectRoot).toBe("./x");
  });
});

describe("runProductSignalStatus", () => {
  it("reports status and last submit", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-status-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    const cacheDir = join(root, ".deft-cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "product-signal-last-submit.json"),
      `${JSON.stringify({ outcome: "submitted", issueUrl: "https://x/y", at: "2026-07-21T12:00:00Z" })}\n`,
      "utf8",
    );
    const result = runProductSignalStatus(root);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("consented=");
    expect(result.text).toContain("last=submitted");
  });

  it("handles invalid last submit file gracefully", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-status-bad-"));
    roots.push(root);
    writeProjectDef(root, {});
    const cacheDir = join(root, ".deft-cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "product-signal-last-submit.json"), "not-json\n", "utf8");
    const result = runProductSignalStatus(root);
    expect(result.text).toContain("last submit: none");
  });
});

describe("runProductSignalEnable", () => {
  it("requires confirm before enabling", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-enable-"));
    roots.push(root);
    writeProjectDef(root, {});
    const denied = runProductSignalEnable(root, false);
    expect(denied.exitCode).toBe(1);
    expect(denied.text).toContain("Capability-cost disclosure");
    const enabled = runProductSignalEnable(root, true);
    expect(enabled.exitCode).toBe(0);
    expect(enabled.text).toContain("enabled=true");
  });

  it("errors without project root", () => {
    expect(runProductSignalEnable("/nonexistent/path", true).exitCode).toBe(2);
  });
});

describe("runProductSignalConsent", () => {
  it("grant and revoke paths", () => {
    applyIsolatedConsentEnv(roots, false);
    const grant = runProductSignalConsent("grant");
    expect(grant.exitCode).toBe(0);
    expect(grant.text).toContain("granted");
    const revoke = runProductSignalConsent("revoke");
    expect(revoke.exitCode).toBe(0);
    expect(revoke.text).toContain("revoked");
  });
});

describe("productSignalMain", () => {
  it("routes status subcommand", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-main-status-"));
    roots.push(root);
    writeProjectDef(root, {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await productSignalMain(["status", "--project-root", root]);
    expect(code).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toContain("product-signal");
  });

  it("routes status with project-root= form", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-main-status-eq-"));
    roots.push(root);
    writeProjectDef(root, {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["status", `--project-root=${root}`])).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toContain("product-signal");
  });

  it("routes enable with confirm", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-main-enable-"));
    roots.push(root);
    writeProjectDef(root, {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await productSignalMain(["enable", "--confirm", "--project-root", root]);
    expect(code).toBe(0);
  });

  it("routes consent grant", async () => {
    applyIsolatedConsentEnv(roots, false);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["consent", "--grant"])).toBe(0);
  });

  it("routes consent revoke", async () => {
    applyIsolatedConsentEnv(roots, false);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["consent", "--grant"])).toBe(0);
    expect(await productSignalMain(["consent", "--revoke"])).toBe(0);
  });

  it("rejects consent without grant or revoke", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await productSignalMain(["consent"])).toBe(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("usage");
  });

  it("routes bootstrap-sink dry-run", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["bootstrap-sink", "--dry-run"])).toBe(0);
  });

  it("routes submit with json output", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-main-submit-"));
    roots.push(root);
    setupEnabledConsented(root);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await productSignalMain([
      "submit",
      "--project-root",
      root,
      "--dry-run",
      "--json",
      "--nps",
      "8",
    ]);
    expect(code).toBe(0);
  });

  it("routes submit without json output", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-main-submit-plain-"));
    roots.push(root);
    setupEnabledConsented(root);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await productSignalMain(["submit", "--project-root", root, "--dry-run"]);
    expect(code).toBe(0);
    expect(String(stdout.mock.calls[0]?.[0])).toContain("dry-run");
  });

  it("rejects submit with bad args", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await productSignalMain(["submit", "--nps", "99"])).toBe(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("invalid --nps");
  });

  it("returns usage for unknown subcommand", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await productSignalMain(["unknown"])).toBe(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("usage");
  });
});

describe("mainEntry", () => {
  it("delegates to productSignalMain", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await mainEntry(["bootstrap-sink", "--dry-run"])).toBe(0);
  });
});

describe("submitProductSignal validation", () => {
  it("returns validation outcome for bad payload", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-submit-valid-"));
    roots.push(root);
    setupEnabledConsented(root);
    vi.spyOn(payloadModule, "validateProductSignalPayload").mockReturnValue(["human.nps invalid"]);
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      skipGates: true,
    });
    expect(result.outcome).toBe("validation");
    expect(result.exitCode).toBe(1);
  });
});
