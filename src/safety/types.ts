export const CHILD_SAFETY_MODES = ["shadow", "advisory", "active"] as const;

export type ChildSafetyMode = (typeof CHILD_SAFETY_MODES)[number];

export type ChildSafetyRiskThresholds = {
  blockAbove?: number;
  rewriteAbove?: number;
  escalateAbove?: number;
};

export type ChildSafetyResolvedConfig = {
  enabled: boolean;
  mode: ChildSafetyMode;
  ageBand?: string;
  riskThresholds: Required<ChildSafetyRiskThresholds>;
  allowedDomains: string[];
  blockedCategories: string[];
  logPassEvents: boolean;
};

export type SafetyDirection = "inbound" | "outbound" | "tool";

export type SafetyAction = "pass" | "shadow_flag";

export type SafetyRiskLevel = "low" | "medium" | "high";

export type SafetyCategory =
  | "adult_content"
  | "violence"
  | "self_harm"
  | "pii"
  | "prompt_injection"
  | "external_domain";

export type SafetyDetectionLayer = "L1_pattern" | "L1_url";

export type SafetyFinding = {
  category: SafetyCategory;
  score: number;
  layer: SafetyDetectionLayer;
  signal: string;
};

export type SafetyEvent = {
  id: string;
  ts: number;
  seq: number;
  direction: SafetyDirection;
  action: SafetyAction;
  mode: ChildSafetyMode;
  riskLevel: SafetyRiskLevel;
  score: number;
  findings: SafetyFinding[];
  channel?: string;
  accountId?: string;
  sessionKey?: string;
  agentId?: string;
  to?: string;
  stage?: string;
  toolName?: string;
  contentHash?: string;
  contentSample?: string;
};

export type SafetyEventInput = Omit<SafetyEvent, "id" | "ts" | "seq">;
