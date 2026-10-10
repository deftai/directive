export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityScenario {
  readonly name: string;
  readonly argv: readonly string[];
  readonly compareStdout?: boolean;
}

export interface ParityDiff {
  readonly name: string;
  readonly exitMismatch: boolean;
  readonly outputMismatch: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
  readonly pythonOutput: string;
  readonly tsOutput: string;
  readonly stream: "stdout" | "stderr";
}

export interface ParityResult {
  readonly ok: boolean;
  readonly diffs: ParityDiff[];
}

export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  { name: "help", argv: ["--help"], compareStdout: true },
  { name: "dry-run", argv: ["--dry-run"] },
  { name: "dry-run-destroy-repo", argv: ["--dry-run", "--destroy-repo"] },
  {
    name: "dry-run-project-root",
    argv: ["--dry-run", "--owner", "deftai", "--project-root", "/tmp/deft-e2e-parity-root"],
  },
];

/** Normalise volatile repo slugs and ISO dates in stderr while preserving semantics. */
export function normaliseStderr(text: string): string {
  return text
    .replace(/deftai-release-test-\d{14}-[0-9a-f]{6}/g, "deftai-release-test-YYYYMMDDHHMMSS-uuid6")
    .replace(/\d{4}-\d{2}-\d{2}/g, "YYYY-MM-DD");
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `release-e2e parity: CLEAN -- Python and TS agree on ${result.diffs.length} scenario(s).`;
  }
  const lines = ["release-e2e parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.outputMismatch) {
      lines.push(`  scenario: ${d.name}`);
      if (d.exitMismatch) {
        lines.push(`    exit mismatch: python=${d.pythonExit} ts=${d.tsExit}`);
      }
      if (d.outputMismatch) {
        lines.push(`    stream: ${d.stream}`);
        lines.push(`    python (${d.pythonOutput.length} bytes):`);
        lines.push(d.pythonOutput);
        lines.push(`    ts (${d.tsOutput.length} bytes):`);
        lines.push(d.tsOutput);
      }
    }
  }
  return lines.join("\n");
}
