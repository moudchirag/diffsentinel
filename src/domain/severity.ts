export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type RiskLevel = Severity;

export const FINDING_CATEGORIES = [
  "bug",
  "security",
  "performance",
  "reliability",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** Deterministic overall risk: highest severity present, else "low". */
export function calculateOverallRisk(findings: ReadonlyArray<{ severity: Severity }>): RiskLevel {
  for (const level of SEVERITIES) {
    if (findings.some((f) => f.severity === level)) return level;
  }
  return "low";
}
