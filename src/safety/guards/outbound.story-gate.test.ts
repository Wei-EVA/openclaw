import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { recordSafetyEvent } from "../events.js";
import { resetStoryGateCacheForTest, runOutboundStoryGate } from "./outbound.js";

vi.mock("../events.js", () => ({
  recordSafetyEvent: vi.fn(async () => {}),
}));

type MutableEnv = NodeJS.ProcessEnv & {
  OPENCLAW_STORY_POLICY_PATH?: string;
  OPENCLAW_STORY_PROGRESS_PATH?: string;
};

const LOCK_TEMPLATE =
  "Story mode is locked until today's learning tasks are complete. Next step: <next task>.";

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data), "utf8");
}

describe("runOutboundStoryGate", () => {
  const env = process.env as MutableEnv;
  const baseConfig = {} as OpenClawConfig;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "story-gate-"));
    vi.mocked(recordSafetyEvent).mockClear();
    resetStoryGateCacheForTest();
  });

  afterEach(async () => {
    resetStoryGateCacheForTest();
    delete env.OPENCLAW_STORY_POLICY_PATH;
    delete env.OPENCLAW_STORY_PROGRESS_PATH;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks LearnLM story output when allComplete is false", async () => {
    const policyPath = path.join(tempDir, "state-policy.json");
    const progressPath = path.join(tempDir, "midterm-card-progress.json");
    await writeJson(policyPath, { storyControl: { enabled: true } });
    await writeJson(progressPath, { today: { allComplete: false } });
    env.OPENCLAW_STORY_POLICY_PATH = policyPath;
    env.OPENCLAW_STORY_PROGRESS_PATH = progressPath;

    const result = await runOutboundStoryGate({
      config: baseConfig,
      text: "Episode 39: Bruno and Nova enter the room.",
      agentId: "learnlm",
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toBe(LOCK_TEMPLATE);
    expect(result.signals?.length).toBeGreaterThan(0);
    expect(vi.mocked(recordSafetyEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordSafetyEvent).mock.calls[0]?.[0]?.action).toBe("block");
  });

  it("allows story output when allComplete is true", async () => {
    const policyPath = path.join(tempDir, "state-policy.json");
    const progressPath = path.join(tempDir, "midterm-card-progress.json");
    await writeJson(policyPath, { storyControl: { enabled: true } });
    await writeJson(progressPath, { today: { allComplete: true } });
    env.OPENCLAW_STORY_POLICY_PATH = policyPath;
    env.OPENCLAW_STORY_PROGRESS_PATH = progressPath;

    const result = await runOutboundStoryGate({
      config: baseConfig,
      text: "Episode 39: Bruno and Nova enter the room.",
      agentId: "learnlm",
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain("Episode 39");
    expect(vi.mocked(recordSafetyEvent)).not.toHaveBeenCalled();
  });

  it("allows story output when parent override is active", async () => {
    const policyPath = path.join(tempDir, "state-policy.json");
    const progressPath = path.join(tempDir, "midterm-card-progress.json");
    await writeJson(policyPath, { storyControl: { enabled: true } });
    await writeJson(progressPath, {
      today: {
        allComplete: false,
        storyOverride: {
          allowed: true,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          approvedBy: "parent",
        },
      },
    });
    env.OPENCLAW_STORY_POLICY_PATH = policyPath;
    env.OPENCLAW_STORY_PROGRESS_PATH = progressPath;

    const result = await runOutboundStoryGate({
      config: baseConfig,
      text: "Bruno said he has a plan for Episode 39.",
      agentId: "learnlm",
    });

    expect(result.blocked).toBe(false);
    expect(vi.mocked(recordSafetyEvent)).not.toHaveBeenCalled();
  });

  it("blocks story output when parent override has expired", async () => {
    const policyPath = path.join(tempDir, "state-policy.json");
    const progressPath = path.join(tempDir, "midterm-card-progress.json");
    await writeJson(policyPath, { storyControl: { enabled: true } });
    await writeJson(progressPath, {
      today: {
        allComplete: false,
        storyOverride: {
          allowed: true,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          approvedBy: "parent",
        },
      },
    });
    env.OPENCLAW_STORY_POLICY_PATH = policyPath;
    env.OPENCLAW_STORY_PROGRESS_PATH = progressPath;

    const result = await runOutboundStoryGate({
      config: baseConfig,
      text: "Bruno said he has a plan for Episode 39.",
      agentId: "learnlm",
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toBe(LOCK_TEMPLATE);
    expect(vi.mocked(recordSafetyEvent)).toHaveBeenCalledTimes(1);
  });

  it("does not block non-story text even when locked", async () => {
    const policyPath = path.join(tempDir, "state-policy.json");
    const progressPath = path.join(tempDir, "midterm-card-progress.json");
    await writeJson(policyPath, { storyControl: { enabled: true } });
    await writeJson(progressPath, { today: { allComplete: false } });
    env.OPENCLAW_STORY_POLICY_PATH = policyPath;
    env.OPENCLAW_STORY_PROGRESS_PATH = progressPath;

    const result = await runOutboundStoryGate({
      config: baseConfig,
      text: "Let's continue maths: what is 45 + 70?",
      agentId: "learnlm",
    });

    expect(result.blocked).toBe(false);
    expect(vi.mocked(recordSafetyEvent)).not.toHaveBeenCalled();
  });

  it("does not apply to non-LearnLM agents", async () => {
    const policyPath = path.join(tempDir, "state-policy.json");
    const progressPath = path.join(tempDir, "midterm-card-progress.json");
    await writeJson(policyPath, { storyControl: { enabled: true } });
    await writeJson(progressPath, { today: { allComplete: false } });
    env.OPENCLAW_STORY_POLICY_PATH = policyPath;
    env.OPENCLAW_STORY_PROGRESS_PATH = progressPath;

    const result = await runOutboundStoryGate({
      config: baseConfig,
      text: "Episode 39 is waiting.",
      agentId: "main",
    });

    expect(result.blocked).toBe(false);
    expect(vi.mocked(recordSafetyEvent)).not.toHaveBeenCalled();
  });
});
