import type { ChildSafetyResolvedConfig, SafetyCategory, SafetyFinding } from "../types.js";
import { normalizeText } from "../normalize.js";

type Rule = {
  category: SafetyCategory;
  score: number;
  layer: "L1_pattern";
  signal: string;
  test: (normalized: ReturnType<typeof normalizeText>) => boolean;
};

const RULES: Rule[] = [
  {
    category: "adult_content",
    score: 0.95,
    layer: "L1_pattern",
    signal: "adult-keyword",
    test: (n) =>
      /\b(porn|nsfw|nude|naked|blowjob|handjob|boob|penis|vagina|masturbat(?:e|ion|ing)?|sex(?:\s+chat)?)\b/.test(
        n.collapsed,
      ) || /\bsex\b/.test(n.leet),
  },
  {
    category: "violence",
    score: 0.85,
    layer: "L1_pattern",
    signal: "violence-keyword",
    test: (n) => /\b(kill|murder|stab|shoot|bomb|behead|attack)\b/.test(n.collapsed),
  },
  {
    category: "self_harm",
    score: 0.98,
    layer: "L1_pattern",
    signal: "self-harm-keyword",
    test: (n) =>
      /\b(kill myself|end my life|self[-\s]+harm|cut myself|suicide)\b/.test(n.collapsed),
  },
  {
    category: "pii",
    score: 0.7,
    layer: "L1_pattern",
    signal: "pii-request",
    test: (n) =>
      /(what is your (name|address|phone|school)|tell me your (address|phone|school)|share your (phone|address|school))/.test(
        n.collapsed,
      ),
  },
  {
    category: "prompt_injection",
    score: 0.75,
    layer: "L1_pattern",
    signal: "prompt-injection",
    test: (n) =>
      /(ignore (all|previous|prior) instructions|reveal (your|the) system prompt|developer message|jailbreak|bypass safety)/.test(
        n.collapsed,
      ),
  },
];

export function scanTextRules(params: {
  text: string;
  config: ChildSafetyResolvedConfig;
}): SafetyFinding[] {
  const normalized = normalizeText(params.text);
  if (!normalized.collapsed) {
    return [];
  }
  const findings: SafetyFinding[] = [];
  for (const rule of RULES) {
    if (!params.config.blockedCategories.includes(rule.category)) {
      continue;
    }
    if (rule.test(normalized)) {
      findings.push({
        category: rule.category,
        score: rule.score,
        layer: rule.layer,
        signal: rule.signal,
      });
    }
  }
  return findings;
}
