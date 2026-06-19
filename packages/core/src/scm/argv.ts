/** Return `(present, remainder)` after removing every occurrence of `flag`. */
export function extractFlag(extra: readonly string[], flag: string): [boolean, string[]] {
  const present = extra.includes(flag);
  const remainder = extra.filter((a) => a !== flag);
  return [present, remainder];
}

/** Return `(value, remainder)` for `--flag VALUE` or `--flag=VALUE`. */
export function extractValueFlag(
  extra: readonly string[],
  flag: string,
  defaultValue: string | null = null,
): [string | null, string[]] {
  const out: string[] = [];
  let value = defaultValue;
  let seen = false;
  let i = 0;
  while (i < extra.length) {
    const token = extra[i];
    if (!seen && token === flag && i + 1 < extra.length) {
      value = extra[i + 1] ?? null;
      seen = true;
      i += 2;
      continue;
    }
    if (!seen && token?.startsWith(`${flag}=`)) {
      value = token.split("=", 2)[1] ?? null;
      seen = true;
      i += 1;
      continue;
    }
    if (token !== undefined) {
      out.push(token);
    }
    i += 1;
  }
  return [value, out];
}

/** Project `obj` (dict or list[dict]) onto `fields`. */
export function filterJsonFields(obj: unknown, fields: readonly string[]): unknown {
  if (fields.length === 0) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => filterJsonFields(item, fields));
  }
  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const key of fields) {
      if (key in record) {
        filtered[key] = record[key];
      }
    }
    return filtered;
  }
  return obj;
}
