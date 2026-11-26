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
  "Rename or remove the named foreign hook in .agents/hooks.json, or run `deft policy:disable-host-hooks --host agy --confirm`.";

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
        detail: `.agents/hooks.json is not valid JSON (${String((error as Error).message)}).`,
      },
    ];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [
      {
        name: "",
        kind: "unparseable-config",
        detail: ".agents/hooks.json is not a JSON object keyed by hook name.",
      },
    ];
  }
  const own = Buffer.from(directiveName, "utf8");
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (name === directiveName) continue;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      findings.push({
        name,
        kind: "undeterminable-entry",
        detail: `Hook "${name}" is not an object, so its events cannot be read.`,
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
        detail: `Hook "${name}" has a PreToolUse value that is not a list.`,
      });
      continue;
    }
    if (groups.length === 0) continue;
    if (!/^[A-Za-z0-9._~-]+$/.test(name)) {
      findings.push({
        name,
        kind: "out-of-observed-alphabet",
        detail: `Hook "${name}" uses characters whose order was not observed, so it counts as running at or after Directive's entry.`,
      });
    } else if (name.startsWith(directiveName)) {
      findings.push({
        name,
        kind: "extends-directive-name",
        detail: `Hook "${name}" extends Directive's name "${directiveName}", so it runs after it.`,
      });
    } else if (Buffer.compare(Buffer.from(name, "utf8"), own) >= 0) {
      findings.push({
        name,
        kind: "sorts-at-or-after",
        detail: `Hook "${name}" sorts at or after Directive's "${directiveName}", so it can rewrite arguments Directive already checked.`,
      });
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
export const AGY_HOOK_ORDER_OUTER_FINDINGS_SOURCE = `function agyHookOrderFindingsFromText(configText, directiveName) {
  const findings = [];
  let parsed;
  try {
    parsed = JSON.parse(configText);
  } catch (error) {
    return [{ name: "", kind: "unparseable-config", detail: ".agents/hooks.json is not valid JSON (" + String(error.message) + ")." }];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [{ name: "", kind: "unparseable-config", detail: ".agents/hooks.json is not a JSON object keyed by hook name." }];
  }
  const own = Buffer.from(directiveName, "utf8");
  for (const [name, entry] of Object.entries(parsed)) {
    if (name === directiveName) continue;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      findings.push({ name, kind: "undeterminable-entry", detail: "Hook \\"" + name + "\\" is not an object, so its events cannot be read." });
      continue;
    }
    if (entry.enabled === false) continue;
    if (!("PreToolUse" in entry)) continue;
    const groups = entry.PreToolUse;
    if (!Array.isArray(groups)) {
      findings.push({ name, kind: "undeterminable-entry", detail: "Hook \\"" + name + "\\" has a PreToolUse value that is not a list." });
      continue;
    }
    if (groups.length === 0) continue;
    if (!/^[A-Za-z0-9._~-]+$/.test(name)) {
      findings.push({ name, kind: "out-of-observed-alphabet", detail: "Hook \\"" + name + "\\" uses characters whose order was not observed, so it counts as running at or after Directive's entry." });
    } else if (name.startsWith(directiveName)) {
      findings.push({ name, kind: "extends-directive-name", detail: "Hook \\"" + name + "\\" extends Directive's name \\"" + directiveName + "\\", so it runs after it." });
    } else if (Buffer.compare(Buffer.from(name, "utf8"), own) >= 0) {
      findings.push({ name, kind: "sorts-at-or-after", detail: "Hook \\"" + name + "\\" sorts at or after Directive's \\"" + directiveName + "\\", so it can rewrite arguments Directive already checked." });
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
  for (const workspace of paths) {
    let text;
    try {
      text = readFileSync(join(workspace, AGY_HOOKS_JSON_REL), "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      findings.push({ name: "", kind: "unparseable-config", detail: ".agents/hooks.json could not be read in " + workspace + "." });
      continue;
    }
    findings.push(...agyHookOrderFindingsFromText(text, AGY_DIRECTIVE_HOOK_NAME));
  }
  return findings;
}`,
    `function agyHookOrderDenial(findings) {
  return "Directive cannot confirm that it runs last among agy PreToolUse hooks. " + findings.map((f) => f.detail).join(" ") + " " + AGY_HOOK_ORDER_REMEDIATION;
}`,
  ].join("\n");
}
