import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorSet(text: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (!m) continue;
    const base = githubSlug(m[2] ?? "");
    if (!counts.has(base)) {
      counts.set(base, 0);
      anchors.add(base);
    } else {
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      anchors.add(`${base}-${n}`);
    }
  }
  return anchors;
}

function sectionBody(text: string, headingSubstr: string, maxLevel: number): string {
  const lines = text.split("\n");
  let start = -1;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const m = lines[idx]?.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (m && (m[2] ?? "").includes(headingSubstr)) {
      start = idx;
      break;
    }
  }
  expect(start).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^(#{1,6})\s+/);
    if (m && (m[1]?.length ?? 99) <= maxLevel) break;
    body.push(line);
  }
  return body.join("\n");
}

describe("test_quickstart_combined_remediation.py", () => {
  it("test_quick_start_exists", () => {
    expect(isFile("QUICK-START.md")).toBe(true);
  });
  it("test_joint_check_gate_present_in_detection", () => {
    const text = readText("QUICK-START.md");
    const step3Idx = text.indexOf("## Step 3");
    expect(step3Idx).not.toBe(-1);
    const gateIdx = text.indexOf("Big-jump joint check");
    expect(gateIdx).not.toBe(-1);
    expect(gateIdx).toBeLessThan(step3Idx);
    const gateWindow = text.slice(gateIdx, step3Idx);
    for (const token of ["Case G+H", "pre-cutover", "Case G", "Case H"]) {
      expect(gateWindow).toContain(token);
    }
    expect(gateWindow.includes("jump to **Case G+H**") || gateWindow.includes("Case G+H")).toBe(
      true,
    );
  });
  it("test_combined_case_section_present", () => {
    expect(readText("QUICK-START.md")).toContain("### Case G+H");
  });
  it("test_combined_case_orders_refresh_before_migration", () => {
    const body = sectionBody(readText("QUICK-START.md"), "Case G+H", 3);
    expect(body).toContain("AGENTS.md refresh first, migration second");
    const refreshIdx = body.indexOf("Refresh AGENTS.md first");
    const migrationIdx = body.indexOf("Run migration second");
    expect(refreshIdx).not.toBe(-1);
    expect(migrationIdx).not.toBe(-1);
    expect(refreshIdx).toBeLessThan(migrationIdx);
  });
  it("test_combined_case_emits_single_restart", () => {
    const body = sectionBody(readText("QUICK-START.md"), "Case G+H", 3);
    expect(body).toContain("EXACTLY ONCE");
    expect(body).toContain("Do NOT emit a second restart");
    expect(body).toContain("step-5 restart");
    expect(body).toContain("step 8 (restart)");
  });
  it("test_combined_case_documents_equivalent_end_state", () => {
    const body = sectionBody(readText("QUICK-START.md"), "Case G+H", 3);
    expect(body).toContain("byte-identical");
    expect(body).toContain("separately");
  });
  it("test_combined_case_cross_reference_resolves", () => {
    const qsText = readText("QUICK-START.md");
    const upAnchors = anchorSet(readText("UPGRADING.md"));
    const body = sectionBody(qsText, "Case G+H", 3);
    const upgradingLinks = [...body.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
      .map((m) => m[2] ?? "")
      .filter((target) => target.includes("UPGRADING.md#"));
    expect(upgradingLinks.length).toBeGreaterThan(0);
    for (const target of upgradingLinks) {
      const anchor = target.split("#", 2)[1] ?? "";
      expect(upAnchors.has(anchor)).toBe(true);
    }
  });
});
