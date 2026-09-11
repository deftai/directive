import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { defaultNpmConfigGet, runNpmRegistryMirrorCheck } from "./npm-registry.js";
import { createPlainSink } from "./output.js";
import type { Finding } from "./types.js";

function runCheck(values: Readonly<Record<string, { ok: boolean; value: string }>>): {
  findings: Finding[];
  output: string;
  keys: string[];
} {
  const findings: Finding[] = [];
  const output: string[] = [];
  const keys: string[] = [];
  runNpmRegistryMirrorCheck(
    "/tmp/project",
    createPlainSink({ write: (text) => output.push(text) }),
    (finding) => findings.push(finding),
    {
      runNpmConfigGet: (key) => {
        keys.push(key);
        return values[key] ?? { ok: false, value: "" };
      },
    },
  );
  return { findings, output: output.join(""), keys };
}

describe("npm registry mirror doctor check (#2808)", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("does not warn when the default registry is the canonical public registry", () => {
    const result = runCheck({
      "@deftai:registry": { ok: true, value: "undefined" },
      registry: { ok: true, value: "https://registry.npmjs.org/" },
    });

    expect(result.keys).toEqual(["@deftai:registry", "registry"]);
    expect(result.findings.filter((finding) => finding.severity === "warning")).toEqual([]);
    expect(result.output).toBe("");
  });

  it("warns when the effective default registry is a corporate mirror", () => {
    const result = runCheck({
      "@deftai:registry": { ok: true, value: "undefined" },
      registry: { ok: true, value: "https://npm.internal.example.com/artifactory/api/npm/" },
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        check: "npm-registry-mirror",
        status: "non-public",
        registry_source: "default",
      }),
    );
    expect(result.output).toContain("E404");
    expect(result.output).toContain("ETARGET");
    expect(result.output).toContain("silently serve stale");
    expect(result.output).toContain("--registry` does not beat `@deftai:registry");
    expect(result.output).toContain("$HOME");
    expect(result.output).toContain("--userconfig");
    expect(result.output).toContain("@deftai:registry=https://registry.npmjs.org/");
    expect(result.output).not.toMatch(/retry with `npm i -g @deftai\/directive@latest --registry=/);
    expect(result.output).toContain("content/UPGRADING.md#corporate-or-mirrored-npm-registry");
  });

  it("honors a public @deftai scoped registry over a mirrored default", () => {
    const result = runCheck({
      "@deftai:registry": { ok: true, value: "https://registry.npmjs.org/" },
      registry: { ok: true, value: "https://npm.internal.example.com/" },
    });

    expect(result.keys).toEqual(["@deftai:registry"]);
    expect(result.findings.filter((finding) => finding.severity === "warning")).toEqual([]);
  });

  it("warns when a mirrored @deftai scoped registry overrides a public default", () => {
    const result = runCheck({
      "@deftai:registry": { ok: true, value: "https://npm.internal.example.com/" },
      registry: { ok: true, value: "https://registry.npmjs.org/" },
    });

    expect(result.keys).toEqual(["@deftai:registry"]);
    expect(result.findings[0]).toMatchObject({
      severity: "warning",
      check: "npm-registry-mirror",
      registry_source: "scoped",
    });
  });

  it.each([
    ["scoped command failure", { "@deftai:registry": { ok: false, value: "" } }],
    [
      "default command failure",
      {
        "@deftai:registry": { ok: true, value: "undefined" },
        registry: { ok: false, value: "" },
      },
    ],
    [
      "malformed registry",
      {
        "@deftai:registry": { ok: true, value: "undefined" },
        registry: { ok: true, value: "not a registry URL" },
      },
    ],
    [
      "unset registries",
      {
        "@deftai:registry": { ok: true, value: "null" },
        registry: { ok: true, value: "  " },
      },
    ],
  ])("skips without warning when %s", (_label, values) => {
    const result = runCheck(values);

    expect(result.findings.filter((finding) => finding.severity === "warning")).toEqual([]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "skip",
        check: "npm-registry-mirror",
        status: "skip",
      }),
    );
  });

  it("never renders a registry URL or embedded credentials", () => {
    const secretRegistry =
      "https://build-user:super-secret@npm.internal.example.com/artifactory/api/npm/";
    const result = runCheck({
      "@deftai:registry": { ok: true, value: secretRegistry },
    });
    const serialized = JSON.stringify(result.findings);

    expect(result.output).not.toContain(secretRegistry);
    expect(result.output).not.toContain("npm.internal.example.com");
    expect(result.output).not.toContain("super-secret");
    expect(serialized).not.toContain(secretRegistry);
    expect(serialized).not.toContain("npm.internal.example.com");
    expect(serialized).not.toContain("super-secret");
  });

  it("does not treat the insecure public HTTP endpoint as canonical", () => {
    const result = runCheck({
      "@deftai:registry": { ok: true, value: "http://registry.npmjs.org/" },
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        check: "npm-registry-mirror",
      }),
    );
  });

  it("runs npm config get without a shell or network-capable npm subcommand", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "https://registry.npmjs.org/\n",
      stderr: "",
      pid: 1,
      output: [null, "https://registry.npmjs.org/\n", ""],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmConfigGet("@deftai:registry", "/tmp/project")).toEqual({
      ok: true,
      value: "https://registry.npmjs.org/",
    });
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "npm",
      ["config", "get", "@deftai:registry"],
      {
        cwd: "/tmp/project",
        encoding: "utf8",
        shell: false,
        timeout: 5_000,
        windowsHide: true,
      },
    );
  });
});
