import fs from "node:fs/promises";

type RecoveryMessage = {
  role: "user" | "assistant";
  text: string;
};

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const block = item as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    const text = block.text.trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function extractMessageFromEntry(entry: unknown): RecoveryMessage | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as {
    type?: unknown;
    message?: unknown;
    role?: unknown;
    content?: unknown;
  };

  const messagePayload =
    record.type === "message" && record.message && typeof record.message === "object"
      ? (record.message as { role?: unknown; content?: unknown })
      : null;
  const role = (messagePayload?.role ?? record.role) as unknown;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = extractText(messagePayload?.content ?? record.content);
  if (!text) {
    return null;
  }
  return { role, text };
}

function normalizeSnippet(text: string, maxCharsPerLine: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxCharsPerLine) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxCharsPerLine - 1).trimEnd()}…`;
}

function clampMessageWindow(messages: RecoveryMessage[], maxMessages: number): RecoveryMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }
  return messages.slice(-maxMessages);
}

function trimToLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Build a compact recovery checkpoint that can be injected into the next run's
 * system prompt after a compaction failure reset.
 */
export async function buildCompactionRecoveryNote(params: {
  sessionFile?: string;
  latestUserPrompt?: string;
  maxMessages?: number;
  maxCharsPerLine?: number;
  maxChars?: number;
}): Promise<string | undefined> {
  const maxMessages = Math.max(1, Math.floor(params.maxMessages ?? 8));
  const maxCharsPerLine = Math.max(40, Math.floor(params.maxCharsPerLine ?? 180));
  const maxChars = Math.max(200, Math.floor(params.maxChars ?? 1600));
  const messages: RecoveryMessage[] = [];

  if (params.sessionFile) {
    try {
      const raw = await fs.readFile(params.sessionFile, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          const message = extractMessageFromEntry(parsed);
          if (message) {
            messages.push(message);
          }
        } catch {
          // Ignore invalid JSONL rows.
        }
      }
    } catch {
      // Missing transcript should not block reset flow.
    }
  }

  const recent = clampMessageWindow(messages, maxMessages);
  const lines = recent.map(
    (msg) => `- ${msg.role}: ${normalizeSnippet(msg.text, maxCharsPerLine)}`,
  );

  const latestPrompt = params.latestUserPrompt?.trim();
  if (latestPrompt) {
    const normalized = normalizeSnippet(latestPrompt, maxCharsPerLine);
    const exists = lines.some((line) => line.includes(normalized));
    if (!exists) {
      lines.push(`- user(latest): ${normalized}`);
    }
  }

  if (lines.length === 0) {
    return undefined;
  }

  const note = [
    "Compaction recovery checkpoint:",
    "Continue from this recent context and do not restart the conversation from scratch.",
    ...lines,
  ].join("\n");
  return trimToLength(note, maxChars);
}
