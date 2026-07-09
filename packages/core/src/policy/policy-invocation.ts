/** User-facing colon-form policy verb for consumer `deft` disclosures (#2367). */
export function policyColonInvocation(subcommand: string, trailing = ""): string {
  return `deft policy:${subcommand}${trailing}`;
}

/** User-facing `deft policy set <cmd>` form for policy-set disclosures (#2367). */
export function policySetInvocation(subcommand: string, trailing = ""): string {
  return `deft policy set ${subcommand}${trailing}`;
}
