import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FORGE_OUTAGE_RETRY_MINUTES,
  FIELD_FORGE_OUTAGE_RETRY_MINUTES,
  FIELD_FORGE_OUTAGE_RETRY_MINUTES_CLI_ALIAS,
  inspectForgeOutageRetryMinutes,
  MIN_FORGE_OUTAGE_RETRY_MINUTES,
  parseForgeOutageRetryMinutesFromUserMd,
  resolveForgeOutageRetryMinutes,
  validateForgeOutageRetryMinutes,
} from "./forge-outage-retry.js";
import { inspectOnePolicy, registeredPolicyNames } from "./index.js";

function writeProjectDef(root: string, policy: Record<string, unknown>): void {
  const dir = join(root, "xbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], policy },
    }),
    { encoding: "utf8" },
  );
}

describe("forgeOutageRetryMinutes (#3422)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function root(): string {
    const r = mkdtempSync(join(tmpdir(), "deft-forge-outage-"));
    roots.push(r);
    return r;
  }

  it("defaults to 30 when no overrides exist", () => {
    const r = root();
    writeProjectDef(r, {});
    const resolved = resolveForgeOutageRetryMinutes({
      projectRoot: r,
      userMdText: "## Personal (always wins)\n\n**Name**: Test\n",
    });
    expect(resolved.minutes).toBe(DEFAULT_FORGE_OUTAGE_RETRY_MINUTES);
    expect(resolved.source).toBe("default");
  });

  it("uses typed project policy over the default", () => {
    const r = root();
    writeProjectDef(r, { forgeOutageRetryMinutes: 45 });
    const resolved = resolveForgeOutageRetryMinutes({
      projectRoot: r,
      userMdText: "## Personal (always wins)\n\n**Name**: Test\n",
    });
    expect(resolved.minutes).toBe(45);
    expect(resolved.source).toBe("typed");
  });

  it("lets USER.md Personal win over project policy", () => {
    const r = root();
    writeProjectDef(r, { forgeOutageRetryMinutes: 45 });
    const resolved = resolveForgeOutageRetryMinutes({
      projectRoot: r,
      userMdText: "## Personal (always wins)\n\n**forgeOutageRetryMinutes**: 15\n",
    });
    expect(resolved.minutes).toBe(15);
    expect(resolved.source).toBe("user-md");
  });

  it("parses labeled Personal minutes tokens", () => {
    expect(
      parseForgeOutageRetryMinutesFromUserMd(
        "## Personal\n\n**Forge outage retry**: 20m\n\n## Defaults\n",
      ),
    ).toBe(20);
    expect(
      parseForgeOutageRetryMinutesFromUserMd("## Personal\n\nForge outage retry: 12 minutes\n"),
    ).toBe(12);
    expect(
      parseForgeOutageRetryMinutesFromUserMd("## Defaults\n\nforgeOutageRetryMinutes: 9\n"),
    ).toBe(null);
  });

  it("rejects values below the 5-minute floor", () => {
    expect(validateForgeOutageRetryMinutes(4)).toContain("must be >= 5");
    expect(validateForgeOutageRetryMinutes(MIN_FORGE_OUTAGE_RETRY_MINUTES)).toBeNull();
    const r = root();
    writeProjectDef(r, { forgeOutageRetryMinutes: 4 });
    const resolved = resolveForgeOutageRetryMinutes({
      projectRoot: r,
      userMdText: "## Personal\n\n**Name**: Test\n",
    });
    expect(resolved.minutes).toBe(30);
    expect(resolved.source).toBe("default-on-error");
  });

  it("falls through an invalid Personal value to project policy", () => {
    const r = root();
    writeProjectDef(r, { forgeOutageRetryMinutes: 40 });
    const resolved = resolveForgeOutageRetryMinutes({
      projectRoot: r,
      userMdText: "## Personal\n\nforgeOutageRetryMinutes: 2\n",
    });
    expect(resolved.minutes).toBe(40);
    expect(resolved.source).toBe("typed");
  });

  it("lets published JSON Schemas accept null as unset", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const repo = resolve(here, "../../../../");
    const paths = [
      join(repo, "content/vbrief/schemas/vbrief-core.schema.json"),
      join(repo, "packages/types/schemas/vbrief-core-0.6.schema.json"),
    ];
    for (const path of paths) {
      const schema = JSON.parse(readFileSync(path, { encoding: "utf8" })) as {
        $defs: { Policy: { properties: { forgeOutageRetryMinutes: { type: unknown } } } };
      };
      expect(schema.$defs.Policy.properties.forgeOutageRetryMinutes.type).toEqual([
        "integer",
        "null",
      ]);
    }
  });

  it("treats null project policy as default", () => {
    const r = root();
    writeProjectDef(r, { forgeOutageRetryMinutes: null });
    const resolved = resolveForgeOutageRetryMinutes({
      projectRoot: r,
      userMdText: "## Personal\n\n**Name**: Test\n",
    });
    expect(resolved.source).toBe("default");
    expect(resolved.minutes).toBe(30);
  });

  it("inspects via policy:show alias and canonical name", () => {
    const r = root();
    writeProjectDef(r, { forgeOutageRetryMinutes: 25 });
    const field = inspectForgeOutageRetryMinutes(null, r);
    expect(field.name).toBe(FIELD_FORGE_OUTAGE_RETRY_MINUTES);
    expect(field.default).toBe(30);
    expect(registeredPolicyNames()).toContain(FIELD_FORGE_OUTAGE_RETRY_MINUTES);
    const prev = process.env.DEFT_USER_PATH;
    const userMd = join(r, "USER.md");
    writeFileSync(userMd, "## Personal\n\nName: Test\n", { encoding: "utf8" });
    process.env.DEFT_USER_PATH = userMd;
    try {
      const byAlias = inspectOnePolicy(FIELD_FORGE_OUTAGE_RETRY_MINUTES_CLI_ALIAS, r);
      const byCanonical = inspectOnePolicy(FIELD_FORGE_OUTAGE_RETRY_MINUTES, r);
      expect(byAlias?.current).toBe(25);
      expect(byAlias?.source).toBe("typed");
      expect(byCanonical?.current).toBe(25);
    } finally {
      if (prev === undefined) delete process.env.DEFT_USER_PATH;
      else process.env.DEFT_USER_PATH = prev;
    }
  });
});
