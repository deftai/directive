import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { armDelegation, formatArmOutcomeLine, parseArmCommand } from "./arm.js";
import {
  delegationAuditPath,
  delegationStatePath,
  loadDelegationState,
  writeEnrolledSecret,
} from "./store.js";
import { totpCodeForStep, totpStepAt } from "./totp.js";
import { DELEGATION_DEFAULT_TTL_HOURS, DELEGATION_MAX_TTL_HOURS } from "./types.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const T0 = new Date("2026-11-27T12:00:00Z");

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): { root: string; secretPath: string } {
  const root = mkdtempSync(join(tmpdir(), "deleg-arm-"));
  roots.push(root);
  const secretPath = join(root, "user-config", "delegation", "totp-secret.json");
  writeEnrolledSecret(
    secretPath,
    { secretBase32: SECRET, enrolledAt: "2026-11-27T00:00:00Z", account: "op" },
    false,
  );
  return { root, secretPath };
}

function codeAt(now: Date, delta = 0): string {
  return totpCodeForStep(SECRET, totpStepAt(now) + delta) as string;
}

function arm(f: { root: string; secretPath: string }, prompt: string, now = T0, session = "s-1") {
  return armDelegation({
    projectRoot: f.root,
    storeRoot: f.root,
    secretPath: f.secretPath,
    promptText: prompt,
    hostSessionId: session,
    host: "claude",
    now,
  });
}

describe("parseArmCommand", () => {
  it("finds the arm line with an optional ttl", () => {
    expect(parseArmCommand("deft delegate on 123456")).toEqual({
      code: "123456",
      ttlHours: null,
      commandError: null,
    });
    expect(parseArmCommand("please\n  deft delegate on 8h 123456\nthanks")).toEqual({
      code: "123456",
      ttlHours: 8,
      commandError: null,
    });
    expect(parseArmCommand("no command here")).toBeNull();
  });

  it("marks extra tokens and an over-cap ttl as a refused command but keeps the code", () => {
    expect(parseArmCommand("deft delegate on 100h 123456")?.commandError).toMatch(/72h maximum/);
    expect(parseArmCommand("deft delegate on 123456 && rm")?.code).toBe("123456");
    expect(parseArmCommand("deft delegate on 123456 && rm")?.commandError).toMatch(/unexpected/);
    expect(parseArmCommand("deft delegate on")?.code).toBeNull();
  });
});

describe("armDelegation (#7420 B1 / clause 9)", () => {
  it("a valid code arms and writes the record with the arm-time session id", () => {
    const f = fixture();
    const out = arm(f, `deft delegate on ${codeAt(T0)}`);
    expect(out.kind).toBe("armed");
    const st = loadDelegationState(f.root);
    expect(st.ok && st.state.record?.hostSessionId).toBe("s-1");
    expect(st.ok && st.state.lastAcceptedStep).toBe(totpStepAt(T0));
    if (out.kind !== "armed") throw new Error("not armed");
    const ttlMs = Date.parse(out.record.expiresAt) - Date.parse(out.record.armedAt);
    expect(ttlMs).toBe(DELEGATION_DEFAULT_TTL_HOURS * 3600 * 1000);
    expect(out.record.provenance).toBe("delegated-totp");
    expect(out.record.allowlist.verbs).toEqual(["scope:record-approved-scope", "authz:grant"]);
    expect(formatArmOutcomeLine(out)).toMatch(/^\[delegated-totp\] delegation armed until/);
    expect(readFileSync(delegationAuditPath(f.root), "utf8")).toMatch(/"event":"arm"/);
  });

  it("caps the expiry at 72h", () => {
    const f = fixture();
    const out = arm(f, `deft delegate on 72h ${codeAt(T0)}`);
    if (out.kind !== "armed") throw new Error(`not armed: ${out.kind}`);
    const ttlMs = Date.parse(out.record.expiresAt) - Date.parse(out.record.armedAt);
    expect(ttlMs).toBe(DELEGATION_MAX_TTL_HOURS * 3600 * 1000);
  });

  it("a wrong or missing code writes nothing", () => {
    const f = fixture();
    const wrong = String((Number(codeAt(T0)) + 1) % 1_000_000).padStart(6, "0");
    expect(arm(f, `deft delegate on ${wrong}`).kind).toBe("refused-no-write");
    expect(arm(f, "deft delegate on 12h").kind).toBe("refused-no-write");
    expect(existsSync(delegationStatePath(f.root))).toBe(false);
  });

  it("no enrolled secret writes nothing", () => {
    const f = fixture();
    const out = armDelegation({
      projectRoot: f.root,
      storeRoot: f.root,
      secretPath: join(f.root, "missing.json"),
      promptText: `deft delegate on ${codeAt(T0)}`,
      hostSessionId: "s-1",
      host: "claude",
      now: T0,
    });
    expect(out.kind).toBe("refused-no-write");
    expect(existsSync(delegationStatePath(f.root))).toBe(false);
  });

  it("a repeat of the same input is a quiet no-op", () => {
    const f = fixture();
    const prompt = `deft delegate on ${codeAt(T0)}`;
    const first = arm(f, prompt);
    const before = readFileSync(delegationStatePath(f.root), "utf8");
    const again = arm(f, prompt);
    expect(first.kind).toBe("armed");
    expect(again.kind).toBe("noop-replay");
    expect(formatArmOutcomeLine(again)).toBeNull();
    expect(readFileSync(delegationStatePath(f.root), "utf8")).toBe(before);
  });

  it("a step at or below lastAcceptedStep is a quiet no-op (older code inside the drift window)", () => {
    const f = fixture();
    expect(arm(f, `deft delegate on ${codeAt(T0)}`).kind).toBe("armed");
    const before = readFileSync(delegationStatePath(f.root), "utf8");
    expect(arm(f, `deft delegate on ${codeAt(T0, -1)}`).kind).toBe("noop-replay");
    expect(readFileSync(delegationStatePath(f.root), "utf8")).toBe(before);
  });

  it("a valid code inside a refused command still advances lastAcceptedStep", () => {
    const f = fixture();
    const out = arm(f, `deft delegate on 100h ${codeAt(T0)}`);
    expect(out.kind).toBe("refused-burned");
    const st = loadDelegationState(f.root);
    expect(st.ok && st.state.lastAcceptedStep).toBe(totpStepAt(T0));
    expect(st.ok && st.state.record).toBeNull();
    // The burned code cannot arm afterwards.
    expect(arm(f, `deft delegate on ${codeAt(T0)}`).kind).toBe("noop-replay");
    expect(formatArmOutcomeLine(out)).toMatch(/code is used/);
  });

  it("an empty session id is a refused command that still burns the code", () => {
    const f = fixture();
    expect(arm(f, `deft delegate on ${codeAt(T0)}`, T0, "  ").kind).toBe("refused-burned");
  });

  it("does not arm while a UAT lease is active (code burned)", () => {
    const f = fixture();
    const authzDir = join(f.root, ".deft", "authz");
    mkdirSync(authzDir, { recursive: true });
    writeFileSync(
      join(authzDir, "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        activeGrantIds: [],
        uat: {
          active: true,
          campaignId: "c1",
          startedAt: "2026-11-27T00:00:00Z",
          startedBy: { kind: "operator-cli", actor: "op", mintedAt: "2026-11-27T00:00:00Z" },
        },
      }),
    );
    const out = arm(f, `deft delegate on ${codeAt(T0)}`);
    expect(out.kind).toBe("refused-burned");
  });
});

describe("concurrent arms (#7420 clause 10)", () => {
  it("two processes arming with the same code create one record", async () => {
    const f = fixture();
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..", "..", "..", "..");
    const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const script = join(f.root, "arm-child.ts");
    const armModule = join(here, "arm.ts").replace(/\\/g, "/");
    writeFileSync(
      script,
      [
        `import { armDelegation } from ${JSON.stringify(`file:///${armModule.replace(/^\//, "")}`)};`,
        "const out = armDelegation({",
        `  projectRoot: ${JSON.stringify(f.root)},`,
        `  storeRoot: ${JSON.stringify(f.root)},`,
        `  secretPath: ${JSON.stringify(f.secretPath)},`,
        `  promptText: ${JSON.stringify(`deft delegate on ${codeAt(T0)}`)},`,
        "  hostSessionId: process.argv[2],",
        '  host: "claude",',
        `  now: new Date(${JSON.stringify(T0.toISOString())}),`,
        "});",
        "process.stdout.write(out.kind);",
      ].join("\n"),
    );
    const runChild = (session: string): Promise<string> =>
      new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [tsx, script, session], { cwd: repoRoot });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => {
          out += String(d);
        });
        child.stderr.on("data", (d) => {
          err += String(d);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) reject(new Error(`child exit ${String(code)}: ${err}`));
          else resolvePromise(out.trim());
        });
      });
    const results = await Promise.all([runChild("s-a"), runChild("s-b")]);
    expect([...results].sort()).toEqual(["armed", "noop-replay"]);
    const st = loadDelegationState(f.root);
    expect(st.ok && st.state.record).not.toBeNull();
    const audit = readFileSync(delegationAuditPath(f.root), "utf8")
      .split("\n")
      .filter((l) => l.includes('"event":"arm"'));
    expect(audit).toHaveLength(1);
  }, 60_000);
});
