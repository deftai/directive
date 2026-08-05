import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFreshnessArgv, runFreshnessCli } from "./cli.js";
import { REBIND_GUIDANCE } from "./compare.js";
import { liveGenerationPath, stampLiveGeneration } from "./generation.js";

const temps: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-fresh-cli-"));
  temps.push(root);
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fresh-fixture" })}\n`);
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "t" } })}\n`,
  );
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const p = temps.pop();
    if (p) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("freshness CLI (#3117)", () => {
  it("parseFreshnessArgv defaults to report", () => {
    expect(parseFreshnessArgv([]).command).toBe("report");
    expect(parseFreshnessArgv([]).sessionId).toBeUndefined();
    expect(parseFreshnessArgv(["bind", "--json"]).command).toBe("bind");
    expect(parseFreshnessArgv(["--help"]).help).toBe(true);
    expect(parseFreshnessArgv(["--session-id", "abc"]).sessionId).toBe("abc");
    expect(parseFreshnessArgv(["--session-id="]).sessionId).toBe("");
  });

  it("runFreshnessCli report and bind", () => {
    const root = tempProject();
    stampLiveGeneration(root, {
      contentVersion: "9.9.9",
      stampedBy: "test",
      increment: true,
    });
    const unbound = runFreshnessCli(["report", "--project-root", root, "--json"]);
    expect(unbound.exitCode).toBe(1);
    const parsed = JSON.parse(unbound.stdout) as { state: string };
    expect(parsed.state).toBe("unbound");

    const boundResult = runFreshnessCli([
      "bind",
      "--project-root",
      root,
      "--session-id",
      "cli-sid",
      "--json",
    ]);
    expect(boundResult.exitCode).toBe(0);
    const current = runFreshnessCli([
      "--project-root",
      root,
      "--session-id",
      "cli-sid",
      "--json",
    ]);
    expect(current.exitCode).toBe(0);
    expect((JSON.parse(current.stdout) as { state: string }).state).toBe("current");
  });

  it("disk token is readable without host APIs", () => {
    const root = tempProject();
    stampLiveGeneration(root, {
      contentVersion: "1.0.0",
      stampedBy: "directive-update",
      increment: true,
    });
    const raw = JSON.parse(readFileSync(liveGenerationPath(root), "utf8")) as {
      generation: number;
    };
    expect(raw.generation).toBe(1);
    expect(REBIND_GUIDANCE).toMatch(/without restarting/i);
  });
});
