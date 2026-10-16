import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBrokenLinks } from "../validate-content/validate-links.js";
import { destContentionItTimeout } from "../vitest-runner/dest-contention-it-timeout.helper.test.js";
import { classifyPackedDepositBrokenLinks } from "./classify-packed-link-residuals.js";
import {
  REWRITE_MARKER_PREFIX,
  rewriteRelativeLink,
  splitLinkHash,
} from "./rewrite-deposit-links.js";
import { stageContentPack } from "./stage-content-pack.js";

const created: string[] = [];

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("stageContentPack (#3937 / #4890)", () => {
  it("rewrites flatten-sensitive links in the pack copy and leaves the source tree alone", () => {
    const root = tempDir("stage-pack-src-");
    mkdirSync(join(root, "content", "coding"), { recursive: true });
    writeFileSync(
      join(root, "main.md"),
      "See [coding](./content/coding/coding.md) and [refs](./REFERENCES.md).\n",
      "utf8",
    );
    writeFileSync(join(root, "SKILL.md"), "# skill\n", "utf8");
    writeFileSync(
      join(root, "content", "coding", "coding.md"),
      "Back to [main](../../main.md).\n",
      "utf8",
    );
    const dest = join(tempDir("stage-pack-dst-"), "pack");
    const { filesRewritten } = stageContentPack({ repoRoot: root, destDir: dest });
    expect(filesRewritten).toBeGreaterThan(0);
    const packedMain = readFileSync(join(dest, "main.md"), "utf8");
    expect(packedMain).toContain("](./coding/coding.md)");
    expect(packedMain).not.toContain("./content/coding");
    expect(packedMain).toContain("](./REFERENCES.md)");
    expect(packedMain).toContain(REWRITE_MARKER_PREFIX);
    const packedCoding = readFileSync(join(dest, "coding", "coding.md"), "utf8");
    expect(packedCoding).toContain("](../main.md)");
    expect(packedCoding).not.toContain("../../main.md");
    expect(readFileSync(join(root, "main.md"), "utf8")).toContain("./content/coding/coding.md");
    expect(readFileSync(join(root, "content", "coding", "coding.md"), "utf8")).toContain(
      "../../main.md",
    );
  });

  it(
    "validate-links on a packed fixture fails closed except unmapped unshipped residuals",
    destContentionItTimeout(),
    () => {
      const dest = join(tempDir("stage-pack-live-"), "pack");
      stageContentPack({ repoRoot: process.cwd(), destDir: dest });
      expect(existsSync(join(dest, "main.md"))).toBe(true);
      expect(existsSync(join(dest, "content"))).toBe(false);

      const packedMain = readFileSync(join(dest, "main.md"), "utf8");
      expect(packedMain).toContain(REWRITE_MARKER_PREFIX);
      expect(packedMain).not.toContain("./content/coding/coding.md");
      expect(packedMain).not.toContain("](./REFERENCES.md)");

      const packedSecurity = readFileSync(join(dest, "meta", "security.md"), "utf8");
      expect(packedSecurity).toContain(REWRITE_MARKER_PREFIX);
      expect(packedSecurity).toContain("](../main.md)");
      expect(packedSecurity).not.toContain("](../../main.md)");

      const broken = collectBrokenLinks(dest);
      const repoRoot = process.cwd();
      const { unexpected, residualTargets } = classifyPackedDepositBrokenLinks({
        broken,
        repoRoot,
      });
      expect(unexpected, unexpected.join("\n")).toEqual([]);

      const securityBroken = broken.filter(
        (item) => item.file.replace(/\\/g, "/") === "meta/security.md",
      );
      expect(securityBroken.map((item) => splitLinkHash(item.target).path)).toEqual([]);

      const mainBroken = broken.filter((item) => item.file.replace(/\\/g, "/") === "main.md");
      const mainUnexpected = mainBroken.filter((item) => {
        const mapped = rewriteRelativeLink({
          sourceFileRel: "main.md",
          packFileRel: "main.md",
          target: item.target,
        });
        return mapped.packMapped;
      });
      expect(mainUnexpected).toEqual([]);

      expect(residualTargets).toEqual(NAMED_PACK_RESIDUALS);
      expect(readFileSync(join(process.cwd(), "main.md"), "utf8")).toContain(
        "./content/coding/coding.md",
      );
    },
  );
});

/**
 * #4890 membership: keep. Tip-measured unique residuals after stageContentPack
 * + collectBrokenLinks. Do not silently widen. Shrink only with a ship
 * decision. Split ADR docs/decisions targets to neighbor #3847 rather than
 * dropping them here. Body ~103/60 census is historical.
 */
const NAMED_PACK_RESIDUALS = [
  "../../../AGENTS.md",
  "../../../CONTRIBUTING.md",
  "../../../docs/RELEASING.md",
  "../../../docs/analysis/2026-08-07-portfolio-priority-brief-patterns-pilot.md",
  "../../../docs/decisions/ADR-005-design-critique-judgment-gate.md",
  "../../../docs/decisions/ADR-006-parent-side-substantiation.md",
  "../../../meta/lessons.md",
  "../../CONTRIBUTING.md",
  "../../PROJECT.md",
  "../../README.md",
  "../../REFERENCES.md",
  "../../UPGRADING.md",
  "../../contracts/deterministic-questions.md",
  "../../conventions/references.md",
  "../../conventions/vbrief-filenames.md",
  "../../docs/ARCHITECTURE.md",
  "../../docs/CONCEPTS.md",
  "../../docs/analysis/2026-07-31-inter-run-learning-surface.md",
  "../../docs/decisions/ADR-005-design-critique-judgment-gate.md",
  "../../docs/decisions/ADR-006-parent-side-substantiation.md",
  "../../docs/openclaw-agent-host.md",
  "../../docs/security.md",
  "../../incidents/2026-04-pocketos-railway-prod-db-wipe.md",
  "../../meta/lessons.md",
  "../../tests/content/test_agents_entry_contract.py",
  "../../tests/content/test_taskfile_caching.py",
  "../../vbrief/completed/2026-04-20-431-deterministic-questions-rc2-defects.vbrief.json",
  "../../xbrief/decisions/README.md",
  "../CHANGELOG.md",
  "../CONTRIBUTING.md",
  "../docs/ARCHITECTURE.md",
  "../docs/CATEGORY.md",
  "../docs/install-manifest.md",
  "../docs/privacy-nfr.md",
  "../docs/quarantine-spec.md",
  "../packages/core/src/metrics/resolve-metrics-home.ts",
  "../packages/core/src/triage/cache-path.ts",
  "../packaging/openpackage/deft-directive-skills/README.md",
  "../scripts/_relocate_states.py",
  "../scripts/doctor.py",
  "../scripts/relocate.py",
  "../scripts/triage_welcome.py",
  "../tests/cmd_gate/test_state_detection.py",
  "./docs/decisions/ADR-001.md",
  "<url>/commit/<sha>",
  "url",
];
