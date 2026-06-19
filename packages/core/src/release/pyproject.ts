import { PYPROJECT_VERSION_LINE_RE } from "./constants.js";

/** Rewrite [project].version in pyproject.toml content (#771). */
export function updatePyprojectVersion(text: string, version: string): string {
  if (typeof text !== "string") {
    throw new Error(`text must be a string, got ${typeof text}`);
  }
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("version must be a non-empty string");
  }

  const lines = text.split(/(?<=\n)/);
  let inProjectSection = false;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) {
      continue;
    }
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      inProjectSection = stripped === "[project]";
      continue;
    }
    if (inProjectSection && PYPROJECT_VERSION_LINE_RE.test(stripped)) {
      const newLine = line.replace(PYPROJECT_VERSION_LINE_RE, `version = "${version}"`);
      if (newLine === line) {
        return text;
      }
      lines[idx] = newLine;
      return lines.join("");
    }
  }
  throw new Error("pyproject.toml has no [project] section with a version key");
}
