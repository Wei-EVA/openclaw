/**
 * Image Processor Module
 *
 * Provides OCR and description generation for images using vision models.
 * Used by the image archive system to extract meaningful text from images.
 */

import type { ClawdbotConfig } from "../config/config.js";
import { resolveClawdbotAgentDir } from "../agents/agent-paths.js";
import { loadConfig } from "../config/config.js";
import { describeImageWithModel } from "../media-understanding/providers/image.js";

// ============================================================================
// Types
// ============================================================================

export interface ImageProcessorOptions {
  /** Agent directory for model discovery */
  agentDir?: string;
  /** Config for API key resolution */
  config?: ClawdbotConfig;
  /** Preferred model provider */
  provider?: string;
  /** Preferred model ID */
  model?: string;
}

export interface OcrResult {
  /** Extracted text content */
  text: string;
  /** Confidence that this is primarily text content (0-1) */
  textConfidence: number;
  /** Type of content detected */
  contentType: "handwriting" | "printed" | "mixed" | "minimal_text";
}

export interface ImageDescription {
  /** Visual description of the image */
  description: string;
  /** Detected content categories */
  categories: string[];
}

// ============================================================================
// Default Model Configuration
// ============================================================================

const DEFAULT_OCR_PROVIDER = "anthropic";
const DEFAULT_OCR_MODEL = "claude-sonnet-4-20250514";

const DEFAULT_DESCRIPTION_PROVIDER = "anthropic";
const DEFAULT_DESCRIPTION_MODEL = "claude-sonnet-4-20250514";

// ============================================================================
// OCR Prompts
// ============================================================================

const OCR_PROMPT = `Analyze this image and extract any text content.

Your task:
1. If the image contains readable text (handwritten, printed, or typed), extract ALL the text exactly as it appears
2. Preserve the original formatting, line breaks, and structure as much as possible
3. For handwritten content, do your best to transcribe accurately

Output format:
- If text is found, output the extracted text directly
- If no meaningful text is found, output: [NO_TEXT_CONTENT]
- For mixed content (text + images/diagrams), extract the text and note: [Contains non-text elements]

Focus on accuracy. This is likely homework, notes, or educational content from a child.`;

const CONTENT_TYPE_PROMPT = `Briefly classify this image content type. Output ONLY one of:
- HANDWRITING (handwritten text, notes, homework)
- PRINTED (typed/printed text, documents)
- MIXED (combination of text and images/diagrams)
- MINIMAL_TEXT (primarily visual content with little or no text)`;

// ============================================================================
// Description Prompts
// ============================================================================

const DESCRIPTION_PROMPT = `Describe this image in detail. Include:
1. What type of content it is (drawing, photo, diagram, etc.)
2. The main subject or theme
3. Key visual elements and colors
4. Any context that would help understand the image

Keep the description concise but informative (2-4 sentences).
This is likely content from a child's learning activities.`;

// ============================================================================
// Image Processing Functions
// ============================================================================

/**
 * Performs OCR on an image, extracting text content.
 */
export async function performOcr(params: {
  imageBuffer: Buffer;
  mimeType: string;
  options?: ImageProcessorOptions;
}): Promise<OcrResult> {
  const { imageBuffer, mimeType, options } = params;

  const agentDir = options?.agentDir ?? resolveClawdbotAgentDir();
  const cfg = options?.config ?? loadConfig();
  const provider = options?.provider ?? DEFAULT_OCR_PROVIDER;
  const model = options?.model ?? DEFAULT_OCR_MODEL;

  try {
    // First, determine content type
    const contentTypeResult = await describeImageWithModel({
      buffer: imageBuffer,
      fileName: "image",
      mime: mimeType,
      prompt: CONTENT_TYPE_PROMPT,
      provider,
      model,
      cfg,
      agentDir,
      maxTokens: 50,
      timeoutMs: 30000,
    });

    const contentTypeRaw = contentTypeResult.text.toUpperCase().trim();
    let contentType: OcrResult["contentType"] = "minimal_text";

    if (contentTypeRaw.includes("HANDWRITING")) {
      contentType = "handwriting";
    } else if (contentTypeRaw.includes("PRINTED")) {
      contentType = "printed";
    } else if (contentTypeRaw.includes("MIXED")) {
      contentType = "mixed";
    }

    // Skip OCR for minimal text content
    if (contentType === "minimal_text") {
      return {
        text: "",
        textConfidence: 0.1,
        contentType,
      };
    }

    // Perform OCR
    const ocrResult = await describeImageWithModel({
      buffer: imageBuffer,
      fileName: "image",
      mime: mimeType,
      prompt: OCR_PROMPT,
      provider,
      model,
      cfg,
      agentDir,
      maxTokens: 2048,
      timeoutMs: 60000,
    });

    const text = ocrResult.text.trim();

    // Check if no text was found
    if (text.includes("[NO_TEXT_CONTENT]")) {
      return {
        text: "",
        textConfidence: 0.1,
        contentType: "minimal_text",
      };
    }

    // Calculate confidence based on content type and result
    let textConfidence = 0.5;
    if (contentType === "handwriting" || contentType === "printed") {
      textConfidence = 0.85;
    } else if (contentType === "mixed") {
      textConfidence = 0.7;
    }

    return {
      text,
      textConfidence,
      contentType,
    };
  } catch (error) {
    console.warn(`OCR failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      text: "",
      textConfidence: 0,
      contentType: "minimal_text",
    };
  }
}

/**
 * Generates a description of an image.
 */
export async function generateImageDescription(params: {
  imageBuffer: Buffer;
  mimeType: string;
  options?: ImageProcessorOptions;
}): Promise<ImageDescription> {
  const { imageBuffer, mimeType, options } = params;

  const agentDir = options?.agentDir ?? resolveClawdbotAgentDir();
  const cfg = options?.config ?? loadConfig();
  const provider = options?.provider ?? DEFAULT_DESCRIPTION_PROVIDER;
  const model = options?.model ?? DEFAULT_DESCRIPTION_MODEL;

  try {
    const result = await describeImageWithModel({
      buffer: imageBuffer,
      fileName: "image",
      mime: mimeType,
      prompt: DESCRIPTION_PROMPT,
      provider,
      model,
      cfg,
      agentDir,
      maxTokens: 256,
      timeoutMs: 30000,
    });

    return {
      description: result.text.trim(),
      categories: detectCategories(result.text),
    };
  } catch (error) {
    console.warn(
      `Image description failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      description: "Image content could not be analyzed",
      categories: ["unknown"],
    };
  }
}

/**
 * Detects content categories from description text.
 */
function detectCategories(description: string): string[] {
  const categories: string[] = [];
  const lower = description.toLowerCase();

  if (lower.includes("drawing") || lower.includes("sketch") || lower.includes("illustration")) {
    categories.push("artwork");
  }
  if (lower.includes("photo") || lower.includes("photograph")) {
    categories.push("photo");
  }
  if (lower.includes("homework") || lower.includes("assignment") || lower.includes("exercise")) {
    categories.push("homework");
  }
  if (lower.includes("handwrit") || lower.includes("written")) {
    categories.push("handwriting");
  }
  if (lower.includes("diagram") || lower.includes("chart") || lower.includes("graph")) {
    categories.push("diagram");
  }
  if (lower.includes("screen") || lower.includes("screenshot")) {
    categories.push("screenshot");
  }

  if (categories.length === 0) {
    categories.push("general");
  }

  return categories;
}

/**
 * Processes an image, extracting text via OCR or generating a description.
 * Returns the most appropriate text representation.
 */
export async function processImage(params: {
  imageBuffer: Buffer;
  mimeType: string;
  context?: string;
  options?: ImageProcessorOptions;
}): Promise<{
  text: string;
  type: "ocr" | "description";
  confidence: number;
  categories: string[];
}> {
  const { imageBuffer, mimeType, context, options } = params;

  // First try OCR
  const ocrResult = await performOcr({
    imageBuffer,
    mimeType,
    options,
  });

  // If OCR found meaningful text, use it
  if (ocrResult.text && ocrResult.textConfidence >= 0.5) {
    return {
      text: ocrResult.text,
      type: "ocr",
      confidence: ocrResult.textConfidence,
      categories: [ocrResult.contentType],
    };
  }

  // Otherwise, generate a description
  const description = await generateImageDescription({
    imageBuffer,
    mimeType,
    options,
  });

  return {
    text: description.description,
    type: "description",
    confidence: 0.8,
    categories: description.categories,
  };
}
