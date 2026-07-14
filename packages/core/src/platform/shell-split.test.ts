import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../content-contracts/standards/_helpers.js";

const require = createRequire(import.meta.url);
const { shellSplit } = require(join(repoRoot(), "tasks/engine-invoke.cjs")) as {
  shellSplit: (input: string) => string[];
};

describe("shellSplit (engine-invoke #2547)", () => {
  it("splits simple tokens", () => {
    expect(shellSplit("release 0.0.0 --dry-run")).toEqual(["release", "0.0.0", "--dry-run"]);
  });

  it("preserves apostrophes inside double-quoted summary text", () => {
    expect(shellSplit('release 0.0.0 --dry-run --summary "test what\'s next"')).toEqual([
      "release",
      "0.0.0",
      "--dry-run",
      "--summary",
      "test what's next",
    ]);
  });

  it("preserves forward-slash Windows paths inside double-quoted segments (#2547)", () => {
    const cmd =
      'migrate-preflight --project-root "D:/a/consumer/proj" --deft-root "D:/a/directive/directive"';
    expect(shellSplit(cmd)).toEqual([
      "migrate-preflight",
      "--project-root",
      "D:/a/consumer/proj",
      "--deft-root",
      "D:/a/directive/directive",
    ]);
  });
});
