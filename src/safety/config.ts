import type { OpenClawConfig } from "../config/config.js";
import {
  CHILD_SAFETY_MODES,
  type ChildSafetyMode,
  type ChildSafetyResolvedConfig,
  type SafetyCategory,
} from "./types.js";

const DEFAULT_THRESHOLDS = {
  blockAbove: 0.9,
  rewriteAbove: 0.5,
  escalateAbove: 0.7,
} as const;

const DEFAULT_BLOCKED_CATEGORIES: SafetyCategory[] = [
  "adult_content",
  "violence",
  "self_harm",
  "pii",
  "prompt_injection",
  "external_domain",
];

function normalizeMode(value: unknown): ChildSafetyMode {
  if (typeof value !== "string") {
    return "shadow";
  }
  const normalized = value.trim().toLowerCase();
  return CHILD_SAFETY_MODES.includes(normalized as ChildSafetyMode)
    ? (normalized as ChildSafetyMode)
    : "shadow";
}

function normalizeCategoryList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const list = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(list)];
}

function clampThreshold(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

export function resolveChildSafetyConfig(config?: OpenClawConfig): ChildSafetyResolvedConfig {
  const raw = config?.childSafety;
  const blockedCategories = normalizeCategoryList(raw?.blockedCategories);
  return {
    enabled: raw?.enabled === true,
    mode: normalizeMode(raw?.mode),
    ageBand: typeof raw?.ageBand === "string" ? raw.ageBand.trim() || undefined : undefined,
    riskThresholds: {
      blockAbove: clampThreshold(raw?.riskThresholds?.blockAbove, DEFAULT_THRESHOLDS.blockAbove),
      rewriteAbove: clampThreshold(
        raw?.riskThresholds?.rewriteAbove,
        DEFAULT_THRESHOLDS.rewriteAbove,
      ),
      escalateAbove: clampThreshold(
        raw?.riskThresholds?.escalateAbove,
        DEFAULT_THRESHOLDS.escalateAbove,
      ),
    },
    allowedDomains: normalizeCategoryList(raw?.allowedDomains),
    blockedCategories:
      blockedCategories.length > 0 ? blockedCategories : [...DEFAULT_BLOCKED_CATEGORIES],
    logPassEvents: raw?.logPassEvents === true,
  };
}
