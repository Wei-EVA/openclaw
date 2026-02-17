// Copyright (c) 2024-2026 Tianwei Zhou. All rights reserved.
// Licensed under AGPL-3.0. See LICENSE for details.

import { describe, expect, it, vi } from "vitest";

// Mock loadConfig to return per-channel-peer dmScope
const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    session: { dmScope: "per-channel-peer" as const },
    channels: { telegram: {} },
  })),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig };
});

// Mock loadSessionStore to control the session store contents
const { loadSessionStore } = vi.hoisted(() => ({
  loadSessionStore: vi.fn(() => ({})),
}));

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore,
    resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
  };
});

import { buildTelegramMessageContext } from "./bot-message-context.js";

describe("buildTelegramMessageContext A2A routing fix", () => {
  const baseConfig = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
    session: { dmScope: "per-channel-peer" as const },
  } as never;

  const buildContext = async (message: Record<string, unknown>, cfg = baseConfig) =>
    await buildTelegramMessageContext({
      primaryCtx: {
        message,
        me: { id: 7, username: "bot" },
      } as never,
      allMedia: [],
      storeAllowFrom: [],
      options: {},
      bot: {
        api: {
          sendChatAction: vi.fn(),
          setMessageReaction: vi.fn(),
        },
      } as never,
      cfg,
      account: { accountId: "default" } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      ackReactionScope: "off",
      logger: { info: vi.fn() },
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

  it("redirects DM to main session when main session delivers to same peer", async () => {
    // Main session has delivery context pointing to telegram:8313945262
    loadSessionStore.mockReturnValue({
      "agent:main:main": {
        deliveryContext: { channel: "telegram", to: "8313945262" },
        updatedAt: Date.now(),
      },
    });

    loadConfig.mockReturnValue({
      session: { dmScope: "per-channel-peer" },
      channels: { telegram: {} },
    });

    const ctx = await buildContext({
      message_id: 1,
      chat: { id: 8313945262, type: "private" },
      date: 1700000000,
      text: "Disney",
      from: { id: 8313945262, first_name: "XiaoBao" },
    });

    expect(ctx).not.toBeNull();
    // Should route to main session (where A2A conversation lives),
    // NOT to agent:main:telegram:dm:8313945262
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });

  it("keeps per-peer session key when main session delivers to different peer", async () => {
    // Main session delivers to a DIFFERENT peer
    loadSessionStore.mockReturnValue({
      "agent:main:main": {
        deliveryContext: { channel: "telegram", to: "9999999999" },
        updatedAt: Date.now(),
      },
    });

    loadConfig.mockReturnValue({
      session: { dmScope: "per-channel-peer" },
      channels: { telegram: {} },
    });

    const ctx = await buildContext({
      message_id: 2,
      chat: { id: 8313945262, type: "private" },
      date: 1700000001,
      text: "hello",
      from: { id: 8313945262, first_name: "XiaoBao" },
    });

    expect(ctx).not.toBeNull();
    // Should use the per-peer session key since main session targets someone else
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:dm:8313945262");
  });

  it("keeps per-peer session key when main session has no delivery context", async () => {
    // Main session has no delivery context
    loadSessionStore.mockReturnValue({});

    loadConfig.mockReturnValue({
      session: { dmScope: "per-channel-peer" },
      channels: { telegram: {} },
    });

    const ctx = await buildContext({
      message_id: 3,
      chat: { id: 8313945262, type: "private" },
      date: 1700000002,
      text: "table",
      from: { id: 8313945262, first_name: "XiaoBao" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:dm:8313945262");
  });

  it("keeps per-peer session key when main session delivers on different channel", async () => {
    // Main session delivers on WhatsApp, not Telegram
    loadSessionStore.mockReturnValue({
      "agent:main:main": {
        deliveryContext: { channel: "whatsapp", to: "8313945262@s.whatsapp.net" },
        updatedAt: Date.now(),
      },
    });

    loadConfig.mockReturnValue({
      session: { dmScope: "per-channel-peer" },
      channels: { telegram: {} },
    });

    const ctx = await buildContext({
      message_id: 4,
      chat: { id: 8313945262, type: "private" },
      date: 1700000003,
      text: "hello",
      from: { id: 8313945262, first_name: "XiaoBao" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:dm:8313945262");
  });

  it("does not redirect group messages even with matching delivery context", async () => {
    loadSessionStore.mockReturnValue({
      "agent:main:main": {
        deliveryContext: { channel: "telegram", to: "-1001234567890" },
        updatedAt: Date.now(),
      },
    });

    loadConfig.mockReturnValue({
      session: { dmScope: "per-channel-peer" },
      channels: { telegram: {} },
    });

    const ctx = await buildContext(
      {
        message_id: 5,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        date: 1700000004,
        text: "@bot hello",
        from: { id: 42, first_name: "Alice" },
      },
      {
        ...baseConfig,
        // Force mention to be recognized for group messages
      } as never,
    );

    // Group messages should never be redirected
    if (ctx) {
      expect(ctx.ctxPayload?.SessionKey).not.toBe("agent:main:main");
    }
  });
});
