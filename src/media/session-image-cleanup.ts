/**
 * Session Image Cleanup Module
 *
 * Scans existing session transcript files and replaces inline base64 images
 * with lightweight text references (OCR text or descriptions).
 * The original images are archived to disk for future access if needed.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

export interface CleanupResult {
  /** Session file path */
  sessionFile: string;
  /** Number of images found */
  imagesFound: number;
  /** Number of images successfully processed */
  imagesProcessed: number;
  /** Number of images skipped (errors) */
  imagesSkipped: number;
  /** Total bytes saved */
  bytesSaved: number;
  /** Whether the file was modified */
  modified: boolean;
  /** Errors encountered */
  errors: string[];
}

export interface CleanupOptions {
  /** Dry run - analyze but don't modify files */
  dryRun?: boolean;
  /** Skip OCR processing (just archive images without extracting text) */
  skipOcr?: boolean;
  /** Image processor options */
  processorOptions?: ImageProcessorOptions;
  /** Progress callback */
  onProgress?: (current: number, total: number, sessionFile: string) => void;
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

function hasBase64Images(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const msg = message as Record<string, unknown>;
  const content = msg.content;
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
// Message Processing
// ============================================================================

async function processMessageImages(params: {
  message: Record<string, unknown>;
  agentId: string;
  sessionId: string;
  options?: CleanupOptions;
}): Promise<{
  message: Record<string, unknown>;
  imagesProcessed: number;
  bytesSaved: number;
  errors: string[];
}> {
  const { message, agentId, sessionId, options } = params;
  const content = message.content;
  if (!Array.isArray(content)) {
    return { message, imagesProcessed: 0, bytesSaved: 0, errors: [] };
  }

  const newContent: unknown[] = [];
  let imagesProcessed = 0;
  let bytesSaved = 0;
  const errors: string[] = [];

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

      // Archive the image
      const { reference } = await archiveImage({
        agentId,
        sessionId,
        imageContent,
      });

      // Try to extract text (OCR) or generate description
      if (!options?.skipOcr) {
        try {
          const result = await extractTextFromImage({
            imageContent,
            options: options?.processorOptions,
          });

          if (result) {
            if (result.isTextContent && result.text) {
              reference.extractedText = result.text;
            } else if (result.text) {
              reference.description = result.text;
            }
          }

          // Update metadata file with extracted info
          const metaPath = `${reference.archivePath}.meta.json`;
          await fs.writeFile(metaPath, JSON.stringify(reference, null, 2));
        } catch (ocrError) {
          errors.push(
            `OCR failed: ${ocrError instanceof Error ? ocrError.message : String(ocrError)}`,
          );
        }
      }

      // Calculate bytes saved
      const originalBytes = Buffer.from(data, "base64").length;
      const textRep = buildTextRepresentation(reference);
      const newBytes = Buffer.byteLength(textRep, "utf8");
      bytesSaved += originalBytes - newBytes;

      // Replace image with text block
      newContent.push({
        type: "text",
        text: textRep,
      });

      imagesProcessed++;
    } catch (err) {
      errors.push(`Failed to process image: ${err instanceof Error ? err.message : String(err)}`);
      // Keep original block if processing fails
      newContent.push(block);
    }
  }

  return {
    message: { ...message, content: newContent },
    imagesProcessed,
    bytesSaved,
    errors,
  };
}

// ============================================================================
// Session File Processing
// ============================================================================

interface TranscriptEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: Record<string, unknown>;
}

async function processSessionFile(params: {
  sessionFile: string;
  agentId: string;
  sessionId: string;
  options?: CleanupOptions;
}): Promise<CleanupResult> {
  const { sessionFile, agentId, sessionId, options } = params;
  const result: CleanupResult = {
    sessionFile,
    imagesFound: 0,
    imagesProcessed: 0,
    imagesSkipped: 0,
    bytesSaved: 0,
    modified: false,
    errors: [],
  };

  try {
    const content = await fs.readFile(sessionFile, "utf-8");
    const lines = content.split(/\r?\n/);
    const newLines: string[] = [];
    let modified = false;

    for (const line of lines) {
      if (!line.trim()) {
        newLines.push(line);
        continue;
      }

      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        newLines.push(line);
        continue;
      }

      // Check if this line has a message with images
      if (entry.message && hasBase64Images(entry.message)) {
        result.imagesFound++;

        if (options?.dryRun) {
          newLines.push(line);
          continue;
        }

        const processed = await processMessageImages({
          message: entry.message,
          agentId,
          sessionId,
          options,
        });

        if (processed.imagesProcessed > 0) {
          entry.message = processed.message;
          newLines.push(JSON.stringify(entry));
          result.imagesProcessed += processed.imagesProcessed;
          result.bytesSaved += processed.bytesSaved;
          modified = true;
        } else {
          result.imagesSkipped++;
          newLines.push(line);
        }

        result.errors.push(...processed.errors);
      } else {
        newLines.push(line);
      }
    }

    if (modified && !options?.dryRun) {
      // Write the cleaned file
      await fs.writeFile(sessionFile, newLines.join("\n"));
      result.modified = true;
    }
  } catch (err) {
    result.errors.push(
      `Failed to process file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Cleans up images in a single session transcript file.
 */
export async function cleanupSessionImages(params: {
  sessionFile: string;
  agentId: string;
  sessionId: string;
  options?: CleanupOptions;
}): Promise<CleanupResult> {
  return processSessionFile(params);
}

/**
 * Cleans up images in all session transcript files for an agent.
 */
export async function cleanupAllSessionImages(params: {
  agentId: string;
  sessionsDir?: string;
  options?: CleanupOptions;
}): Promise<{
  results: CleanupResult[];
  totalImagesFound: number;
  totalImagesProcessed: number;
  totalBytesSaved: number;
}> {
  const { agentId, options } = params;
  const sessionsDir = params.sessionsDir ?? path.join(os.homedir(), ".clawdbot", "sessions");

  const results: CleanupResult[] = [];
  let totalImagesFound = 0;
  let totalImagesProcessed = 0;
  let totalBytesSaved = 0;

  try {
    const files = await fs.readdir(sessionsDir);
    const sessionFiles = files.filter((f) => f.endsWith(".jsonl"));

    for (let i = 0; i < sessionFiles.length; i++) {
      const file = sessionFiles[i];
      const sessionFile = path.join(sessionsDir, file);
      const sessionId = file.replace(".jsonl", "");

      options?.onProgress?.(i + 1, sessionFiles.length, sessionFile);

      const result = await cleanupSessionImages({
        sessionFile,
        agentId,
        sessionId,
        options,
      });

      results.push(result);
      totalImagesFound += result.imagesFound;
      totalImagesProcessed += result.imagesProcessed;
      totalBytesSaved += result.bytesSaved;
    }
  } catch (err) {
    // Directory doesn't exist or can't be read
    console.warn(
      `Failed to read sessions directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    results,
    totalImagesFound,
    totalImagesProcessed,
    totalBytesSaved,
  };
}

/**
 * Scans session files to count images without modifying anything.
 */
export async function scanSessionsForImages(params: { sessionsDir?: string }): Promise<{
  sessionCount: number;
  sessionsWithImages: number;
  totalImages: number;
  estimatedBytes: number;
}> {
  const sessionsDir = params.sessionsDir ?? path.join(os.homedir(), ".clawdbot", "sessions");

  let sessionCount = 0;
  let sessionsWithImages = 0;
  let totalImages = 0;
  let estimatedBytes = 0;

  try {
    const files = await fs.readdir(sessionsDir);
    const sessionFiles = files.filter((f) => f.endsWith(".jsonl"));
    sessionCount = sessionFiles.length;

    for (const file of sessionFiles) {
      const sessionFile = path.join(sessionsDir, file);
      const content = await fs.readFile(sessionFile, "utf-8");
      const lines = content.split(/\r?\n/);
      let hasImages = false;

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);
          if (entry.message && hasBase64Images(entry.message)) {
            hasImages = true;
            totalImages++;

            // Estimate bytes from base64 data
            const msg = entry.message as Record<string, unknown>;
            const contentArr = msg.content as unknown[];
            for (const block of contentArr) {
              if (isBase64ImageBlock(block)) {
                const { data } = getImageData(block);
                estimatedBytes += Buffer.from(data, "base64").length;
              }
            }
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (hasImages) sessionsWithImages++;
    }
  } catch {
    // Directory doesn't exist
  }

  return {
    sessionCount,
    sessionsWithImages,
    totalImages,
    estimatedBytes,
  };
}
