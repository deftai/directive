import { ARTIFACT_SUFFIXES, hasArtifactSuffix, stripArtifactSuffix } from "../layout/resolve.js";
import { LIFECYCLE_FOLDERS } from "./constants.js";

/** D7: filename convention without polynomial regex (#1782 s3). */
export function matchesFilenameConvention(name: string): boolean {
  // Layout-aware (#2109 part 1): accept either .vbrief.json or .xbrief.json.
  if (!ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return false;
  }
  const stem = stripArtifactSuffix(name);
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

/** Basename of a posix or Win32 path (#4578: pass basename into validateFilename). */
export function d7Basename(pathOrName: string): string {
  return pathOrName.split(/[/\\]/).pop() ?? pathOrName;
}

/** Artifact suffix on `name`, or null when neither accepted suffix is present. */
export function artifactSuffixOf(name: string): string | null {
  for (const suffix of ARTIFACT_SUFFIXES) {
    if (name.endsWith(suffix)) return suffix;
  }
  return null;
}

/** Example D7 name using one accepted suffix. */
export function filenameConventionExample(suffix: string): string {
  return `YYYY-MM-DD-descriptive-slug${suffix}`;
}

/** Aggregate D7 example listing both accepted suffixes. */
export function filenameConventionExamples(): string {
  return ARTIFACT_SUFFIXES.map((suffix) => filenameConventionExample(suffix)).join(" or ");
}

/** True when posix is xbrief|vbrief/<lifecycle>/<file>. */
export function isScopeLifecyclePath(posix: string): boolean {
  const parts = posix.split("/");
  if (parts.length !== 3) {
    return false;
  }
  const root = parts[0] ?? "";
  const folder = parts[1] ?? "";
  return (root === "xbrief" || root === "vbrief") && LIFECYCLE_FOLDERS.includes(folder);
}

/** Check filename matches YYYY-MM-DD-descriptive-slug with an accepted artifact suffix (D7). */
export function validateFilename(filepath: string): string[] {
  const name = filepath.split("/").pop() ?? filepath;
  if (hasArtifactSuffix(name) && stripArtifactSuffix(name) === "PROJECT-DEFINITION") {
    return [];
  }
  if (!matchesFilenameConvention(name)) {
    const suffix = artifactSuffixOf(name);
    const example =
      suffix !== null ? filenameConventionExample(suffix) : filenameConventionExamples();
    return [`${filepath}: filename '${name}' does not match convention ${example} (D7)`];
  }
  return [];
}
