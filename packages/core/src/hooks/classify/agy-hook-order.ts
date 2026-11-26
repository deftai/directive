/**
 * Antigravity (`agy`) hook ordering predicate (#7378, slice of #7332).
 *
 * agy runs `PreToolUse` hooks in hook-name order and the last `overwrite` wins
 * (#7345 s11/s12/s22/s23), so Directive's check covers the arguments that run
 * only when no foreign hook runs at or after Directive's entry. The entry name
 * below is a convenience; this predicate carries the safety claim.
 *
 * Readers: doctor and the contract test call {@link agyHookOrderFindingsFromText};
 * the deposited outer carries {@link AGY_HOOK_ORDER_OUTER_FINDINGS_SOURCE}, a
 * literal plain-JavaScript copy with the same findings so the outer's bytes do
 * not depend on the build tool. A conformance test runs both over one corpus.
 */

/** Directive's agy hook entry name: one constant, last among ordinary names. */
export const AGY_DIRECTIVE_HOOK_NAME = "zzzz-directive";

/** Project hook file the predicate reads, relative to a workspace path. */
export const AGY_HOOKS_JSON_REL = ".agents/hooks.json";

/** The one remediation named by every finding (#7378). */
export const AGY_HOOK_ORDER_REMEDIATION =
  "Rename or remove the named foreign hook in the file named, or run `deft policy:disable-host-hooks --host agy --confirm`.";

export type AgyHookOrderFindingKind =
  | "sorts-at-or-after"
  | "equal-name"
  | "extends-directive-name"
  | "out-of-observed-alphabet"
  | "undeterminable-entry"
  | "unparseable-config"
  | "unresolvable-workspace";

export interface AgyHookOrderFinding {
  /** Foreign hook name; empty for config-level findings. */
  readonly name: string;
  readonly kind: AgyHookOrderFindingKind;
  readonly detail: string;
}

/**
 * Findings for one `.agents/hooks.json` text. Observed (#7345 s22/s23 on 1.5.16;
 * the 1.5.18 neighbour run in agy-observation.ts): names run in byte order. A
 * foreign entry with a non-empty `PreToolUse` list counts as at-or-after when its
 * name is outside `[A-Za-z0-9._~-]`, equals or starts with Directive's name, or
 * is not byte-less than it. `matcher` is never read. `enabled: false` skips an
 * entry. An entry whose shape cannot be read is a finding.
 */
export function agyHookOrderFindingsFromText(
  configText: string,
  directiveName: string,
  source: string = AGY_HOOKS_JSON_REL,
  ownFile = true,
): AgyHookOrderFinding[] {
  const findings: AgyHookOrderFinding[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch (error) {
    return [
      {
        name: "",
        kind: "unparseable-config",
        detail: `${source} is not valid JSON (${String((error as Error).message)}).`,
      },
    ];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [
      {
        name: "",
        kind: "unparseable-config",
        detail: `${source} is not a JSON object keyed by hook name.`,
      },
    ];
  }
  const own = Buffer.from(directiveName, "utf8");
  const where = source === AGY_HOOKS_JSON_REL ? "" : ` (in ${source})`;
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (ownFile && name === directiveName) continue;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      findings.push({
        name,
        kind: "undeterminable-entry",
        detail: `Hook "${name}"${where} is not an object, so its events cannot be read.`,
      });
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.enabled === false) continue;
    if (!("PreToolUse" in record)) continue;
    const groups = record.PreToolUse;
    if (!Array.isArray(groups)) {
      findings.push({
        name,
        kind: "undeterminable-entry",
        detail: `Hook "${name}"${where} has a PreToolUse value that is not a list.`,
      });
      continue;
    }
    if (groups.length === 0) continue;
    if (!/^[A-Za-z0-9._~-]+$/.test(name)) {
      findings.push({
        name,
        kind: "out-of-observed-alphabet",
        detail: `Hook "${name}"${where} uses characters whose order was not observed, so it counts as running at or after Directive's entry.`,
      });
    } else if (name === directiveName) {
      findings.push({
        name,
        kind: "equal-name",
        detail: `Hook "${name}"${where} has Directive's name, so its order against Directive's entry is not defined.`,
      });
    } else if (name.startsWith(directiveName)) {
      findings.push({
        name,
        kind: "extends-directive-name",
        detail: `Hook "${name}"${where} extends Directive's name "${directiveName}", so it runs after it.`,
      });
    } else if (Buffer.compare(Buffer.from(name, "utf8"), own) >= 0) {
      findings.push({
        name,
        kind: "sorts-at-or-after",
        detail: `Hook "${name}"${where} sorts at or after Directive's "${directiveName}", so it can rewrite arguments Directive already checked.`,
      });
    }
  }
  return findings;
}

/** Hook-file access for the collectors (a seam so doctor and tests can stub it). */
export interface AgyHookFileSeams {
  /** File text, or null when the file does not exist; throws on any other read error. */
  readonly readText: (path: string) => string | null;
  /** Child directory names, or [] when the directory does not exist; throws on other errors. */
  readonly listDirs: (path: string) => string[];
}

function joinPath(base: string, ...parts: string[]): string {
  return [base.replace(/[\\/]+$/, ""), ...parts].join("/");
}

/**
 * Every hook file agy read for a workspace and the user on 1.5.18 (#7378, n02 to
 * n05): `<ws>/.agents/hooks.json` (Directive's own), `<ws>/.agents/plugins/<name>/hooks.json`,
 * `<home>/.gemini/config/hooks.json` and `<home>/.gemini/config/plugins/<name>/hooks.json`.
 * All merge into one hook-name order and are re-read before the next call.
 * Locations not observed stay a stated limit.
 */
export function agyHookOrderFilePaths(
  workspace: string,
  home: string | null,
  seams: AgyHookFileSeams,
): { path: string; own: boolean }[] {
  const out: { path: string; own: boolean }[] = [
    { path: joinPath(workspace, AGY_HOOKS_JSON_REL), own: true },
  ];
  const roots: string[] = [joinPath(workspace, ".agents", "plugins")];
  if (home !== null) {
    out.push({ path: joinPath(home, ".gemini", "config", "hooks.json"), own: false });
    roots.push(joinPath(home, ".gemini", "config", "plugins"));
  }
  for (const root of roots) {
    for (const dir of [...seams.listDirs(root)].sort()) {
      out.push({ path: joinPath(root, dir, "hooks.json"), own: false });
    }
  }
  return out;
}

/**
 * Findings across every observed hook file for the given workspaces. An
 * unreadable file or folder, or an empty workspace list, is a finding.
 */
export function collectAgyHookOrderFindings(
  workspaces: readonly string[],
  home: string | null,
  seams: AgyHookFileSeams,
): AgyHookOrderFinding[] {
  if (workspaces.length === 0 || workspaces.some((w) => w.length === 0)) {
    return [
      {
        name: "",
        kind: "unresolvable-workspace",
        detail: "The hook payload names no workspace, so the hook config cannot be read.",
      },
    ];
  }
  const findings: AgyHookOrderFinding[] = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    let files: { path: string; own: boolean }[];
    try {
      files = agyHookOrderFilePaths(workspace, home, seams);
    } catch {
      findings.push({
        name: "",
        kind: "unparseable-config",
        detail: `A hook plugin folder could not be listed for ${workspace}.`,
      });
      continue;
    }
    for (const file of files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      let text: string | null;
      try {
        text = seams.readText(file.path);
      } catch {
        findings.push({
          name: "",
          kind: "unparseable-config",
          detail: `${file.path} could not be read.`,
        });
        continue;
      }
      if (text === null) continue;
      findings.push(
        ...agyHookOrderFindingsFromText(
          text,
          AGY_DIRECTIVE_HOOK_NAME,
          file.own ? AGY_HOOKS_JSON_REL : file.path,
          file.own,
        ),
      );
    }
  }
  return findings;
}

/** Findings for one config text against Directive's constant name. */
export function agyHookOrderFindings(configText: string): AgyHookOrderFinding[] {
  return agyHookOrderFindingsFromText(configText, AGY_DIRECTIVE_HOOK_NAME);
}

/** True when the config has a Directive entry (doctor reports only then). */
export function agyConfigHasDirectiveEntry(configText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(configText);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      AGY_DIRECTIVE_HOOK_NAME in (parsed as Record<string, unknown>)
    );
  } catch {
    return false;
  }
}

/** One deny reason: every finding, then the single remediation. */
export function formatAgyHookOrderDenial(findings: readonly AgyHookOrderFinding[]): string {
  const lines = findings.map((finding) => finding.detail).join(" ");
  return `Directive cannot confirm that it runs last among agy PreToolUse hooks. ${lines} ${AGY_HOOK_ORDER_REMEDIATION}`;
}

/**
 * Plain-JavaScript copy of {@link agyHookOrderFindingsFromText} for the outer.
 * Keep the two in step; the conformance test fails on any divergence.
 */
export const AGY_HOOK_ORDER_OUTER_FINDINGS_SOURCE = `function agyHookOrderFindingsFromText(configText, directiveName, source = ".agents/hooks.json", ownFile = true) {
  const findings = [];
  let parsed;
  try {
    parsed = JSON.parse(configText);
  } catch (error) {
    return [{ name: "", kind: "unparseable-config", detail: source + " is not valid JSON (" + String(error.message) + ")." }];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [{ name: "", kind: "unparseable-config", detail: source + " is not a JSON object keyed by hook name." }];
  }
  const own = Buffer.from(directiveName, "utf8");
  const where = source === ".agents/hooks.json" ? "" : " (in " + source + ")";
  for (const [name, entry] of Object.entries(parsed)) {
    if (ownFile && name === directiveName) continue;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      findings.push({ name, kind: "undeterminable-entry", detail: "Hook \\"" + name + "\\"" + where + " is not an object, so its events cannot be read." });
      continue;
    }
    if (entry.enabled === false) continue;
    if (!("PreToolUse" in entry)) continue;
    const groups = entry.PreToolUse;
    if (!Array.isArray(groups)) {
      findings.push({ name, kind: "undeterminable-entry", detail: "Hook \\"" + name + "\\"" + where + " has a PreToolUse value that is not a list." });
      continue;
    }
    if (groups.length === 0) continue;
    if (!/^[A-Za-z0-9._~-]+$/.test(name)) {
      findings.push({ name, kind: "out-of-observed-alphabet", detail: "Hook \\"" + name + "\\"" + where + " uses characters whose order was not observed, so it counts as running at or after Directive's entry." });
    } else if (name === directiveName) {
      findings.push({ name, kind: "equal-name", detail: "Hook \\"" + name + "\\"" + where + " has Directive's name, so its order against Directive's entry is not defined." });
    } else if (name.startsWith(directiveName)) {
      findings.push({ name, kind: "extends-directive-name", detail: "Hook \\"" + name + "\\"" + where + " extends Directive's name \\"" + directiveName + "\\", so it runs after it." });
    } else if (Buffer.compare(Buffer.from(name, "utf8"), own) >= 0) {
      findings.push({ name, kind: "sorts-at-or-after", detail: "Hook \\"" + name + "\\"" + where + " sorts at or after Directive's \\"" + directiveName + "\\", so it can rewrite arguments Directive already checked." });
    }
  }
  return findings;
}`;

/**
 * Source of the per-call check deposited in the outer: the findings function
 * plus a reader that resolves each `workspacePaths` entry, fails closed on an
 * unresolvable payload, and returns findings. The outer already imports
 * `readFileSync` and `join`.
 */
export function agyHookOrderOuterSource(): string {
  return [
    `const AGY_DIRECTIVE_HOOK_NAME = ${JSON.stringify(AGY_DIRECTIVE_HOOK_NAME)};`,
    `const AGY_HOOKS_JSON_REL = ${JSON.stringify(AGY_HOOKS_JSON_REL)};`,
    `const AGY_HOOK_ORDER_REMEDIATION = ${JSON.stringify(AGY_HOOK_ORDER_REMEDIATION)};`,
    AGY_HOOK_ORDER_OUTER_FINDINGS_SOURCE,
    `function agyHookOrderPayloadFindings(payload) {
  const paths = payload !== null && typeof payload === "object" ? payload.workspacePaths : null;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p.length > 0)) {
    return [{ name: "", kind: "unresolvable-workspace", detail: "The hook payload names no workspace, so the hook config cannot be read." }];
  }
  const findings = [];
  const home = homedir();
  const seen = new Set();
  const listDirs = (root) => {
    try {
      return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch (error) {
      if (error && error.code === "ENOENT") return [];
      throw error;
    }
  };
  for (const workspace of paths) {
    const files = [{ path: join(workspace, AGY_HOOKS_JSON_REL), own: true }];
    const roots = [join(workspace, ".agents", "plugins")];
    files.push({ path: join(home, ".gemini", "config", "hooks.json"), own: false });
    roots.push(join(home, ".gemini", "config", "plugins"));
    for (const root of roots) {
      try {
        for (const dir of listDirs(root)) files.push({ path: join(root, dir, "hooks.json"), own: false });
      } catch {
        findings.push({ name: "", kind: "unparseable-config", detail: "A hook plugin folder could not be listed: " + root + "." });
      }
    }
    for (const file of files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      let text;
      try {
        text = readFileSync(file.path, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        findings.push({ name: "", kind: "unparseable-config", detail: file.path + " could not be read." });
        continue;
      }
      findings.push(...agyHookOrderFindingsFromText(text, AGY_DIRECTIVE_HOOK_NAME, file.own ? AGY_HOOKS_JSON_REL : file.path, file.own));
    }
  }
  return findings;
}`,
    `function agyHookOrderDenial(findings) {
  return "Directive cannot confirm that it runs last among agy PreToolUse hooks. " + findings.map((f) => f.detail).join(" ") + " " + AGY_HOOK_ORDER_REMEDIATION;
}`,
  ].join("\n");
}
