/**
 * #6185: a root mismatch caused by a runtime linked in from another checkout is
 * named `foreign-runtime-link` with a recovery that clears it. Wording only:
 * every case is still a deny, and a genuine mismatch keeps today's text.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE } from "@deftai/directive-core/dist/install-health/constants.js";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLaunchingCheckoutRootFromPath, run } from "./hook-dispatch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = resolve(HERE, "..", "dist");
const PACKAGES = resolve(HERE, "..", "..");

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const t = temps.pop();
    if (t) rmSync(t, { recursive: true, force: true });
  }
});

function tempBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fwdlink-")));
  temps.push(base);
  return base;
}

function junction(target: string, link: string): void {
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, "junction");
}

function installRuntime(checkout: string): string {
  const dir = join(checkout, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "hook-bin.js"), "// fixture\n");
  return dir;
}

interface Outcome {
  readonly code: number;
  readonly raw: string;
  readonly message: string;
}

/** Drive `run` as if hook-bin were launched from `linkSideFile`, real path under `realFile`. */
function runFrom(projectRoot: string, linkSideFile: string | undefined, realFile: string): Outcome {
  const out: string[] = [];
  const code = run(["--host=cursor", "--event=tool.before", `--project-root=${projectRoot}`], {
    readStdin: () =>
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: join(projectRoot, "a.txt"), contents: "x" },
        workspace_roots: [projectRoot],
      }),
    writeOut: (text) => out.push(text),
    writeErr: () => undefined,
    cwd: () => projectRoot,
    stdinEmptyRetryMs: 0,
    launchingCheckoutRoot: () => resolveLaunchingCheckoutRootFromPath(realpathSync(realFile)),
    launcherPath: () => linkSideFile,
  });
  const raw = out.join("").trim();
  const body = raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
  const message = String(body.user_message ?? body.agent_message ?? body.reason ?? "");
  return { code, raw, message };
}

const HOOK_REL = join("node_modules", "@deftai", "directive-runtime", "dist", "hook-bin.js");

describe("foreign-runtime-link refusal (#6185)", () => {
  it("names a junctioned runtime directory and gives the scoped recovery", () => {
    const base = tempBase();
    const owner = join(base, "owner");
    const w = join(base, "w");
    mkdirSync(w);
    const ownerRuntime = installRuntime(owner);
    junction(ownerRuntime, join(w, "node_modules", "@deftai", "directive-runtime"));
    const result = runFrom(w, join(w, HOOK_REL), join(w, HOOK_REL));
    expect(result.code).toBe(0);
    expect(result.message).toContain("foreign-runtime-link");
    expect(result.message).toContain(`payloadRoot=${w} `);
    expect(result.message).toContain(`launchRoot=${owner})`);
    expect(result.message).toContain("terminal outside this locked agent session");
    expect(result.message.replace(/\\/g, "/")).toContain(`${w.replace(/\\/g, "/")}/node_modules`);
    expect(result.message).toContain("clears the foreign-runtime root mismatch");
    expect(result.message).not.toContain("<payloadRoot>");
    expect(result.message).not.toContain(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE);
  });

  it("names a junctioned whole node_modules", () => {
    const base = tempBase();
    const owner = join(base, "owner");
    const w = join(base, "w");
    mkdirSync(w);
    installRuntime(owner);
    junction(join(owner, "node_modules"), join(w, "node_modules"));
    const result = runFrom(w, join(w, HOOK_REL), join(w, HOOK_REL));
    expect(result.message).toContain("foreign-runtime-link");
  });

  it("names a nested reverse link (primary runtime linked into a nested worker worktree)", () => {
    const base = tempBase();
    const p = join(base, "p");
    const w = join(p, ".deft-scratch", "worktrees", "w");
    mkdirSync(w, { recursive: true });
    const pRuntime = installRuntime(p);
    junction(pRuntime, join(w, "node_modules", "@deftai", "directive-runtime"));
    const result = runFrom(w, join(w, HOOK_REL), join(w, HOOK_REL));
    expect(result.message).toContain("foreign-runtime-link");
    expect(result.message).toContain(`launchRoot=${p})`);
  });

  it("keeps today's text for a genuine mismatch (own runtime, other payload root)", () => {
    const base = tempBase();
    const p = join(base, "p");
    const other = join(base, "other");
    mkdirSync(other);
    installRuntime(p);
    const result = runFrom(other, join(p, HOOK_REL), join(p, HOOK_REL));
    expect(result.code).toBe(0);
    expect(result.message).toContain("payload project root does not match the launching checkout");
    expect(result.message).toContain(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE);
    expect(result.message).not.toContain("foreign-runtime-link");
  });

  it("keeps today's text when the launcher path is unknown or not a runtime path", () => {
    const base = tempBase();
    const p = join(base, "p");
    const other = join(base, "other");
    mkdirSync(other);
    installRuntime(p);
    for (const launcher of [undefined, "/repo/node_modules/vitest/x.js"]) {
      const result = runFrom(other, launcher, join(p, HOOK_REL));
      expect(result.message).toContain(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE);
    }
  });

  it("reads process.argv[1] when no launcher seam is given", () => {
    const base = tempBase();
    const other = join(base, "other");
    mkdirSync(other);
    const out: string[] = [];
    run(["--host=cursor", "--event=tool.before", `--project-root=${other}`], {
      readStdin: () => JSON.stringify({ tool_name: "Write", workspace_roots: [other] }),
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => other,
      stdinEmptyRetryMs: 0,
      launchingCheckoutRoot: () => join(base, "elsewhere"),
    });
    expect(out.join("")).toContain("payload project root does not match");
  });
});

describe("foreign-runtime-link through the real launcher (#6185)", () => {
  const built = existsSync(join(RUNTIME_DIST, "hook-bin.js"));

  it.skipIf(!built)(
    "denies with foreign-runtime-link when the deposited hook-bin runs through a junction",
    () => {
      const base = tempBase();
      const owner = join(base, "owner");
      const w = join(base, "w");
      mkdirSync(w);
      const ownerRuntime = join(owner, "node_modules", "@deftai", "directive-runtime");
      mkdirSync(ownerRuntime, { recursive: true });
      cpSync(RUNTIME_DIST, join(ownerRuntime, "dist"), { recursive: true });
      writeFileSync(
        join(ownerRuntime, "package.json"),
        JSON.stringify({ name: "@deftai/directive-runtime", version: "0.0.0", type: "module" }),
      );
      for (const dep of ["core", "content", "types"]) {
        junction(join(PACKAGES, dep), join(owner, "node_modules", "@deftai", `directive-${dep}`));
      }
      junction(ownerRuntime, join(w, "node_modules", "@deftai", "directive-runtime"));

      const launcher = join(w, HOOK_REL);
      const child = spawnSync(
        process.execPath,
        [launcher, "--host=cursor", "--event=tool.before", `--project-root=${w}`],
        {
          cwd: w,
          input: JSON.stringify({
            tool_name: "Write",
            tool_input: { file_path: join(w, "a.txt"), contents: "x" },
            workspace_roots: [w],
          }),
          encoding: "utf8",
        },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain("foreign-runtime-link");
      expect(child.stdout).toContain("clears the foreign-runtime root mismatch");
    },
  );
});
