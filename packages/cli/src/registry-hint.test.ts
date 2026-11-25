/**
 * Split `@deftai` registry hint (#6141, D-009 message only).
 */
import { describe, expect, it } from "vitest";
import { isDirectiveRegistryMiss, scopedRegistryHint } from "./registry-hint.js";

const PRIVATE = "https://ci-bot:tok123@npm.pkg.github.com/deftai/";

const NPM_404 = [
  "npm view @deftai/directive-runtime version failed: npm error code E404",
  "npm error 404 Not Found - GET https://npm.pkg.github.com/deftai/@deftai%2fdirective-runtime - Not found",
  "npm error 404 '@deftai/directive-runtime@*' is not in this registry.",
].join("\n");

function hintFor(blob: string, registry: string | null, extra: Record<string, unknown> = {}) {
  return scopedRegistryHint("/tmp/project", blob, {
    verb: "upgrade",
    env: {},
    readScopedRegistry: () => registry,
    ...extra,
  });
}

describe("isDirectiveRegistryMiss", () => {
  it.each([
    ["npm E404", NPM_404],
    ["pnpm fetch 404", "ERR_PNPM_FETCH_404 GET https://x/@deftai%2Fdirective-runtime: Not Found"],
    [
      "ETARGET",
      "npm error code ETARGET\nNo matching version found for @deftai/directive-runtime@9.9.9",
    ],
    [
      "pnpm no matching",
      "ERR_PNPM_NO_MATCHING_VERSION No matching version for @deftai/directive@1.0.0",
    ],
  ])("matches %s", (_label, blob) => {
    expect(isDirectiveRegistryMiss(blob)).toBe(true);
  });

  it("ignores a 404 for a non-Directive package", () => {
    expect(
      isDirectiveRegistryMiss("npm error code E404\nnpm error 404 '@deftai/rivet-os@1.0.0'"),
    ).toBe(false);
    expect(
      isDirectiveRegistryMiss("npm error code E404\n'left-pad@*' is not in this registry"),
    ).toBe(false);
  });

  it("ignores another dependency's miss when only the command echo names Directive", () => {
    const blob = [
      "npm install --save-dev --save-exact @deftai/directive-runtime@1.2.3 failed",
      "npm error code E404",
      "npm error 404 Not Found - GET https://proxy.example/@acme%2fwidget - Not found",
      "npm error 404 '@acme/widget@^2.0.0' is not in this registry.",
    ].join("\n");
    expect(isDirectiveRegistryMiss(blob)).toBe(false);
    expect(
      isDirectiveRegistryMiss(
        "npm view @deftai/directive-runtime@2.0.0 directive failed: npm error code E404",
      ),
    ).toBe(false);
  });

  it("ignores non-miss failures such as an unreachable host", () => {
    expect(isDirectiveRegistryMiss("npm error code ENOTFOUND for @deftai/directive-runtime")).toBe(
      false,
    );
  });
});

describe("scopedRegistryHint", () => {
  it("returns the hint for a Directive miss under a non-public @deftai:registry", () => {
    const result = hintFor(NPM_404, PRIVATE);
    expect(result).not.toBeNull();
    const hint = result?.hint ?? "";
    expect(hint).toContain("sends every @deftai package to a non-public registry");
    expect(hint).toContain("@deftai/directive, @deftai/directive-runtime");
    expect(hint).toContain("Do not remap the whole @deftai scope in .npmrc");
    expect(hint).toContain("Re-run the same command with the same flags");
    expect(hint).toContain("works only when your other @deftai packages");
    expect(hint).toContain("proxy with an npmjs upstream");
    expect(hint).toContain(
      "env 'npm_config_@deftai:registry=https://registry.npmjs.org/' directive upgrade",
    );
    expect(hint).toContain(
      "PowerShell: $" +
        "{env:npm_config_@deftai:registry}='https://registry.npmjs.org/'; directive upgrade; Remove-Item 'env:npm_config_@deftai:registry'",
    );
    expect(hint).not.toContain("npm.pkg.github.com");
    expect(hint).not.toContain("tok123");
  });

  it("redacts the configured registry from PM output", () => {
    const result = hintFor(NPM_404, PRIVATE);
    const redacted = result?.redact(NPM_404) ?? "";
    expect(redacted).not.toContain("npm.pkg.github.com");
    expect(redacted).toContain("<@deftai registry>");
    expect(redacted).toContain("E404");
    expect(result?.redact(`config is ${PRIVATE}`)).toBe("config is <@deftai registry>");
  });

  it("redacts a host:port registry (local stub)", () => {
    const blob =
      "npm error code E404\nnpm error 404 Not Found - GET http://127.0.0.1:48765/@deftai%2fdirective-runtime - Not found";
    const result = hintFor(blob, "http://127.0.0.1:48765/");
    expect(result?.redact(blob)).not.toContain("127.0.0.1");
  });

  it("returns null when @deftai:registry is public, unset or invalid", () => {
    expect(hintFor(NPM_404, "https://registry.npmjs.org/")).toBeNull();
    expect(hintFor(NPM_404, "undefined")).toBeNull();
    expect(hintFor(NPM_404, null)).toBeNull();
    expect(hintFor(NPM_404, "not a url")).toBeNull();
  });

  it("returns null for a non-Directive 404 without reading config", () => {
    let read = false;
    const result = scopedRegistryHint("/tmp/project", "npm error code E404 @deftai/rivet-os", {
      verb: "install",
      readScopedRegistry: () => {
        read = true;
        return PRIVATE;
      },
    });
    expect(result).toBeNull();
    expect(read).toBe(false);
  });

  it("npm repair with a lockfile pin names npm ci first; pnpm does not", () => {
    const npm = hintFor(NPM_404, PRIVATE, {
      verb: "repair",
      pm: "npm",
      lockfileRecordsPin: true,
    })?.hint;
    expect(npm).toContain(
      "If package-lock.json records the runtime's npmjs URL, run `npm ci` in this project, then `directive install --repair`",
    );
    expect(npm?.indexOf("npm ci")).toBeLessThan(npm?.indexOf("env 'npm_config") ?? 0);

    // pnpm lockfiles carry no tarball URL; a frozen install re-routes through the scope.
    const pnpm = hintFor(NPM_404, PRIVATE, {
      verb: "repair",
      pm: "pnpm",
      lockfileRecordsPin: true,
    })?.hint;
    expect(pnpm).not.toContain("--frozen-lockfile");
    expect(pnpm).toContain(
      "env 'npm_config_@deftai:registry=https://registry.npmjs.org/' directive install --repair",
    );

    const noLock = hintFor(NPM_404, PRIVATE, { verb: "repair", lockfileRecordsPin: false })?.hint;
    expect(noLock).not.toContain("npm ci");
    expect(noLock).toContain("directive install --repair");
  });

  it("swallows a throwing config read", () => {
    expect(
      scopedRegistryHint("/tmp/project", NPM_404, {
        verb: "install",
        readScopedRegistry: () => {
          throw new Error("boom");
        },
      }),
    ).toBeNull();
  });
});
