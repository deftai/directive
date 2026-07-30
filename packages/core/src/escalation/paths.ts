import { join } from "node:path";
import { ESCALATION_DIR } from "./types.js";

export function escalationsDir(projectRoot: string): string {
  return join(projectRoot, ...ESCALATION_DIR.split("/"));
}

export function escalationPath(projectRoot: string, escalationId: string): string {
  const safe = escalationId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(escalationsDir(projectRoot), `${safe}.json`);
}
