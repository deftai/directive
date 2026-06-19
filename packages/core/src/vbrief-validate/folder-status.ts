import { FOLDER_ALLOWED_STATUSES } from "./constants.js";
import { lifecycleFolderFor } from "./paths.js";
import type { JsonObject } from "./schema.js";

/** Verify plan.status matches the lifecycle folder the file is in (D2). */
export function validateFolderStatus(
  filepath: string,
  data: JsonObject,
  vbriefDir: string,
): string[] {
  const folder = lifecycleFolderFor(filepath, vbriefDir);
  if (folder === null || !(folder in FOLDER_ALLOWED_STATUSES)) {
    return [];
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const status = (plan as JsonObject).status;
  if (status === undefined || status === null) {
    return [];
  }

  const allowed = FOLDER_ALLOWED_STATUSES[folder];
  if (allowed === undefined || !allowed.has(String(status))) {
    const sorted = [...(allowed ?? [])]
      .sort()
      .map((s) => `'${s}'`)
      .join(", ");
    return [
      `${filepath}: plan.status is '${String(status)}' but file is in ` +
        `'${folder}/' (allowed statuses: [${sorted}]) (D2)`,
    ];
  }
  return [];
}
