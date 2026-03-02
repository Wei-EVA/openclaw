import fs from "node:fs/promises";
import path from "node:path";
import type { SafetyEvent } from "./types.js";
import { resolveStateDir } from "../config/paths.js";

function resolveSafetyEventsPath(): string {
  return path.join(resolveStateDir(), "logs", "safety-events.jsonl");
}

export async function appendSafetyEvent(event: SafetyEvent): Promise<void> {
  const filePath = resolveSafetyEventsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
}
