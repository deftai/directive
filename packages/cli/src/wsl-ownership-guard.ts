/**
 * Shared live WSL ownership gate for protected mutating CLI entry points (#1617).
 * Independent of ritual/doctor cache. ownership:doctor/fix are not gated here.
 */
import { assertProtectedMutationOwnership } from "@deftai/directive-core/platform";

export function refuseIfWslOwnershipBlocked(
  projectRoot: string,
  writeErr: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): number | null {
  const gate = assertProtectedMutationOwnership({ projectRoot });
  if (gate.ok) return null;
  writeErr(`${gate.message}\n`);
  return gate.exitCode;
}
