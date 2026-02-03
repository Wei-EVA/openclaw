/**
 * Inbound Image Processor
 *
 * Processes images at message reception time, before they enter the session history.
 * This prevents large base64 images from bloating the session transcript.
 *
 * The flow is:
 * 1. User sends message with images
 * 2. This module intercepts the images before agent processing
 * 3. Images are archived to disk
 * 4. OCR/description is extracted
 * 5. Text representations are returned to be used instead of raw images
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import type { ImageProcessorOptions } from "./image-processor.js";
import { archiveImage, extractTextFromImage, type ImageReference } from "./image-archive.js";

// ============================================================================
// Types
// ============================================================================

export interface InboundImageProcessorOptions {
  /** Skip OCR processing (just archive images) */
  skipOcr?: boolean;
  /** Image processor options for OCR */
  processorOptions?: ImageProcessorOptions;
  /** Maximum size for images to process with OCR (larger images just archived) */
  maxOcrBytes?: number;
  /** Callback when image processing completes */
  onImageProcessed?: (info: {
    originalBytes: number;
    archivePath: string;
    hasText: boolean;
    processingTimeMs: number;
  }) => void;
  /** Callback for errors during processing */
  onError?: (error: Error, imageIndex: number) => void;
}

export interface ProcessedImage {
  /** The original image (for model consumption) */
  image: ImageContent;
  /** The text representation (for session storage) */
  textRepresentation: string;
  /** The archive reference */
  reference: ImageReference;
  /** Processing time in ms */
  processingTimeMs: number;
}

export interface InboundImageProcessResult {
  /** Processed images with text representations */
  processed: ProcessedImage[];
  /** Total bytes saved (original - text representation) */
  bytesSaved: number;
  /** Total processing time in ms */
  totalProcessingTimeMs: number;
  /** Errors encountered during processing */
  errors: Array<{ index: number; message: string }>;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

// ============================================================================
// Main Processing Function
// ============================================================================

/**
 * Processes inbound images, archiving them and extracting text/descriptions.
 * Returns both the original images (for model) and text representations (for storage).
 *
 * This function should be called BEFORE sending images to the agent/model.
 * The text representations can then be stored in the session history instead
 * of the raw base64 data.
 */
export async function processInboundImages(params: {
  images: ImageContent[];
  agentId: string;
  sessionId: string;
  options?: InboundImageProcessorOptions;
}): Promise<InboundImageProcessResult> {
  const { images, agentId, sessionId, options } = params;
  const startTime = Date.now();

  const result: InboundImageProcessResult = {
    processed: [],
    bytesSaved: 0,
    totalProcessingTimeMs: 0,
    errors: [],
  };

  if (images.length === 0) {
    return result;
  }

  const maxOcrBytes = options?.maxOcrBytes ?? 2 * 1024 * 1024; // 2MB default

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const imageStartTime = Date.now();

    try {
      // Convert to our ImageContent format for archiving
      const imageContent = {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mimeType ?? "image/jpeg",
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

      // Try OCR if not skipped and image is not too large
      if (!options?.skipOcr && originalBytes <= maxOcrBytes) {
        try {
          const textResult = await extractTextFromImage({
            imageContent,
            options: options?.processorOptions,
          });

          if (textResult) {
            if (textResult.isTextContent && textResult.text) {
              reference.extractedText = textResult.text;
            } else if (textResult.text) {
              reference.description = textResult.text;
            }

            // Update metadata file
            const fs = await import("node:fs/promises");
            const metaPath = `${reference.archivePath}.meta.json`;
            await fs.writeFile(metaPath, JSON.stringify(reference, null, 2));
          }
        } catch (ocrError) {
          result.errors.push({
            index: i,
            message: `OCR failed: ${ocrError instanceof Error ? ocrError.message : String(ocrError)}`,
          });
        }
      }

      // Build text representation
      const textRep = buildTextRepresentation(reference);
      const textBytes = Buffer.byteLength(textRep, "utf8");
      const processingTimeMs = Date.now() - imageStartTime;

      result.processed.push({
        image,
        textRepresentation: textRep,
        reference,
        processingTimeMs,
      });

      result.bytesSaved += originalBytes - textBytes;

      options?.onImageProcessed?.({
        originalBytes,
        archivePath: reference.archivePath,
        hasText: Boolean(reference.extractedText || reference.description),
        processingTimeMs,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      result.errors.push({
        index: i,
        message: error.message,
      });
      options?.onError?.(error, i);
    }
  }

  result.totalProcessingTimeMs = Date.now() - startTime;
  return result;
}

/**
 * Creates a middleware function that processes images before they reach the agent.
 * Can be used to wrap the image array before passing to agent runner.
 */
export function createInboundImageMiddleware(params: {
  agentId: string;
  sessionId: string;
  options?: InboundImageProcessorOptions;
}): {
  /**
   * Process images and return them unchanged (for model use).
   * The text representations are stored internally for later retrieval.
   */
  processImages: (images: ImageContent[]) => Promise<ImageContent[]>;
  /**
   * Get the text representations for the last processed batch.
   * Call this to get text for session storage.
   */
  getTextRepresentations: () => string[];
  /**
   * Get processing stats for the last batch.
   */
  getLastResult: () => InboundImageProcessResult | null;
} {
  let lastResult: InboundImageProcessResult | null = null;

  return {
    processImages: async (images: ImageContent[]): Promise<ImageContent[]> => {
      if (images.length === 0) {
        lastResult = {
          processed: [],
          bytesSaved: 0,
          totalProcessingTimeMs: 0,
          errors: [],
        };
        return images;
      }

      lastResult = await processInboundImages({
        images,
        agentId: params.agentId,
        sessionId: params.sessionId,
        options: params.options,
      });

      // Return original images for model consumption
      return lastResult.processed.map((p) => p.image);
    },

    getTextRepresentations: (): string[] => {
      if (!lastResult) return [];
      return lastResult.processed.map((p) => p.textRepresentation);
    },

    getLastResult: () => lastResult,
  };
}

/**
 * Simplified function that processes images and returns a combined text block
 * suitable for appending to the user's message in session history.
 */
export async function processAndSummarizeImages(params: {
  images: ImageContent[];
  agentId: string;
  sessionId: string;
  options?: InboundImageProcessorOptions;
}): Promise<{
  /** Combined text summary of all images */
  textSummary: string;
  /** Original images (unmodified, for model use) */
  images: ImageContent[];
  /** Bytes saved by using text instead of base64 */
  bytesSaved: number;
  /** Errors during processing */
  errors: Array<{ index: number; message: string }>;
}> {
  const result = await processInboundImages(params);

  const textParts = result.processed.map((p, i) => {
    const prefix = result.processed.length > 1 ? `[Image ${i + 1}] ` : "";
    return prefix + p.textRepresentation;
  });

  return {
    textSummary: textParts.join("\n\n"),
    images: result.processed.map((p) => p.image),
    bytesSaved: result.bytesSaved,
    errors: result.errors,
  };
}
