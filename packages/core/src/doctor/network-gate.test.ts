import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from "node:child_process";
import { DOCTOR_ALLOWED_FLAGS } from "./constants.js";
import { parseDoctorFlags } from "./flags.js";
import { cmdDoctor } from "./main.js";

/**
 * #2182: doctor MUST default to an OFFLINE tier -- the payload-staleness
 * check (the only doctor check that can shell out to `npm`/`git ls-remote`
 * against a registry/remote) MUST be gated behind an explicit `--network`
 * flag, disclosed before it runs, and never invoked from a bare `deft doctor`
 * call (which is exactly what the gated session-ritual tier issues).
 */

function seedConsumerProject(): { root: string; framework: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-doc-network-"));
  const framework = mkdtempSync(join(tmpdir(), "deft-doc-network-fw-"));
  const deposit = join(root, ".deft", "core");
  mkdirSync(deposit, { recursive: true });
  writeFileSync(
    join(deposit, "VERSION"),
    `sha: ${"a".repeat(40)}\nref: v0.1.0\ntag: v0.1.0\n`,
    "utf8",
  );
  // Simulates the private-scope-registry fixture from the issue: a private
  // npm scope pointed at an internal registry. Package-manager network
  // checks in read-only/offline flows MUST NOT contact this (or any)
  // registry, so its mere presence must not change offline-tier behavior.
  writeFileSync(
    join(root, ".npmrc"),
    "@my-private-scope:registry=https://npm.internal.example.com/\n" +
      "//npm.internal.example.com/:_authToken=should-never-be-read\n",
    "utf8",
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
    "utf8",
  );
  return { root, framework };
}

describe("doctor --network flag (#2182)", () => {
  it("is a recognised flag", () => {
    expect(DOCTOR_ALLOWED_FLAGS).toContain("--network");
    expect(parseDoctorFlags(["--network"]).network).toBe(true);
    expect(parseDoctorFlags([]).network).toBe(false);
  });
});

describe("payload-staleness offline-by-default gating (#2182)", () => {
  let root: string;
  let framework: string;
  const spawnSyncMock = vi.mocked(spawnSync);

  beforeEach(() => {
    ({ root, framework } = seedConsumerProject());
    spawnSyncMock.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(framework, { recursive: true, force: true });
  });

  it("skips payload-staleness and never shells out to git/npm without --network", () => {
    const stdout: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      cmdDoctor(["--full", "--json", "--project-root", root], {
        frameworkRoot: framework,
        whichFn: () => "/bin/x",
        agentsRefreshPlan: () => ({ state: "current" }),
      });
    } finally {
      process.stdout.write = origWrite;
    }

    // Real spawnSync (git ls-remote / npm view) MUST never fire when the
    // network tier was not explicitly requested -- this is the assertion
    // the #2182 acceptance criteria calls out: "assert not-called-with-network".
    expect(spawnSyncMock).not.toHaveBeenCalled();

    const payload = JSON.parse(stdout.join(""));
    const finding = (payload.findings as Array<Record<string, unknown>>).find(
      (f) => f.check === "payload-staleness",
    );
    expect(finding?.status).toBe("skip");
    expect(finding?.reason).toBe("offline-tier");
    expect(String(finding?.message)).toContain("--network");
  });

  it("discloses the tool + registry class and runs the check when --network is passed", () => {
    const stdout: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      cmdDoctor(["--full", "--network", "--project-root", root], {
        frameworkRoot: framework,
        whichFn: () => "/bin/x",
        agentsRefreshPlan: () => ({ state: "current" }),
        runGitLsRemote: () => ({ ok: false, stdout: "" }),
        runNpmViewVersion: () => ({ ok: true, version: "9.9.9" }),
      });
    } finally {
      process.stdout.write = origWrite;
    }
    const rendered = stdout.join("");
    // Disclosure MUST appear before any registry contact is possible.
    expect(rendered).toContain("--network");
    expect(rendered).toMatch(/npm registry/i);
    expect(rendered).toContain("registry.npmjs.org");
  });
});
