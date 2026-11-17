/**
 * #6507: in a checkout of the framework source repository, a refresh that names
 * no template reads the checkout's own content/templates/agents-entry.md, not the
 * template found by the module walk (the pinned runtime's copy in a real session).
 * Consumers, explicit seams and DEFT_ROOT keep today's template source.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentRoot } from "../content-root.js";
import { DEFT_REPO_POSITIVE_MARKERS } from "../doctor/constants.js";
import {
  agentsRefreshPlan,
  applyAgentsRefresh,
  frameworkRoot,
  renderManagedSection,
} from "./agents-md.js";

const OPEN = "<!-- deft:managed-section v3 -->";
const CLOSE = "<!-- /deft:managed-section -->";

function template(body: string): string {
  return `${OPEN}\n${body}\n${CLOSE}\n`;
}

const CHECKOUT_TEMPLATE = template("# Checkout rules (#6507 fixture)\n\n! Newer checkout rule.");
const OLD_SECTION_BODY = "# Checkout rules (#6507 fixture)\n\n! Older rule only.";

const TEMPS: string[] = [];
const SAVED_DEFT_ROOT = process.env.DEFT_ROOT;

afterEach(() => {
  for (const dir of TEMPS.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (SAVED_DEFT_ROOT === undefined) delete process.env.DEFT_ROOT;
  else process.env.DEFT_ROOT = SAVED_DEFT_ROOT;
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMPS.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function agentsWithSection(body: string): string {
  return `# Project header\n\n<!-- deft:managed-section v3 sha=0.0.0 refreshed=2026-01-01T00:00:00Z session=abc123abc123 -->\n${body}\n${CLOSE}\n`;
}

/** Source-checkout fixture: main.md + framework markers; agents-entry is `tpl`. */
function sourceCheckout(tpl: string, agents: string | null): string {
  const root = temp("deft-6507-source-");
  write(root, "main.md", "# main\n");
  for (const marker of DEFT_REPO_POSITIVE_MARKERS) write(root, marker, "marker\n");
  write(root, "content/templates/agents-entry.md", tpl);
  write(root, "package.json", JSON.stringify({ name: "fixture", version: "9.9.9-fixture" }));
  if (agents !== null) write(root, "AGENTS.md", agents);
  return root;
}

function walkRendered(): string {
  const text = readFileSync(
    join(contentRoot(frameworkRoot()), "templates", "agents-entry.md"),
    "utf8",
  );
  return renderManagedSection(text) ?? "";
}

describe("agents refresh in a framework source checkout (#6507)", () => {
  it("the module walk finds a different template than the fixture (precondition)", () => {
    expect(walkRendered()).not.toBe(renderManagedSection(CHECKOUT_TEMPLATE));
  });

  it("a section that matches the checkout template is current and is not written", () => {
    delete process.env.DEFT_ROOT;
    const agents = agentsWithSection("# Checkout rules (#6507 fixture)\n\n! Newer checkout rule.");
    const root = sourceCheckout(CHECKOUT_TEMPLATE, agents);

    const result = applyAgentsRefresh(root);

    expect(result.state).toBe("current");
    expect(result.wrote).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(agents);
  });

  it("an older section is stale and the new content carries the checkout template", () => {
    delete process.env.DEFT_ROOT;
    const root = sourceCheckout(CHECKOUT_TEMPLATE, agentsWithSection(OLD_SECTION_BODY));

    const plan = agentsRefreshPlan(root);

    expect(plan.state).toBe("stale");
    expect(String(plan.new_content)).toContain("! Newer checkout rule.");
    expect(String(plan.new_content)).not.toContain("! Older rule only.");
    expect(plan.sha).toBe("9.9.9-fixture");
  });

  it("reads the checkout file even when a staged content package would win contentRoot", () => {
    delete process.env.DEFT_ROOT;
    const agents = agentsWithSection("# Checkout rules (#6507 fixture)\n\n! Newer checkout rule.");
    const root = sourceCheckout(CHECKOUT_TEMPLATE, agents);
    const pkg = join("node_modules", "@deftai", "directive-content");
    write(root, join(pkg, "package.json"), JSON.stringify({ name: "@deftai/directive-content" }));
    write(root, join(pkg, "templates", "agents-entry.md"), template("# Staged package rules"));
    write(root, join(pkg, "skills", "x", "SKILL.md"), "x\n");
    expect(contentRoot(root)).toBe(join(root, pkg));

    const plan = agentsRefreshPlan(root);

    expect(plan.state).toBe("current");
    expect(String(plan.rendered)).toContain("! Newer checkout rule.");
  });

  it("a consumer project keeps the module-walk template", () => {
    delete process.env.DEFT_ROOT;
    const root = temp("deft-6507-consumer-");

    const plan = agentsRefreshPlan(root);

    expect(plan.state).toBe("absent");
    expect(plan.rendered).toBe(walkRendered());
  });

  it("DEFT_ROOT wins in a source checkout", () => {
    const deftRoot = temp("deft-6507-root-");
    write(deftRoot, "templates/agents-entry.md", template("# DEFT_ROOT rules"));
    process.env.DEFT_ROOT = deftRoot;
    const root = sourceCheckout(CHECKOUT_TEMPLATE, null);

    expect(String(agentsRefreshPlan(root).rendered)).toContain("# DEFT_ROOT rules");
  });

  it("an explicit frameworkRoot or readTemplate seam wins in a source checkout", () => {
    delete process.env.DEFT_ROOT;
    const other = temp("deft-6507-seam-");
    write(other, "templates/agents-entry.md", template("# Seam root rules"));
    const root = sourceCheckout(CHECKOUT_TEMPLATE, null);

    expect(String(agentsRefreshPlan(root, { frameworkRoot: other }).rendered)).toContain(
      "# Seam root rules",
    );
    expect(
      String(
        agentsRefreshPlan(root, { readTemplate: () => template("# Seam text rules") }).rendered,
      ),
    ).toContain("# Seam text rules");
  });

  it("without its agents-entry file the checkout is not a source checkout", () => {
    delete process.env.DEFT_ROOT;
    const root = sourceCheckout(CHECKOUT_TEMPLATE, null);
    rmSync(join(root, "content", "templates", "agents-entry.md"));
    // agents-entry.md is a framework marker, so the plan falls back to the walk.
    expect(agentsRefreshPlan(root).rendered).toBe(walkRendered());
  });
});
