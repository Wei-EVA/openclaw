#!/usr/bin/env npx tsx
/**
 * 一次性脚本：清理 session 历史中的图片
 *
 * 用法：
 *   npx tsx scripts/cleanup-session-images.ts              # 扫描所有 agents
 *   npx tsx scripts/cleanup-session-images.ts --execute    # 执行清理
 *   npx tsx scripts/cleanup-session-images.ts --agent learnlm  # 只处理指定 agent
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { scanSessionsForImages, cleanupAllSessionImages } from "../src/media/session-image-cleanup.js";

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const agentIndex = args.indexOf("--agent");
  const specificAgent = agentIndex >= 0 ? args[agentIndex + 1] : null;

  const clawdbotDir = path.join(os.homedir(), ".clawdbot");
  const agentsDir = path.join(clawdbotDir, "agents");

  // 获取所有 agent 目录
  let agentIds: string[] = [];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    agentIds = entries
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    console.error("❌ Cannot read agents directory:", agentsDir);
    process.exit(1);
  }

  if (specificAgent) {
    if (!agentIds.includes(specificAgent)) {
      console.error(`❌ Agent "${specificAgent}" not found. Available agents: ${agentIds.join(", ")}`);
      process.exit(1);
    }
    agentIds = [specificAgent];
  }

  console.log("🔍 Session Image Cleanup Tool");
  console.log("============================");
  console.log(`Clawdbot directory: ${clawdbotDir}`);
  console.log(`Agents to process: ${agentIds.join(", ")}`);
  console.log(`Mode: ${execute ? "EXECUTE (will modify files)" : "SCAN ONLY (dry run)"}`);
  console.log("");

  let grandTotalImages = 0;
  let grandTotalBytes = 0;
  let grandTotalSessions = 0;
  let grandTotalProcessed = 0;
  let grandBytesSaved = 0;

  for (const agentId of agentIds) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");

    if (!fs.existsSync(sessionsDir)) {
      console.log(`⏭️  Agent "${agentId}": no sessions directory, skipping`);
      continue;
    }

    console.log(`\n📁 Agent: ${agentId}`);
    console.log(`   Sessions directory: ${sessionsDir}`);

    // 扫描统计
    const scan = await scanSessionsForImages({ sessionsDir });
    grandTotalSessions += scan.sessionCount;
    grandTotalImages += scan.totalImages;
    grandTotalBytes += scan.estimatedBytes;

    console.log(`   Sessions: ${scan.sessionCount}, With images: ${scan.sessionsWithImages}`);
    console.log(`   Images: ${scan.totalImages}, Size: ${formatBytes(scan.estimatedBytes)}`);

    if (scan.totalImages === 0) {
      continue;
    }

    if (!execute) {
      continue;
    }

    // 执行清理
    console.log(`   🧹 Cleaning up...`);
    const result = await cleanupAllSessionImages({
      agentId,
      sessionsDir,
      options: {
        dryRun: false,
        skipOcr: false,
        onProgress: (current, total, file) => {
          const pct = Math.round((current / total) * 100);
          process.stdout.write(`\r   [${pct}%] ${current}/${total}: ${path.basename(file)}          `);
        },
      },
    });

    console.log("");
    console.log(`   ✅ Processed: ${result.totalImagesProcessed}/${result.totalImagesFound} images`);
    console.log(`   💾 Saved: ${formatBytes(result.totalBytesSaved)}`);

    grandTotalProcessed += result.totalImagesProcessed;
    grandBytesSaved += result.totalBytesSaved;

    // 显示错误
    const filesWithErrors = result.results.filter(r => r.errors.length > 0);
    if (filesWithErrors.length > 0) {
      console.log(`   ⚠️  Errors in ${filesWithErrors.length} file(s)`);
    }
  }

  // 总结
  console.log("\n" + "=".repeat(40));
  console.log("📊 Summary:");
  console.log(`   Total sessions: ${grandTotalSessions}`);
  console.log(`   Total images found: ${grandTotalImages}`);
  console.log(`   Total size: ${formatBytes(grandTotalBytes)}`);

  if (execute) {
    console.log(`   Images processed: ${grandTotalProcessed}`);
    console.log(`   Bytes saved: ${formatBytes(grandBytesSaved)}`);
    console.log("\n✅ Cleanup complete!");
  } else if (grandTotalImages > 0) {
    console.log("\nℹ️  To execute cleanup, run with --execute flag:");
    console.log("   npx tsx scripts/cleanup-session-images.ts --execute");
    if (specificAgent) {
      console.log(`   npx tsx scripts/cleanup-session-images.ts --execute --agent ${specificAgent}`);
    }
  } else {
    console.log("\n✅ No images to clean up.");
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
