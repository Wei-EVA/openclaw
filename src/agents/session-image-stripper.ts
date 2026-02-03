/**
 * Session media stripper - removes base64 media (images, audio, video) from messages before persistence.
 *
 * Supports multiple media formats:
 * - New format: { type: "image"|"audio"|"video", data: string, mimeType: string }
 * - Old format (Anthropic): { type: "image", source: { type: "base64", media_type: string, data: string } }
 * - URL format: { type: "image_url", image_url: { url: string } } (data URLs only)
 *
 * Defensive detection for audio/video is included even though the current architecture
 * converts them to text (ASR/video descriptions) before reaching the session. This guards
 * against future changes that might bypass the text conversion pipeline.
 *
 * @module session-image-stripper
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ============================================================================
// Types
// ============================================================================

/** Media types that can contain base64 data */
type MediaType = "image" | "audio" | "video";

/** New format media block (image, audio, or video) */
interface MediaBlockNew {
  type: MediaType;
  data: string;
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

/** URL format image block (OpenAI style) - we only strip data URLs */
interface ImageBlockUrl {
  type: "image_url";
  image_url: {
    url: string;
    detail?: string;
  };
}

/** Audio URL format - we only strip data URLs */
interface AudioBlockUrl {
  type: "audio_url";
  audio_url: {
    url: string;
  };
}

/** Video URL format - we only strip data URLs */
interface VideoBlockUrl {
  type: "video_url";
  video_url: {
    url: string;
  };
}

type MediaBlock = MediaBlockNew | ImageBlockOld | ImageBlockUrl | AudioBlockUrl | VideoBlockUrl;

export interface MediaStrippingResult {
  message: AgentMessage;
  strippedCount: number;
}

export interface MediaStrippingStats {
  totalStripped: number;
  byMimeType: Record<string, number>;
  totalBytesRemoved: number;
}

// Legacy aliases for backwards compatibility
export type ImageStrippingResult = MediaStrippingResult;
export type ImageStrippingStats = MediaStrippingStats;

// ============================================================================
// Detection functions
// ============================================================================

/** Check for new format media block (image, audio, or video with inline data) */
function isNewFormatMediaBlock(block: unknown): block is MediaBlockNew {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  const isMediaType = rec.type === "image" || rec.type === "audio" || rec.type === "video";
  return isMediaType && typeof rec.data === "string" && typeof rec.mimeType === "string";
}

/** Check for old Anthropic-style image block with base64 source */
function isOldFormatImageBlock(block: unknown): block is ImageBlockOld {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  if (rec.type !== "image") return false;
  const source = rec.source as Record<string, unknown> | undefined;
  return source?.type === "base64" && typeof source?.data === "string";
}

/** Check for data URL in image_url block */
function isDataUrlImageBlock(block: unknown): block is ImageBlockUrl {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  if (rec.type !== "image_url") return false;
  const imageUrl = rec.image_url as Record<string, unknown> | undefined;
  if (typeof imageUrl?.url !== "string") return false;
  // Only match data URLs (base64 embedded), not regular URLs
  return imageUrl.url.startsWith("data:");
}

/** Check for data URL in audio_url block (defensive) */
function isDataUrlAudioBlock(block: unknown): block is AudioBlockUrl {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  if (rec.type !== "audio_url") return false;
  const audioUrl = rec.audio_url as Record<string, unknown> | undefined;
  if (typeof audioUrl?.url !== "string") return false;
  return audioUrl.url.startsWith("data:");
}

/** Check for data URL in video_url block (defensive) */
function isDataUrlVideoBlock(block: unknown): block is VideoBlockUrl {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  if (rec.type !== "video_url") return false;
  const videoUrl = rec.video_url as Record<string, unknown> | undefined;
  if (typeof videoUrl?.url !== "string") return false;
  return videoUrl.url.startsWith("data:");
}

/**
 * Check if a block contains base64 media data that should be stripped.
 * Covers images, audio, and video in various formats.
 */
export function isBase64MediaBlock(block: unknown): block is MediaBlock {
  return (
    isNewFormatMediaBlock(block) ||
    isOldFormatImageBlock(block) ||
    isDataUrlImageBlock(block) ||
    isDataUrlAudioBlock(block) ||
    isDataUrlVideoBlock(block)
  );
}

// Legacy alias for backwards compatibility
export const isBase64ImageBlock = isBase64MediaBlock;

// ============================================================================
// Data extraction
// ============================================================================

function parseDataUrl(dataUrl: string): { data: string; mimeType: string } | null {
  // Format: data:[<mediatype>][;base64],<data>
  const match = dataUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
  if (!match) return null;
  return {
    mimeType: match[1] || "application/octet-stream",
    data: match[2] || "",
  };
}

/** Extract data and mime type from any supported media block format */
export function getMediaData(block: MediaBlock): { data: string; mimeType: string } {
  if (isNewFormatMediaBlock(block)) {
    return {
      data: block.data,
      mimeType: block.mimeType,
    };
  }
  if (isOldFormatImageBlock(block)) {
    return {
      data: block.source.data,
      mimeType: block.source.media_type,
    };
  }
  // URL format (image_url, audio_url, or video_url)
  let url: string | undefined;
  if ("image_url" in block && block.image_url) {
    url = block.image_url.url;
  } else if ("audio_url" in block && block.audio_url) {
    url = block.audio_url.url;
  } else if ("video_url" in block && block.video_url) {
    url = block.video_url.url;
  }
  if (url) {
    const parsed = parseDataUrl(url);
    if (parsed) return parsed;
  }
  return { data: "", mimeType: "unknown" };
}

// Legacy alias for backwards compatibility
export const getImageData = getMediaData;

// ============================================================================
// Formatting utilities
// ============================================================================

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function estimateBase64Bytes(base64Length: number): number {
  // base64 encodes 3 bytes as 4 characters
  return Math.ceil((base64Length * 3) / 4);
}

// ============================================================================
// Core stripping logic
// ============================================================================

/** Determine the media kind label for placeholder text */
function getMediaKindLabel(mimeType: string): string {
  if (mimeType.startsWith("audio/")) return "Audio";
  if (mimeType.startsWith("video/")) return "Video";
  return "Image";
}

export function hasBase64Media(content: unknown[]): boolean {
  return content.some((block) => isBase64MediaBlock(block));
}

// Legacy alias for backwards compatibility
export const hasBase64Images = hasBase64Media;

export function replaceMediaWithPlaceholders(
  content: unknown[],
  stats?: MediaStrippingStats,
): unknown[] {
  return content.map((block) => {
    if (!isBase64MediaBlock(block)) return block;

    const { data, mimeType } = getMediaData(block);
    const sizeBytes = estimateBase64Bytes(data.length);
    const kindLabel = getMediaKindLabel(mimeType);

    // Update stats if provided
    if (stats) {
      stats.totalStripped++;
      stats.byMimeType[mimeType] = (stats.byMimeType[mimeType] || 0) + 1;
      stats.totalBytesRemoved += sizeBytes;
    }

    return {
      type: "text",
      text: `[${kindLabel}: ${mimeType}, ${formatBytes(sizeBytes)}]\n[${kindLabel} data removed from session history to save context space]`,
    };
  });
}

// Legacy alias for backwards compatibility
export const replaceImagesWithPlaceholders = replaceMediaWithPlaceholders;

/**
 * Strip base64 media (images, audio, video) from a message, replacing them with text placeholders.
 *
 * @param message - The message to process
 * @param enabled - Whether stripping is enabled (pass false to skip)
 * @returns The processed message and count of stripped media items
 */
export function stripMediaFromMessage(message: AgentMessage, enabled = true): MediaStrippingResult {
  if (!enabled) {
    return { message, strippedCount: 0 };
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { message, strippedCount: 0 };
  }

  if (!hasBase64Media(content)) {
    return { message, strippedCount: 0 };
  }

  const stats: MediaStrippingStats = {
    totalStripped: 0,
    byMimeType: {},
    totalBytesRemoved: 0,
  };

  const strippedContent = replaceMediaWithPlaceholders(content, stats);

  return {
    message: { ...message, content: strippedContent } as AgentMessage,
    strippedCount: stats.totalStripped,
  };
}

// Legacy alias for backwards compatibility
export const stripImagesFromMessage = stripMediaFromMessage;

// ============================================================================
// Logging (with sampling to avoid log spam)
// ============================================================================

let strippedSinceLastLog = 0;
let lastLogTime = 0;
const LOG_INTERVAL_MS = 60_000; // Log at most once per minute
const LOG_THRESHOLD = 10; // Or when 10+ images stripped

/**
 * Log media stripping with sampling to avoid spam.
 * Logs immediately for first item, then batches subsequent logs.
 */
export function logMediaStripping(
  role: string | undefined,
  strippedCount: number,
  forceLog = false,
): void {
  if (strippedCount === 0) return;

  strippedSinceLastLog += strippedCount;
  const now = Date.now();

  // Log if: forced, first time, threshold reached, or interval passed
  const shouldLog =
    forceLog ||
    lastLogTime === 0 ||
    strippedSinceLastLog >= LOG_THRESHOLD ||
    now - lastLogTime >= LOG_INTERVAL_MS;

  if (shouldLog) {
    if (strippedSinceLastLog === strippedCount) {
      // Single item, simple log
      console.log(
        `[session-media-stripper] Stripped ${strippedCount} media item(s) from ${role ?? "unknown"} message`,
      );
    } else {
      // Batched log
      console.log(
        `[session-media-stripper] Stripped ${strippedSinceLastLog} media item(s) total (latest: ${strippedCount} from ${role ?? "unknown"})`,
      );
    }
    strippedSinceLastLog = 0;
    lastLogTime = now;
  }
}

// Legacy alias for backwards compatibility
export const logImageStripping = logMediaStripping;

// ============================================================================
// Testing exports
// ============================================================================

export const __testing = {
  isNewFormatMediaBlock,
  isOldFormatImageBlock,
  isDataUrlImageBlock,
  isDataUrlAudioBlock,
  isDataUrlVideoBlock,
  parseDataUrl,
  getMediaKindLabel,
  // Reset log state for testing
  resetLogState: () => {
    strippedSinceLastLog = 0;
    lastLogTime = 0;
  },
} as const;
