import { join } from "node:path";
import { AUTHZ_AUDIT_FILE, AUTHZ_DIR, AUTHZ_GRANTS_DIR, AUTHZ_STATE_FILE } from "./types.js";

export function authzDir(projectRoot: string): string {
  return join(projectRoot, ...AUTHZ_DIR.split("/"));
}

export function authzStatePath(projectRoot: string): string {
  return join(authzDir(projectRoot), AUTHZ_STATE_FILE);
}

export function authzGrantsDir(projectRoot: string): string {
  return join(authzDir(projectRoot), AUTHZ_GRANTS_DIR);
}

export function authzGrantPath(projectRoot: string, grantId: string): string {
  const safe = grantId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(authzGrantsDir(projectRoot), `${safe}.json`);
}

export function authzAuditPath(projectRoot: string): string {
  return join(authzDir(projectRoot), AUTHZ_AUDIT_FILE);
}
