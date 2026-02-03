import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { makeMissingToolResult } from "./session-transcript-repair.js";

// ============================================================================
// Image stripping utilities (inline to avoid circular dependencies)
// Added 2026-01-28 for session image protection
// ============================================================================

/** New format image block */
interface ImageBlockNew {
  type: "image";
  data: string; // base64 data
  mimeType: string;
}

/** Old format image block (Anthropic style) */
interface ImageBlockOld {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

function isNewFormatImageBlock(block: unknown): block is ImageBlockNew {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  return rec.type === "image" && typeof rec.data === "string" && typeof rec.mimeType === "string";
}

function isOldFormatImageBlock(block: unknown): block is ImageBlockOld {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  if (rec.type !== "image") return false;
  const source = rec.source as Record<string, unknown> | undefined;
  return source?.type === "base64" && typeof source?.data === "string";
}

function isBase64ImageBlock(block: unknown): block is ImageBlockNew | ImageBlockOld {
  return isNewFormatImageBlock(block) || isOldFormatImageBlock(block);
}

function getImageData(block: ImageBlockNew | ImageBlockOld): { data: string; mimeType: string } {
  if (isNewFormatImageBlock(block)) {
    return {
      data: block.data,
      mimeType: block.mimeType,
    };
  }
  return {
    data: block.source.data,
    mimeType: block.source.media_type,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hasBase64Images(content: unknown[]): boolean {
  return content.some((block) => isBase64ImageBlock(block));
}

function replaceImagesWithPlaceholders(content: unknown[]): unknown[] {
  return content.map((block) => {
    if (!isBase64ImageBlock(block)) return block;
    const { data, mimeType } = getImageData(block);
    const sizeBytes = Math.ceil((data.length * 3) / 4); // base64 to bytes estimate
    return {
      type: "text",
      text: `[Image: ${mimeType}, ${formatBytes(sizeBytes)}]\n[Image data removed from session history to save context space]`,
    };
  });
}

function maybeStripImages(message: AgentMessage, stripImages: boolean): AgentMessage {
  if (!stripImages) return message;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;
  if (!hasBase64Images(content)) return message;

  console.log(
    "[session-tool-result-guard] Stripping images from message, role:",
    (message as { role?: string }).role,
  );
  const strippedContent = replaceImagesWithPlaceholders(content);
  return { ...message, content: strippedContent } as AgentMessage;
}

// ============================================================================
// End of image stripping utilities
// ============================================================================

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
     * Whether to strip base64 images from messages before persisting to session.
     * Images are replaced with text placeholders to save context space.
     * Defaults to true.
     */
    stripImagesFromSession?: boolean;
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
  const stripImages = opts?.stripImagesFromSession ?? true;

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
    // Strip base64 images before any persistence
    const strippedMessage = maybeStripImages(message, stripImages);
    const role = (strippedMessage as { role?: unknown }).role;

    if (role === "toolResult") {
      const id = extractToolResultId(
        strippedMessage as Extract<AgentMessage, { role: "toolResult" }>,
      );
      const toolName = id ? pending.get(id) : undefined;
      if (id) {
        pending.delete(id);
      }
      return originalAppend(
        persistToolResult(strippedMessage, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }) as never,
      );
    }

    const toolCalls =
      role === "assistant"
        ? extractAssistantToolCalls(strippedMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    if (allowSyntheticToolResults) {
      // If previous tool calls are still pending, flush before non-tool results.
      if (pending.size > 0 && (toolCalls.length === 0 || role !== "assistant")) {
        flushPendingToolResults();
      }
      // If new tool calls arrive while older ones are pending, flush the old ones first.
      if (pending.size > 0 && toolCalls.length > 0) {
        flushPendingToolResults();
      }
    }

    const result = originalAppend(strippedMessage as never);

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
  console.log("[session-tool-result-guard] Installing guard, stripImages:", stripImages);
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
  };
}
