import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCompactionRecoveryNote } from "./session-recovery.js";

describe("buildCompactionRecoveryNote", () => {
  it("extracts recent user/assistant snippets from JSONL transcript", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-recovery-note-"));
    const transcript = path.join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "s1", version: 1, timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "We finished maths and moved to Gaeilge homework." }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Good. Next is vocabulary and one L5 challenge." }],
        },
      }),
    ];
    await fs.writeFile(transcript, `${lines.join("\n")}\n`, "utf-8");

    const note = await buildCompactionRecoveryNote({
      sessionFile: transcript,
      latestUserPrompt: "Please continue from where we stopped.",
    });

    expect(note).toBeTruthy();
    expect(note).toContain("Compaction recovery checkpoint");
    expect(note).toContain("user: We finished maths");
    expect(note).toContain("assistant: Good. Next is vocabulary");
    expect(note).toContain("user(latest): Please continue from where we stopped.");
  });

  it("returns undefined when no recoverable snippets exist", async () => {
    const note = await buildCompactionRecoveryNote({
      sessionFile: "/tmp/does-not-exist-recovery-note.jsonl",
      latestUserPrompt: "   ",
    });
    expect(note).toBeUndefined();
  });

  it("respects maxMessages and per-line truncation limits", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-recovery-note-limit-"));
    const transcript = path.join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "s2", version: 1, timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "message-1 this should be trimmed out by maxMessages" }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "message-2 this should also be trimmed out by maxMessages" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "message-3 with a very long content ".repeat(8),
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "message-4 with a very long content ".repeat(8),
            },
          ],
        },
      }),
    ];
    await fs.writeFile(transcript, `${lines.join("\n")}\n`, "utf-8");

    const note = await buildCompactionRecoveryNote({
      sessionFile: transcript,
      latestUserPrompt: "message-5 latest user continuation",
      maxMessages: 2,
      maxCharsPerLine: 50,
      maxChars: 600,
    });

    expect(note).toBeTruthy();
    expect(note!.length).toBeLessThanOrEqual(600);
    expect(note).not.toContain("message-1");
    expect(note).not.toContain("message-2");
    expect(note).toContain("message-3");
    expect(note).toContain("message-4");
    expect(note).toContain("message-5");
    expect(note).toContain("…");
  });

  it("respects maxChars hard cap", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-recovery-note-hard-cap-"));
    const transcript = path.join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "s2b", version: 1, timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "A long line ".repeat(20) }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Another long line ".repeat(20) }],
        },
      }),
    ];
    await fs.writeFile(transcript, `${lines.join("\n")}\n`, "utf-8");

    const note = await buildCompactionRecoveryNote({
      sessionFile: transcript,
      latestUserPrompt: "Latest continuation line that may be trimmed by cap",
      maxChars: 220,
    });

    expect(note).toBeTruthy();
    expect(note!.length).toBeLessThanOrEqual(220);
    expect(note).toContain("Compaction recovery checkpoint");
    expect(note).toContain("…");
  });

  it("extracts string message content when transcript uses plain string blocks", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-recovery-note-string-"));
    const transcript = path.join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "s3", version: 1, timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "string-content-user" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "string-content-assistant" },
      }),
    ];
    await fs.writeFile(transcript, `${lines.join("\n")}\n`, "utf-8");

    const note = await buildCompactionRecoveryNote({ sessionFile: transcript });
    expect(note).toContain("user: string-content-user");
    expect(note).toContain("assistant: string-content-assistant");
  });
});
