import type { SafetyFinding, SafetyRiskLevel } from "./types.js";

export function resolveRiskLevel(findings: SafetyFinding[]): SafetyRiskLevel {
  const max = findings.reduce((acc, finding) => Math.max(acc, finding.score), 0);
  if (max >= 0.9) {
    return "high";
  }
  if (max >= 0.7) {
    return "medium";
  }
  return "low";
}
