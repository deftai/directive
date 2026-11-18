import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(result.output).toContain("does not load the project `.npmrc`");
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

  it("names only the two published Directive packages in mirror advice (#6141)", () => {
    const result = runCheck({
      "@deftai:registry": { ok: true, value: "undefined" },
      registry: { ok: true, value: "https://npm.internal.example.com/" },
    });

    expect(result.output).toContain("`@deftai/directive` and `@deftai/directive-runtime`");
    for (const retired of ["directive-core", "directive-content", "directive-types"]) {
      expect(result.output).not.toContain(retired);
    }
  });

  describe("split @deftai scope (#6141)", () => {
    function runInProject(
      manifest: Record<string, unknown> | null,
      values: Readonly<Record<string, { ok: boolean; value: string }>>,
    ): { findings: Finding[]; output: string } {
      const root = mkdtempSync(join(tmpdir(), "npm-registry-split-"));
      try {
        if (manifest !== null) {
          writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
        }
        const findings: Finding[] = [];
        const output: string[] = [];
        runNpmRegistryMirrorCheck(
          root,
          createPlainSink({ write: (text) => output.push(text) }),
          (finding) => findings.push(finding),
          { runNpmConfigGet: (key) => values[key] ?? { ok: false, value: "" } },
        );
        return { findings, output: output.join("") };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const privateScope = "https://ci-bot:tok123@npm.pkg.github.com/deftai/";

    it("reports split-scope without remap advice or the configured URL", () => {
      const result = runInProject(
        {
          dependencies: { "@deftai/rivet-os": "1.0.0" },
          devDependencies: { "@deftai/directive-runtime": "1.2.3" },
        },
        { "@deftai:registry": { ok: true, value: privateScope } },
      );

      expect(result.findings).toEqual([
        expect.objectContaining({
          severity: "warning",
          check: "npm-registry-mirror",
          status: "split-scope",
          registry_source: "scoped",
        }),
      ]);
      expect(result.output).not.toContain("@deftai:registry=https://registry.npmjs.org/");
      expect(result.output).toContain("Do not remap the whole @deftai scope");
      expect(result.output).toContain("`npm ci` / `pnpm install --frozen-lockfile`");
      expect(result.output).toContain("proxy registry");
      expect(result.output).toContain("different scope");
      expect(result.output).toContain("`@deftai/directive` and `@deftai/directive-runtime`");
      const serialized = JSON.stringify(result.findings) + result.output;
      expect(serialized).not.toContain("npm.pkg.github.com");
      expect(serialized).not.toContain("tok123");
    });

    it("keeps today's advice when no other @deftai package is used", () => {
      const result = runInProject(
        { devDependencies: { "@deftai/directive-runtime": "1.2.3", "@deftai/directive": "1.2.3" } },
        { "@deftai:registry": { ok: true, value: privateScope } },
      );

      expect(result.findings[0]).toMatchObject({ status: "non-public", registry_source: "scoped" });
      expect(result.output).toContain("@deftai:registry=https://registry.npmjs.org/");
      expect(result.output).toContain("`@deftai/directive` and `@deftai/directive-runtime`");
      expect(result.output).not.toContain("npm.pkg.github.com");
    });

    it("does not call a default-registry mirror split even with other @deftai packages", () => {
      const result = runInProject(
        { dependencies: { "@deftai/rivet-os": "1.0.0" } },
        {
          "@deftai:registry": { ok: true, value: "undefined" },
          registry: { ok: true, value: "https://npm.internal.example.com/" },
        },
      );

      expect(result.findings[0]).toMatchObject({
        status: "non-public",
        registry_source: "default",
      });
    });

    it("treats a missing package.json as no other packages", () => {
      expect(
        runInProject(null, { "@deftai:registry": { ok: true, value: privateScope } }).findings[0],
      ).toMatchObject({ status: "non-public" });
    });
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
