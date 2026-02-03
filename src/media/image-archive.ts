/**
 * Image Archive Module
 *
 * Provides functionality to:
 * 1. Archive images to disk, replacing inline base64 with file references
 * 2. Extract text from images via OCR (for homework, notes, etc.)
 * 3. Generate descriptions for non-text images
 * 4. Replace images in messages with lightweight text representations
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveClawdbotAgentDir } from "../agents/agent-paths.js";

// ============================================================================
// Types
// ============================================================================

export interface ImageReference {
  /** Type marker for serialization */
  type: "image_reference";
  /** Original image hash for deduplication */
  hash: string;
  /** Path to archived image file */
  archivePath: string;
  /** MIME type of the image */
  mediaType: string;
  /** Original size in bytes */
  originalSize: number;
  /** Extracted text (OCR result) if applicable */
  extractedText?: string;
  /** Visual description if no text extracted */
  description?: string;
  /** Timestamp when archived */
  archivedAt: string;
  /** Original image dimensions */
  dimensions?: { width: number; height: number };
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface ArchiveImageResult {
  /** The image reference (lightweight) */
  reference: ImageReference;
  /** Whether this was a new archive or existing */
  isNew: boolean;
}

export interface ProcessImageResult {
  /** The image reference */
  reference: ImageReference;
  /** Text representation for session storage */
  textRepresentation: string;
}

// ============================================================================
// Archive Path Resolution
// ============================================================================

/**
 * Resolves the base archive directory for images.
 * Default: ~/.clawdbot/archives/images
 */
export function resolveImageArchiveDir(): string {
  // Use ~/.clawdbot as the base data directory
  const homeDir = os.homedir();
  const dataDir = path.join(homeDir, ".clawdbot");
  return path.join(dataDir, "archives", "images");
}

/**
 * Resolves the archive directory for a specific agent and session.
 */
export function resolveSessionImageArchiveDir(agentId: string, sessionId: string): string {
  const baseDir = resolveImageArchiveDir();
  return path.join(baseDir, agentId, sessionId);
}

/**
 * Generates a unique filename for an archived image.
 */
function generateArchiveFilename(hash: string, mediaType: string): string {
  const timestamp = Date.now();
  const ext = mediaType.split("/")[1] || "bin";
  return `${timestamp}-${hash.slice(0, 12)}.${ext}`;
}

// ============================================================================
// Image Hashing
// ============================================================================

/**
 * Computes a SHA-256 hash of image data for deduplication.
 */
export function hashImageData(base64Data: string): string {
  const buffer = Buffer.from(base64Data, "base64");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// ============================================================================
// Archive Operations
// ============================================================================

/**
 * Archives an image to disk, returning a lightweight reference.
 * If the image already exists (by hash), returns the existing reference.
 */
export async function archiveImage(params: {
  agentId: string;
  sessionId: string;
  imageContent: ImageContent;
}): Promise<ArchiveImageResult> {
  const { agentId, sessionId, imageContent } = params;
  const { media_type, data } = imageContent.source;

  // Compute hash for deduplication
  const hash = hashImageData(data);
  const buffer = Buffer.from(data, "base64");
  const originalSize = buffer.length;

  // Resolve archive directory
  const archiveDir = resolveSessionImageArchiveDir(agentId, sessionId);
  await fs.mkdir(archiveDir, { recursive: true });

  // Check if already archived (by hash)
  const existingRef = await findExistingArchive(archiveDir, hash);
  if (existingRef) {
    return { reference: existingRef, isNew: false };
  }

  // Generate filename and write to disk
  const filename = generateArchiveFilename(hash, media_type);
  const archivePath = path.join(archiveDir, filename);
  await fs.writeFile(archivePath, buffer);

  // Create reference
  const reference: ImageReference = {
    type: "image_reference",
    hash,
    archivePath,
    mediaType: media_type,
    originalSize,
    archivedAt: new Date().toISOString(),
  };

  // Write metadata file
  const metaPath = `${archivePath}.meta.json`;
  await fs.writeFile(metaPath, JSON.stringify(reference, null, 2));

  return { reference, isNew: true };
}

/**
 * Finds an existing archive by hash in a directory.
 */
async function findExistingArchive(
  archiveDir: string,
  hash: string,
): Promise<ImageReference | null> {
  try {
    const files = await fs.readdir(archiveDir);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));

    for (const metaFile of metaFiles) {
      try {
        const metaPath = path.join(archiveDir, metaFile);
        const content = await fs.readFile(metaPath, "utf-8");
        const ref = JSON.parse(content) as ImageReference;
        if (ref.hash === hash) {
          return ref;
        }
      } catch {
        // Skip invalid meta files
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return null;
}

/**
 * Loads an archived image back to base64.
 * Used when deep access to original image is needed.
 */
export async function loadArchivedImage(reference: ImageReference): Promise<ImageContent | null> {
  try {
    const buffer = await fs.readFile(reference.archivePath);
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: reference.mediaType,
        data: buffer.toString("base64"),
      },
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Text Extraction (OCR)
// ============================================================================

import { processImage, type ImageProcessorOptions } from "./image-processor.js";

/**
 * Extracts text from an image using vision model.
 */
export async function extractTextFromImage(params: {
  imageContent: ImageContent;
  context?: string;
  options?: ImageProcessorOptions;
}): Promise<{ text: string; isTextContent: boolean; categories: string[] } | null> {
  try {
    const buffer = Buffer.from(params.imageContent.source.data, "base64");
    const mimeType = params.imageContent.source.media_type;

    const result = await processImage({
      imageBuffer: buffer,
      mimeType,
      context: params.context,
      options: params.options,
    });

    return {
      text: result.text,
      isTextContent: result.type === "ocr",
      categories: result.categories,
    };
  } catch (error) {
    console.warn(
      `extractTextFromImage failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Generates a description of an image using vision model.
 */
export async function describeImage(params: {
  imageContent: ImageContent;
  context?: string;
  options?: ImageProcessorOptions;
}): Promise<string | null> {
  try {
    const buffer = Buffer.from(params.imageContent.source.data, "base64");
    const mimeType = params.imageContent.source.media_type;

    const result = await processImage({
      imageBuffer: buffer,
      mimeType,
      context: params.context,
      options: params.options,
    });

    return result.text;
  } catch (error) {
    console.warn(`describeImage failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ============================================================================
// Message Processing
// ============================================================================

/**
 * Processes an image content block, archiving it and extracting text/description.
 * Returns a lightweight text representation suitable for session storage.
 */
export async function processImageForArchive(params: {
  agentId: string;
  sessionId: string;
  imageContent: ImageContent;
  context?: string;
  /** If true, skip OCR/description (faster, for batch processing) */
  skipProcessing?: boolean;
  /** Options for image processing */
  processorOptions?: ImageProcessorOptions;
}): Promise<ProcessImageResult> {
  const { agentId, sessionId, imageContent, context, skipProcessing, processorOptions } = params;

  // Archive the image
  const { reference, isNew } = await archiveImage({
    agentId,
    sessionId,
    imageContent,
  });

  // Try to extract text (OCR) or generate description
  if (isNew && !skipProcessing) {
    try {
      const result = await extractTextFromImage({
        imageContent,
        context,
        options: processorOptions,
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
    } catch (error) {
      console.warn(
        `Image processing failed for archive: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Build text representation
  const textRepresentation = buildTextRepresentation(reference);

  return { reference, textRepresentation };
}

/**
 * Builds a text representation of an image reference.
 */
function buildTextRepresentation(ref: ImageReference): string {
  const parts: string[] = [];

  parts.push(`[Image: ${ref.mediaType}, ${formatBytes(ref.originalSize)}]`);

  if (ref.extractedText) {
    parts.push(`\nExtracted text:\n${ref.extractedText}`);
  } else if (ref.description) {
    parts.push(`\nDescription: ${ref.description}`);
  }

  parts.push(`\n[Archived: ${ref.archivePath}]`);

  return parts.join("");
}

/**
 * Formats bytes to human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// Message Transformation
// ============================================================================

/**
 * Transforms a message's content, replacing images with text references.
 * Returns the transformed content array.
 */
export async function transformMessageImages(params: {
  agentId: string;
  sessionId: string;
  content: unknown[];
  context?: string;
}): Promise<unknown[]> {
  const { agentId, sessionId, content, context } = params;
  const transformed: unknown[] = [];

  for (const block of content) {
    if (isImageContent(block)) {
      const { textRepresentation } = await processImageForArchive({
        agentId,
        sessionId,
        imageContent: block,
        context,
      });
      // Replace image with text block
      transformed.push({
        type: "text",
        text: textRepresentation,
      });
    } else {
      transformed.push(block);
    }
  }

  return transformed;
}

/**
 * Type guard for image content blocks.
 */
function isImageContent(block: unknown): block is ImageContent {
  if (typeof block !== "object" || block === null) return false;
  const obj = block as Record<string, unknown>;
  if (obj.type !== "image") return false;
  if (typeof obj.source !== "object" || obj.source === null) return false;
  const source = obj.source as Record<string, unknown>;
  return source.type === "base64" && typeof source.data === "string";
}

// ============================================================================
// Session History Transformation
// ============================================================================

/**
 * Transforms session history messages, replacing images with lightweight references.
 * This is used when fetching history for agent-to-agent communication.
 */
export async function transformSessionHistoryImages(params: {
  agentId: string;
  sessionId: string;
  messages: unknown[];
}): Promise<unknown[]> {
  const { agentId, sessionId, messages } = params;
  const transformed: unknown[] = [];

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) {
      transformed.push(msg);
      continue;
    }

    const message = msg as Record<string, unknown>;
    const content = message.content;

    if (!Array.isArray(content)) {
      transformed.push(msg);
      continue;
    }

    // Check if any images in content
    const hasImages = content.some(isImageContent);
    if (!hasImages) {
      transformed.push(msg);
      continue;
    }

    // Transform images
    const transformedContent = await transformMessageImages({
      agentId,
      sessionId,
      content,
    });

    transformed.push({
      ...message,
      content: transformedContent,
    });
  }

  return transformed;
}

// ============================================================================
// Cleanup Utilities
// ============================================================================

/**
 * Removes archived images older than the specified age.
 */
export async function cleanupOldArchives(params: {
  maxAgeDays: number;
  dryRun?: boolean;
}): Promise<{ deleted: string[]; totalBytes: number }> {
  const { maxAgeDays, dryRun } = params;
  const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  let totalBytes = 0;

  const baseDir = resolveImageArchiveDir();

  try {
    await walkArchiveDir(baseDir, async (filePath, stat) => {
      if (filePath.endsWith(".meta.json")) return;

      if (stat.mtimeMs < cutoffTime) {
        if (!dryRun) {
          await fs.unlink(filePath).catch(() => {});
          await fs.unlink(`${filePath}.meta.json`).catch(() => {});
        }
        deleted.push(filePath);
        totalBytes += stat.size;
      }
    });
  } catch {
    // Base directory doesn't exist
  }

  return { deleted, totalBytes };
}

/**
 * Walks an archive directory recursively.
 */
async function walkArchiveDir(
  dir: string,
  callback: (filePath: string, stat: { mtimeMs: number; size: number }) => Promise<void>,
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkArchiveDir(fullPath, callback);
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      await callback(fullPath, { mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
}
