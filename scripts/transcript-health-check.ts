// Copyright (c) 2024-2026 Tianwei Zhou. All rights reserved.
// Licensed under AGPL-3.0. See LICENSE for details.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CliOptions = {
  root: string;
  json: boolean;
  maxFindings: number;
};

type Finding = {
  file: string;
  line: number;
  id?: string;
  timestamp?: string;
  issues: string[];
};

type Summary = {
  root: string;
  filesScanned: number;
  assistantMessages: number;
  findings: number;
};

type MessageEntry = {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    usage?: unknown;
    stopReason?: unknown;
  };
};

function printUsage() {
  console.log(
    [
      "Usage: node --import tsx scripts/transcript-health-check.ts [options]",
      "",
      "Options:",
      "  --root <path>          Agent sessions root (default: ~/.openclaw/agents)",
      "  --max-findings <n>      Max findings to print (default: 200)",
      "  --json                  Print JSON output",
      "  --help                  Show this help",
    ].join("\n"),
  );
}

function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function parseArgs(argv: string[]): CliOptions | null {
  const opts: CliOptions = {
    root: path.join(os.homedir(), ".openclaw", "agents"),
    json: false,
    maxFindings: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return null;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--root requires a path");
      }
      opts.root = expandHome(value);
      i += 1;
      continue;
    }
    if (arg === "--max-findings") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--max-findings requires a number");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--max-findings must be a positive integer");
      }
      opts.maxFindings = parsed;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

async function collectSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!nextPath.endsWith(".jsonl")) {
        continue;
      }
      if (!nextPath.includes(`${path.sep}sessions${path.sep}`)) {
        continue;
      }
      files.push(nextPath);
    }
  }
  files.sort();
  return files;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validateAssistant(entry: MessageEntry): string[] {
  const issues: string[] = [];
  const message = entry.message;
  if (!message || message.role !== "assistant") {
    return issues;
  }
  const usage =
    message.usage && typeof message.usage === "object"
      ? (message.usage as Record<string, unknown>)
      : undefined;
  if (!usage) {
    issues.push("missing usage");
  } else {
    if (asFiniteNumber(usage.input) === undefined) {
      issues.push("usage.input missing/invalid");
    }
    if (asFiniteNumber(usage.output) === undefined) {
      issues.push("usage.output missing/invalid");
    }
    if (asFiniteNumber(usage.cacheRead) === undefined) {
      issues.push("usage.cacheRead missing/invalid");
    }
    if (asFiniteNumber(usage.cacheWrite) === undefined) {
      issues.push("usage.cacheWrite missing/invalid");
    }
    if (asFiniteNumber(usage.totalTokens) === undefined) {
      issues.push("usage.totalTokens missing/invalid");
    }
  }
  if (typeof message.stopReason !== "string" || message.stopReason.trim().length === 0) {
    issues.push("missing stopReason");
  }
  return issues;
}

async function run(opts: CliOptions): Promise<{ summary: Summary; findings: Finding[] }> {
  const files = await collectSessionFiles(opts.root);
  const findings: Finding[] = [];
  let assistantMessages = 0;

  for (const file of files) {
    let content = "";
    try {
      content = await fs.readFile(file, "utf-8");
    } catch (err) {
      if (findings.length < opts.maxFindings) {
        findings.push({
          file,
          line: 0,
          issues: [`failed to read file: ${err instanceof Error ? err.message : "unknown error"}`],
        });
      }
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw?.trim()) {
        continue;
      }
      let parsed: MessageEntry;
      try {
        parsed = JSON.parse(raw) as MessageEntry;
      } catch {
        if (findings.length < opts.maxFindings) {
          findings.push({
            file,
            line: i + 1,
            issues: ["malformed json line"],
          });
        }
        continue;
      }
      if (parsed.type !== "message" || parsed.message?.role !== "assistant") {
        continue;
      }
      assistantMessages += 1;
      const issues = validateAssistant(parsed);
      if (issues.length === 0) {
        continue;
      }
      if (findings.length < opts.maxFindings) {
        findings.push({
          file,
          line: i + 1,
          id: typeof parsed.id === "string" ? parsed.id : undefined,
          timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
          issues,
        });
      }
    }
  }

  return {
    summary: {
      root: opts.root,
      filesScanned: files.length,
      assistantMessages,
      findings: findings.length,
    },
    findings,
  };
}

function printText(summary: Summary, findings: Finding[]) {
  console.log("Transcript Health Check");
  console.log(`root: ${summary.root}`);
  console.log(`filesScanned: ${summary.filesScanned}`);
  console.log(`assistantMessages: ${summary.assistantMessages}`);
  console.log(`findings: ${summary.findings}`);
  if (findings.length === 0) {
    return;
  }
  console.log("");
  for (const finding of findings) {
    const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    const head = [location, finding.id ? `id=${finding.id}` : "", finding.timestamp ?? ""]
      .filter((part) => part.length > 0)
      .join("  ");
    console.log(`- ${head}`);
    console.log(`  issues: ${finding.issues.join(", ")}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    process.exit(0);
  }
  const result = await run(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result.summary, result.findings);
    if (result.summary.findings > 0) {
      console.log("");
      console.log(
        "Recommendation: rotate to a clean session or normalize malformed assistant entries before next run.",
      );
    }
  }
  process.exit(result.summary.findings > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
