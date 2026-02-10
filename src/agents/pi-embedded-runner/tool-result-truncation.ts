/**
 * Tool result truncation utilities for recovering from context overflow
 * caused by oversized tool results (e.g., reading a huge file or `gh pr diff`).
 *
 * Two layers of defense:
 * 1. Pre-emptive guard: hard cap of 400K chars (~100K tokens) applied before persistence.
 * 2. Recovery path: scan session for oversized results, truncate via session branching, retry.
 *
 * Ported from upstream openclaw/openclaw#11579.
 */

import { SessionManager } from "@mariozechner/pi-coding-agent";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Max share of context window a single tool result may occupy. */
export const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/** Absolute hard cap (characters) regardless of model context window. */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;

/** Minimum chars to keep even for very small context windows. */
export const MIN_KEEP_CHARS = 2_000;

const TRUNCATION_SUFFIX = [
  "",
  "--- Tool result truncated ---",
  "The output above was truncated because it exceeded the model's context window.",
  "To see more of this content, try using `offset` and `limit` parameters to read",
  "specific sections, or use a more targeted query.",
].join("\n");

// ── Text truncation ────────────────────────────────────────────────────────────

/**
 * Truncate text at a newline boundary, keeping at most `maxChars` characters.
 * Appends a truncation notice when truncation occurs.
 */
export function truncateToolResultText(text: string, maxChars: number): string {
  const effectiveMax = Math.max(maxChars, MIN_KEEP_CHARS);
  if (text.length <= effectiveMax) {
    return text;
  }
  // Try to cut at a newline boundary within the budget
  const cutRegion = text.slice(0, effectiveMax);
  const lastNewline = cutRegion.lastIndexOf("\n");
  const cutPoint = lastNewline > effectiveMax * 0.8 ? lastNewline : effectiveMax;
  return text.slice(0, cutPoint) + TRUNCATION_SUFFIX;
}

// ── Context-window-proportional sizing ─────────────────────────────────────────

/**
 * Calculate the max chars allowed for a single tool result given the model's
 * context window (in tokens). Assumes ~4 chars/token on average.
 */
export function calculateMaxToolResultChars(contextWindowTokens: number): number {
  const proportional = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE * 4);
  return Math.min(Math.max(proportional, MIN_KEEP_CHARS), HARD_MAX_TOOL_RESULT_CHARS);
}

// ── Message inspection helpers ─────────────────────────────────────────────────

interface MessageLike {
  role?: string;
  content?: unknown;
}

interface TextContentBlock {
  type: "text";
  text: string;
}

function isTextBlock(block: unknown): block is TextContentBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as Record<string, unknown>).type === "text" &&
    typeof (block as Record<string, unknown>).text === "string"
  );
}

function getToolResultTextLength(msg: MessageLike): number {
  if (msg.role !== "toolResult" || !Array.isArray(msg.content)) {
    return 0;
  }
  let total = 0;
  for (const block of msg.content) {
    if (isTextBlock(block)) {
      total += block.text.length;
    }
  }
  return total;
}

/**
 * Check whether a single message is an oversized tool result.
 */
export function isOversizedToolResult(msg: unknown, contextWindowTokens: number): boolean {
  const m = msg as MessageLike;
  if (m.role !== "toolResult") {
    return false;
  }
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  return getToolResultTextLength(m) > maxChars;
}

/**
 * Scan a message array for any oversized tool results.
 */
export function sessionLikelyHasOversizedToolResults(params: {
  messages: unknown[];
  contextWindowTokens: number;
}): boolean {
  return params.messages.some((m) => isOversizedToolResult(m, params.contextWindowTokens));
}

// ── In-memory truncation ───────────────────────────────────────────────────────

function truncateToolResultMessage(msg: MessageLike, maxChars: number): MessageLike {
  if (msg.role !== "toolResult" || !Array.isArray(msg.content)) {
    return msg;
  }
  const totalLen = getToolResultTextLength(msg);
  if (totalLen <= maxChars) {
    return msg;
  }

  // Proportionally distribute the budget across text blocks
  const newContent = msg.content.map((block: unknown) => {
    if (!isTextBlock(block)) {
      return block;
    }
    const share = totalLen > 0 ? block.text.length / totalLen : 1;
    const blockBudget = Math.floor(maxChars * share);
    return { ...block, text: truncateToolResultText(block.text, blockBudget) };
  });

  return { ...msg, content: newContent };
}

/**
 * In-memory truncation of oversized tool results in a message array.
 */
export function truncateOversizedToolResultsInMessages(
  messages: unknown[],
  contextWindowTokens: number,
): unknown[] {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  return messages.map((m) => {
    if (isOversizedToolResult(m, contextWindowTokens)) {
      return truncateToolResultMessage(m as MessageLike, maxChars);
    }
    return m;
  });
}

// ── Session-level truncation (branch and rewrite) ──────────────────────────────

/**
 * Open a Pi session file, walk the branch from root to leaf, find oversized
 * tool results, and create a new branch with truncated content.
 * Returns true if any truncation was applied.
 */
export function truncateOversizedToolResultsInSession(params: {
  sessionFile: string;
  contextWindowTokens: number;
  sessionId: string;
  sessionKey?: string;
}): boolean {
  const { sessionFile, contextWindowTokens } = params;
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);

  let sessionManager: SessionManager;
  try {
    sessionManager = SessionManager.open(sessionFile);
  } catch {
    return false;
  }

  // Walk the branch to find entries
  const entries = sessionManager.getEntries();
  if (!entries || entries.length === 0) {
    return false;
  }

  // Find oversized tool result entries
  let hasOversized = false;
  for (const entry of entries) {
    if (
      entry.type === "message" &&
      entry.message &&
      typeof entry.message === "object" &&
      (entry.message as MessageLike).role === "toolResult"
    ) {
      const msg = entry.message as MessageLike;
      if (getToolResultTextLength(msg) > maxChars) {
        hasOversized = true;
        break;
      }
    }
  }

  if (!hasOversized) {
    return false;
  }

  // Create a new branch with truncated tool results by re-appending entries.
  // We branch from the session header (root) and replay all entries, truncating
  // oversized tool results along the way.
  try {
    // Find the first oversized entry to branch from its parent
    let branchFromId: string | undefined;
    for (const entry of entries) {
      if (
        entry.type === "message" &&
        entry.message &&
        typeof entry.message === "object" &&
        (entry.message as MessageLike).role === "toolResult" &&
        getToolResultTextLength(entry.message as MessageLike) > maxChars
      ) {
        break;
      }
      branchFromId = entry.id;
    }

    if (branchFromId) {
      sessionManager.branch(branchFromId);
    }

    // Re-append entries from the branch point with truncated tool results
    let replaying = branchFromId === undefined;
    for (const entry of entries) {
      if (!replaying) {
        if (entry.id === branchFromId) {
          replaying = true;
        }
        continue;
      }

      if (entry.type === "message" && entry.message) {
        const msg = entry.message as MessageLike;
        const truncated =
          msg.role === "toolResult" && getToolResultTextLength(msg) > maxChars
            ? truncateToolResultMessage(msg, maxChars)
            : msg;
        sessionManager.appendMessage(truncated as Parameters<SessionManager["appendMessage"]>[0]);
      } else if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
        sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
      } else if (entry.type === "model_change" && entry.provider && entry.modelId) {
        sessionManager.appendModelChange(entry.provider, entry.modelId);
      } else if (entry.type === "custom" && entry.customType) {
        sessionManager.appendCustomEntry(entry.customType, entry.data);
      } else if (entry.type === "session_info" && entry.name) {
        sessionManager.appendSessionInfo(entry.name);
      }
      // Skip branch_summary and label entries to avoid inconsistency
    }

    return true;
  } catch {
    return false;
  }
}
