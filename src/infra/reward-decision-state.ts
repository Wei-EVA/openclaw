import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("infra/reward-decision-state");

const DEFAULT_REWARD_DECISION_STATE_PATH = path.join(
  os.homedir(),
  "clawd",
  "memory",
  "learning",
  "reward-decision-state.json",
);

const REWARD_DECISION_HEADER_RE =
  /【\s*(?:[^\n】]*?-\s*)?REWARD_DECISION\s*:\s*(APPROVED|DENIED)\s*】/i;

export type RewardDecisionStatus = "approved" | "denied";

export type RewardDecisionRecord = {
  date: string;
  status: RewardDecisionStatus;
  updatedAt: string;
  source: "sessions_send";
  header: string;
  message: string;
  summary: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  targetSessionKey?: string;
  targetDisplayKey?: string;
};

type RewardDecisionState = {
  _meta?: {
    version: string;
  };
  today?: RewardDecisionRecord;
  lastDecision?: RewardDecisionRecord;
};

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isRewardDecisionStatus(value: unknown): value is RewardDecisionStatus {
  return value === "approved" || value === "denied";
}

function parseRecord(value: unknown, today: string): RewardDecisionRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  const statusRaw = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
  if (date !== today || !isRewardDecisionStatus(statusRaw)) {
    return null;
  }
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt.trim() : "";
  const header = typeof raw.header === "string" ? raw.header : "";
  const message = typeof raw.message === "string" ? raw.message : "";
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  if (!updatedAt || !header || !message) {
    return null;
  }
  return {
    date,
    status: statusRaw,
    updatedAt,
    source: "sessions_send",
    header,
    message,
    summary,
    requesterSessionKey:
      typeof raw.requesterSessionKey === "string" ? raw.requesterSessionKey : undefined,
    requesterChannel:
      typeof raw.requesterChannel === "string"
        ? (raw.requesterChannel as GatewayMessageChannel)
        : undefined,
    targetSessionKey: typeof raw.targetSessionKey === "string" ? raw.targetSessionKey : undefined,
    targetDisplayKey: typeof raw.targetDisplayKey === "string" ? raw.targetDisplayKey : undefined,
  };
}

async function readStateFile(filePath: string): Promise<RewardDecisionState> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as RewardDecisionState) : {};
  } catch {
    return {};
  }
}

export function resolveRewardDecisionStatePath(): string {
  const env = process.env.OPENCLAW_REWARD_DECISION_STATE_PATH?.trim();
  return env || DEFAULT_REWARD_DECISION_STATE_PATH;
}

export function extractRewardDecisionMessage(message: string): {
  status: RewardDecisionStatus;
  header: string;
  summary: string;
} | null {
  const match = REWARD_DECISION_HEADER_RE.exec(message);
  if (!match) {
    return null;
  }
  const status = match[1]?.toLowerCase();
  if (!isRewardDecisionStatus(status)) {
    return null;
  }
  const header = match[0].trim();
  const summary = message.slice((match.index ?? 0) + match[0].length).trim();
  return { status, header, summary };
}

export async function persistRewardDecisionState(params: {
  message: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  targetSessionKey?: string;
  targetDisplayKey?: string;
}): Promise<RewardDecisionRecord | null> {
  const parsed = extractRewardDecisionMessage(params.message);
  if (!parsed) {
    return null;
  }

  const filePath = resolveRewardDecisionStatePath();
  const now = new Date();
  const record: RewardDecisionRecord = {
    date: formatLocalDate(now),
    status: parsed.status,
    updatedAt: now.toISOString(),
    source: "sessions_send",
    header: parsed.header,
    message: params.message,
    summary: parsed.summary,
    requesterSessionKey: params.requesterSessionKey,
    requesterChannel: params.requesterChannel,
    targetSessionKey: params.targetSessionKey,
    targetDisplayKey: params.targetDisplayKey,
  };

  try {
    const state = await readStateFile(filePath);
    const nextState: RewardDecisionState = {
      ...state,
      _meta: {
        version: "reward-decision-state-v1",
      },
      today: record,
      lastDecision: record,
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    await fs.rename(`${filePath}.tmp`, filePath);
    return record;
  } catch (error) {
    log.warn("failed to persist reward decision state", {
      filePath,
      status: record.status,
      targetSessionKey: params.targetSessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function readRewardDecisionState(filePath = resolveRewardDecisionStatePath()) {
  const state = await readStateFile(filePath);
  const today = formatLocalDate(new Date());
  return parseRecord(state.today, today) ?? parseRecord(state.lastDecision, today);
}
