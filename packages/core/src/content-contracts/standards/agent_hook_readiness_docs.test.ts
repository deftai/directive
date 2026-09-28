/** Content contract for deterministic functional agent-hook readiness (#3100). */
import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const CONTRACT = "contracts/agent-hook-readiness.md";

describe("agent-hook functional readiness docs (#3100)", () => {
  it("publishes the readiness contract", () => {
    expect(isFile(CONTRACT)).toBe(true);
    const text = readText(CONTRACT);
    for (const token of [
      "registration",
      "command functionality",
      "host trust",
      "interception coverage",
      "verify:hooks-installed --scope=agent --live",
      "installed `deft-hook` shim",
      "hostHooks",
      "manual-review-required",
      "not-directly-verified",
      "maintainer source checkout",
      "1.5 seconds",
      "24 seconds",
      "one retry",
      "disable-host-hooks",
      "deft policy:disable-host-hooks --host <host> --confirm",
    ]) {
      expect(text, `readiness contract missing ${token}`).toContain(token);
    }
    expect(text).not.toContain("disable-host-hooks -- --host");
  });

  it("documents mutation wiring without moving the probe onto cold session start", () => {
    const text = readText("commands.md");
    expect(text).toContain("verify:hooks-installed --scope=agent --live");
    expect(text).toContain("non-deferrable");
    expect(text).toContain("does **not** run the live agent-hook probe");
    expect(text).toContain("contracts/agent-hook-readiness.md");
  });

  it("locks Codex ritual-git recovery on README and this contract (#4664)", () => {
    const contract = readText(CONTRACT);
    const readme = readText("README.md");
    for (const token of [
      "Codex ritual git",
      "outside-sandbox",
      "Environment: local",
      "/approvals",
      "in-process git substitute",
    ]) {
      expect(contract, `contract missing ${token}`).toContain(token);
      expect(readme, `README missing ${token}`).toContain(token);
    }
    expect(contract.toLowerCase()).toContain("to approve");
    expect(readme.toLowerCase()).toContain("approve outside-sandbox");
    expect(contract.toLowerCase()).toContain("repeated per-verb");
    expect(readme.toLowerCase()).toContain("repeated per-verb");
    expect(contract).toContain("Codex ritual-git recovery (#4664)");
    expect(readme).toContain("spawnSync git EPERM");
  });
});
