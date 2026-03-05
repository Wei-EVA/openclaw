import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChildSafetyConfig } from "../config.js";
import { recordSafetyEvent } from "../events.js";
import { sampleContent } from "../normalize.js";
import { resolveRiskLevel } from "../risk.js";
import { scanTextRules } from "../rules/text-rules.js";
import { scanUrlRules } from "../rules/url-rules.js";

const DEFAULT_STORY_POLICY_PATH = path.join(os.homedir(), "clawd", "config", "state-policy.json");
const DEFAULT_STORY_PROGRESS_PATH = path.join(
  os.homedir(),
  "clawd",
  "memory",
  "midterm-card-progress.json",
);
const STORY_LOCK_TEMPLATE =
  "Story mode is locked until today's learning tasks are complete. Next step: <next task>.";

const STORY_SIGNALS: Array<{ key: string; regex: RegExp; score: number }> = [
  { key: "episode", regex: /\bepisode\s*\d+\b/i, score: 1.0 },
  { key: "bruno", regex: /\bbruno\b/i, score: 0.98 },
  { key: "nova", regex: /\bnova\b/i, score: 0.95 },
  { key: "jake", regex: /\bjake\b/i, score: 0.85 },
  { key: "roleplay", regex: /\brole\s*-?\s*play\b/i, score: 0.8 },
  { key: "happens_next", regex: /\bwhat\s+happens\s+next\b/i, score: 0.9 },
];

type StoryLockDecision = {
  text: string;
  blocked: boolean;
  reason?: "all_complete_not_met";
  signals?: string[];
};

type StoryControlSnapshot = {
  enabled: boolean;
};

type StoryOverride = {
  allowed: boolean;
  expiresAtMs?: number;
};

let policyCache: { path?: string; mtimeMs?: number; data?: StoryControlSnapshot } = {};
let progressCache: {
  path?: string;
  mtimeMs?: number;
  allComplete?: boolean;
  override?: StoryOverride;
} = {};

function resolveStoryPolicyPath(): string {
  const env = process.env.OPENCLAW_STORY_POLICY_PATH?.trim();
  return env || DEFAULT_STORY_POLICY_PATH;
}

function resolveStoryProgressPath(): string {
  const env = process.env.OPENCLAW_STORY_PROGRESS_PATH?.trim();
  return env || DEFAULT_STORY_PROGRESS_PATH;
}

function looksLikeStoryLockTemplate(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("story mode is locked until") ||
    lower.includes("today story is done") ||
    lower.includes("today story is over")
  );
}

function parseOverride(value: unknown): StoryOverride {
  if (!value || typeof value !== "object") {
    return { allowed: false };
  }
  const raw = value as Record<string, unknown>;
  if (raw.allowed !== true) {
    return { allowed: false };
  }

  const expiresRaw = raw.expiresAt;
  if (typeof expiresRaw === "number" && Number.isFinite(expiresRaw)) {
    const ms = expiresRaw > 1e12 ? expiresRaw : expiresRaw * 1000;
    return { allowed: Date.now() <= ms, expiresAtMs: ms };
  }
  if (typeof expiresRaw === "string" && expiresRaw.trim()) {
    const parsed = Date.parse(expiresRaw);
    if (Number.isFinite(parsed)) {
      return { allowed: Date.now() <= parsed, expiresAtMs: parsed };
    }
    return { allowed: false };
  }
  return { allowed: true };
}

async function readStoryPolicySnapshot(filePath: string): Promise<StoryControlSnapshot> {
  try {
    const stat = await fs.stat(filePath);
    if (policyCache.path === filePath && policyCache.mtimeMs === stat.mtimeMs && policyCache.data) {
      return policyCache.data;
    }
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const storyControl =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).storyControl
        : undefined;
    const enabled = !!(
      storyControl &&
      typeof storyControl === "object" &&
      (storyControl as Record<string, unknown>).enabled === true
    );
    const snapshot = { enabled };
    policyCache = { path: filePath, mtimeMs: stat.mtimeMs, data: snapshot };
    return snapshot;
  } catch {
    return { enabled: false };
  }
}

async function readStoryProgressSnapshot(filePath: string): Promise<{
  allComplete: boolean;
  override: StoryOverride;
}> {
  try {
    const stat = await fs.stat(filePath);
    if (
      progressCache.path === filePath &&
      progressCache.mtimeMs === stat.mtimeMs &&
      typeof progressCache.allComplete === "boolean" &&
      progressCache.override
    ) {
      return { allComplete: progressCache.allComplete, override: progressCache.override };
    }
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const today =
      root.today && typeof root.today === "object"
        ? (root.today as Record<string, unknown>)
        : undefined;

    const allComplete = today?.allComplete === true;
    const override = parseOverride(today?.storyOverride ?? root.storyOverride);

    progressCache = {
      path: filePath,
      mtimeMs: stat.mtimeMs,
      allComplete,
      override,
    };
    return { allComplete, override };
  } catch {
    // Fail closed for story unlock checks.
    return { allComplete: false, override: { allowed: false } };
  }
}

function collectStorySignals(text: string): Array<{ signal: string; score: number }> {
  const hits: Array<{ signal: string; score: number }> = [];
  for (const rule of STORY_SIGNALS) {
    if (rule.regex.test(text)) {
      hits.push({ signal: rule.key, score: rule.score });
    }
  }
  return hits;
}

export async function runOutboundStoryGate(params: {
  config: OpenClawConfig;
  text: string;
  channel?: string;
  accountId?: string;
  sessionKey?: string;
  agentId?: string;
  to?: string;
  stage?: string;
}): Promise<StoryLockDecision> {
  const agentId = params.agentId?.trim().toLowerCase();
  if (agentId !== "learnlm") {
    return { text: params.text, blocked: false };
  }

  const policyPath = resolveStoryPolicyPath();
  const policy = await readStoryPolicySnapshot(policyPath);
  if (!policy.enabled) {
    return { text: params.text, blocked: false };
  }

  if (looksLikeStoryLockTemplate(params.text)) {
    return { text: params.text, blocked: false };
  }

  const signalHits = collectStorySignals(params.text);
  if (signalHits.length === 0) {
    return { text: params.text, blocked: false };
  }

  const progressPath = resolveStoryProgressPath();
  const { allComplete, override } = await readStoryProgressSnapshot(progressPath);
  if (allComplete || override.allowed) {
    return { text: params.text, blocked: false };
  }

  const childSafety = resolveChildSafetyConfig(params.config);
  const score = signalHits.reduce((max, hit) => Math.max(max, hit.score), 0.9);
  const findings = signalHits.map((hit) => ({
    category: "story_lock" as const,
    score: hit.score,
    layer: "L1_pattern" as const,
    signal: `story-${hit.signal}`,
  }));
  const combined = params.text;
  await recordSafetyEvent({
    direction: "outbound",
    action: "block",
    mode: childSafety.mode,
    riskLevel: "high",
    score,
    findings,
    channel: params.channel,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    to: params.to,
    stage: params.stage ? `${params.stage}:story_gate` : "story_gate",
    contentHash: crypto.createHash("sha256").update(combined).digest("hex"),
    contentSample: sampleContent(combined),
  });

  return {
    text: STORY_LOCK_TEMPLATE,
    blocked: true,
    reason: "all_complete_not_met",
    signals: signalHits.map((hit) => hit.signal),
  };
}

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

export function resetStoryGateCacheForTest(): void {
  policyCache = {};
  progressCache = {};
}
