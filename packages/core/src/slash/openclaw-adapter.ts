/**
 * OpenClaw-native L2 product-command adapter (#3064 D1–D3).
 *
 * Hybrid skills-first MVP:
 * - One thin **router** user-invocable skill (`deft`) for native menus
 * - 13 thin user-invocable skills mapped from the L2 product set
 *
 * Reuses {@link generateThinWrappers} / {@link listProductCommands} — no second
 * name table. Bodies stay thin (L5). Not a fake `.openclaw/commands/` file emitter.
 */

import {
  estimateTokens,
  generateThinWrappers,
  MAX_WRAPPER_BODY_TOKENS,
  type ThinWrapperIR,
} from "./generator.js";
import {
  assertOpenClawSlugMapIntegrity,
  listOpenClawSlugEntries,
  logicalIdToOpenClawSlug,
  OPENCLAW_ROUTER_SLUG,
  openClawSlugToLogicalId,
} from "./openclaw-slugs.js";
import { listProductCommands, PRODUCT_COMMAND_COUNT } from "./product-set.js";

/** Ownership marker in managed OpenClaw L2 skill bodies (idempotent rewrite). */
export const OPENCLAW_L2_MANAGED_MARKER = "<!-- deft-managed: openclaw-l2-product-command -->";

/** Router role marker (distinct from the 13 product skills). */
export const OPENCLAW_L2_ROUTER_MARKER = "<!-- deft-openclaw-role: router -->";

/** One OpenClaw skill directory artifact ready for deposit (D4). */
export interface OpenClawSkillArtifact {
  /** Directory name under workspace skills root (= OpenClaw slug). */
  readonly slug: string;
  /** Canonical product slash id, or null for the router. */
  readonly logicalId: string | null;
  readonly description: string;
  /** Full SKILL.md contents. */
  readonly skillMarkdown: string;
  /** Content-relative dispatch path (null for router). */
  readonly dispatchPath: string | null;
  readonly role: "router" | "product";
  readonly estimatedBodyTokens: number;
}

function yamlSingleLine(value: string): string {
  if (/[:#{}[\],&*!|>'"%@`]|^\s|\s$/.test(value) || value === "") {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Render thin product skill body from shared IR (L5).
 * OpenClaw frontmatter: name + description + user-invocable.
 */
export function renderOpenClawProductSkillMarkdown(wrapper: ThinWrapperIR): string {
  const slug = logicalIdToOpenClawSlug(wrapper.logicalId);
  const frontmatter = [
    `name: ${slug}`,
    `description: ${yamlSingleLine(wrapper.description)}`,
    "user-invocable: true",
  ];
  if (wrapper.argumentHint !== undefined) {
    frontmatter.push(`argument-hint: ${yamlSingleLine(wrapper.argumentHint)}`);
  }
  const body = [
    OPENCLAW_L2_MANAGED_MARKER,
    "",
    `# ${slug}`,
    "",
    `Canonical slash: \`${wrapper.logicalId}\``,
    "",
    wrapper.bodyMarkdown.trimEnd(),
    "",
  ].join("\n");
  return `---\n${frontmatter.join("\n")}\n---\n\n${body}`;
}

/**
 * Router skill: one native-menu-facing entry that lists L2 slug dispatch (D1/D3).
 * Keeps body thin — no inlined strategy/skill content.
 */
export function renderOpenClawRouterSkillMarkdown(
  wrappers: readonly ThinWrapperIR[] = generateThinWrappers(),
): string {
  const slugLines = wrappers
    .map((w) => {
      const slug = logicalIdToOpenClawSlug(w.logicalId);
      return `- \`${slug}\` → \`${w.logicalId}\` (${w.dispatchPath})`;
    })
    .join("\n");

  const description =
    "Directive L2 product-command router (prefer for native menus; Telegram budget)";
  const frontmatter = [
    `name: ${OPENCLAW_ROUTER_SLUG}`,
    `description: ${yamlSingleLine(description)}`,
    "user-invocable: true",
    'argument-hint: "<slug-or-logical-id>"',
  ];
  const body = [
    OPENCLAW_L2_MANAGED_MARKER,
    OPENCLAW_L2_ROUTER_MARKER,
    "",
    `# ${OPENCLAW_ROUTER_SLUG} (router)`,
    "",
    "Prefer this skill for native/Telegram menus (one slot). All 13 L2 commands remain invocable as `/<slug>` text skills when deposited.",
    "",
    "On invoke: match `$ARGUMENTS` to an OpenClaw slug or canonical `/deft…` id, then read and follow that command's content-relative dispatch path under `.deft/core/` when installed.",
    "Do not inline strategy, skill, or commands.md bodies.",
    "",
    "L2 slug map:",
    slugLines,
    "",
  ].join("\n");
  return `---\n${frontmatter.join("\n")}\n---\n\n${body}`;
}

/** True when on-disk skill looks like a Directive-managed OpenClaw L2 artifact. */
export function isManagedOpenClawL2Skill(skillMarkdown: string): boolean {
  return skillMarkdown.includes(OPENCLAW_L2_MANAGED_MARKER);
}

/** True when content is the managed router skill. */
export function isManagedOpenClawRouterSkill(skillMarkdown: string): boolean {
  return (
    isManagedOpenClawL2Skill(skillMarkdown) && skillMarkdown.includes(OPENCLAW_L2_ROUTER_MARKER)
  );
}

/**
 * Build router + 13 product skill artifacts from shared thin-wrapper IR.
 *
 * Count of product skills === {@link PRODUCT_COMMAND_COUNT}; plus one router.
 */
export function generateOpenClawSkillArtifacts(
  wrappers: readonly ThinWrapperIR[] = generateThinWrappers(),
): readonly OpenClawSkillArtifact[] {
  assertOpenClawSlugMapIntegrity(listProductCommands());
  if (wrappers.length !== PRODUCT_COMMAND_COUNT) {
    throw new Error(
      `Expected ${PRODUCT_COMMAND_COUNT} thin wrappers for OpenClaw adapter, got ${wrappers.length}`,
    );
  }

  const routerMd = renderOpenClawRouterSkillMarkdown(wrappers);
  const routerBodyStart = routerMd.indexOf("\n---\n", 4);
  const routerBody = routerBodyStart >= 0 ? routerMd.slice(routerBodyStart + 5) : routerMd;

  const artifacts: OpenClawSkillArtifact[] = [
    {
      slug: OPENCLAW_ROUTER_SLUG,
      logicalId: null,
      description: "Directive L2 product-command router (prefer for native menus; Telegram budget)",
      skillMarkdown: routerMd,
      dispatchPath: null,
      role: "router",
      estimatedBodyTokens: estimateTokens(routerBody),
    },
  ];

  for (const w of wrappers) {
    const skillMarkdown = renderOpenClawProductSkillMarkdown(w);
    const bodyStart = skillMarkdown.indexOf("\n---\n", 4);
    const body = bodyStart >= 0 ? skillMarkdown.slice(bodyStart + 5) : skillMarkdown;
    artifacts.push({
      slug: logicalIdToOpenClawSlug(w.logicalId),
      logicalId: w.logicalId,
      description: w.description,
      skillMarkdown,
      dispatchPath: w.dispatchPath,
      role: "product",
      estimatedBodyTokens: estimateTokens(body),
    });
  }

  return artifacts;
}

/** Product skill slugs only (no router), stable order. */
export function listOpenClawProductSkillSlugs(): readonly string[] {
  return listOpenClawSlugEntries().map((e) => e.openClawSlug);
}

/** All managed skill directory names (router + 13). */
export function listOpenClawManagedSkillSlugs(): readonly string[] {
  return [OPENCLAW_ROUTER_SLUG, ...listOpenClawProductSkillSlugs()];
}

/**
 * Thinness guard for OpenClaw skills: managed marker + dispatch path present
 * (product) or router marker; body token budget.
 */
export function isThinOpenClawSkillMarkdown(
  skillMarkdown: string,
  options: { dispatchPath?: string | null; role: "router" | "product" },
): boolean {
  if (!isManagedOpenClawL2Skill(skillMarkdown)) return false;
  if (!skillMarkdown.startsWith("---\n")) return false;
  if (!/^user-invocable:\s*true\s*$/m.test(skillMarkdown)) return false;
  if (/^##\s+(Phase|Workflow|Steps|Acceptance)\b/m.test(skillMarkdown)) return false;

  const close = skillMarkdown.indexOf("\n---\n", 4);
  const body = close >= 0 ? skillMarkdown.slice(close + 5) : skillMarkdown;
  // Router lists the full slug map; allow a slightly larger budget than file hosts.
  const maxBody =
    options.role === "router" ? MAX_WRAPPER_BODY_TOKENS * 4 : MAX_WRAPPER_BODY_TOKENS + 40;
  if (estimateTokens(body) > maxBody) return false;

  if (options.role === "router") {
    return isManagedOpenClawRouterSkill(skillMarkdown);
  }
  if (!options.dispatchPath) return false;
  if (!body.includes(options.dispatchPath)) return false;
  if (!body.includes("Read and follow")) return false;
  if (!body.includes("Do not inline")) return false;
  return true;
}

/** Assert generated artifacts stay thin and cover the full L2 set. */
export function assertThinOpenClawArtifacts(
  artifacts: readonly OpenClawSkillArtifact[] = generateOpenClawSkillArtifacts(),
): void {
  const products = artifacts.filter((a) => a.role === "product");
  const routers = artifacts.filter((a) => a.role === "router");
  if (routers.length !== 1) {
    throw new Error(`Expected exactly 1 OpenClaw router skill, got ${routers.length}`);
  }
  if (products.length !== PRODUCT_COMMAND_COUNT) {
    throw new Error(
      `Expected ${PRODUCT_COMMAND_COUNT} OpenClaw product skills, got ${products.length}`,
    );
  }
  for (const a of artifacts) {
    if (
      !isThinOpenClawSkillMarkdown(a.skillMarkdown, {
        dispatchPath: a.dispatchPath,
        role: a.role,
      })
    ) {
      throw new Error(`Non-thin OpenClaw skill artifact: ${a.slug}`);
    }
    if (a.role === "product" && a.logicalId) {
      const reverse = openClawSlugToLogicalId(a.slug);
      if (reverse !== a.logicalId) {
        throw new Error(`Slug/logicalId mismatch for ${a.slug}`);
      }
    }
  }
}
