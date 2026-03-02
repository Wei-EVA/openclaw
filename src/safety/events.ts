import crypto from "node:crypto";
import type { SafetyEvent, SafetyEventInput } from "./types.js";
import { appendSafetyEvent } from "./event-store.js";

let seq = 0;
const listeners = new Set<(event: SafetyEvent) => void>();

export async function recordSafetyEvent(input: SafetyEventInput): Promise<void> {
  const event: SafetyEvent = {
    ...input,
    id: crypto.randomUUID(),
    ts: Date.now(),
    seq: (seq += 1),
  };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Listener failures should not impact runtime.
    }
  }
  try {
    await appendSafetyEvent(event);
  } catch {
    // Logging failures should never block runtime paths.
  }
}

export function onSafetyEvent(listener: (event: SafetyEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetSafetyEventsForTest(): void {
  seq = 0;
  listeners.clear();
}
