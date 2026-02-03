/**
 * Media Processing Module
 *
 * Provides utilities for handling media content (images, audio, video) in Clawdbot.
 * Key features:
 * - Image archiving: Store images on disk, replace inline base64 with text references
 * - OCR: Extract text from images (homework, notes, documents)
 * - Image description: Generate descriptions for non-text images
 * - Session cleanup: Remove/replace images in existing session history
 * - Inbound processing: Handle images at message receipt time
 */

// Image Archive
export {
  archiveImage,
  cleanupOldArchives,
  describeImage,
  extractTextFromImage,
  hashImageData,
  loadArchivedImage,
  processImageForArchive,
  resolveImageArchiveDir,
  resolveSessionImageArchiveDir,
  transformMessageImages,
  transformSessionHistoryImages,
  type ArchiveImageResult,
  type ImageContent,
  type ImageReference,
  type ProcessImageResult,
} from "./image-archive.js";

// Image Processor
export {
  generateImageDescription,
  performOcr,
  processImage,
  type ImageDescription,
  type ImageProcessorOptions,
  type OcrResult,
} from "./image-processor.js";

// Session Image Cleanup
export {
  cleanupAllSessionImages,
  cleanupSessionImages,
  scanSessionsForImages,
  type CleanupOptions,
  type CleanupResult,
} from "./session-image-cleanup.js";

// Session Image Guard
export {
  createImageTransformForToolResult,
  processMessageImages,
  processUserMessageImages,
  type SessionImageGuardOptions,
  type SessionImageGuardStats,
} from "./session-image-guard.js";

// Inbound Image Processor
export {
  createInboundImageMiddleware,
  processAndSummarizeImages,
  processInboundImages,
  type InboundImageProcessorOptions,
  type InboundImageProcessResult,
  type ProcessedImage,
} from "./inbound-image-processor.js";
