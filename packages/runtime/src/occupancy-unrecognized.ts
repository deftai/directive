/** Occupancy-namespace parse: unknown flags name the help surface (#4411). */
export function occupancyUnrecognizedArgument(arg: string | undefined): string {
  return `unrecognized argument: ${arg}. See \`deft help\` or \`deft commands\`.`;
}
