import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pythonJsonPretty } from "./json.js";
import {
  CONFIGURED_PROJECT_DEFINITION_LABEL,
  projectDefinitionPath,
} from "./project-definition-io.js";
import { withProjectDefinitionMutation } from "./project-definition-mutation.js";
import { ProjectDefinitionIOError } from "./types.js";

const roots: string[] = [];
const savedProjectPath = process.env.DEFT_PROJECT_PATH;

function seedProject(prefix: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  const path = projectDefinitionPath(root);
  writeFileSync(
    path,
    pythonJsonPretty({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [] },
    }),
    "utf8",
  );
  return { root, path };
}

afterEach(() => {
  if (savedProjectPath === undefined) delete process.env.DEFT_PROJECT_PATH;
  else process.env.DEFT_PROJECT_PATH = savedProjectPath;
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("withProjectDefinitionMutation (#3796)", () => {
  it("round-trips load and persist against the captured artifact", () => {
    const { root, path } = seedProject("pd-cap-roundtrip-");

    const captured = withProjectDefinitionMutation(root, (mutation) => {
      const data = mutation.load();
      (data.plan as Record<string, unknown>).title = "Updated";
      mutation.persist(data);
      return mutation.artifactPath;
    });

    expect(captured).toBe(path);
    const roundtrip = JSON.parse(readFileSync(path, "utf8")) as { plan: { title: string } };
    expect(roundtrip.plan.title).toBe("Updated");
    // The lock directory is released with the section.
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("keeps one artifact identity when the configured path is retargeted mid-section", () => {
    const { root, path } = seedProject("pd-cap-retarget-");
    const decoyDir = join(root, "decoy");
    mkdirSync(decoyDir, { recursive: true });
    const decoy = join(decoyDir, "other-project.xbrief.json");
    writeFileSync(decoy, pythonJsonPretty({ plan: { title: "decoy" } }), "utf8");

    const observed = withProjectDefinitionMutation(root, (mutation) => {
      // A configured-path retarget after the lock is taken must not move the
      // read or the write: that split is the bug the capability closes.
      process.env.DEFT_PROJECT_PATH = join("decoy", "other-project.xbrief.json");
      const data = mutation.load();
      (data.plan as Record<string, unknown>).title = "written-under-lock";
      mutation.persist(data);
      return { artifactPath: mutation.artifactPath, title: (data.plan as { title: string }).title };
    });

    expect(observed.artifactPath).toBe(path);
    const locked = JSON.parse(readFileSync(path, "utf8")) as { plan: { title: string } };
    expect(locked.plan.title).toBe("written-under-lock");
    const untouched = JSON.parse(readFileSync(decoy, "utf8")) as { plan: { title: string } };
    expect(untouched.plan.title).toBe("decoy");
  });

  it("surfaces the loader's typed error for a malformed artifact", () => {
    const { root, path } = seedProject("pd-cap-malformed-");
    writeFileSync(path, "not-json", "utf8");

    expect(() => withProjectDefinitionMutation(root, (mutation) => mutation.load())).toThrow(
      ProjectDefinitionIOError,
    );
  });

  it("reports the constant label for a configured artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "pd-cap-label-"));
    roots.push(root);
    mkdirSync(join(root, "config"), { recursive: true });
    const configured = join(root, "config", "custom-project.xbrief.json");
    writeFileSync(configured, pythonJsonPretty({ plan: { title: "C" } }), "utf8");
    process.env.DEFT_PROJECT_PATH = join("config", "custom-project.xbrief.json");

    const label = withProjectDefinitionMutation(root, (mutation) => mutation.artifactLabel);
    expect(label).toBe(CONFIGURED_PROJECT_DEFINITION_LABEL);
  });

  it("persists a configured artifact that resolves outside the project root", () => {
    const outer = mkdtempSync(join(tmpdir(), "pd-cap-outside-"));
    roots.push(outer);
    const root = join(outer, "project");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const configured = join(outer, "external-project.xbrief.json");
    writeFileSync(configured, pythonJsonPretty({ plan: { title: "E" } }), "utf8");
    process.env.DEFT_PROJECT_PATH = join("..", "external-project.xbrief.json");

    withProjectDefinitionMutation(root, (mutation) => {
      const data = mutation.load();
      (data.plan as Record<string, unknown>).title = "external-write";
      mutation.persist(data);
    });

    const roundtrip = JSON.parse(readFileSync(configured, "utf8")) as { plan: { title: string } };
    expect(roundtrip.plan.title).toBe("external-write");
  });

  it("refuses a persist when the artifact itself is a symlink", () => {
    const { root, path } = seedProject("pd-cap-symlink-");
    const real = join(root, "xbrief", "real-target.json");
    writeFileSync(real, "{}", "utf8");
    rmSync(path, { force: true });
    let linked = false;
    try {
      symlinkSync(real, path, "file");
      linked = true;
    } catch {
      // Windows needs privileges for symlinks; skip the assertion when denied.
      linked = false;
    }
    if (!linked) return;

    expect(() =>
      withProjectDefinitionMutation(root, (mutation) => {
        mutation.persist({ plan: { title: "diverted" } });
      }),
    ).toThrow(/symlink/i);
  });

  it("does not hold the lock after the section throws", () => {
    const { root, path } = seedProject("pd-cap-release-");

    expect(() =>
      withProjectDefinitionMutation(root, () => {
        throw new Error("section failed");
      }),
    ).toThrow("section failed");

    expect(existsSync(`${path}.lock`)).toBe(false);
    // A later mutation still acquires cleanly.
    expect(withProjectDefinitionMutation(root, () => "ok")).toBe("ok");
  });
});
