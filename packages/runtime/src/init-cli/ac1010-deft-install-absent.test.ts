/**
 * AC10.10 / DEFT-INSTALL-MSG — Go installer messages and DEFT_INSTALL_BINARY
 * teaching must not ship in runtime init-cli.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = join(HERE, "..", "..");
const DIST_INIT = join(RUNTIME_ROOT, "dist", "init-cli");

describe("AC10.10 deft-install user messages absent (DEFT-INSTALL-MSG)", () => {
  it("run-deft-install.ts source is deleted", () => {
    expect(existsSync(join(HERE, "run-deft-install.ts"))).toBe(false);
  });

  it("init-cli sources do not teach deft-install / DEFT_INSTALL_BINARY", () => {
    const files = readdirSync(HERE).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
    const hits: string[] = [];
    for (const name of files) {
      const text = readFileSync(join(HERE, name), "utf8");
      if (/DEFT_INSTALL_BINARY|deft-install/i.test(text)) {
        hits.push(name);
      }
    }
    expect(hits, `forbidden deft-install teaching in: ${hits.join(", ")}`).toEqual([]);
  });

  it("compiled dist/init-cli (when present) has no deft-install / DEFT_INSTALL_BINARY", () => {
    if (!existsSync(DIST_INIT)) return;
    const hits: string[] = [];
    for (const name of readdirSync(DIST_INIT)) {
      if (!name.endsWith(".js")) continue;
      const text = readFileSync(join(DIST_INIT, name), "utf8");
      if (/DEFT_INSTALL_BINARY|bundled deft-install|vendor\/deft-install/i.test(text)) {
        hits.push(name);
      }
    }
    expect(hits, `forbidden remnants in dist: ${hits.join(", ")}`).toEqual([]);
  });
});
