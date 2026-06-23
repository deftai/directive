import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const TRIAGE_HEADING = "Big-jump triage";
const DOCTOR_ANCHOR = "canonical-installer--doctor-handoff-v037--epic-56-1339-1340-1409";

function githubSlug(text: string): string {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/gu, "");
  return s.replace(/\s/g, "-");
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

describe("test_upgrading_bigjump_triage.py", () => {
  it("test_upgrading_exists", () => {
    expect(isFile("UPGRADING.md")).toBe(true);
  });
  it("test_big_jump_entry_point_is_discoverable", () => {
    const text = readText("UPGRADING.md");
    const triageIdx = text.indexOf(`## ${TRIAGE_HEADING}`);
    expect(triageIdx).toBeGreaterThanOrEqual(0);
    const sectionIdxs = ["\n## From ", "\n## Canonical installer"]
      .map((m) => text.indexOf(m))
      .filter((i) => i !== -1);
    expect(sectionIdxs.length).toBeGreaterThan(0);
    expect(triageIdx).toBeLessThan(Math.min(...sectionIdxs));
  });
  it("test_triage_lists_version_buckets_with_apply_order", () => {
    const body = sectionBody(readText("UPGRADING.md"), TRIAGE_HEADING, 2);
    expect(
      body.split("\n").filter((ln) => ln.startsWith("- **From")).length,
    ).toBeGreaterThanOrEqual(5);
    expect(body).toContain("apply-order");
    expect(body.toLowerCase()).toContain("oldest");
  });
  it("test_triage_flags_auto_vs_manual", () => {
    const body = sectionBody(readText("UPGRADING.md"), TRIAGE_HEADING, 2);
    expect(body).toContain("auto-handled");
    expect(body).toContain("manual");
  });
  it("test_triage_references_quickstart_and_doctor_surface", () => {
    const body = sectionBody(readText("UPGRADING.md"), TRIAGE_HEADING, 2);
    expect(body).toContain("QUICK-START.md#");
    // npm is now the canonical upgrade command; Go installer is a frozen legacy bridge (#1912)
    expect(body).toContain("npm i -g @deftai/directive@latest");
    expect(body).toContain("directive doctor");
  });
  it("test_doctor_anchor_actually_exists", () => {
    expect(anchorSet(readText("UPGRADING.md"))).toContain(DOCTOR_ANCHOR);
  });
});
