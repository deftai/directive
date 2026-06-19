/** D7: filename convention without polynomial regex (#1782 s3). */
export function matchesFilenameConvention(name: string): boolean {
  if (!name.endsWith(".vbrief.json")) {
    return false;
  }
  const stem = name.slice(0, -".vbrief.json".length);
  if (stem.length < 12) {
    return false;
  }
  const datePart = stem.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return false;
  }
  if (stem[10] !== "-") {
    return false;
  }
  const slug = stem.slice(11);
  if (!slug) {
    return false;
  }
  let i = 0;
  while (i < slug.length) {
    let j = i;
    while (j < slug.length) {
      const ch = slug[j] ?? "";
      const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
      if (!ok) {
        break;
      }
      j += 1;
    }
    if (j === i) {
      return false;
    }
    i = j;
    if (i < slug.length) {
      if (slug[i] !== "-") {
        return false;
      }
      i += 1;
      if (i >= slug.length) {
        return false;
      }
    }
  }
  return true;
}

/** Check filename matches YYYY-MM-DD-descriptive-slug.vbrief.json (D7). */
export function validateFilename(filepath: string): string[] {
  const name = filepath.split("/").pop() ?? filepath;
  if (name === "PROJECT-DEFINITION.vbrief.json") {
    return [];
  }
  if (!matchesFilenameConvention(name)) {
    return [
      `${filepath}: filename '${name}' does not match convention ` +
        "YYYY-MM-DD-descriptive-slug.vbrief.json (D7)",
    ];
  }
  return [];
}
