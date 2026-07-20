import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeSessionReleaseAvailability } from "./release-availability.js";

const root = join("consumer");
const manifestPath = join(root, ".deft", "core", "VERSION");
const statePath = join(root, "xbrief", ".triage-cache", "release-availability-state.json");
const manifest = `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n`;

function options(overrides: Parameters<typeof probeSessionReleaseAvailability>[1] = {}) {
  return {
    isFile: (path: string) => path === manifestPath,
    readText: (path: string) => (path === manifestPath ? manifest : null),
    now: new Date("2026-07-20T20:30:00Z"),
    ...overrides,
  };
}

describe("session release availability advisory (#1692)", () => {
  it("discloses the public registry and emits a newer-release advisory", () => {
    let written = "";
    const result = probeSessionReleaseAvailability(
      root,
      options({
        runNpmView: () => ({ ok: true, version: "1.1.0" }),
        writeState: (_path, content) => {
          written = content;
        },
      }),
    );

    expect(result.lines.join("\n")).toContain("registry.npmjs.org");
    expect(result.lines.join("\n")).toContain("Newer Directive release available: v1.1.0");
    expect(written).toContain('"latestVersion": "1.1.0"');
  });

  it("suppresses a repeat notification for the same latest version within 24 hours", () => {
    const result = probeSessionReleaseAvailability(
      root,
      options({
        runNpmView: () => ({ ok: true, version: "1.1.0" }),
        readState: (path) =>
          path === statePath
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
    let calls = 0;
    const result = probeSessionReleaseAvailability(
      root,
      options({
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
});
