/** Parse (repo, issue_number) from a github-issue reference URI. */
export function parseGithubIssueUri(uri: unknown): [string | null, number | null] {
  if (typeof uri !== "string") return [null, null];
  const cleaned = uri.trim().replace(/\/$/, "");
  if (!cleaned) return [null, null];
  const noScheme = cleaned.includes("://") ? cleaned.split("://").slice(1).join("://") : cleaned;
  const parts = noScheme.split("/").filter(Boolean);
  if (parts.length >= 4 && parts[parts.length - 2] === "issues") {
    const tail = parts[parts.length - 1] ?? "";
    if (/^\d+$/.test(tail)) {
      const owner = parts[parts.length - 4];
      const repo = parts[parts.length - 3];
      if (owner && repo) return [`${owner}/${repo}`, Number(tail)];
    }
  }
  const tail = parts[parts.length - 1] ?? "";
  if (/^\d+$/.test(tail)) return [null, Number(tail)];
  return [null, null];
}

export function extractIssueRef(data: Record<string, unknown>): [string | null, number | null] {
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return [null, null];
  const refs = (plan as Record<string, unknown>).references;
  if (!Array.isArray(refs)) return [null, null];
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
    const rec = ref as Record<string, unknown>;
    if (rec.type !== "x-vbrief/github-issue") continue;
    const [repo, number] = parseGithubIssueUri(rec.uri);
    if (number !== null) return [repo, number];
  }
  return [null, null];
}
