import { resolveGh } from "../release/gh.js";
import { spawnText } from "../release/spawn.js";
import type { E2ESeams } from "./types.js";

export function provisionTempRepo(
  owner: string,
  slug: string,
  seams: E2ESeams = {},
): [boolean, string] {
  const ghPath = resolveGh({ whichGh: seams.whichGh });
  if (ghPath === null) {
    return [false, "gh CLI not found on PATH"];
  }
  const full = `${owner}/${slug}`;
  const spawn = seams.spawnText ?? spawnText;
  const result = spawn(
    ghPath,
    [
      "repo",
      "create",
      full,
      "--private",
      "--description",
      "Auto-generated release-rehearsal repo (deft #716); safe to delete.",
    ],
    { env: { ...process.env }, timeoutMs: 120_000 },
  );
  if (result.status !== 0) {
    return [false, `gh repo create failed: ${result.stderr.trim()}`];
  }
  return [true, `created ${full} (private)`];
}

export function destroyTempRepo(
  owner: string,
  slug: string,
  seams: E2ESeams = {},
): [boolean, string] {
  const ghPath = resolveGh({ whichGh: seams.whichGh });
  if (ghPath === null) {
    return [false, "gh CLI not found on PATH"];
  }
  const full = `${owner}/${slug}`;
  const spawn = seams.spawnText ?? spawnText;
  const result = spawn(ghPath, ["repo", "delete", full, "--yes"], {
    env: { ...process.env },
    timeoutMs: 120_000,
  });
  if (result.status !== 0) {
    return [false, `gh repo delete failed: ${result.stderr.trim()}`];
  }
  return [true, `deleted ${full}`];
}

export function verifyDraftRelease(
  owner: string,
  slug: string,
  version: string,
  seams: E2ESeams = {},
): [boolean, string] {
  const ghPath = resolveGh({ whichGh: seams.whichGh });
  if (ghPath === null) {
    return [false, "gh CLI not found on PATH"];
  }
  const tag = `v${version}`;
  const full = `${owner}/${slug}`;
  const spawn = seams.spawnText ?? spawnText;
  const result = spawn(
    ghPath,
    ["release", "view", tag, "--repo", full, "--json", "isDraft,tagName,name,url"],
    { env: { ...process.env }, timeoutMs: 60_000 },
  );
  if (result.status !== 0) {
    return [false, `gh release view failed: ${result.stderr.trim()}`];
  }
  let payload: { isDraft?: boolean; tagName?: string };
  try {
    payload = JSON.parse(result.stdout) as { isDraft?: boolean; tagName?: string };
  } catch (exc) {
    return [false, `gh release view returned non-JSON: ${String(exc)}`];
  }
  if (!payload.isDraft) {
    return [
      false,
      `draft verify FAIL: expected isDraft=true on ${full} ${tag}, got ${JSON.stringify(payload)}`,
    ];
  }
  if (payload.tagName !== tag) {
    return [
      false,
      `draft verify FAIL: expected tagName=${JSON.stringify(tag)} on ${full}, got tagName=${JSON.stringify(payload.tagName)}`,
    ];
  }
  return [true, `verified draft ${tag} on ${full}`];
}
