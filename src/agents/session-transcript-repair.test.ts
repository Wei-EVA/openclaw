import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairing,
  stripErroredAssistantTurns,
} from "./session-transcript-repair.js";

describe("sanitizeToolUseResultPairing", () => {
  it("moves tool results directly after tool calls and inserts missing results", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "toolCall", id: "call_2", name: "exec", arguments: {} },
        ],
      },
      { role: "user", content: "user message that should come after tool use" },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "exec",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("toolResult");
    expect((out[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(out[2]?.role).toBe("toolResult");
    expect((out[2] as { toolCallId?: string }).toolCallId).toBe("call_2");
    expect(out[3]?.role).toBe("user");
  });

  it("drops duplicate tool results for the same id within a span", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second" }],
        isError: false,
      },
      { role: "user", content: "ok" },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  it("drops duplicate tool results for the same id across the transcript", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second (duplicate)" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    const results = out.filter((m) => m.role === "toolResult") as Array<{
      toolCallId?: string;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]?.toolCallId).toBe("call_1");
  });

  it("drops orphan tool results that do not match any tool call", () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "read",
        content: [{ type: "text", text: "orphan" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("stripErroredAssistantTurns", () => {
  it("strips errored assistant and its tool results", () => {
    const input: AgentMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolCall", id: "call_err", name: "read", arguments: {} }],
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_err",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
      },
      { role: "user", content: "retry" },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    ];

    const out = stripErroredAssistantTurns(input);
    expect(out.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
  });

  it("strips aborted assistant and its tool results", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "toolCall", id: "call_ab", name: "exec", arguments: {} }],
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_ab",
        toolName: "exec",
        content: [{ type: "text", text: "partial" }],
        isError: true,
      },
      { role: "user", content: "next" },
    ];

    const out = stripErroredAssistantTurns(input);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps normal assistant messages untouched", () => {
    const input: AgentMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_ok", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_ok",
        toolName: "read",
        content: [{ type: "text", text: "data" }],
        isError: false,
      },
    ];

    const out = stripErroredAssistantTurns(input);
    expect(out).toBe(input); // same reference = no changes
  });

  it("strips errored assistant with no tool calls (text only)", () => {
    const input: AgentMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "text", text: "oops" }],
        errorMessage: "rate limit",
      } as AgentMessage,
      { role: "user", content: "retry" },
    ];

    const out = stripErroredAssistantTurns(input);
    expect(out.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("only strips tool results belonging to the errored assistant", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_good", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_good",
        toolName: "read",
        content: [{ type: "text", text: "good" }],
        isError: false,
      },
      { role: "user", content: "more" },
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolCall", id: "call_bad", name: "exec", arguments: {} }],
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_bad",
        toolName: "exec",
        content: [{ type: "text", text: "bad" }],
        isError: false,
      },
    ];

    const out = stripErroredAssistantTurns(input);
    expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
    expect((out[1] as { toolCallId?: string }).toolCallId).toBe("call_good");
  });
});

describe("sanitizeToolCallInputs", () => {
  it("drops tool calls missing input or arguments", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      },
      { role: "user", content: "hello" },
    ];

    const out = sanitizeToolCallInputs(input);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps valid tool calls and preserves text blocks", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "toolUse", id: "call_ok", name: "read", input: { path: "a" } },
          { type: "toolCall", id: "call_drop", name: "read" },
        ],
      },
    ];

    const out = sanitizeToolCallInputs(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const types = Array.isArray(assistant.content)
      ? assistant.content.map((block) => (block as { type?: unknown }).type)
      : [];
    expect(types).toEqual(["text", "toolUse"]);
  });
});
