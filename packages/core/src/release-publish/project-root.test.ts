import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintClosedVerbTemplateGrant } from "../authz/templates.js";
import { cmdReleasePublish } from "./main.js";

/** Repository checkout that holds this module (the old fallback's answer under Vitest). */
const moduleCheckout = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const VERSION = "0.129.0";

/**
 * #6864: with no `--project-root` and no `DEFT_PROJECT_ROOT`, the installed CLI
 * looked for grants in the runtime package. These tests run `cmdReleasePublish`
 * from a temporary repository as the working directory, with the grant minted
 * on disk under that repository and the real grant loader (no grant seam).
 */
describe("release-publish reads grants from the working directory (#6864)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repoAsCwd(template: "release-publish" | "release-promote-latest"): string {
    const dir = mkdtempSync(join(tmpdir(), "release-publish-cwd-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q", dir]);
    const minted = mintClosedVerbTemplateGrant({
      projectRoot: dir,
      template,
      target: VERSION,
      actor: "operator",
    });
    expect(minted.ok).toBe(true);
    // No root flag or env; the old fallback honoured DEFT_ROOT, so point it elsewhere.
    vi.stubEnv("DEFT_PROJECT_ROOT", "");
    vi.stubEnv("DEFT_ROOT", moduleCheckout);
    vi.stubEnv("DEFT_ALLOW_RELEASE_PUBLISH", "");
    vi.stubEnv("DEFT_ALLOW_RELEASE_PROMOTE_LATEST", "");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect(resolve(dir)).not.toBe(resolve(moduleCheckout));
    return dir;
  }

  function stderrText(spy: { mock: { calls: unknown[][] } }): string {
    return spy.mock.calls.map((c) => String(c[0])).join("");
  }

  const originSeam = (_cmd: string, args: readonly string[]) =>
    args.includes("remote")
      ? { status: 0, stdout: "https://github.com/deftai/directive.git\n", stderr: "" }
      : { status: 0, stdout: "{}", stderr: "" };

  it("--promote-latest X --dry-run passes the gate with a release-promote-latest grant", () => {
    repoAsCwd("release-promote-latest");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const rc = cmdReleasePublish(["--promote-latest", VERSION, "--dry-run"], {
      closedVerbEnv: {},
      spawnText: originSeam,
    } as never);
    const out = stderrText(spy);
    expect(out).toContain("Closed-verb gate release-promote-latest");
    expect(out).toContain("OK (closed-verb-allow grant=");
    expect(out).not.toContain("denied code=");
    expect(rc).toBe(0);
  });

  it("release-publish X passes the gate with a release-publish grant", () => {
    repoAsCwd("release-publish");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let viewCalls = 0;
    const rc = cmdReleasePublish([VERSION], {
      closedVerbEnv: {},
      whichGh: () => "/usr/bin/gh",
      spawnText: (cmd: string, args: readonly string[]) => {
        if (args.includes("--paginate")) {
          viewCalls += 1;
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 42,
                draft: viewCalls === 1,
                tag_name: `v${VERSION}`,
                html_url: "https://example.com/r",
              },
            ]),
            stderr: "",
          };
        }
        return originSeam(cmd, args);
      },
    } as never);
    const out = stderrText(spy);
    expect(out).toContain("OK (closed-verb-allow grant=");
    expect(out).not.toContain("denied code=");
    expect(rc).toBe(0);
  });

  it("a deny without a grant names the working directory it searched", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-publish-cwd-empty-"));
    dirs.push(dir);
    vi.stubEnv("DEFT_PROJECT_ROOT", "");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const rc = cmdReleasePublish(["--promote-latest", VERSION, "--dry-run"], {
      closedVerbEnv: {},
      spawnText: originSeam,
    } as never);
    expect(rc).toBe(1);
    const deny = spy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.startsWith("[promote-latest] denied code="));
    expect(deny).toContain(`projectRoot=${resolve(dir)}\n`);
  });
});
