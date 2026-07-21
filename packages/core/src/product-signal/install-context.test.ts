import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectInstallContext } from "./install-context.js";

const roots: string[] = [];
const envBackup = { ...process.env };

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  process.env = { ...envBackup };
});

describe("collectInstallContext", () => {
  it("returns install context fields", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-ctx-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", "utf8");
    const ctx = collectInstallContext(root);
    expect(ctx.installId).toBeTruthy();
    expect(ctx.directiveVersion).toBeTruthy();
  });

  it("detects harness from env", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-ctx-h-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", "utf8");

    process.env.DEFT_HARNESS = "cursor";
    process.env.CURSOR_VERSION = "1.2.3";
    expect(collectInstallContext(root).harness).toBe("cursor");
    expect(collectInstallContext(root).harnessVersion).toBe("1.2.3");

    process.env.DEFT_HARNESS = undefined;
    process.env.CURSOR_SESSION_ID = "sess";
    expect(collectInstallContext(root).harness).toBe("cursor");

    delete process.env.CURSOR_SESSION_ID;
    process.env.CODEX_HOME = "/tmp/codex";
    expect(collectInstallContext(root).harness).toBe("codex");

    delete process.env.CODEX_HOME;
    process.env.OPENCODE = "1";
    expect(collectInstallContext(root).harness).toBe("opencode");

    delete process.env.OPENCODE;
    expect(collectInstallContext(root).harness).toBe("cli");
  });
});
