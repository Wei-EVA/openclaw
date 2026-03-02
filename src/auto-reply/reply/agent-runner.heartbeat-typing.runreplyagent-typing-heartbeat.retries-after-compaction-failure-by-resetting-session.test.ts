import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import * as sessions from "../../config/sessions.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
  }),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

function createMinimalRun(params?: {
  opts?: GetReplyOptions;
  resolvedVerboseLevel?: "off" | "on";
  sessionStore?: Record<string, SessionEntry>;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  typingMode?: TypingMode;
  blockStreamingEnabled?: boolean;
}) {
  const typing = createMockTypingController();
  const opts = params?.opts;
  const sessionCtx = {
    Provider: "whatsapp",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionKey = params?.sessionKey ?? "main";
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: params?.resolvedVerboseLevel ?? "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;

  return {
    typing,
    opts,
    run: () =>
      runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        isStreaming: false,
        opts,
        typing,
        sessionEntry: params?.sessionEntry,
        sessionStore: params?.sessionStore,
        sessionKey,
        storePath: params?.storePath,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-5",
        resolvedVerboseLevel: params?.resolvedVerboseLevel ?? "off",
        isNewSession: false,
        blockStreamingEnabled: params?.blockStreamingEnabled ?? false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: params?.typingMode ?? "instant",
      }),
  };
}

describe("runReplyAgent typing (heartbeat)", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
  });

  it("retries after compaction failure by resetting the session", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-session-compaction-reset-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      const sessionEntry = { sessionId, updatedAt: Date.now(), sessionFile: transcriptPath };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({ type: "session", id: sessionId, version: 1 }),
          JSON.stringify({
            type: "message",
            message: {
              role: "user",
              content: [
                { type: "text", text: "We already completed Starlight and maths homework." },
              ],
            },
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Great, let's continue with vocabulary and Gaeilge." },
              ],
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
        throw new Error(
          'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        );
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({
        text: expect.stringContaining("Context limit exceeded during compaction"),
      });
      expect(payload.text?.toLowerCase()).toContain("reset");
      expect(sessionStore.main.sessionId).not.toBe(sessionId);
      expect(sessionStore.main.compactionRecoveryNote).toContain("Compaction recovery checkpoint");
      expect(sessionStore.main.compactionRecoveryApplied).toBe(false);

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
      expect(typeof persisted.main.compactionRecoveryNote).toBe("string");
    } finally {
      if (prevStateDir) {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("retries after context overflow payload by resetting the session", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-session-overflow-reset-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      const sessionEntry = { sessionId, updatedAt: Date.now(), sessionFile: transcriptPath };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
        payloads: [{ text: "Context overflow: prompt too large", isError: true }],
        meta: {
          durationMs: 1,
          error: {
            kind: "context_overflow",
            message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
          },
        },
      }));

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({
        text: expect.stringContaining("Context limit exceeded"),
      });
      expect(payload.text?.toLowerCase()).toContain("reset");
      expect(sessionStore.main.sessionId).not.toBe(sessionId);

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
    } finally {
      if (prevStateDir) {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("resets the session after role ordering payloads", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-session-role-ordering-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      const sessionEntry = { sessionId, updatedAt: Date.now(), sessionFile: transcriptPath };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
        payloads: [{ text: "Message ordering conflict - please try again.", isError: true }],
        meta: {
          durationMs: 1,
          error: {
            kind: "role_ordering",
            message: 'messages: roles must alternate between "user" and "assistant"',
          },
        },
      }));

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({
        text: expect.stringContaining("Message ordering conflict"),
      });
      expect(payload.text?.toLowerCase()).toContain("reset");
      expect(sessionStore.main.sessionId).not.toBe(sessionId);
      await expect(fs.access(transcriptPath)).rejects.toBeDefined();

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
    } finally {
      if (prevStateDir) {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("captures a one-shot recovery checkpoint after successful auto-compaction", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(
      path.join(tmpdir(), "openclaw-session-compaction-checkpoint-"),
    );
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      const sessionEntry = { sessionId, updatedAt: Date.now(), sessionFile: transcriptPath };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({ type: "session", id: sessionId, version: 1 }),
          JSON.stringify({
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "We already completed homework and vocabulary." }],
            },
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Great, next is L4/L5 maths and reading." }],
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      runEmbeddedPiAgentMock.mockImplementationOnce(async (params: unknown) => {
        const runParams = params as {
          onAgentEvent?: (evt: {
            stream: string;
            data: { phase?: string; willRetry?: boolean };
          }) => void;
        };
        runParams.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry: false },
        });
        return {
          payloads: [{ text: "ok" }],
          meta: { durationMs: 1 },
        };
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload?.text).toContain("ok");
      expect(sessionStore.main.compactionRecoveryNote).toContain("Compaction recovery checkpoint");
      expect(sessionStore.main.compactionRecoveryApplied).toBe(false);
      expect(sessionStore.main.compactionRecoverySourceSessionId).toBe(sessionId);

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(typeof persisted.main.compactionRecoveryNote).toBe("string");
      expect(persisted.main.compactionRecoveryApplied).toBe(false);
    } finally {
      if (prevStateDir) {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
});
