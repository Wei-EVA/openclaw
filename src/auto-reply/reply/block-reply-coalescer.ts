// Modifications copyright (c) 2024-2026 Tianwei Zhou. All rights reserved.
// Original work copyright OpenClaw contributors, licensed under AGPL-3.0.

import type { ReplyPayload } from "../types.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";
import { logVerbose } from "../../globals.js";

export type BlockReplyCoalescer = {
  enqueue: (payload: ReplyPayload) => void;
  flush: (options?: { force?: boolean }) => Promise<void>;
  hasBuffered: () => boolean;
  stop: () => void;
};

export function createBlockReplyCoalescer(params: {
  config: BlockStreamingCoalescing;
  shouldAbort: () => boolean;
  onFlush: (payload: ReplyPayload) => Promise<void> | void;
}): BlockReplyCoalescer {
  const { config, shouldAbort, onFlush } = params;
  const minChars = Math.max(1, Math.floor(config.minChars));
  const maxChars = Math.max(minChars, Math.floor(config.maxChars));
  const idleMs = Math.max(0, Math.floor(config.idleMs));
  const joiner = config.joiner ?? "";
  const flushOnEnqueue = config.flushOnEnqueue === true;

  let bufferText = "";
  let bufferReplyToId: ReplyPayload["replyToId"];
  let bufferAudioAsVoice: ReplyPayload["audioAsVoice"];
  let idleTimer: NodeJS.Timeout | undefined;
  // Track pending flush operations to ensure they complete before new operations
  let flushChain: Promise<void> = Promise.resolve();

  const clearIdleTimer = () => {
    if (!idleTimer) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const resetBuffer = () => {
    bufferText = "";
    bufferReplyToId = undefined;
    bufferAudioAsVoice = undefined;
  };

  const scheduleIdleFlush = () => {
    if (idleMs <= 0) {
      return;
    }
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      // Chain the idle flush to preserve ordering
      flushChain = flushChain
        .then(() => flushInternal({ force: false }))
        .catch((err) => {
          logVerbose(`block-reply-coalescer: idle flush error: ${String(err)}`);
        });
    }, idleMs);
  };

  const flushInternal = async (options?: { force?: boolean }) => {
    clearIdleTimer();
    if (shouldAbort()) {
      resetBuffer();
      return;
    }
    if (!bufferText) {
      return;
    }
    if (!options?.force && !flushOnEnqueue && bufferText.length < minChars) {
      scheduleIdleFlush();
      return;
    }
    const payload: ReplyPayload = {
      text: bufferText,
      replyToId: bufferReplyToId,
      audioAsVoice: bufferAudioAsVoice,
    };
    resetBuffer();
    await onFlush(payload);
  };

  const flush = async (options?: { force?: boolean }) => {
    // Chain flush operations to ensure proper ordering
    const flushPromise = flushChain.then(() => flushInternal(options));
    flushChain = flushPromise.catch((err) => {
      logVerbose(`block-reply-coalescer: flush error: ${String(err)}`);
    });
    await flushPromise;
  };

  // Helper to chain onFlush calls through the flush chain for proper ordering
  const chainedOnFlush = (payload: ReplyPayload) => {
    flushChain = flushChain
      .then(() => onFlush(payload))
      .catch((err) => {
        logVerbose(`block-reply-coalescer: onFlush error: ${String(err)}`);
      });
  };

  const enqueue = (payload: ReplyPayload) => {
    if (shouldAbort()) {
      return;
    }
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    const text = payload.text ?? "";
    const hasText = text.trim().length > 0;
    if (hasMedia) {
      // Chain media payload through flush chain to preserve ordering
      flushChain = flushChain
        .then(() => flushInternal({ force: true }))
        .then(() => onFlush(payload))
        .catch((err) => {
          logVerbose(`block-reply-coalescer: media flush error: ${String(err)}`);
        });
      return;
    }
    if (!hasText) {
      return;
    }

    // When flushOnEnqueue is set (chunkMode="newline"), each enqueued payload is treated
    // as a separate paragraph and flushed immediately so delivery matches streaming boundaries.
    // We capture the payload at enqueue time and send it directly via the chain,
    // rather than relying on the buffer (which could be overwritten by subsequent enqueues
    // before the chain runs).
    if (flushOnEnqueue) {
      const capturedPayload: ReplyPayload = {
        text,
        replyToId: payload.replyToId,
        audioAsVoice: payload.audioAsVoice,
      };
      flushChain = flushChain
        .then(() => onFlush(capturedPayload))
        .catch((err) => {
          logVerbose(`block-reply-coalescer: flushOnEnqueue error: ${String(err)}`);
        });
      return;
    }

    if (
      bufferText &&
      (bufferReplyToId !== payload.replyToId || bufferAudioAsVoice !== payload.audioAsVoice)
    ) {
      flushChain = flushChain
        .then(() => flushInternal({ force: true }))
        .catch((err) => {
          logVerbose(`block-reply-coalescer: context change flush error: ${String(err)}`);
        });
    }

    if (!bufferText) {
      bufferReplyToId = payload.replyToId;
      bufferAudioAsVoice = payload.audioAsVoice;
    }

    const nextText = bufferText ? `${bufferText}${joiner}${text}` : text;
    if (nextText.length > maxChars) {
      if (bufferText) {
        flushChain = flushChain
          .then(() => flushInternal({ force: true }))
          .catch((err) => {
            logVerbose(`block-reply-coalescer: overflow flush error: ${String(err)}`);
          });
        bufferReplyToId = payload.replyToId;
        bufferAudioAsVoice = payload.audioAsVoice;
        if (text.length >= maxChars) {
          chainedOnFlush(payload);
          return;
        }
        bufferText = text;
        scheduleIdleFlush();
        return;
      }
      chainedOnFlush(payload);
      return;
    }

    bufferText = nextText;
    if (bufferText.length >= maxChars) {
      flushChain = flushChain
        .then(() => flushInternal({ force: true }))
        .catch((err) => {
          logVerbose(`block-reply-coalescer: max length flush error: ${String(err)}`);
        });
      return;
    }
    scheduleIdleFlush();
  };

  return {
    enqueue,
    flush,
    hasBuffered: () => Boolean(bufferText),
    stop: () => clearIdleTimer(),
  };
}
