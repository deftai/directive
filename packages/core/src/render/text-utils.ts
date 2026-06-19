/** Split camelCase / PascalCase into lowercase words (linear; mirrors Python `_split_camel`). */
export function splitCamel(name: string): string[] {
  if (!name) return [];
  let spaced = "";
  for (let i = 0; i < name.length; i += 1) {
    const c = name[i] ?? "";
    const prev = i > 0 ? (name[i - 1] ?? "") : "";
    if (i > 0 && prev >= "a" && prev <= "z" && c >= "A" && c <= "Z") {
      spaced += ` ${c}`;
    } else {
      spaced += c;
    }
  }
  return spaced
    .split(" ")
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

/** Tokenize on non-word chars (linear scanner; mirrors Python ``re.split(r"\\W+", ...)``). */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? "";
    const isWord =
      (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
    if (isWord) {
      current += c;
    } else if (current) {
      words.push(current);
      current = "";
    }
  }
  if (current) words.push(current);
  return words;
}

/** Parse ``Phase N`` prefix for roadmap sorting (#641). */
export function parsePhaseNumber(phaseName: string): number | null {
  const trimmed = phaseName.trimStart();
  if (!trimmed.startsWith("Phase")) return null;
  let i = 5;
  while (i < trimmed.length && trimmed[i] === " ") i += 1;
  let digits = "";
  while (i < trimmed.length && trimmed.charCodeAt(i) >= 48 && trimmed.charCodeAt(i) <= 57) {
    digits += trimmed[i] ?? "";
    i += 1;
  }
  if (!digits) return null;
  if (i < trimmed.length) {
    const next = trimmed[i] ?? "";
    if (
      (next >= "a" && next <= "z") ||
      (next >= "A" && next <= "Z") ||
      (next >= "0" && next <= "9") ||
      next === "_"
    ) {
      return null;
    }
  }
  return Number.parseInt(digits, 10);
}

export function phaseSortKey(phaseName: string): [number, number, string] {
  const num = parsePhaseNumber(phaseName);
  if (num !== null) return [0, num, phaseName];
  return [1, 0, phaseName];
}
