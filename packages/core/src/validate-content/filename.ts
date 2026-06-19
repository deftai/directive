/** Linear filename validator for YYYY-MM-DD-<slug>.vbrief.json (no nested regex). */
export function isDatePrefixedVbriefFilename(name: string): boolean {
  const suffix = ".vbrief.json";
  if (!name.endsWith(suffix)) return false;
  const base = name.slice(0, -suffix.length);
  if (base.length < 12) return false;
  const y = base.slice(0, 4);
  const sep1 = base[4];
  const mo = base.slice(5, 7);
  const sep2 = base[7];
  const day = base.slice(8, 10);
  const sep3 = base[10];
  if (sep1 !== "-" || sep2 !== "-" || sep3 !== "-") return false;
  if (!isDigits(y) || !isDigits(mo) || !isDigits(day)) return false;
  const slug = base.slice(11);
  if (!slug) return false;
  return isSlugSegments(slug);
}

function isDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (const ch of value) {
    if (ch < "0" || ch > "9") return false;
  }
  return true;
}

function isLowerAlnum(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
}

function isSlugSegments(slug: string): boolean {
  let i = 0;
  while (i < slug.length) {
    if (!isLowerAlnum(slug[i] ?? "")) return false;
    i += 1;
    while (i < slug.length && isLowerAlnum(slug[i] ?? "")) i += 1;
    if (i < slug.length) {
      if (slug[i] !== "-") return false;
      i += 1;
      if (i >= slug.length || !isLowerAlnum(slug[i] ?? "")) return false;
    }
  }
  return true;
}
