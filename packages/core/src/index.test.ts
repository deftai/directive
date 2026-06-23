import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_PACKAGE, engineInfo } from "./index.js";

const pkgVersion = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { version: string }
).version;

describe("@deftai/directive-core", () => {
  it("reports engine info backed by an @deftai/directive-types shape", () => {
    expect(engineInfo()).toEqual({ name: CORE_PACKAGE, version: pkgVersion });
  });
});
