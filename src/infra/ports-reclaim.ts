/**
 * Port reclaim: detect and kill processes occupying a port.
 * Used when Gateway startup fails due to EADDRINUSE.
 */

import { spawnSync } from "node:child_process";
import type { PortListener } from "./ports-types.js";
import { inspectPortUsage } from "./ports-inspect.js";

export type ReclaimResult = {
  reclaimed: boolean;
  killed: KilledProcess[];
  errors: string[];
};

export type KilledProcess = {
  pid: number;
  command?: string;
  commandLine?: string;
  user?: string;
  signal: "SIGTERM" | "SIGKILL";
  wasClawdbot: boolean;
};

function isClawdbotProcess(listener: PortListener): boolean {
  const cmd = listener.commandLine ?? listener.command ?? "";
  return /clawdbot|gateway-daemon|src\/index\.ts|dist\/index\.js/i.test(cmd);
}

function killProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  try {
    const result = spawnSync("kill", [`-${signal === "SIGTERM" ? "TERM" : "KILL"}`, String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    // kill -0 checks if process exists without sending a signal
    const result = spawnSync("kill", ["-0", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Attempt to reclaim a port by killing any processes using it.
 *
 * Strategy:
 * 1. Detect all processes listening on the port
 * 2. For each process:
 *    a. Send SIGTERM, wait up to 3 seconds
 *    b. If still alive, send SIGKILL
 * 3. Report all killed processes (for logging)
 */
export async function reclaimPort(
  port: number,
  opts?: {
    gracePeriodMs?: number;
    log?: (msg: string) => void;
  },
): Promise<ReclaimResult> {
  const gracePeriodMs = opts?.gracePeriodMs ?? 3000;
  const log = opts?.log ?? (() => {});
  const killed: KilledProcess[] = [];
  const errors: string[] = [];

  // Inspect who's using the port
  const usage = await inspectPortUsage(port);

  if (usage.status !== "busy" || usage.listeners.length === 0) {
    return { reclaimed: true, killed, errors };
  }

  log(`Port ${port} is occupied by ${usage.listeners.length} process(es)`);

  for (const listener of usage.listeners) {
    if (!listener.pid) {
      errors.push(`Cannot kill process: PID unknown (address: ${listener.address ?? "unknown"})`);
      continue;
    }

    const pid = listener.pid;
    const wasClawdbot = isClawdbotProcess(listener);
    const processDesc = [
      `pid=${pid}`,
      listener.command && `cmd=${listener.command}`,
      listener.user && `user=${listener.user}`,
      wasClawdbot ? "(clawdbot)" : "(other)",
    ]
      .filter(Boolean)
      .join(" ");

    log(`Killing process: ${processDesc}`);

    // Try SIGTERM first
    if (!killProcess(pid, "SIGTERM")) {
      errors.push(`Failed to send SIGTERM to pid ${pid}`);
      continue;
    }

    // Wait for graceful shutdown
    const checkInterval = 200;
    const maxChecks = Math.ceil(gracePeriodMs / checkInterval);
    let died = false;

    for (let i = 0; i < maxChecks; i++) {
      await sleep(checkInterval);
      if (!isProcessAlive(pid)) {
        died = true;
        break;
      }
    }

    if (died) {
      killed.push({
        pid,
        command: listener.command,
        commandLine: listener.commandLine,
        user: listener.user,
        signal: "SIGTERM",
        wasClawdbot,
      });
      log(`Process ${pid} terminated gracefully`);
      continue;
    }

    // Still alive, use SIGKILL
    log(`Process ${pid} didn't respond to SIGTERM, sending SIGKILL`);
    if (!killProcess(pid, "SIGKILL")) {
      errors.push(`Failed to send SIGKILL to pid ${pid}`);
      continue;
    }

    // Brief wait for SIGKILL
    await sleep(500);

    if (!isProcessAlive(pid)) {
      killed.push({
        pid,
        command: listener.command,
        commandLine: listener.commandLine,
        user: listener.user,
        signal: "SIGKILL",
        wasClawdbot,
      });
      log(`Process ${pid} killed forcefully`);
    } else {
      errors.push(`Process ${pid} survived SIGKILL (permission denied?)`);
    }
  }

  // Verify port is now free
  await sleep(200);
  const recheck = await inspectPortUsage(port);
  const reclaimed = recheck.status !== "busy";

  if (!reclaimed) {
    errors.push(`Port ${port} still occupied after killing ${killed.length} process(es)`);
  }

  return { reclaimed, killed, errors };
}

/**
 * Format killed processes for logging/notification.
 */
export function formatReclaimReport(result: ReclaimResult, port: number): string[] {
  const lines: string[] = [];

  if (result.killed.length === 0 && result.errors.length === 0) {
    return lines;
  }

  if (result.killed.length > 0) {
    lines.push(`⚠️ Port ${port} reclaimed - killed ${result.killed.length} process(es):`);

    for (const proc of result.killed) {
      const parts = [
        `  - PID ${proc.pid}`,
        proc.command && `(${proc.command})`,
        proc.user && `user=${proc.user}`,
        `signal=${proc.signal}`,
        proc.wasClawdbot ? "[clawdbot]" : "[OTHER]",
      ];
      lines.push(parts.filter(Boolean).join(" "));

      if (proc.commandLine && proc.commandLine !== proc.command) {
        lines.push(`    cmdline: ${proc.commandLine.slice(0, 200)}`);
      }
    }
  }

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const err of result.errors) {
      lines.push(`  - ${err}`);
    }
  }

  return lines;
}
