import { describe, expect, it } from "vitest";
import { formatReclaimReport, type ReclaimResult } from "./ports-reclaim.js";

describe("ports-reclaim", () => {
  describe("formatReclaimReport", () => {
    it("returns empty array when no processes killed", () => {
      const result: ReclaimResult = { reclaimed: true, killed: [], errors: [] };
      const report = formatReclaimReport(result, 18789);
      expect(report).toEqual([]);
    });

    it("formats killed clawdbot process", () => {
      const result: ReclaimResult = {
        reclaimed: true,
        killed: [
          {
            pid: 12345,
            command: "node",
            commandLine: "clawdbot-gateway",
            user: "testuser",
            signal: "SIGTERM",
            wasClawdbot: true,
          },
        ],
        errors: [],
      };
      const report = formatReclaimReport(result, 18789);
      expect(report.length).toBeGreaterThan(0);
      expect(report[0]).toContain("18789");
      expect(report[0]).toContain("1 process");
      expect(report.some((line) => line.includes("PID 12345"))).toBe(true);
      expect(report.some((line) => line.includes("[clawdbot]"))).toBe(true);
    });

    it("formats killed non-clawdbot process with OTHER tag", () => {
      const result: ReclaimResult = {
        reclaimed: true,
        killed: [
          {
            pid: 99999,
            command: "python",
            user: "testuser",
            signal: "SIGKILL",
            wasClawdbot: false,
          },
        ],
        errors: [],
      };
      const report = formatReclaimReport(result, 18789);
      expect(report.some((line) => line.includes("[OTHER]"))).toBe(true);
      expect(report.some((line) => line.includes("SIGKILL"))).toBe(true);
    });

    it("includes errors in report", () => {
      const result: ReclaimResult = {
        reclaimed: false,
        killed: [],
        errors: ["Failed to send SIGTERM to pid 123"],
      };
      const report = formatReclaimReport(result, 18789);
      expect(report.some((line) => line.includes("Errors:"))).toBe(true);
      expect(report.some((line) => line.includes("Failed to send SIGTERM"))).toBe(true);
    });
  });
});
