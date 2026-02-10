import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { HARD_MAX_TOOL_RESULT_CHARS } from "./pi-embedded-runner/tool-result-truncation.js";
import { logImageStripping, stripImagesFromMessage } from "./session-image-stripper.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";

const GUARD_TRUNCATION_SUFFIX =
  "\n\n--- Tool result truncated during persistence ---\n" +
  "The output was too large and has been truncated to prevent session corruption.\n" +
  "Use `offset` and `limit` parameters to read specific sections.";

/**
 * Pre-emptive hard cap on tool result size before persistence.
 * Prevents extremely large tool results from ever being stored in full.
 */
function capToolResultSize(msg: AgentMessage): AgentMessage {
  const role = (msg as { role?: string }).role;
  if (role !== "toolResult") {
    return msg;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  let totalChars = 0;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as TextContent).text === "string"
    ) {
      totalChars += (block as TextContent).text.length;
    }
  }

  if (totalChars <= HARD_MAX_TOOL_RESULT_CHARS) {
    return msg;
  }

  // Proportionally distribute the budget across text blocks
  const newContent = content.map((block: unknown) => {
    if (
      !block ||
      typeof block !== "object" ||
      (block as { type?: string }).type !== "text" ||
      typeof (block as TextContent).text !== "string"
    ) {
      return block;
    }
    const textBlock = block as TextContent;
    const share = totalChars > 0 ? textBlock.text.length / totalChars : 1;
    const blockBudget = Math.floor(HARD_MAX_TOOL_RESULT_CHARS * share);
    if (textBlock.text.length <= blockBudget) {
      return block;
    }
    // Try to cut at a newline boundary (within 80% of budget)
    const cutRegion = textBlock.text.slice(0, blockBudget);
    const lastNewline = cutRegion.lastIndexOf("\n");
    const cutPoint = lastNewline > blockBudget * 0.8 ? lastNewline : blockBudget;
    return { ...textBlock, text: textBlock.text.slice(0, cutPoint) + GUARD_TRUNCATION_SUFFIX };
  });

  return { ...msg, content: newContent } as AgentMessage;
}

type ToolCall = { id: string; name?: string };

function extractAssistantToolCalls(msg: Extract<AgentMessage, { role: "assistant" }>): ToolCall[] {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) {
      continue;
    }
    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(msg: Extract<AgentMessage, { role: "toolResult" }>): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) {
    return toolCallId;
  }
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) {
    return toolUseId;
  }
  return null;
}

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    /**
     * Whether to strip base64 media (images, audio, video) from messages before persisting to session.
     * Media data is replaced with text placeholders to save context space.
     * Defaults to true.
     */
    stripMediaFromSession?: boolean;
  },
): {
  flushPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
  // Support both new name (stripMediaFromSession) and legacy name (stripImagesFromSession)
  const stripMedia =
    opts?.stripMediaFromSession ??
    (opts as { stripImagesFromSession?: boolean })?.stripImagesFromSession ??
    true;

  const flushPendingToolResults = () => {
    if (pending.size === 0) {
      return;
    }
    if (allowSyntheticToolResults) {
      for (const [id, name] of pending.entries()) {
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        originalAppend(
          persistToolResult(synthetic, {
            toolCallId: id,
            toolName: name,
            isSynthetic: true,
          }) as never,
        );
      }
    }
    pending.clear();
  };

  const guardedAppend = (message: AgentMessage) => {
    // Strip base64 media (images, audio, video) before any persistence
    const { message: strippedMessage, strippedCount } = stripImagesFromMessage(message, stripMedia);
    const role = (strippedMessage as { role?: string }).role;

    // Log with sampling (avoids spam)
    if (strippedCount > 0) {
      logImageStripping(role, strippedCount);
    }

    let nextMessage = strippedMessage;

    // Sanitize assistant tool call inputs
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([nextMessage]);
      if (sanitized.length === 0) {
        if (allowSyntheticToolResults && pending.size > 0) {
          flushPendingToolResults();
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = (nextMessage as { role?: unknown }).role;

    if (nextRole === "toolResult") {
      // Pre-emptive hard cap: prevent extremely large tool results from persisting.
      nextMessage = capToolResultSize(nextMessage);
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pending.get(id) : undefined;
      if (id) {
        pending.delete(id);
      }
      return originalAppend(
        persistToolResult(nextMessage, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }) as never,
      );
    }

    const toolCalls =
      nextRole === "assistant"
        ? extractAssistantToolCalls(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    if (allowSyntheticToolResults) {
      // If previous tool calls are still pending, flush before non-tool results.
      if (pending.size > 0 && (toolCalls.length === 0 || nextRole !== "assistant")) {
        flushPendingToolResults();
      }
      // If new tool calls arrive while older ones are pending, flush the old ones first.
      if (pending.size > 0 && toolCalls.length > 0) {
        flushPendingToolResults();
      }
    }

    const result = originalAppend(nextMessage as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        pending.set(call.id, call.name);
      }
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  // Note: Only log on first install, not on every message
  console.log("[session-tool-result-guard] Guard installed, stripMedia:", stripMedia);
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
  };
}
