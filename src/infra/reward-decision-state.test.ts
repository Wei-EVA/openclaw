import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractRewardDecisionMessage,
  persistRewardDecisionState,
  readRewardDecisionState,
} from "./reward-decision-state.js";

type MutableEnv = NodeJS.ProcessEnv & {
  OPENCLAW_REWARD_DECISION_STATE_PATH?: string;
};

describe("reward decision state", () => {
  const env = process.env as MutableEnv;
  let tempDir = "";
  let statePath = "";
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "reward-decision-state-"));
    statePath = path.join(tempDir, "reward-decision-state.json");
    originalPath = env.OPENCLAW_REWARD_DECISION_STATE_PATH;
    env.OPENCLAW_REWARD_DECISION_STATE_PATH = statePath;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T11:55:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (originalPath == null) {
      delete env.OPENCLAW_REWARD_DECISION_STATE_PATH;
    } else {
      env.OPENCLAW_REWARD_DECISION_STATE_PATH = originalPath;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("extracts structured reward decisions and summary text", () => {
    expect(
      extractRewardDecisionMessage("【Aoife - REWARD_DECISION: DENIED】\n\nNeed more maths first."),
    ).toEqual({
      status: "denied",
      header: "【Aoife - REWARD_DECISION: DENIED】",
      summary: "Need more maths first.",
    });

    expect(
      extractRewardDecisionMessage("【 REWARD_DECISION:  APPROVED 】  Story is approved."),
    ).toEqual({
      status: "approved",
      header: "【 REWARD_DECISION:  APPROVED 】",
      summary: "Story is approved.",
    });
  });

  it("rejects malformed reward decisions", () => {
    expect(extractRewardDecisionMessage("REWARD_DECISION: APPROVED")).toBeNull();
    expect(extractRewardDecisionMessage("【REWARD_DECISION: MAYBE】")).toBeNull();
    expect(
      extractRewardDecisionMessage("【multi\nline - REWARD_DECISION: DENIED】\nNot accepted."),
    ).toBeNull();
  });

  it("persists and reads the current day's decision", async () => {
    const record = await persistRewardDecisionState({
      message: "【REWARD_DECISION: APPROVED】\n\nStory is approved.",
      requesterSessionKey: "agent:main:parent",
      targetSessionKey: "agent:learnlm:main",
      targetDisplayKey: "learnlm",
    });

    expect(record).toMatchObject({
      date: "2026-03-14",
      status: "approved",
      requesterSessionKey: "agent:main:parent",
      targetSessionKey: "agent:learnlm:main",
      summary: "Story is approved.",
    });

    const stored = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      today?: { status?: string };
      lastDecision?: { status?: string };
    };
    expect(stored.today?.status).toBe("approved");
    expect(stored.lastDecision?.status).toBe("approved");

    await persistRewardDecisionState({
      message: "【REWARD_DECISION: DENIED】\n\nNeed more vocabulary first.",
      targetSessionKey: "agent:learnlm:main",
    });

    await expect(readRewardDecisionState()).resolves.toMatchObject({
      date: "2026-03-14",
      status: "denied",
      summary: "Need more vocabulary first.",
    });
  });

  it("does not write a file for non-structured messages", async () => {
    await expect(
      persistRewardDecisionState({
        message: "Please keep going for now.",
        targetSessionKey: "agent:learnlm:main",
      }),
    ).resolves.toBeNull();

    await expect(fs.access(statePath)).rejects.toThrow();
    await expect(readRewardDecisionState()).resolves.toBeNull();
  });

  it("ignores stale decisions from a previous day", async () => {
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          today: {
            date: "2026-03-13",
            status: "approved",
            updatedAt: "2026-03-13T20:00:00.000Z",
            header: "【REWARD_DECISION: APPROVED】",
            message: "【REWARD_DECISION: APPROVED】\n\nYesterday only.",
            summary: "Yesterday only.",
          },
          lastDecision: {
            date: "2026-03-13",
            status: "approved",
            updatedAt: "2026-03-13T20:00:00.000Z",
            header: "【REWARD_DECISION: APPROVED】",
            message: "【REWARD_DECISION: APPROVED】\n\nYesterday only.",
            summary: "Yesterday only.",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(readRewardDecisionState()).resolves.toBeNull();
  });
});
