/**
 * Foreign runtime link diagnosis (#6185): ownership cut, wording classifier and
 * the direct doctor / session-start check, over real directory junctions.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE } from "./constants.js";
import {
  checkRuntimeLinkOwner,
  classifyRootMismatch,
  FOREIGN_RUNTIME_LINK,
  resolveLaunchingCheckoutRootFromPath,
} from "./runtime-link.js";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const t = temps.pop();
    if (t) rmSync(t, { recursive: true, force: true });
  }
});

function tempBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rtlink-")));
  temps.push(base);
  return base;
}

/** Real runtime package under a checkout; returns its directory. */
function installRuntime(checkout: string): string {
  const dir = join(checkout, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "hook-bin.js"), "// fixture\n");
  return dir;
}

function junction(target: string, link: string): void {
  mkdirSync(join(link, ".."), { recursive: true });
  symlinkSync(target, link, "junction");
}

describe("resolveLaunchingCheckoutRootFromPath", () => {
  it("cuts a runtime path to the consumer root", () => {
    expect(
      resolveLaunchingCheckoutRootFromPath("/p/node_modules/@deftai/directive-runtime/dist/a.js"),
    ).toBe("/p");
    expect(
      resolveLaunchingCheckoutRootFromPath("C:\\p\\node_modules\\@deftai\\directive-runtime"),
    ).toBe("C:/p");
  });

  it("normalises a pnpm .pnpm path to the consumer root", () => {
    expect(
      resolveLaunchingCheckoutRootFromPath(
        "/p/node_modules/.pnpm/@deftai+directive-runtime@1/node_modules/@deftai/directive-runtime/dist/a.js",
      ),
    ).toBe("/p");
  });

  it("returns null outside a runtime package and for an empty cut", () => {
    expect(resolveLaunchingCheckoutRootFromPath("/repo/packages/runtime/src/a.ts")).toBeNull();
    expect(
      resolveLaunchingCheckoutRootFromPath("/node_modules/@deftai/directive-runtime"),
    ).toBeNull();
  });
});

describe("classifyRootMismatch", () => {
  it("names a foreign runtime link when the link-side cut is the payload root", () => {
    const base = tempBase();
    const w = join(base, "w");
    const o = join(base, "o");
    mkdirSync(w);
    mkdirSync(o);
    const link = `${w}/node_modules/@deftai/directive-runtime/dist/hook-bin.js`;
    expect(classifyRootMismatch(o, link, w)).toBe(FOREIGN_RUNTIME_LINK);
  });

  it("keeps a plain root mismatch when the link-side path is unusable or elsewhere", () => {
    const base = tempBase();
    const w = join(base, "w");
    const o = join(base, "o");
    const x = join(base, "x");
    for (const d of [w, o, x]) mkdirSync(d);
    expect(classifyRootMismatch(o, undefined, w)).toBe("root-mismatch");
    expect(classifyRootMismatch(o, "", w)).toBe("root-mismatch");
    expect(classifyRootMismatch(o, "/repo/node_modules/vitest/x.js", w)).toBe("root-mismatch");
    // link-side cut names a third checkout
    expect(
      classifyRootMismatch(o, `${x}/node_modules/@deftai/directive-runtime/dist/a.js`, w),
    ).toBe("root-mismatch");
    // launch root already equals the payload root: not a mismatch to explain
    expect(
      classifyRootMismatch(w, `${w}/node_modules/@deftai/directive-runtime/dist/a.js`, w),
    ).toBe("root-mismatch");
  });
});

describe("checkRuntimeLinkOwner", () => {
  it("passes for a runtime that belongs to this checkout", () => {
    const base = tempBase();
    const p = join(base, "p");
    installRuntime(p);
    const result = checkRuntimeLinkOwner(p);
    expect(result.status).toBe("pass");
    expect(result.name).toBe(FOREIGN_RUNTIME_LINK);
  });

  it("passes for a pnpm .pnpm link inside the checkout", () => {
    const base = tempBase();
    const p = join(base, "p");
    const real = join(
      p,
      "node_modules",
      ".pnpm",
      "@deftai+directive-runtime@1.0.0",
      "node_modules",
      "@deftai",
      "directive-runtime",
    );
    mkdirSync(join(real, "dist"), { recursive: true });
    junction(real, join(p, "node_modules", "@deftai", "directive-runtime"));
    expect(checkRuntimeLinkOwner(p).status).toBe("pass");
  });

  it("fails for a junctioned runtime directory", () => {
    const base = tempBase();
    const owner = join(base, "owner");
    const w = join(base, "w");
    const ownerRuntime = installRuntime(owner);
    junction(ownerRuntime, join(w, "node_modules", "@deftai", "directive-runtime"));
    const result = checkRuntimeLinkOwner(w);
    expect(result.status).toBe("fail");
    expect(result.data?.owner_root).toBe(owner.replace(/\\/g, "/"));
    expect(result.detail).toContain(w);
  });

  it("fails for a junctioned whole node_modules", () => {
    const base = tempBase();
    const owner = join(base, "owner");
    const w = join(base, "w");
    installRuntime(owner);
    junction(join(owner, "node_modules"), join(w, "node_modules"));
    expect(checkRuntimeLinkOwner(w).status).toBe("fail");
  });

  it("fails for a nested reverse link: primary runtime linked into a nested worker worktree", () => {
    const base = tempBase();
    const p = join(base, "p");
    const w = join(p, ".deft-scratch", "worktrees", "w");
    const pRuntime = installRuntime(p);
    junction(pRuntime, join(w, "node_modules", "@deftai", "directive-runtime"));
    const nested = checkRuntimeLinkOwner(w);
    expect(nested.status).toBe("fail");
    expect(nested.data?.owner_root).toBe(p.replace(/\\/g, "/"));
    // The owner itself stays clean: identity, not containment.
    expect(checkRuntimeLinkOwner(p).status).toBe("pass");
  });

  it("skips when the runtime is absent or its real path is not a runtime package", () => {
    const base = tempBase();
    const p = join(base, "p");
    mkdirSync(p);
    expect(checkRuntimeLinkOwner(p).status).toBe("skip");
    const plain = join(base, "plain");
    mkdirSync(plain);
    junction(plain, join(p, "node_modules", "@deftai", "directive-runtime"));
    expect(checkRuntimeLinkOwner(p).status).toBe("skip");
  });

  it("reads exactly one path through the realpath seam", () => {
    const seen: string[] = [];
    const result = checkRuntimeLinkOwner("/c", {
      realpath: (path) => {
        seen.push(path.replace(/\\/g, "/"));
        return "/c/node_modules/@deftai/directive-runtime";
      },
    });
    expect(result.status).toBe("pass");
    expect(seen).toEqual(["/c/node_modules/@deftai/directive-runtime"]);
  });
});

describe("FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE", () => {
  it("says what it fixes and what still applies", () => {
    expect(FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE).toContain("terminal outside");
    expect(FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE).toContain("<payloadRoot>/node_modules");
    expect(FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE).toContain(
      "<payloadRoot>/node_modules/@deftai/directive-runtime",
    );
    expect(FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE).toContain(
      "clears the foreign-runtime root mismatch",
    );
    expect(FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE).toContain(
      "existing install and policy gates still apply",
    );
  });
});
