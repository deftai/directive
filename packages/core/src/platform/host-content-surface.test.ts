import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyHostContentSurface,
  ENV_HOST_CONTENT_SURFACE,
  ENV_HOST_REPL_FIRST,
  ENV_HOST_SELF_MUTATE,
  formatHostContentSurfaceLines,
  hostContentSurfaceToDict,
  probeHostContentSurface,
  probeManagedSectionDrift,
} from "./host-content-surface.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "host-surface-"));
  temps.push(root);
  return root;
}

const MANAGED_BODY = [
  "<!-- deft:managed-section v3 sha=deadbeefcafe refreshed=2026-01-01T00:00:00Z session=abc -->",
  "! always-pin example",
  "<!-- /deft:managed-section -->",
].join("\n");

describe("classifyHostContentSurface (#3162)", () => {
  it("defaults to file-first when no signals", () => {
    const result = classifyHostContentSurface({});
    expect(result.contentClass).toBe("file-first");
    expect(result.source).toBe("assumed");
    expect(result.signals).toEqual([]);
  });

  it("honors explicit DEFT_HOST_CONTENT_SURFACE", () => {
    const result = classifyHostContentSurface({
      [ENV_HOST_CONTENT_SURFACE]: "repl-first",
    });
    expect(result.contentClass).toBe("repl-first");
    expect(result.source).toBe(`env:${ENV_HOST_CONTENT_SURFACE}`);
    expect(result.signals).toContain(ENV_HOST_CONTENT_SURFACE);
  });

  it("accepts self-mutating aliases", () => {
    expect(
      classifyHostContentSurface({ [ENV_HOST_CONTENT_SURFACE]: "continual-harness" }).contentClass,
    ).toBe("self-mutating");
  });

  it("returns unknown for unrecognized explicit value", () => {
    const result = classifyHostContentSurface({
      [ENV_HOST_CONTENT_SURFACE]: "not-a-class",
    });
    expect(result.contentClass).toBe("unknown");
    expect(result.source).toContain("unrecognized");
  });

  it("self-mutate supersedes repl-first when both set", () => {
    const result = classifyHostContentSurface({
      [ENV_HOST_SELF_MUTATE]: "1",
      [ENV_HOST_REPL_FIRST]: "yes",
    });
    expect(result.contentClass).toBe("self-mutating");
    expect(result.signals).toEqual(
      expect.arrayContaining([ENV_HOST_SELF_MUTATE, ENV_HOST_REPL_FIRST]),
    );
  });

  it("classifies REPL-first from env flag", () => {
    expect(classifyHostContentSurface({ [ENV_HOST_REPL_FIRST]: "true" }).contentClass).toBe(
      "repl-first",
    );
  });
});

describe("probeManagedSectionDrift (#3162)", () => {
  it("reports absent when AGENTS.md is missing", () => {
    const root = tempRoot();
    const report = probeManagedSectionDrift(root, {
      agentsMdSeams: {
        readTemplate: () => MANAGED_BODY,
        resolveSha: () => "deadbeefcafe",
      },
    });
    expect(report.state).toBe("absent");
    expect(report.path).toContain("AGENTS.md");
  });

  it("reports current when body matches template", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), `header\n${MANAGED_BODY}\n`, "utf8");
    const report = probeManagedSectionDrift(root, {
      agentsMdSeams: {
        readTemplate: () =>
          "<!-- deft:managed-section v3 -->\n! always-pin example\n<!-- /deft:managed-section -->",
        resolveSha: () => "deadbeefcafe",
      },
    });
    expect(report.state).toBe("current");
    expect(report.embeddedSha).toBe("deadbeefcafe");
    expect(report.bodyHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("reports stale when managed body drifted", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `header\n${MANAGED_BODY.replace("always-pin example", "host rewrote pins")}\n`,
      "utf8",
    );
    const report = probeManagedSectionDrift(root, {
      agentsMdSeams: {
        readTemplate: () =>
          "<!-- deft:managed-section v3 -->\n! always-pin example\n<!-- /deft:managed-section -->",
        resolveSha: () => "deadbeefcafe",
      },
    });
    expect(report.state).toBe("stale");
  });
});

describe("probeHostContentSurface + format (#3162)", () => {
  it("builds a serializable report with honesty lines for REPL-first + drift", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `header\n${MANAGED_BODY.replace("always-pin example", "tampered")}\n`,
      "utf8",
    );
    const report = probeHostContentSurface(root, {
      environ: { [ENV_HOST_CONTENT_SURFACE]: "repl-first" },
      runtimeMode: "local-unsandboxed",
      agentsMdSeams: {
        readTemplate: () =>
          "<!-- deft:managed-section v3 -->\n! always-pin example\n<!-- /deft:managed-section -->",
        resolveSha: () => "deadbeefcafe",
      },
    });
    expect(report.contentClass).toBe("repl-first");
    expect(report.runtimeMode).toBe("local-unsandboxed");
    expect(report.managedSection.state).toBe("stale");

    const dict = hostContentSurfaceToDict(report);
    expect(dict.content_class).toBe("repl-first");
    expect((dict.managed_section as { state: string }).state).toBe("stale");

    const lines = formatHostContentSurfaceLines(report);
    expect(lines[0]).toContain("[deft host-surface] class=repl-first");
    expect(lines[0]).toContain("managed=stale");
    expect(lines.some((l) => l.includes("honesty:"))).toBe(true);
    expect(lines.some((l) => l.includes("agents:refresh"))).toBe(true);
  });

  it("file-first + current is a single summary line", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), `header\n${MANAGED_BODY}\n`, "utf8");
    const report = probeHostContentSurface(root, {
      environ: {},
      agentsMdSeams: {
        readTemplate: () =>
          "<!-- deft:managed-section v3 -->\n! always-pin example\n<!-- /deft:managed-section -->",
        resolveSha: () => "deadbeefcafe",
      },
    });
    const lines = formatHostContentSurfaceLines(report);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("class=file-first");
    expect(lines[0]).toContain("managed=current");
  });

  it("absent AGENTS.md includes agents:refresh remediation", () => {
    const root = tempRoot();
    const report = probeHostContentSurface(root, {
      environ: {},
      agentsMdSeams: {
        readTemplate: () =>
          "<!-- deft:managed-section v3 -->\n! always-pin example\n<!-- /deft:managed-section -->",
        resolveSha: () => "deadbeefcafe",
      },
    });
    expect(report.managedSection.state).toBe("absent");
    const lines = formatHostContentSurfaceLines(report);
    expect(lines.some((l) => l.includes("agents:refresh"))).toBe(true);
  });
});
