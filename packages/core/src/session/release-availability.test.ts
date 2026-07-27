import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTriageCachePath } from "../triage/cache-path.js";
import { probeSessionReleaseAvailability } from "./release-availability.js";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scaffoldConsumer(): {
  root: string;
  manifestPath: string;
  statePath: string;
  manifest: string;
} {
  const root = mkdtempSync(join(tmpdir(), "deft-session-rel-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
  const manifest = `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n`;
  const manifestPath = join(root, ".deft", "core", "VERSION");
  writeFileSync(manifestPath, manifest, "utf8");
  const statePath = resolveTriageCachePath(root, "release-availability-state.json");
  return { root, manifestPath, statePath, manifest };
}

function options(
  fixture: ReturnType<typeof scaffoldConsumer>,
  overrides: Parameters<typeof probeSessionReleaseAvailability>[1] = {},
) {
  return {
    isFile: (path: string) => path === fixture.manifestPath,
    readText: (path: string) => (path === fixture.manifestPath ? fixture.manifest : null),
    now: new Date("2026-07-20T20:30:00Z"),
    ...overrides,
  };
}

describe("session release availability advisory (#1692 / #2869)", () => {
  it("discloses the public registry and emits a newer-release advisory", () => {
    const fixture = scaffoldConsumer();
    let written = "";
    let writtenPath = "";
    const result = probeSessionReleaseAvailability(
      fixture.root,
      options(fixture, {
        runNpmView: () => ({ ok: true, version: "1.1.0" }),
        writeState: (path, content) => {
          writtenPath = path;
          written = content;
        },
      }),
    );

    expect(result.lines.join("\n")).toContain("registry.npmjs.org");
    expect(result.lines.join("\n")).toContain("Newer Directive release available: v1.1.0");
    expect(written).toContain('"latestVersion": "1.1.0"');
    expect(writtenPath).toBe(fixture.statePath);
  });

  it("suppresses a repeat notification for the same latest version within 24 hours", () => {
    const fixture = scaffoldConsumer();
    const result = probeSessionReleaseAvailability(
      fixture.root,
      options(fixture, {
        runNpmView: () => ({ ok: true, version: "1.1.0" }),
        readState: (path) =>
          path === fixture.statePath
            ? JSON.stringify({
                latestVersion: "1.1.0",
                notifiedAt: "2026-07-20T00:00:00Z",
              })
            : null,
      }),
    );

    expect(result.lines).toEqual([]);
  });

  it("skips without contacting npm when DEFT_NO_NETWORK=1", () => {
    const fixture = scaffoldConsumer();
    let calls = 0;
    const result = probeSessionReleaseAvailability(
      fixture.root,
      options(fixture, {
        env: { DEFT_NO_NETWORK: "1" },
        runNpmView: () => {
          calls += 1;
          return { ok: true, version: "1.1.0" };
        },
      }),
    );

    expect(calls).toBe(0);
    expect(result.lines).toEqual(["[deft release] skipped (DEFT_NO_NETWORK=1)."]);
  });

  it("resolves throttle state via resolveTriageCachePath (no hardcoded join)", () => {
    const fixture = scaffoldConsumer();
    expect(fixture.statePath.replace(/\\/g, "/")).toMatch(
      /xbrief\/\.triage-cache\/release-availability-state\.json$/,
    );
  });
});
