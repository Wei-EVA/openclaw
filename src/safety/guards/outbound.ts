import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChildSafetyConfig } from "../config.js";
import { recordSafetyEvent } from "../events.js";
import { sampleContent } from "../normalize.js";
import { resolveRiskLevel } from "../risk.js";
import { scanTextRules } from "../rules/text-rules.js";
import { scanUrlRules } from "../rules/url-rules.js";

export async function runOutboundSafetyShadow(params: {
  config: OpenClawConfig;
  text: string;
  urls?: string[];
  channel?: string;
  accountId?: string;
  sessionKey?: string;
  agentId?: string;
  to?: string;
  stage?: string;
}): Promise<void> {
  const childSafety = resolveChildSafetyConfig(params.config);
  if (!childSafety.enabled) {
    return;
  }
  const findings = [
    ...scanTextRules({ text: params.text, config: childSafety }),
    ...scanUrlRules({ text: params.text, urls: params.urls, config: childSafety }),
  ];
  if (findings.length === 0 && !childSafety.logPassEvents) {
    return;
  }
  const combined = [params.text, ...(params.urls ?? [])].join("\n");
  await recordSafetyEvent({
    direction: "outbound",
    action: findings.length > 0 ? "shadow_flag" : "pass",
    mode: childSafety.mode,
    riskLevel: findings.length > 0 ? resolveRiskLevel(findings) : "low",
    score: findings.reduce((acc, finding) => Math.max(acc, finding.score), 0),
    findings,
    channel: params.channel,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    to: params.to,
    stage: params.stage,
    contentHash: crypto.createHash("sha256").update(combined).digest("hex"),
    contentSample: sampleContent(combined),
  });
}
