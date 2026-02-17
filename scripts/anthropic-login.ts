// Copyright (c) 2024-2026 Tianwei Zhou. All rights reserved.
// Licensed under AGPL-3.0. See LICENSE for details.

import { anthropicOAuthProvider } from "@mariozechner/pi-ai";
import { exec } from "child_process";
import * as readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function login() {
  console.log("Starting Anthropic OAuth login...");
  console.log("Browser will open. After authorization, paste the code here.");
  console.log("");

  const credentials = await anthropicOAuthProvider.login({
    onAuth: async ({ url }) => {
      console.log("Opening browser...");
      exec(`open '${url}'`);
    },
    onPrompt: async (_prompt) => {
      return new Promise((resolve) => {
        rl.question("Paste authorization code: ", (answer) => {
          resolve(answer.trim());
        });
      });
    },
  });

  console.log("\n✅ Login successful!");
  console.log("Access token prefix:", credentials.access?.substring(0, 40) + "...");
  console.log("Expires:", new Date(credentials.expires).toISOString());

  // Save to auth-profiles.json
  const { upsertAuthProfile } = await import("../src/agents/auth-profiles.js");
  const { resolveOpenClawAgentDir } = await import("../src/agents/agent-paths.js");

  upsertAuthProfile({
    profileId: "anthropic:claude-cli",
    credential: {
      type: "oauth",
      provider: "anthropic",
      ...credentials,
    },
    agentDir: resolveOpenClawAgentDir(),
  });

  console.log("✅ Credentials saved!");
  rl.close();
}

login().catch((err) => {
  console.error("❌ Login failed:", err.message);
  rl.close();
  process.exit(1);
});
