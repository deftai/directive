import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWithMutationLedger, snapshotMutationSummary } from "../fs/mutation-ledger.js";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import {
  assertProjectedSchemaDescriptionsRooted,
  rewriteProjectedSchemaContent,
  syncBareVersionMarker,
  syncConsumerXbriefSchemas,
  syncExistingBareVersionMarker,
} from "./xbrief-projections.js";

const itSymlink = it.skipIf(process.platform === "win32");

describe("xbrief consumer projections (#2595)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function fixture(): { project: string; deftDir: string; schemas: string } {
    const project = mkdtempSync(join(tmpdir(), "xbrief-projections-"));
    created.push(project);
    const deftDir = join(project, ".deft", "core");
    const schemas = join(deftDir, "vbrief", "schemas");
    mkdirSync(schemas, { recursive: true });
    writeFileSync(join(schemas, "vbrief-core.schema.json"), "legacy\n", "utf8");
    writeFileSync(join(schemas, "xbrief-core-0.8.schema.json"), "current\n", "utf8");
    writeFileSync(join(schemas, "shared.schema.json"), "shared-current\n", "utf8");
    return { project, deftDir, schemas };
  }

  it("reprojects framework schemas, removes only the obsolete root, and is idempotent", () => {
    const { project, deftDir, schemas } = fixture();
    const consumerSchemas = join(project, "xbrief", "schemas");
    mkdirSync(join(schemas, "nested"), { recursive: true });
    writeFileSync(join(schemas, "nested", "child.schema.json"), "child\n", "utf8");
    writeFileSync(
      join(schemas, "candidates.schema.json"),
      '{"description":"one line in vbrief/.eval/candidates.jsonl"}\n',
      "utf8",
    );
    mkdirSync(consumerSchemas, { recursive: true });
    writeFileSync(join(consumerSchemas, "vbrief-core.schema.json"), "stale\n", "utf8");
    writeFileSync(join(consumerSchemas, "shared.schema.json"), "shared-stale\n", "utf8");
    writeFileSync(join(consumerSchemas, "consumer-owned.schema.json"), "keep\n", "utf8");

    expect(syncConsumerXbriefSchemas(project, deftDir)).toBe(true);
    expect(existsSync(join(consumerSchemas, "vbrief-core.schema.json"))).toBe(false);
    expect(readFileSync(join(consumerSchemas, "xbrief-core-0.8.schema.json"), "utf8")).toBe(
      "current\n",
    );
    expect(readFileSync(join(consumerSchemas, "shared.schema.json"), "utf8")).toBe(
      "shared-current\n",
    );
    expect(readFileSync(join(consumerSchemas, "consumer-owned.schema.json"), "utf8")).toBe(
      "keep\n",
    );
    expect(readFileSync(join(consumerSchemas, "nested", "child.schema.json"), "utf8")).toBe(
      "child\n",
    );
    expect(readFileSync(join(consumerSchemas, "candidates.schema.json"), "utf8")).toBe(
      '{"description":"one line in xbrief/.eval/candidates.jsonl"}\n',
    );
    expect(syncConsumerXbriefSchemas(project, deftDir)).toBe(false);
  });

  it("rewriteProjectedSchemaContent rewrites every vbrief/.eval/ mention", () => {
    const input = "vbrief/.eval/slices.jsonl and vbrief/.eval/README.md per vbrief/.eval/ policy";
    expect(rewriteProjectedSchemaContent(input)).toBe(
      "xbrief/.eval/slices.jsonl and xbrief/.eval/README.md per xbrief/.eval/ policy",
    );
    expect(rewriteProjectedSchemaContent("no legacy paths here")).toBe("no legacy paths here");
  });

  it("assertProjectedSchemaDescriptionsRooted rejects leftover vbrief/.eval/ paths", () => {
    const { project } = fixture();
    const consumerSchemas = join(project, "xbrief", "schemas");
    mkdirSync(consumerSchemas, { recursive: true });
    writeFileSync(
      join(consumerSchemas, "bad.schema.json"),
      '{"description":"still vbrief/.eval/candidates.jsonl"}\n',
      "utf8",
    );
    expect(() => assertProjectedSchemaDescriptionsRooted(project, consumerSchemas)).toThrow(
      /projected xbrief schema still cites vbrief\/\.eval\//,
    );
  });

  it("assertProjectedSchemaDescriptionsRooted no-ops when destination is not a directory (#2666)", () => {
    const { project } = fixture();
    const file = join(project, "not-a-schema-dir");
    writeFileSync(file, "plain file\n", "utf8");
    expect(() => assertProjectedSchemaDescriptionsRooted(project, file)).not.toThrow();
  });

  it("ledgers obsolete schema delete through containedRemove (#3418)", () => {
    const { project, deftDir } = fixture();
    const consumerSchemas = join(project, "xbrief", "schemas");
    mkdirSync(consumerSchemas, { recursive: true });
    writeFileSync(join(consumerSchemas, "vbrief-core.schema.json"), "stale\n", "utf8");

    const summary = runWithMutationLedger(project, () => {
      expect(syncConsumerXbriefSchemas(project, deftDir)).toBe(true);
      return snapshotMutationSummary();
    });

    expect(existsSync(join(consumerSchemas, "vbrief-core.schema.json"))).toBe(false);
    expect(summary.deleted).toContain("xbrief/schemas/vbrief-core.schema.json");
  });

  it("self-check runs after obsolete vbrief-core.schema.json is removed", () => {
    const { project, deftDir } = fixture();
    const consumerSchemas = join(project, "xbrief", "schemas");
    mkdirSync(consumerSchemas, { recursive: true });
    writeFileSync(
      join(consumerSchemas, "vbrief-core.schema.json"),
      '{"description":"legacy vbrief/.eval/candidates.jsonl"}\n',
      "utf8",
    );

    expect(syncConsumerXbriefSchemas(project, deftDir)).toBe(true);
    expect(existsSync(join(consumerSchemas, "vbrief-core.schema.json"))).toBe(false);
  });

  it("repairs a stale lifecycle version marker and then performs no second write", () => {
    const { project } = fixture();
    mkdirSync(join(project, "xbrief", "active"), { recursive: true });
    writeFileSync(join(project, "xbrief", "active", "seed.xbrief.json"), "{}\n", "utf8");
    writeFileSync(join(project, "xbrief", ".deft-version"), "0.72.0\n", "utf8");

    expect(syncBareVersionMarker(project, "v0.78.0")).toBe(true);
    expect(readFileSync(join(project, "xbrief", ".deft-version"), "utf8")).toBe("0.78.0\n");
    expect(syncBareVersionMarker(project, "0.78.0")).toBe(false);
  });

  it("fails loudly when the current core schema is absent", () => {
    const { project, deftDir, schemas } = fixture();
    rmSync(join(schemas, "xbrief-core-0.8.schema.json"));
    expect(() => syncConsumerXbriefSchemas(project, deftDir)).toThrow(
      /xbrief-core-0\.8\.schema\.json/,
    );
  });

  it("fails loudly when the schema source directory is absent or malformed", () => {
    const missing = fixture();
    rmSync(missing.schemas, { recursive: true });
    expect(() => syncConsumerXbriefSchemas(missing.project, missing.deftDir)).toThrow(
      /missing xbrief-core-0\.8\.schema\.json/,
    );

    const malformed = fixture();
    rmSync(join(malformed.schemas, "xbrief-core-0.8.schema.json"));
    mkdirSync(join(malformed.schemas, "xbrief-core-0.8.schema.json"));
    expect(() => syncConsumerXbriefSchemas(malformed.project, malformed.deftDir)).toThrow(
      /missing xbrief-core-0\.8\.schema\.json/,
    );
  });

  it("uses the root marker fallback before a lifecycle artifact exists and ignores dev versions", () => {
    const { project } = fixture();
    expect(syncBareVersionMarker(project, "")).toBe(false);
    expect(syncBareVersionMarker(project, "0.0.0-dev")).toBe(false);
    expect(syncBareVersionMarker(project, "0.78.0")).toBe(true);
    expect(readFileSync(join(project, ".deft-version"), "utf8")).toBe("0.78.0\n");
    expect(syncBareVersionMarker(project, "0.78.0")).toBe(false);
  });

  it("does not create a root fallback during a no-op repair, but repairs one that exists", () => {
    const { project } = fixture();
    expect(syncExistingBareVersionMarker(project, "0.78.0")).toBe(false);
    expect(existsSync(join(project, ".deft-version"))).toBe(false);

    writeFileSync(join(project, ".deft-version"), "0.72.0\n", "utf8");
    expect(syncExistingBareVersionMarker(project, "0.78.0")).toBe(true);
    expect(readFileSync(join(project, ".deft-version"), "utf8")).toBe("0.78.0\n");
  });

  itSymlink("refuses schema symlinks in the framework payload", () => {
    const { project, deftDir, schemas } = fixture();
    const outside = join(project, "outside.schema.json");
    writeFileSync(outside, "outside\n", "utf8");
    symlinkSync(outside, join(schemas, "linked.schema.json"));
    expect(() => syncConsumerXbriefSchemas(project, deftDir)).toThrow(
      /refusing xbrief schema projection from symlink/,
    );
  });

  itSymlink("refuses an xbrief projection path that escapes the project", () => {
    const { project, deftDir } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "xbrief-projections-outside-"));
    created.push(outside);
    symlinkSync(outside, join(project, "xbrief"));

    expect(() => syncConsumerXbriefSchemas(project, deftDir)).toThrow(ProjectionContainmentError);
    expect(() => syncBareVersionMarker(project, "0.78.0")).toThrow(ProjectionContainmentError);
  });
});
