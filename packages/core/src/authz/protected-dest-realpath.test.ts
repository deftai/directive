import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolvedDestIsPayloadRootProtected,
  shellCommandHasPayloadRootProtectedDestAfterRealpath,
} from "./protected-dest-realpath.js";

const itSymlink = it.skipIf(process.platform === "win32");

describe("payload-root dest realpath (#4188)", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  it("does not treat lexically protected dests as a realpath-only hit", () => {
    expect(
      shellCommandHasPayloadRootProtectedDestAfterRealpath(
        "/project",
        "mkfile 1k .deft/authz/grants/evil.json",
      ),
    ).toBe(false);
    expect(resolvedDestIsPayloadRootProtected("/project", "")).toBe(false);
    expect(resolvedDestIsPayloadRootProtected("/project", "   ")).toBe(false);
    expect(shellCommandHasPayloadRootProtectedDestAfterRealpath("/project", "echo ok")).toBe(false);
  });

  it("does not treat absolute dests outside the payload root as protected", () => {
    expect(
      resolvedDestIsPayloadRootProtected("/payload", "/sibling/.deft/authz/grants/x.json"),
    ).toBe(false);
    expect(
      shellCommandHasPayloadRootProtectedDestAfterRealpath(
        "/payload",
        "mkfile 1k /sibling/.deft/authz/grants/x.json",
      ),
    ).toBe(false);
  });

  itSymlink("reveals a payload-root protected dest behind a non-shell symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4188-realpath-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "authz", "grants"), { recursive: true });
    writeFileSync(join(root, ".deft", "authz", "grants", "g.json"), "{}\n");
    symlinkSync(join(root, ".deft", "authz"), join(root, "build-cache"));
    expect(resolvedDestIsPayloadRootProtected(root, "build-cache/grants/g.json")).toBe(true);
    expect(
      shellCommandHasPayloadRootProtectedDestAfterRealpath(
        root,
        "mkfile 1k build-cache/grants/g.json",
      ),
    ).toBe(true);
    expect(
      shellCommandHasPayloadRootProtectedDestAfterRealpath(root, "cat build-cache/grants/g.json"),
    ).toBe(false);

    expect(resolvedDestIsPayloadRootProtected(root, "build-cache/grants/missing.json")).toBe(true);
    // Missing nested ancestors: walk must keep the leaf filename
    // (probe.slice would resolve to .../authz/newdir and miss evil.json).
    expect(resolvedDestIsPayloadRootProtected(root, "build-cache/newdir/evil.json")).toBe(true);
    expect(
      shellCommandHasPayloadRootProtectedDestAfterRealpath(
        root,
        "mkfile 1k build-cache/newdir/evil.json",
      ),
    ).toBe(true);
    mkdirSync(join(root, ".deft", "approved-scope"), { recursive: true });
    symlinkSync(join(root, ".deft", "approved-scope"), join(root, "scope-alias"));
    expect(resolvedDestIsPayloadRootProtected(root, "scope-alias/story.json")).toBe(true);
    writeFileSync(join(root, ".deft-directive-disable"), "");
    symlinkSync(join(root, ".deft-directive-disable"), join(root, "kill-alias"));
    expect(resolvedDestIsPayloadRootProtected(root, "kill-alias")).toBe(true);
    writeFileSync(join(root, ".no-deft-directive"), "");
    symlinkSync(join(root, ".no-deft-directive"), join(root, "opt-out-alias"));
    expect(resolvedDestIsPayloadRootProtected(root, "opt-out-alias")).toBe(true);
    expect(resolvedDestIsPayloadRootProtected(root, "README")).toBe(false);
    mkdirSync(join(root, "mixed-alias-parent"), { recursive: true });
    symlinkSync(join(root, ".deft", "authz"), join(root, "mixed-alias-parent", "Authz"));
    expect(resolvedDestIsPayloadRootProtected(root, "mixed-alias-parent/Authz/grants/g.json")).toBe(
      true,
    );
    expect(resolvedDestIsPayloadRootProtected("/no-such-4188-project", "build-cache/x")).toBe(
      false,
    );
  });
});
