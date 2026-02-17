// Copyright (c) 2024-2026 Tianwei Zhou. All rights reserved.
// Licensed under AGPL-3.0. See LICENSE for details.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, beforeEach } from "vitest";
import {
  isBase64ImageBlock,
  isBase64MediaBlock,
  getImageData,
  getMediaData,
  formatBytes,
  estimateBase64Bytes,
  hasBase64Images,
  hasBase64Media,
  replaceImagesWithPlaceholders,
  replaceMediaWithPlaceholders,
  stripImagesFromMessage,
  stripMediaFromMessage,
  logImageStripping,
  logMediaStripping,
  __testing,
} from "./session-image-stripper.js";

describe("session-image-stripper", () => {
  beforeEach(() => {
    __testing.resetLogState();
  });

  describe("isBase64ImageBlock / isBase64MediaBlock", () => {
    it("detects new format image blocks", () => {
      const block = {
        type: "image",
        data: "aGVsbG8=",
        mimeType: "image/png",
      };
      expect(isBase64ImageBlock(block)).toBe(true);
      expect(isBase64MediaBlock(block)).toBe(true);
    });

    it("detects new format audio blocks", () => {
      const block = {
        type: "audio",
        data: "YXVkaW8=",
        mimeType: "audio/mp3",
      };
      expect(isBase64MediaBlock(block)).toBe(true);
    });

    it("detects new format video blocks", () => {
      const block = {
        type: "video",
        data: "dmlkZW8=",
        mimeType: "video/mp4",
      };
      expect(isBase64MediaBlock(block)).toBe(true);
    });

    it("detects old format (Anthropic) image blocks", () => {
      const block = {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "aGVsbG8=",
        },
      };
      expect(isBase64ImageBlock(block)).toBe(true);
    });

    it("detects data URL image blocks", () => {
      const block = {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,aGVsbG8=",
        },
      };
      expect(isBase64ImageBlock(block)).toBe(true);
    });

    it("detects data URL audio blocks", () => {
      const block = {
        type: "audio_url",
        audio_url: {
          url: "data:audio/mp3;base64,YXVkaW8=",
        },
      };
      expect(isBase64MediaBlock(block)).toBe(true);
    });

    it("detects data URL video blocks", () => {
      const block = {
        type: "video_url",
        video_url: {
          url: "data:video/mp4;base64,dmlkZW8=",
        },
      };
      expect(isBase64MediaBlock(block)).toBe(true);
    });

    it("ignores regular URL image blocks", () => {
      const block = {
        type: "image_url",
        image_url: {
          url: "https://example.com/image.png",
        },
      };
      expect(isBase64ImageBlock(block)).toBe(false);
    });

    it("ignores regular URL audio blocks", () => {
      const block = {
        type: "audio_url",
        audio_url: {
          url: "https://example.com/audio.mp3",
        },
      };
      expect(isBase64MediaBlock(block)).toBe(false);
    });

    it("ignores regular URL video blocks", () => {
      const block = {
        type: "video_url",
        video_url: {
          url: "https://example.com/video.mp4",
        },
      };
      expect(isBase64MediaBlock(block)).toBe(false);
    });

    it("ignores text blocks", () => {
      const block = { type: "text", text: "hello" };
      expect(isBase64ImageBlock(block)).toBe(false);
    });

    it("ignores null/undefined", () => {
      expect(isBase64ImageBlock(null)).toBe(false);
      expect(isBase64ImageBlock(undefined)).toBe(false);
    });

    it("ignores malformed blocks", () => {
      expect(isBase64ImageBlock({ type: "image" })).toBe(false);
      expect(isBase64ImageBlock({ type: "image", data: 123 })).toBe(false);
      expect(isBase64ImageBlock({ type: "image", source: {} })).toBe(false);
    });
  });

  describe("getImageData / getMediaData", () => {
    it("extracts data from new format image", () => {
      const block = {
        type: "image" as const,
        data: "aGVsbG8=",
        mimeType: "image/png",
      };
      expect(getImageData(block)).toEqual({
        data: "aGVsbG8=",
        mimeType: "image/png",
      });
      expect(getMediaData(block)).toEqual({
        data: "aGVsbG8=",
        mimeType: "image/png",
      });
    });

    it("extracts data from new format audio", () => {
      const block = {
        type: "audio" as const,
        data: "YXVkaW8=",
        mimeType: "audio/mp3",
      };
      expect(getMediaData(block)).toEqual({
        data: "YXVkaW8=",
        mimeType: "audio/mp3",
      });
    });

    it("extracts data from new format video", () => {
      const block = {
        type: "video" as const,
        data: "dmlkZW8=",
        mimeType: "video/mp4",
      };
      expect(getMediaData(block)).toEqual({
        data: "dmlkZW8=",
        mimeType: "video/mp4",
      });
    });

    it("extracts data from old format", () => {
      const block = {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/jpeg",
          data: "d29ybGQ=",
        },
      };
      expect(getImageData(block)).toEqual({
        data: "d29ybGQ=",
        mimeType: "image/jpeg",
      });
    });

    it("extracts data from data URL image format", () => {
      const block = {
        type: "image_url" as const,
        image_url: {
          url: "data:image/gif;base64,R0lGODlh",
        },
      };
      expect(getImageData(block)).toEqual({
        data: "R0lGODlh",
        mimeType: "image/gif",
      });
    });

    it("extracts data from data URL audio format", () => {
      const block = {
        type: "audio_url" as const,
        audio_url: {
          url: "data:audio/wav;base64,UklGRg==",
        },
      };
      expect(getMediaData(block)).toEqual({
        data: "UklGRg==",
        mimeType: "audio/wav",
      });
    });

    it("extracts data from data URL video format", () => {
      const block = {
        type: "video_url" as const,
        video_url: {
          url: "data:video/webm;base64,GkXfo==",
        },
      };
      expect(getMediaData(block)).toEqual({
        data: "GkXfo==",
        mimeType: "video/webm",
      });
    });

    it("handles data URL without mime type", () => {
      const block = {
        type: "image_url" as const,
        image_url: {
          url: "data:;base64,aGVsbG8=",
        },
      };
      const result = getImageData(block);
      expect(result.data).toBe("aGVsbG8=");
    });
  });

  describe("parseDataUrl", () => {
    it("parses standard data URL", () => {
      const result = __testing.parseDataUrl("data:image/png;base64,aGVsbG8=");
      expect(result).toEqual({
        mimeType: "image/png",
        data: "aGVsbG8=",
      });
    });

    it("parses data URL without base64 marker", () => {
      const result = __testing.parseDataUrl("data:text/plain,hello");
      expect(result).toEqual({
        mimeType: "text/plain",
        data: "hello",
      });
    });

    it("returns null for non-data URLs", () => {
      expect(__testing.parseDataUrl("https://example.com")).toBe(null);
      expect(__testing.parseDataUrl("not a url")).toBe(null);
    });
  });

  describe("formatBytes", () => {
    it("formats bytes", () => {
      expect(formatBytes(500)).toBe("500 B");
    });

    it("formats kilobytes", () => {
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
    });

    it("formats megabytes", () => {
      expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
      expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
    });
  });

  describe("estimateBase64Bytes", () => {
    it("estimates bytes from base64 length", () => {
      // 4 base64 chars = 3 bytes
      expect(estimateBase64Bytes(4)).toBe(3);
      expect(estimateBase64Bytes(8)).toBe(6);
    });
  });

  describe("hasBase64Images / hasBase64Media", () => {
    it("returns true when content has images", () => {
      const content = [
        { type: "text", text: "hello" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ];
      expect(hasBase64Images(content)).toBe(true);
      expect(hasBase64Media(content)).toBe(true);
    });

    it("returns true when content has audio", () => {
      const content = [
        { type: "text", text: "hello" },
        { type: "audio", data: "abc", mimeType: "audio/mp3" },
      ];
      expect(hasBase64Media(content)).toBe(true);
    });

    it("returns true when content has video", () => {
      const content = [
        { type: "text", text: "hello" },
        { type: "video", data: "abc", mimeType: "video/mp4" },
      ];
      expect(hasBase64Media(content)).toBe(true);
    });

    it("returns false when no media", () => {
      const content = [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ];
      expect(hasBase64Images(content)).toBe(false);
      expect(hasBase64Media(content)).toBe(false);
    });

    it("returns false for empty content", () => {
      expect(hasBase64Images([])).toBe(false);
      expect(hasBase64Media([])).toBe(false);
    });
  });

  describe("replaceImagesWithPlaceholders / replaceMediaWithPlaceholders", () => {
    it("replaces images with placeholders", () => {
      const content = [
        { type: "text", text: "before" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "after" },
      ];
      const result = replaceImagesWithPlaceholders(content);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: "text", text: "before" });
      expect(result[2]).toEqual({ type: "text", text: "after" });

      const placeholder = result[1] as { type: string; text: string };
      expect(placeholder.type).toBe("text");
      expect(placeholder.text).toContain("[Image: image/png");
      expect(placeholder.text).toContain("Image data removed");
    });

    it("replaces audio with placeholders", () => {
      const content = [
        { type: "text", text: "before" },
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/mp3" },
        { type: "text", text: "after" },
      ];
      const result = replaceMediaWithPlaceholders(content);

      expect(result).toHaveLength(3);
      const placeholder = result[1] as { type: string; text: string };
      expect(placeholder.type).toBe("text");
      expect(placeholder.text).toContain("[Audio: audio/mp3");
      expect(placeholder.text).toContain("Audio data removed");
    });

    it("replaces video with placeholders", () => {
      const content = [
        { type: "text", text: "before" },
        { type: "video", data: "dmlkZW8=", mimeType: "video/mp4" },
        { type: "text", text: "after" },
      ];
      const result = replaceMediaWithPlaceholders(content);

      expect(result).toHaveLength(3);
      const placeholder = result[1] as { type: string; text: string };
      expect(placeholder.type).toBe("text");
      expect(placeholder.text).toContain("[Video: video/mp4");
      expect(placeholder.text).toContain("Video data removed");
    });

    it("tracks stats when provided for mixed media", () => {
      const content = [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/mp3" },
        { type: "video", data: "dmlkZW8=", mimeType: "video/mp4" },
        { type: "image", data: "dGVzdA==", mimeType: "image/png" },
      ];
      const stats = { totalStripped: 0, byMimeType: {}, totalBytesRemoved: 0 };
      replaceMediaWithPlaceholders(content, stats);

      expect(stats.totalStripped).toBe(4);
      expect(stats.byMimeType).toEqual({
        "image/png": 2,
        "audio/mp3": 1,
        "video/mp4": 1,
      });
      expect(stats.totalBytesRemoved).toBeGreaterThan(0);
    });

    it("tracks stats when provided (legacy)", () => {
      const content = [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
        { type: "image", data: "dGVzdA==", mimeType: "image/png" },
      ];
      const stats = { totalStripped: 0, byMimeType: {}, totalBytesRemoved: 0 };
      replaceImagesWithPlaceholders(content, stats);

      expect(stats.totalStripped).toBe(3);
      expect(stats.byMimeType).toEqual({ "image/png": 2, "image/jpeg": 1 });
      expect(stats.totalBytesRemoved).toBeGreaterThan(0);
    });
  });

  describe("stripImagesFromMessage / stripMediaFromMessage", () => {
    it("strips images from user message", () => {
      const message: AgentMessage = {
        role: "user",
        content: [
          { type: "text", text: "Look at this:" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      };

      const result = stripImagesFromMessage(message);

      expect(result.strippedCount).toBe(1);
      expect((result.message.content as unknown[])[0]).toEqual({
        type: "text",
        text: "Look at this:",
      });
      const placeholder = (result.message.content as { type: string; text: string }[])[1];
      expect(placeholder.type).toBe("text");
      expect(placeholder.text).toContain("[Image:");
    });

    it("strips audio from user message", () => {
      const message: AgentMessage = {
        role: "user",
        content: [
          { type: "text", text: "Listen to this:" },
          { type: "audio", data: "YXVkaW8=", mimeType: "audio/mp3" },
        ],
        timestamp: Date.now(),
      };

      const result = stripMediaFromMessage(message);

      expect(result.strippedCount).toBe(1);
      const placeholder = (result.message.content as { type: string; text: string }[])[1];
      expect(placeholder.type).toBe("text");
      expect(placeholder.text).toContain("[Audio:");
    });

    it("strips video from user message", () => {
      const message: AgentMessage = {
        role: "user",
        content: [
          { type: "text", text: "Watch this:" },
          { type: "video", data: "dmlkZW8=", mimeType: "video/mp4" },
        ],
        timestamp: Date.now(),
      };

      const result = stripMediaFromMessage(message);

      expect(result.strippedCount).toBe(1);
      const placeholder = (result.message.content as { type: string; text: string }[])[1];
      expect(placeholder.type).toBe("text");
      expect(placeholder.text).toContain("[Video:");
    });

    it("returns original message when disabled", () => {
      const message: AgentMessage = {
        role: "user",
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
        timestamp: Date.now(),
      };

      const result = stripImagesFromMessage(message, false);

      expect(result.strippedCount).toBe(0);
      expect(result.message).toBe(message);
    });

    it("returns original message when no media", () => {
      const message: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: "no media here" }],
        timestamp: Date.now(),
      };

      const result = stripMediaFromMessage(message);

      expect(result.strippedCount).toBe(0);
      expect(result.message).toBe(message);
    });

    it("returns original message when content is not array", () => {
      const message: AgentMessage = {
        role: "user",
        content: "just a string",
        timestamp: Date.now(),
      };

      const result = stripImagesFromMessage(message);

      expect(result.strippedCount).toBe(0);
      expect(result.message).toBe(message);
    });

    it("handles all image formats", () => {
      const message: AgentMessage = {
        role: "user",
        content: [
          { type: "image", data: "new", mimeType: "image/png" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "old" } },
          { type: "image_url", image_url: { url: "data:image/gif;base64,url" } },
        ],
        timestamp: Date.now(),
      };

      const result = stripImagesFromMessage(message);

      expect(result.strippedCount).toBe(3);
      const content = result.message.content as { type: string; text: string }[];
      expect(content.every((block) => block.type === "text")).toBe(true);
    });

    it("handles mixed media types", () => {
      const message: AgentMessage = {
        role: "user",
        content: [
          { type: "image", data: "img", mimeType: "image/png" },
          { type: "audio", data: "aud", mimeType: "audio/mp3" },
          { type: "video", data: "vid", mimeType: "video/mp4" },
          { type: "audio_url", audio_url: { url: "data:audio/wav;base64,wav" } },
          { type: "video_url", video_url: { url: "data:video/webm;base64,webm" } },
        ],
        timestamp: Date.now(),
      };

      const result = stripMediaFromMessage(message);

      expect(result.strippedCount).toBe(5);
      const content = result.message.content as { type: string; text: string }[];
      expect(content.every((block) => block.type === "text")).toBe(true);
      expect(content[0].text).toContain("[Image:");
      expect(content[1].text).toContain("[Audio:");
      expect(content[2].text).toContain("[Video:");
      expect(content[3].text).toContain("[Audio:");
      expect(content[4].text).toContain("[Video:");
    });
  });

  describe("logImageStripping / logMediaStripping", () => {
    it("logs immediately for first item", () => {
      // Just verify it doesn't throw
      logImageStripping("user", 1);
    });

    it("batches subsequent logs", () => {
      logImageStripping("user", 1);
      logImageStripping("assistant", 2);
      logImageStripping("user", 3);
      // Should not spam logs
    });

    it("handles forceLog", () => {
      logImageStripping("user", 1, true);
    });

    it("handles zero count", () => {
      logImageStripping("user", 0);
    });

    it("logMediaStripping is an alias for logImageStripping", () => {
      // Just verify it doesn't throw and is callable
      logMediaStripping("user", 1);
    });
  });

  describe("__testing helpers", () => {
    it("getMediaKindLabel returns correct labels", () => {
      expect(__testing.getMediaKindLabel("audio/mp3")).toBe("Audio");
      expect(__testing.getMediaKindLabel("audio/wav")).toBe("Audio");
      expect(__testing.getMediaKindLabel("video/mp4")).toBe("Video");
      expect(__testing.getMediaKindLabel("video/webm")).toBe("Video");
      expect(__testing.getMediaKindLabel("image/png")).toBe("Image");
      expect(__testing.getMediaKindLabel("image/jpeg")).toBe("Image");
      expect(__testing.getMediaKindLabel("unknown")).toBe("Image");
    });

    it("isDataUrlAudioBlock detects audio data URLs", () => {
      expect(
        __testing.isDataUrlAudioBlock({
          type: "audio_url",
          audio_url: { url: "data:audio/mp3;base64,abc" },
        }),
      ).toBe(true);
      expect(
        __testing.isDataUrlAudioBlock({
          type: "audio_url",
          audio_url: { url: "https://example.com/audio.mp3" },
        }),
      ).toBe(false);
    });

    it("isDataUrlVideoBlock detects video data URLs", () => {
      expect(
        __testing.isDataUrlVideoBlock({
          type: "video_url",
          video_url: { url: "data:video/mp4;base64,abc" },
        }),
      ).toBe(true);
      expect(
        __testing.isDataUrlVideoBlock({
          type: "video_url",
          video_url: { url: "https://example.com/video.mp4" },
        }),
      ).toBe(false);
    });
  });
});
