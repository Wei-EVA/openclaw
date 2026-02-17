// Modifications copyright (c) 2024-2026 Tianwei Zhou. All rights reserved.
// Original work copyright OpenClaw contributors, licensed under AGPL-3.0.

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { textToSpeech } from "../../tts/tts.js";
import { readStringParam } from "./common.js";

const TtsToolSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech." }),
  channel: Type.Optional(
    Type.String({ description: "Optional channel id to pick output format (e.g. telegram)." }),
  ),
});

export function createTtsTool(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  agentSessionKey?: string;
  agentTo?: string;
  agentAccountId?: string;
}): AnyAgentTool {
  return {
    label: "TTS",
    name: "tts",
    description:
      "Convert text to speech and send audio. Use when the user requests audio or TTS is enabled.",
    parameters: TtsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const text = readStringParam(params, "text", { required: true });
      const explicitChannel = readStringParam(params, "channel");
      const cfg = opts?.config ?? loadConfig();

      // Determine target channel for TTS format and delivery
      const targetChannel = explicitChannel ?? opts?.agentChannel;

      const result = await textToSpeech({
        text,
        cfg,
        channel: targetChannel,
      });

      if (!result.success || !result.audioPath) {
        return {
          content: [
            {
              type: "text",
              text: result.error ?? "TTS conversion failed",
            },
          ],
          details: { error: result.error },
        };
      }

      // Try to send directly if we have delivery context
      const deliveryChannel = explicitChannel ?? opts?.agentChannel;
      const deliveryTo = opts?.agentTo;

      if (deliveryChannel && deliveryTo && deliveryChannel !== "webchat") {
        try {
          await callGateway({
            method: "send",
            params: {
              to: deliveryTo,
              message: "", // Empty text, just sending audio
              mediaUrl: result.audioPath,
              audioAsVoice: result.voiceCompatible ?? false,
              channel: deliveryChannel,
              accountId: opts?.agentAccountId,
              idempotencyKey: `tts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            },
            timeoutMs: 30_000,
          });

          return {
            content: [{ type: "text", text: "🔊 Audio sent successfully." }],
            details: {
              audioPath: result.audioPath,
              provider: result.provider,
              delivered: true,
              channel: deliveryChannel,
              to: deliveryTo,
            },
          };
        } catch (err) {
          // If direct send fails, fall back to MEDIA path
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`[tts-tool] Direct send failed: ${errorMsg}`);
        }
      }

      // Fallback: return MEDIA path (for webchat or when direct send fails)
      const lines: string[] = [];
      if (result.voiceCompatible) {
        lines.push("[[audio_as_voice]]");
      }
      lines.push(`MEDIA:${result.audioPath}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          audioPath: result.audioPath,
          provider: result.provider,
          delivered: false,
          fallbackReason:
            deliveryChannel === "webchat"
              ? "webchat channel"
              : !deliveryTo
                ? "no delivery target"
                : "unknown",
        },
      };
    },
  };
}
