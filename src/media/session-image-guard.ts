/**
 * Session Image Guard
 *
 * Intercepts messages being persisted to session transcripts and replaces
 * inline base64 images with lightweight text representations.
 * The original images are archived to disk for future access if needed.
 *
 * This guard should be installed on SessionManager to process images
 * BEFORE they are stored in the session history.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { ImageProcessorOptions } from "./image-processor.js";
import {
  archiveImage,
  extractTextFromImage,
  type ImageContent,
  type ImageReference,
} from "./image-archive.js";

// ============================================================================
// Types
// ============================================================================

export interface SessionImageGuardOptions {
  /** Agent ID for archiving */
  agentId: string;
  /** Session ID for archiving */
  sessionId: string;
  /** Skip OCR processing (just archive images without extracting text) */
  skipOcr?: boolean;
  /** Image processor options */
  processorOptions?: ImageProcessorOptions;
  /** Maximum size for images to process (larger images are archived without OCR) */
  maxOcrBytes?: number;
  /** Callback when an image is processed */
  onImageProcessed?: (info: {
    originalBytes: number;
    textBytes: number;
    hasOcr: boolean;
    archivePath: string;
  }) => void;
}

export interface SessionImageGuardStats {
  imagesProcessed: number;
  bytesSaved: number;
  errors: string[];
}

// ============================================================================
// Image Detection
// ============================================================================

// 新格式: { type: "image", data: "base64...", mimeType: "image/jpeg" }
interface ImageBlockNew {
  type: "image";
  data: string;
  mimeType: string;
}

// 旧格式: { type: "image", source: { type: "base64", media_type: "...", data: "..." } }
interface ImageBlockOld {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

type ImageBlock = ImageBlockNew | ImageBlockOld;

function isNewFormatImageBlock(block: unknown): block is ImageBlockNew {
  if (typeof block !== "object" || block === null) return false;
  const obj = block as Record<string, unknown>;
  return obj.type === "image" && typeof obj.data === "string" && typeof obj.mimeType === "string";
}

function isOldFormatImageBlock(block: unknown): block is ImageBlockOld {
  if (typeof block !== "object" || block === null) return false;
  const obj = block as Record<string, unknown>;
  if (obj.type !== "image") return false;
  if (typeof obj.source !== "object" || obj.source === null) return false;
  const source = obj.source as Record<string, unknown>;
  return source.type === "base64" && typeof source.data === "string";
}

function isBase64ImageBlock(block: unknown): block is ImageBlock {
  return isNewFormatImageBlock(block) || isOldFormatImageBlock(block);
}

// 辅助函数：从任意格式的图片块获取 base64 数据和 mimeType
function getImageData(block: ImageBlock): { data: string; mimeType: string } {
  if (isNewFormatImageBlock(block)) {
    return { data: block.data, mimeType: block.mimeType };
  } else {
    return { data: block.source.data, mimeType: block.source.media_type };
  }
}

function hasBase64Images(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(isBase64ImageBlock);
}

// ============================================================================
// Text Representation Builder
// ============================================================================

function buildTextRepresentation(ref: ImageReference): string {
  const parts: string[] = [];

  const sizeStr = formatBytes(ref.originalSize);
  parts.push(`[Image: ${ref.mediaType}, ${sizeStr}]`);

  if (ref.extractedText) {
    parts.push(`\nExtracted text:\n${ref.extractedText}`);
  } else if (ref.description) {
    parts.push(`\nDescription: ${ref.description}`);
  }

  parts.push(`\n[Archived: ${ref.archivePath}]`);

  return parts.join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// Message Transformation
// ============================================================================

/**
 * Transforms a message content array, replacing images with text references.
 * This is done synchronously for the archive step, with async OCR as a best-effort.
 */
async function transformMessageContent(
  content: unknown[],
  options: SessionImageGuardOptions,
  stats: SessionImageGuardStats,
): Promise<unknown[]> {
  const newContent: unknown[] = [];

  for (const block of content) {
    if (!isBase64ImageBlock(block)) {
      newContent.push(block);
      continue;
    }

    try {
      // 获取图片数据（支持新旧两种格式）
      const { data, mimeType } = getImageData(block);

      const imageContent: ImageContent = {
        type: "image",
        source: {
          type: "base64",
          media_type: mimeType,
          data: data,
        },
      };

      const originalBytes = Buffer.from(data, "base64").length;

      // Archive the image
      const { reference } = await archiveImage({
        agentId: options.agentId,
        sessionId: options.sessionId,
        imageContent,
      });

      // Try OCR if not skipped and image is not too large
      const maxOcrBytes = options.maxOcrBytes ?? 2 * 1024 * 1024; // 2MB default
      if (!options.skipOcr && originalBytes <= maxOcrBytes) {
        try {
          const result = await extractTextFromImage({
            imageContent,
            options: options.processorOptions,
          });

          if (result) {
            if (result.isTextContent && result.text) {
              reference.extractedText = result.text;
            } else if (result.text) {
              reference.description = result.text;
            }

            // Update metadata file
            const fs = await import("node:fs/promises");
            const metaPath = `${reference.archivePath}.meta.json`;
            await fs.writeFile(metaPath, JSON.stringify(reference, null, 2));
          }
        } catch (ocrError) {
          stats.errors.push(
            `OCR failed: ${ocrError instanceof Error ? ocrError.message : String(ocrError)}`,
          );
        }
      }

      // Build text representation
      const textRep = buildTextRepresentation(reference);
      const textBytes = Buffer.byteLength(textRep, "utf8");

      // Track stats
      stats.imagesProcessed++;
      stats.bytesSaved += originalBytes - textBytes;

      // Notify callback
      options.onImageProcessed?.({
        originalBytes,
        textBytes,
        hasOcr: Boolean(reference.extractedText || reference.description),
        archivePath: reference.archivePath,
      });

      // Replace image with text block
      newContent.push({
        type: "text",
        text: textRep,
      });
    } catch (err) {
      stats.errors.push(
        `Failed to process image: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Keep original block if processing fails
      newContent.push(block);
    }
  }

  return newContent;
}

// ============================================================================
// Transform Function for Tool Results
// ============================================================================

/**
 * Creates a transform function for tool result messages that processes images.
 * This can be passed to installSessionToolResultGuard's transformToolResultForPersistence option.
 */
export function createImageTransformForToolResult(
  options: SessionImageGuardOptions,
): (
  message: AgentMessage,
  meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
) => AgentMessage {
  const stats: SessionImageGuardStats = {
    imagesProcessed: 0,
    bytesSaved: 0,
    errors: [],
  };

  return (message, _meta) => {
    const msg = message as unknown as Record<string, unknown>;
    const content = msg.content;

    // Only process if there are base64 images
    if (!hasBase64Images(content)) {
      return message;
    }

    // Process images synchronously by starting the async operation
    // and replacing the message content
    // Note: This is a limitation - we can't truly await here since the
    // transform function is synchronous. We'll need to handle this differently.

    // For now, we'll create a synchronous version that just archives without OCR
    const newContent = transformContentSync(content as unknown[], options, stats);

    return {
      ...msg,
      content: newContent,
    } as AgentMessage;
  };
}

/**
 * Synchronous version of content transformation (archives without OCR).
 * Used when async processing isn't available.
 */
function transformContentSync(
  content: unknown[],
  options: SessionImageGuardOptions,
  stats: SessionImageGuardStats,
): unknown[] {
  const newContent: unknown[] = [];

  for (const block of content) {
    if (!isBase64ImageBlock(block)) {
      newContent.push(block);
      continue;
    }

    // For synchronous processing, we create a placeholder that will be
    // enhanced later. This is a fallback when async isn't available.
    const { data, mimeType } = getImageData(block);
    const originalBytes = Buffer.from(data, "base64").length;
    const sizeStr = formatBytes(originalBytes);

    // Create a minimal text representation
    const textRep = `[Image: ${mimeType}, ${sizeStr}]\n[Pending archive - image data preserved for async processing]`;

    newContent.push({
      type: "text",
      text: textRep,
      // Preserve original data for async processing
      _pendingImage: {
        media_type: mimeType,
        data: data,
      },
    });

    stats.imagesProcessed++;
  }

  return newContent;
}

// ============================================================================
// Async Message Processor
// ============================================================================

/**
 * Processes a message's images asynchronously.
 * This should be called before appending a message to the session.
 */
export async function processMessageImages(
  message: AgentMessage,
  options: SessionImageGuardOptions,
): Promise<{ message: AgentMessage; stats: SessionImageGuardStats }> {
  const stats: SessionImageGuardStats = {
    imagesProcessed: 0,
    bytesSaved: 0,
    errors: [],
  };

  const msg = message as unknown as Record<string, unknown>;
  const content = msg.content;

  // Only process if there are base64 images
  if (!hasBase64Images(content)) {
    return { message, stats };
  }

  const newContent = await transformMessageContent(content as unknown[], options, stats);

  return {
    message: {
      ...msg,
      content: newContent,
    } as AgentMessage,
    stats,
  };
}

/**
 * Processes user message images before they are sent to the agent.
 * Returns a modified message with images replaced by text references.
 */
export async function processUserMessageImages(params: {
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  agentId: string;
  sessionId: string;
  options?: Omit<SessionImageGuardOptions, "agentId" | "sessionId">;
}): Promise<{
  message: string;
  textReferences: string[];
  stats: SessionImageGuardStats;
}> {
  const { message, images, agentId, sessionId, options } = params;
  const stats: SessionImageGuardStats = {
    imagesProcessed: 0,
    bytesSaved: 0,
    errors: [],
  };

  if (!images || images.length === 0) {
    return { message, textReferences: [], stats };
  }

  const textReferences: string[] = [];
  const guardOptions: SessionImageGuardOptions = {
    agentId,
    sessionId,
    ...options,
  };

  for (const image of images) {
    try {
      const imageContent: ImageContent = {
        type: "image",
        source: {
          type: "base64",
          media_type: image.mimeType,
          data: image.data,
        },
      };

      const originalBytes = Buffer.from(image.data, "base64").length;

      // Archive the image
      const { reference } = await archiveImage({
        agentId,
        sessionId,
        imageContent,
      });

      // Try OCR if not skipped
      if (!guardOptions.skipOcr) {
        try {
          const result = await extractTextFromImage({
            imageContent,
            options: guardOptions.processorOptions,
          });

          if (result) {
            if (result.isTextContent && result.text) {
              reference.extractedText = result.text;
            } else if (result.text) {
              reference.description = result.text;
            }

            // Update metadata file
            const fs = await import("node:fs/promises");
            const metaPath = `${reference.archivePath}.meta.json`;
            await fs.writeFile(metaPath, JSON.stringify(reference, null, 2));
          }
        } catch (ocrError) {
          stats.errors.push(
            `OCR failed: ${ocrError instanceof Error ? ocrError.message : String(ocrError)}`,
          );
        }
      }

      // Build text representation
      const textRep = buildTextRepresentation(reference);
      const textBytes = Buffer.byteLength(textRep, "utf8");

      textReferences.push(textRep);

      // Track stats
      stats.imagesProcessed++;
      stats.bytesSaved += originalBytes - textBytes;

      guardOptions.onImageProcessed?.({
        originalBytes,
        textBytes,
        hasOcr: Boolean(reference.extractedText || reference.description),
        archivePath: reference.archivePath,
      });
    } catch (err) {
      stats.errors.push(
        `Failed to process image: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Append text references to the message
  const enhancedMessage =
    textReferences.length > 0 ? `${message}\n\n${textReferences.join("\n\n")}` : message;

  return {
    message: enhancedMessage,
    textReferences,
    stats,
  };
}
