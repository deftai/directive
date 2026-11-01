import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultWhich } from "../scm/binary.js";
import { computeDesiredLabels, reconcileLabels, ScmLabelClient } from "./labels.js";
import type { LabelClient } from "./types.js";

class FakeLabelClient implements LabelClient {
  labels = new Map<string, string[]>();
  applyCalls: Array<[string, number, string[], string[]]> = [];

  fetchLabels(repo: string, issueNumber: number): string[] {
    return [...(this.labels.get(`${repo}:${issueNumber}`) ?? [])];
  }

  apply(
    repo: string,
    issueNumber: number,
    add: readonly string[],
    remove: readonly string[],
  ): void {
    this.applyCalls.push([repo, issueNumber, [...add], [...remove]]);
    const key = `${repo}:${issueNumber}`;
    const cur = new Set(this.labels.get(key) ?? []);
    for (const a of add) cur.add(a);
    for (const r of remove) cur.delete(r);
    this.labels.set(key, [...cur].sort());
  }
}

describe("computeDesiredLabels", () => {
  it("blocked status adds status:blocked", () => {
    expect(computeDesiredLabels({ status: "blocked", metadata: { kind: "story" } }, false)).toEqual(
      new Set(["status:blocked"]),
    );
  });

  it("epic adds tracker labels", () => {
    expect(computeDesiredLabels({ status: "running", metadata: { kind: "epic" } }, false)).toEqual(
      new Set(["epic", "status:tracker"]),
    );
  });
});

describe("reconcileLabels", () => {
  it("adds blocked label", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-labels-"));
    const dir = join(root, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "story.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "blk",
          status: "blocked",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/10" },
          ],
        },
      })}\n`,
      "utf8",
    );
    const client = new FakeLabelClient();
    const [code, outcome] = reconcileLabels(root, { client, repo: "deftai/directive" });
    expect(code).toBe(0);
    expect(client.applyCalls[0]?.[2]).toEqual(["status:blocked"]);
    expect(outcome.changed.length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses cross-repo label mutation without allowCrossRepo (#2601)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-labels-cross-"));
    const dir = join(root, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "story.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "foreign",
          status: "blocked",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/other/victim/issues/99" },
          ],
        },
      })}\n`,
      "utf8",
    );
    const client = new FakeLabelClient();
    client.labels.set("other/victim:99", []);
    const [code, outcome] = reconcileLabels(root, { client, repo: "deftai/directive" });
    expect(code).toBe(1);
    expect(client.applyCalls).toHaveLength(0);
    expect(outcome.errors[0]?.message).toMatch(/refusing cross-repo mutation/);
    rmSync(root, { recursive: true, force: true });
  });

  it("allows cross-repo label mutation when allowCrossRepo is set (#2601)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-labels-cross-allow-"));
    const dir = join(root, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "story.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "foreign",
          status: "blocked",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/other/victim/issues/99" },
          ],
        },
      })}\n`,
      "utf8",
    );
    const client = new FakeLabelClient();
    client.labels.set("other/victim:99", []);
    const [code, outcome] = reconcileLabels(root, {
      client,
      repo: "deftai/directive",
      allowCrossRepo: true,
    });
    expect(code).toBe(0);
    expect(client.applyCalls).toHaveLength(1);
    expect(outcome.changed.length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns exit 2 without vbrief dir", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-labels-missing-"));
    const [code] = reconcileLabels(root, { client: new FakeLabelClient() });
    expect(code).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("ScmLabelClient.fetchLabels plain gh env (#6023)", () => {
  it("reads labels via real call() and a PATH gh shim under CLICOLOR_FORCE=1", () => {
    const stub = resolve(
      import.meta.dirname,
      "..",
      "pr-protected-issues",
      "fixtures",
      "color-gh-stub.mjs",
    );
    // Shim dir under the workspace node_modules/.cache, not os.tmpdir(): a noexec
    // /tmp would block the POSIX shim, while node_modules must already be exec-able
    // for the vitest run itself (node_modules/.bin).
    const cacheDir = join(process.cwd(), "node_modules", ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const dir = mkdtempSync(join(cacheDir, "deft-6023-gh-shim-"));
    try {
      // `issue view` is a live-gh call shape, so call() resolves bare `gh`
      // through PATH like the work-claim scan does.
      if (process.platform === "win32") {
        const cmd = `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`;
        writeFileSync(join(dir, "gh.cmd"), cmd, "utf8");
      } else {
        const sh = `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`;
        writeFileSync(join(dir, "gh"), sh, "utf8");
        chmodSync(join(dir, "gh"), 0o755);
      }
      const sep = process.platform === "win32" ? ";" : ":";
      vi.stubEnv("PATH", `${dir}${sep}${process.env.PATH ?? ""}`);
      vi.stubEnv("CLICOLOR_FORCE", "1");
      vi.stubEnv("NO_COLOR", "");
      // Guard: fail before any spawn unless PATH resolves gh to the shim, so a
      // missed shim can never fall through to a live gh call.
      const found = defaultWhich("gh");
      expect(found).not.toBeNull();
      expect(resolve(dirname(found ?? "")).toLowerCase()).toBe(resolve(dir).toLowerCase());
      // Non-existent repo: even a live gh could only make a failing read.
      const labels = new ScmLabelClient().fetchLabels("example-invalid/no-such-repo-6023", 6023);
      // Marker label only the stub returns: proves the shim ran.
      expect(labels).toEqual(["x-stub-6023-marker"]);
      expect(process.env.CLICOLOR_FORCE).toBe("1");
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
