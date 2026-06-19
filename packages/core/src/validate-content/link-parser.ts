/** Linear markdown link target extractor — avoids polynomial regex backtracking. */
export function extractLinkTargets(line: string): string[] {
  const targets: string[] = [];
  let i = 0;
  while (i < line.length) {
    const bracket = line.indexOf("[", i);
    if (bracket === -1) break;
    let closeBracket = bracket + 1;
    while (closeBracket < line.length && line[closeBracket] !== "]") {
      closeBracket += 1;
    }
    if (closeBracket >= line.length || line[closeBracket + 1] !== "(") {
      i = bracket + 1;
      continue;
    }
    let paren = closeBracket + 2;
    const start = paren;
    while (paren < line.length && line[paren] !== ")") {
      paren += 1;
    }
    if (paren >= line.length) break;
    targets.push(line.slice(start, paren));
    i = paren + 1;
  }
  return targets;
}

/** Mirrors Python SKIP_PATTERNS.search(target) without regex backtracking. */
export function shouldSkipLinkTarget(target: string): boolean {
  if (target.includes("{") || target.includes("}") || target.includes("@")) {
    return true;
  }
  if (target.startsWith("[")) return true;
  if (target.startsWith("./relative-")) return true;
  if (target === "path") return true;
  return false;
}
