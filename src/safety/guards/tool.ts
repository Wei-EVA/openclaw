import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChildSafetyConfig } from "../config.js";
import { recordSafetyEvent } from "../events.js";
import { sampleContent } from "../normalize.js";
import { resolveRiskLevel } from "../risk.js";
import { scanTextRules } from "../rules/text-rules.js";
import { scanUrlRules } from "../rules/url-rules.js";

export async function runToolSafetyShadow(params: {
  config: OpenClawConfig;
  toolName: string;
  stage: string;
  text?: string;
  urls?: string[];
  channel?: string;
  sessionKey?: string;
  agentId?: string;
}): Promise<void> {
  const childSafety = resolveChildSafetyConfig(params.config);
  if (!childSafety.enabled) {
    return;
  }

  const text = params.text ?? "";
  const findings = [
    ...scanTextRules({ text, config: childSafety }),
    ...scanUrlRules({ text, urls: params.urls, config: childSafety }),
  ];
  if (findings.length === 0 && !childSafety.logPassEvents) {
    return;
  }

  const combined = [text, ...(params.urls ?? [])].join("\n");
  await recordSafetyEvent({
    direction: "tool",
    action: findings.length > 0 ? "shadow_flag" : "pass",
    mode: childSafety.mode,
    riskLevel: findings.length > 0 ? resolveRiskLevel(findings) : "low",
    score: findings.reduce((acc, finding) => Math.max(acc, finding.score), 0),
    findings,
    channel: params.channel,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    stage: params.stage,
    toolName: params.toolName,
    contentHash: crypto.createHash("sha256").update(combined).digest("hex"),
    contentSample: sampleContent(combined),
  });
}
