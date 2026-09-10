/**
 * Setup retirement locks for seeded xBRIEF stamps (#4271).
 * Units are Markdown list items, fenced blocks, frontmatter, or sections.
 * After pack edit: task packs:render. Control: task packs:verify-drift.
 * task packs:render-skills is out of scope.
 */

const STAMP_FIELD = /\b(?:deft_version|DeftVersion)\b/;
const CANONICAL_XBRIEF = /PROJECT-DEFINITION|(?:specification|plan)\.(?:x|v)brief\.json/i;
const USER_MD_HINT = /# User Preferences|USER\.md/;

export const PACK_TO_SKILL_REGEN = "task packs:render";
export const PROJECTION_CONTROL = "task packs:verify-drift";
export const PACKS_RENDER_SKILLS_OUT_OF_SCOPE = "task packs:render-skills";
export const SPECIFICATION_DEFT_VERSION_SEEDING = "none-pass1-absence-lock-only";

export function markdownListAndSectionUnits(markdown: string): string[] {
  const units: string[] = [];
  let rest = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (rest.startsWith("---\n")) {
    const end = rest.indexOf("\n---", 4);
    if (end !== -1) {
      const cutAt = rest.indexOf("\n", end + 4);
      const cut = cutAt === -1 ? rest.length : cutAt + 1;
      units.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
  }
  const lines = rest.split("\n");
  let i = 0;
  let section: string[] = [];
  const flush = (): void => {
    const text = section.join("\n").trim();
    if (text.length > 0) units.push(text);
    section = [];
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = line.match(/^(\s*)(```|~~~)/);
    if (fence) {
      flush();
      const marker = fence[2] ?? "```";
      const block = [line];
      i += 1;
      while (i < lines.length) {
        block.push(lines[i] ?? "");
        if ((lines[i] ?? "").trim().startsWith(marker)) {
          i += 1;
          break;
        }
        i += 1;
      }
      units.push(block.join("\n"));
      continue;
    }
    const list = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+/);
    if (list) {
      flush();
      const indent = (list[1] ?? "").length;
      const item = [line];
      i += 1;
      while (i < lines.length) {
        const nxt = lines[i] ?? "";
        if (nxt.trim() === "") {
          let j = i + 1;
          while (j < lines.length && (lines[j] ?? "").trim() === "") j += 1;
          const peek = lines[j] ?? "";
          const peekIndent = (peek.match(/^(\s*)/)?.[1] ?? "").length;
          if (peek.trim() !== "" && peekIndent > indent) {
            item.push(nxt);
            i += 1;
            continue;
          }
          break;
        }
        const nxtList = nxt.match(/^(\s*)(?:[-*+]|\d+\.)\s+/);
        if (nxtList && (nxtList[1] ?? "").length <= indent) break;
        const nxtIndent = (nxt.match(/^(\s*)/)?.[1] ?? "").length;
        if (nxtIndent > indent) {
          item.push(nxt);
          i += 1;
          continue;
        }
        break;
      }
      units.push(item.join("\n"));
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      section.push(line);
      i += 1;
      continue;
    }
    section.push(line);
    i += 1;
  }
  flush();
  return units.filter((u) => u.length > 0);
}

function hasJsonStampKey(unit: string): boolean {
  return /"DeftVersion"\s*:/.test(unit) || /"deft_version"\s*:/.test(unit);
}

/** True when a unit instructs restoring deft_version/DeftVersion onto canonical xBRIEFs. */
export function unitInstructsXbriefStampRestore(unit: string): boolean {
  if (
    USER_MD_HINT.test(unit) &&
    hasJsonStampKey(unit) === false &&
    /PROJECT-DEFINITION/.test(unit) === false
  ) {
    return false;
  }
  if (hasJsonStampKey(unit)) return true;
  if (!STAMP_FIELD.test(unit) || !CANONICAL_XBRIEF.test(unit)) return false;
  if (/⊗|\bMUST NOT\b/.test(unit)) return false;
  if (/\bMUST\b/.test(unit) && /PROJECT-DEFINITION/.test(unit)) return true;
  if (/\b(generate|write|include|set)\b/i.test(unit) && CANONICAL_XBRIEF.test(unit)) {
    return true;
  }
  return false;
}

export function findRetiredStampRestoreInstructions(markdown: string): string[] {
  return markdownListAndSectionUnits(markdown).filter(unitInstructsXbriefStampRestore);
}

export function assertSetupRetirementLocks(markdown: string): void {
  if (markdown.includes(PACKS_RENDER_SKILLS_OUT_OF_SCOPE)) {
    throw new Error(
      `#4271 setup retirement lock: ${PACKS_RENDER_SKILLS_OUT_OF_SCOPE} is out of scope; after pack edit run ${PACK_TO_SKILL_REGEN} then ${PROJECTION_CONTROL}`,
    );
  }
  const hits = findRetiredStampRestoreInstructions(markdown);
  if (hits.length > 0) {
    throw new Error(
      `#4271 setup retirement lock: restore instruction for xBRIEF stamps; specification deft_version seeding=${SPECIFICATION_DEFT_VERSION_SEEDING}`,
    );
  }
}
