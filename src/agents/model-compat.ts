// Modifications copyright (c) 2024-2026 Tianwei Zhou. All rights reserved.
// Original work copyright OpenClaw contributors, licensed under AGPL-3.0.

import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  // Defense-in-depth: ensure `input` is always defined.
  // The pi-ai Anthropic provider accesses `model?.input.includes("image")`
  // without guarding against `model.input` being undefined, which crashes
  // when the model object was constructed without an explicit `input` array
  // (e.g. forward-compat fallback models or session restoration paths).
  if (!model.input) {
    model.input = ["text"];
  }

  const baseUrl = model.baseUrl ?? "";
  const isZai = model.provider === "zai" || baseUrl.includes("api.z.ai");
  if (!isZai || !isOpenAiCompletionsModel(model)) {
    return model;
  }

  const openaiModel = model;
  const compat = openaiModel.compat ?? undefined;
  if (compat?.supportsDeveloperRole === false) {
    return model;
  }

  openaiModel.compat = compat
    ? { ...compat, supportsDeveloperRole: false }
    : { supportsDeveloperRole: false };
  return openaiModel;
}
