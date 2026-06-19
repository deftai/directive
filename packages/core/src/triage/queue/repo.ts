import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ENV_TRIAGE_REPO } from "./constants.js";

/** Best-effort: read git remote get-url origin inside projectRoot. */
export function inferRepoFromGit(projectRoot: string | null): string | null {
  const cwd = projectRoot !== null ? resolve(projectRoot) : undefined;
  try {
    const stdout = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const url = stdout.trim();
    if (url.length === 0) {
      return null;
    }
    let cleaned = url.replace(/\/+$/, "");
    if (cleaned.endsWith(".git")) {
      cleaned = cleaned.slice(0, -".git".length);
    }
    if (!cleaned.includes("github.com")) {
      return null;
    }
    const tail = cleaned.split("github.com")[1]?.replace(/^[:/]+/, "") ?? "";
    const parts = tail.split("/");
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve effective owner/name repo slug (#1238). */
export function resolveRepo(
  explicit: string | null | undefined,
  projectRoot: string,
): string | null {
  if (explicit !== null && explicit !== undefined && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const envRepo = process.env[ENV_TRIAGE_REPO]?.trim() ?? "";
  if (envRepo.length > 0) {
    return envRepo;
  }
  return inferRepoFromGit(projectRoot);
}
