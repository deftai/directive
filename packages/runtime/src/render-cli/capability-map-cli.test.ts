import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch, resolveCanonicalVerb } from "../dispatch.js";
import { runCapabilityMapCli } from "./capability-map-cli.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const temps: string[] = [];
const quietIo = { writeOut: () => {}, writeErr: () => {} };

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("capability-map dispatch witness (#5841)", () => {
  it("registers capability-map and the docs:capability-map alias", () => {
    expect(resolveCanonicalVerb("capability-map")).toBe("capability-map");
    expect(resolveCanonicalVerb("docs:capability-map")).toBe("capability-map");
  });

  it("passes --help through and returns 0", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(runCapabilityMapCli(["--help"])).toBe(0);
  });

  it("dispatch capability-map --check exits 0 on the committed index", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await dispatch(
      ["capability-map", "--project-root", REPO_ROOT, "--check"],
      quietIo,
    );
    expect(code).toBe(0);
  });

  it("dispatch capability-map --check exits nonzero on a stale index without rewriting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cap-map-cli-"));
    temps.push(root);
    mkdirSync(join(root, "content", "docs"), { recursive: true });
    writeFileSync(
      join(root, "content", "docs", "capability-overlay.json"),
      '{"version":1,"entries":[]}\n',
      "utf8",
    );
    const indexPath = join(root, "content", "docs", "capabilities.md");
    writeFileSync(indexPath, "stale\n", "utf8");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await dispatch(["capability-map", "--project-root", root, "--check"], quietIo);
    expect(code).not.toBe(0);
    expect(readFileSync(indexPath, "utf8")).toBe("stale\n");
  });
});
