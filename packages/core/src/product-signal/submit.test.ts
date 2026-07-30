import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRODUCT_SIGNAL_SINK_REPO } from "../policy/product-signal.js";
import { grantProductSignalConsent, resolveProductSignalConsentPath } from "./consent.js";
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

function setupEnabledConsented(root: string, sinkRepo?: string): void {
  writeProjectDef(root, {
    productSignal: { enabled: true, ...(sinkRepo ? { sinkRepo } : {}) },
  });
  applyIsolatedConsentEnv(roots, false);
  grantProductSignalConsent({ sinkRepo: sinkRepo ?? DEFAULT_PRODUCT_SIGNAL_SINK_REPO });
}

function writeLegacyV1Consent(): void {
  const path = resolveProductSignalConsentPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      consentVersion: 1,
      grantedAt: "2026-07-21T12:00:00Z",
      tier: "product-signal",
    })}\n`,
    "utf8",
  );
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
    expect(parseProductSignalSubmitArgs(["--nps"]).error).toBe("invalid --nps");
  });

  it("rejects unrecognized arguments", () => {
    expect(parseProductSignalSubmitArgs(["--bogus"]).error).toContain("unrecognized argument");
  });

  it("rejects invalid surface= form", () => {
    expect(parseProductSignalSubmitArgs(["--surface=bad"]).error).toBe("invalid --surface");
  });

  it("parses --project-root= form", () => {
    expect(parseProductSignalSubmitArgs(["--project-root=./x"]).projectRoot).toBe("./x");
  });

  it("defaults project root when --project-root has no value", () => {
    expect(parseProductSignalSubmitArgs(["--project-root"]).projectRoot).toBe(".");
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
    const grant = runProductSignalConsent({ action: "grant" });
    expect(grant.exitCode).toBe(0);
    expect(grant.text).toContain("granted");
    expect(grant.text).toContain("sinkRepo=");
    const revoke = runProductSignalConsent({ action: "revoke" });
    expect(revoke.exitCode).toBe(0);
    expect(revoke.text).toContain("revoked");
  });

  it("grant binds project sink when project root provided", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-consent-grant-root-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true, sinkRepo: "partner/inbox" } });
    applyIsolatedConsentEnv(roots, false);
    const grant = runProductSignalConsent({ action: "grant", projectRoot: root });
    expect(grant.text).toContain("sinkRepo=partner/inbox");
  });

  it("grant uses default sink when project root missing", () => {
    applyIsolatedConsentEnv(roots, false);
    const grant = runProductSignalConsent({
      action: "grant",
      projectRoot: "/nonexistent/deft-ps-root",
    });
    expect(grant.text).toContain("sinkRepo=deftai/product-signal");
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

  it("routes enable with project-root= form", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-main-enable-eq-"));
    roots.push(root);
    writeProjectDef(root, {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["enable", "--confirm", `--project-root=${root}`])).toBe(0);
  });

  it("routes enable with --project-root and no value", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["enable", "--confirm", "--project-root"])).toBe(0);
  });

  it("routes consent grant", async () => {
    applyIsolatedConsentEnv(roots, false);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["consent", "--grant"])).toBe(0);
  });

  it("routes consent grant with project root", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-main-consent-root-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true, sinkRepo: "partner/inbox" } });
    applyIsolatedConsentEnv(roots, false);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["consent", "--grant", "--project-root", root])).toBe(0);
    expect(String(stdout.mock.calls[0]?.[0])).toContain("partner/inbox");
  });

  it("routes consent grant with --project-root and no value", async () => {
    applyIsolatedConsentEnv(roots, false);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["consent", "--grant", "--project-root"])).toBe(0);
  });

  it("routes consent grant with project-root= form preserving equals in path", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-main-consent-eqpath-"));
    roots.push(root);
    const rootWithEquals = `${root}=suffix`;
    mkdirSync(rootWithEquals, { recursive: true });
    roots.push(rootWithEquals);
    writeProjectDef(rootWithEquals, {
      productSignal: { enabled: true, sinkRepo: "partner/inbox" },
    });
    applyIsolatedConsentEnv(roots, false);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      await productSignalMain(["consent", "--grant", `--project-root=${rootWithEquals}`]),
    ).toBe(0);
    expect(String(stdout.mock.calls[0]?.[0])).toContain("partner/inbox");
  });

  it("routes consent grant with project-root= form", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-main-consent-eq-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true, sinkRepo: "partner/inbox" } });
    applyIsolatedConsentEnv(roots, false);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["consent", "--grant", `--project-root=${root}`])).toBe(0);
  });

  it("routes consent grant with bare --project-root flag", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-main-consent-flag-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true, sinkRepo: "partner/inbox" } });
    applyIsolatedConsentEnv(roots, false);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["consent", "--grant", "--project-root", root])).toBe(0);
  });

  it("routes consent revoke with project-root= form", async () => {
    applyIsolatedConsentEnv(roots, false);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["consent", "--grant"])).toBe(0);
    expect(await productSignalMain(["consent", "--revoke", "--project-root=."])).toBe(0);
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

  it("routes status with project-root flag without value", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await productSignalMain(["status", "--project-root"])).toBe(0);
    expect(String(stdout.mock.calls[0]?.[0])).toContain("product-signal");
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

describe("submitProductSignal sink consent (#2767)", () => {
  it("allows v1 consent with default sink on dry-run", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-sink-v1-default-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    applyIsolatedConsentEnv(roots, false);
    writeLegacyV1Consent();
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      dryRun: true,
      skipGates: true,
    });
    expect(result.outcome).toBe("dry-run");
  });

  it("allows v1 consent with default sink on submit", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-sink-v1-submit-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    applyIsolatedConsentEnv(roots, false);
    writeLegacyV1Consent();
    vi.spyOn(GitHubPrivateSinkAdapter.prototype, "submit").mockResolvedValue({
      outcome: "submitted",
      message: "ok",
      issueUrl: "https://github.com/deftai/product-signal/issues/2",
      issueNumber: 2,
    });
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      skipGates: true,
    });
    expect(result.outcome).toBe("submitted");
  });

  it("rejects v1 consent with custom sink before adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-sink-v1-custom-"));
    roots.push(root);
    writeProjectDef(root, {
      productSignal: { enabled: true, sinkRepo: "evil/custom-sink" },
    });
    applyIsolatedConsentEnv(roots, false);
    writeLegacyV1Consent();
    const adapterSpy = vi.spyOn(GitHubPrivateSinkAdapter.prototype, "submit");
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      skipGates: true,
    });
    expect(result.outcome).toBe("sink-unconsented");
    expect(adapterSpy).not.toHaveBeenCalled();
  });

  it("allows v2 consent when sink matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-sink-v2-match-"));
    roots.push(root);
    setupEnabledConsented(root, "partner/custom-sink");
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      dryRun: true,
      skipGates: true,
    });
    expect(result.outcome).toBe("dry-run");
  });

  it("rejects v2 consent sink mismatch before adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-sink-v2-mismatch-"));
    roots.push(root);
    setupEnabledConsented(root, "partner/a");
    writeProjectDef(root, { productSignal: { enabled: true, sinkRepo: "partner/b" } });
    const adapterSpy = vi.spyOn(GitHubPrivateSinkAdapter.prototype, "submit");
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      skipGates: true,
    });
    expect(result.outcome).toBe("sink-unconsented");
    expect(result.message).toContain("partner/b");
    expect(result.message).toContain("partner/a");
    expect(adapterSpy).not.toHaveBeenCalled();
  });

  it("rejects v2 consent sink mismatch on dry-run", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-sink-v2-dry-mismatch-"));
    roots.push(root);
    setupEnabledConsented(root, "partner/a");
    writeProjectDef(root, { productSignal: { enabled: true, sinkRepo: "partner/b" } });
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      dryRun: true,
      skipGates: true,
    });
    expect(result.outcome).toBe("sink-unconsented");
  });

  it("enforces sink authorization even when skipGates is true", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-sink-skipgates-"));
    roots.push(root);
    setupEnabledConsented(root, "partner/a");
    writeProjectDef(root, { productSignal: { enabled: true, sinkRepo: "partner/b" } });
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      skipGates: true,
    });
    expect(result.outcome).toBe("sink-unconsented");
  });

  it("headless without consent still fails open", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-sink-headless-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    applyIsolatedConsentEnv(roots, false);
    process.env.CI = "true";
    vi.spyOn(headless, "isHeadlessSession").mockReturnValue(true);
    const result = await submitProductSignal({ projectRoot: root, surface: "pulse" });
    expect(result.outcome).toBe("non-interactive");
    expect(result.exitCode).toBe(0);
  });

  it("skipGates with no consent returns sink-unconsented", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-sink-skip-no-consent-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    applyIsolatedConsentEnv(roots, false);
    const adapterSpy = vi.spyOn(GitHubPrivateSinkAdapter.prototype, "submit");
    const result = await submitProductSignal({
      projectRoot: root,
      surface: "pulse",
      skipGates: true,
    });
    expect(result.outcome).toBe("sink-unconsented");
    expect(adapterSpy).not.toHaveBeenCalled();
  });
});

describe("runProductSignalStatus sink fields", () => {
  it("shows consentedSink none when consent missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-status-no-consent-"));
    roots.push(root);
    writeProjectDef(root, { productSignal: { enabled: true } });
    applyIsolatedConsentEnv(roots, false);
    const result = runProductSignalStatus(root);
    expect(result.text).toContain("consented=false");
    expect(result.text).toContain("consentedSink=none");
  });

  it("shows configured vs consented sink and match flag", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-status-sink-"));
    roots.push(root);
    setupEnabledConsented(root, "partner/signal");
    writeProjectDef(root, { productSignal: { enabled: true, sinkRepo: "partner/other" } });
    const result = runProductSignalStatus(root);
    expect(result.text).toContain("configuredSink=partner/other");
    expect(result.text).toContain("consentedSink=partner/signal");
    expect(result.text).toContain("sinksMatch=false");
  });

  it("reports sinksMatch=true when configured and consented sinks align", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-status-sink-match-"));
    roots.push(root);
    setupEnabledConsented(root, "partner/signal");
    const result = runProductSignalStatus(root);
    expect(result.text).toContain("sinksMatch=true");
  });
});

const itSymlink = it.skipIf(process.platform === "win32");

describe("product-signal last-submit symlink containment (#2807)", () => {
  itSymlink(
    "does not append when last-submit path is a symlink to an external victim file",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "deft-ps-submit-symlink-"));
      roots.push(root);
      setupEnabledConsented(root);
      const escapeDir = mkdtempSync(join(tmpdir(), "deft-ps-submit-victim-"));
      const victim = join(escapeDir, "product-signal-last-submit.json");
      writeFileSync(victim, "victim\n", "utf8");
      mkdirSync(join(root, ".deft-cache"), { recursive: true });
      symlinkSync(victim, join(root, PRODUCT_SIGNAL_LAST_SUBMIT_REL));
      vi.spyOn(GitHubPrivateSinkAdapter.prototype, "submit").mockResolvedValue({
        outcome: "submitted",
        message: "pulse submitted",
        issueUrl: "https://github.com/deftai/product-signal/issues/9",
        issueNumber: 9,
      });
      const result = await submitProductSignal({
        projectRoot: root,
        surface: "pulse",
        skipGates: true,
      });
      expect(result.outcome).toBe("error-config");
      expect(result.exitCode).toBe(2);
      expect(result.message).toMatch(/projection write refused|contained write refused|symlink/);
      expect(readFileSync(victim, "utf8")).toBe("victim\n");
      rmSync(escapeDir, { recursive: true, force: true });
    },
  );
});
