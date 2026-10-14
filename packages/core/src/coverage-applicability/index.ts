export {
  type ClassifiedChange,
  type CoverageApplicabilityDeps,
  type CoverageApplicabilityResult,
  classifyChangedPath,
  decodeGitQuotedPath,
  type EvaluateCoverageApplicabilityInput,
  evaluateCoverageApplicability,
  isCoverageHeadroomNotApplicable,
  isProjectDefinitionRegistryRefreshOnly,
  type NameStatusRow,
  type PathClassification,
  parseNameStatus,
} from "./evaluate.js";
