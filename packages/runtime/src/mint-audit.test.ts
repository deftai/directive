/**
 * Mint audit (#7031): which record commands keep the terminal mint.
 *
 * Dropped: `scope:record-observable-scope` and `scope:record-intent-constraint`
 * (single path and cohort) write a declared record from an agent shell with no
 * TTY, no `--confirm` and no typed phrase, and still refuse during a UAT lease.
 * Kept: `scope:record-approved-scope` and `authz:*` (one template shown) still
 * refuse without the terminal mint.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeProvenance } from "@deftai/directive-core";
import { startUatLease } from "@deftai/directive-core/authz";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as authzMain } from "./authz.js";
import { run as runApprovedScope } from "./scope-record-approved-scope.js";
import { run as runIntent } from "./scope-record-intent-constraint.js";
import { run as runObservable } from "./scope-record-observable-scope.js";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Agent markers set, no TTY, no controlling terminal; a prompt would be a bug. */
function agentShell(prompts: { count: number }) {
  return {
    isTty: () => false,
    hasControllingTerminal: () => false,
    readInteractiveConfirm: () => {
      prompts.count += 1;
      return null;
    },
    environ: { CLAUDECODE: "1", CI: "true" },
    repo: "deftai/example",
  };
}

function quiet(): { err: () => string } {
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  return { err: () => err };
}

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "mint-audit-"));
  temps.push(dir);
  mkdirSync(join(dir, "xbrief", "active"), { recursive: true });
  return dir;
}

function brief(dir: string, name: string, planId: string): string {
  const path = join(dir, "xbrief", "active", `${name}.xbrief.json`);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: planId,
        title: name,
        status: "running",
        items: [],
        metadata: { swarm: { file_scope: ["src/a.ts"] } },
        "x-directive/observableChange": {
          changeKind: "fields-only",
          allowedChanges: [{ kind: "control", op: "add", name: planId }],
        },
        "x-directive/intentConstraint": {
          constraints: [{ value: "100", unit: "ms", rejectionScope: "operation" }],
        },
      },
    }),
    "utf8",
  );
  return path;
}

type Stamp = { kind: string; actor: string; mintedAt: string; mintedVia?: string };

function stampOf(dir: string, store: string, planId: string): Stamp {
  const rec = JSON.parse(readFileSync(join(dir, ".deft", store, `${planId}.json`), "utf8")) as {
    humanApproval: Stamp;
  };
  return rec.humanApproval;
}

const DROPPED = [
  { verb: "scope:record-observable-scope", store: "observable-scope", run: runObservable },
  { verb: "scope:record-intent-constraint", store: "intent-constraint", run: runIntent },
] as const;

describe("dropped mint: declared record writers (#7031)", () => {
  for (const d of DROPPED) {
    it(`${d.verb} single path writes a declared record without a TTY under agent markers`, () => {
      const dir = root();
      const a = brief(dir, "a", "story-a");
      const prompts = { count: 0 };
      quiet();
      expect(d.run([a, "--project-root", dir], agentShell(prompts))).toBe(0);
      expect(prompts.count).toBe(0);
      const stamp = stampOf(dir, d.store, "story-a");
      expect(stamp).toMatchObject({ kind: "declared", mintedVia: d.verb, actor: "unspecified" });
      // A declared stamp never counts as human approval elsewhere.
      expect(scopeProvenance.isHumanApprovalStamp(stamp)).toBe(false);
    });

    it(`${d.verb} cohort form writes declared records without a TTY under agent markers`, () => {
      const dir = root();
      const a = brief(dir, "a", "story-a");
      const b = brief(dir, "b", "story-b");
      const prompts = { count: 0 };
      quiet();
      expect(
        d.run([a, b, "--actor", "agent:leaf", "--project-root", dir], agentShell(prompts)),
      ).toBe(0);
      expect(prompts.count).toBe(0);
      for (const id of ["story-a", "story-b"]) {
        expect(stampOf(dir, d.store, id)).toMatchObject({
          kind: "declared",
          actor: "agent:leaf",
          mintedVia: d.verb,
        });
      }
    });

    it(`${d.verb} refuses --kind and --minted-via`, () => {
      const dir = root();
      const a = brief(dir, "a", "story-a");
      const io = quiet();
      expect(
        d.run([a, "--kind", "operator", "--project-root", dir], agentShell({ count: 0 })),
      ).toBe(2);
      expect(
        d.run([a, "--minted-via=in-harness-ask", "--project-root", dir], agentShell({ count: 0 })),
      ).toBe(2);
      expect(io.err()).toContain("is not accepted");
      expect(existsSync(join(dir, ".deft", d.store))).toBe(false);
    });

    it(`${d.verb} still refuses during an active UAT lease`, () => {
      const dir = root();
      const a = brief(dir, "a", "story-a");
      const b = brief(dir, "b", "story-b");
      startUatLease({ projectRoot: dir, campaignId: "uat-7031", actor: "op" });
      const io = quiet();
      expect(d.run([a, "--project-root", dir], agentShell({ count: 0 }))).toBe(2);
      expect(d.run([a, b, "--project-root", dir], agentShell({ count: 0 }))).toBe(2);
      expect(io.err()).toMatch(/UAT/);
      expect(existsSync(join(dir, ".deft", d.store))).toBe(false);
    });
  }
});

describe("kept mint: live-authority commands still refuse without a TTY (#7031)", () => {
  it("scope:record-approved-scope refuses without the terminal mint", () => {
    const dir = root();
    const a = brief(dir, "a", "story-a");
    quiet();
    expect(
      runApprovedScope(
        [a, "--project-root", dir, "--actor", "scott", "--confirm"],
        agentShell({ count: 0 }),
      ),
    ).toBe(2);
    expect(
      runApprovedScope([a, "--project-root", dir, "--actor", "scott", "--confirm"], {
        isTty: () => false,
        hasControllingTerminal: () => true,
        readInteractiveConfirm: () => "mint",
        environ: {},
      }),
    ).toBe(2);
    expect(existsSync(join(dir, ".deft", "approved-scope"))).toBe(false);
  });

  it("authz:grant --template finish-loop refuses without the terminal mint", () => {
    const dir = root();
    const io = quiet();
    expect(
      authzMain(
        ["grant", "--project-root", dir, "--template", "finish-loop", "--actor", "op", "--confirm"],
        { isTty: () => false, environ: {} },
      ),
    ).toBe(2);
    expect(io.err()).toMatch(/TTY|non-TTY|silent-mint/i);
    expect(existsSync(join(dir, ".deft", "authz", "grants"))).toBe(false);
  });
});
