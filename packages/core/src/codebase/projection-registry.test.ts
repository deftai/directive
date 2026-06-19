import { describe, expect, it } from "vitest";
import {
  CODEBASE_MAP_KIND,
  listProjectionKinds,
  resolveProjectionKind,
  runProjectionRegistryCli,
} from "./projection-registry.js";

describe("projection-registry", () => {
  it("resolves codebase-map contract versions", () => {
    const projection = resolveProjectionKind(CODEBASE_MAP_KIND);
    expect(projection.artifact_format_version).toBe("codebase-map.v1");
    expect(projection.provider_contract_version).toBe("codebase-provider.v1");
    expect(projection.generate_action).toBe("generate-codebase-map");
  });

  it("lists kinds in deterministic order", () => {
    const kinds = listProjectionKinds();
    expect(kinds[0]?.kind).toBe("codebase-map");
  });

  it("cli --list exits 0", () => {
    const result = runProjectionRegistryCli(["--list"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { kind: string }[];
    expect(payload[0]?.kind).toBe("codebase-map");
  });

  it("unknown kind exits 1", () => {
    const result = runProjectionRegistryCli(["--kind", "unknown-map"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown projection kind");
  });
});
