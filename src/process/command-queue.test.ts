// Modifications copyright (c) 2024-2026 Tianwei Zhou. All rights reserved.
// Original work copyright OpenClaw contributors, licensed under AGPL-3.0.

import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticMocks = vi.hoisted(() => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diag: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../logging/diagnostic.js", () => ({
  logLaneEnqueue: diagnosticMocks.logLaneEnqueue,
  logLaneDequeue: diagnosticMocks.logLaneDequeue,
  diagnosticLogger: diagnosticMocks.diag,
}));

import { enqueueCommand, enqueueCommandInLane, getQueueSize } from "./command-queue.js";

describe("command queue", () => {
  beforeEach(() => {
    diagnosticMocks.logLaneEnqueue.mockClear();
    diagnosticMocks.logLaneDequeue.mockClear();
    diagnosticMocks.diag.debug.mockClear();
    diagnosticMocks.diag.info.mockClear();
    diagnosticMocks.diag.warn.mockClear();
    diagnosticMocks.diag.error.mockClear();
  });

  it("runs tasks one at a time in order", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: number[] = [];

    const makeTask = (id: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(id);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return id;
    };

    const results = await Promise.all([
      enqueueCommand(makeTask(1)),
      enqueueCommand(makeTask(2)),
      enqueueCommand(makeTask(3)),
    ]);

    expect(results).toEqual([1, 2, 3]);
    expect(calls).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
    expect(getQueueSize()).toBe(0);
  });

  it("logs enqueue depth after push", async () => {
    const task = enqueueCommand(async () => {});

    expect(diagnosticMocks.logLaneEnqueue).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logLaneEnqueue.mock.calls[0]?.[1]).toBe(1);

    await task;
  });

  it("aborts preemptable task when non-preemptable task enqueues on same lane", async () => {
    const lane = "session:test-preempt";
    const ac = new AbortController();
    let preemptableAborted = false;

    // Preemptable task (heartbeat) runs until aborted.
    const preemptableTask = enqueueCommandInLane(
      lane,
      async () => {
        await new Promise<void>((resolve) => {
          const check = () => {
            if (ac.signal.aborted) {
              preemptableAborted = true;
              resolve();
              return;
            }
            setTimeout(check, 5);
          };
          check();
        });
        return "preempted";
      },
      { preemptable: ac },
    );

    // Give the preemptable task time to start executing.
    await new Promise((r) => setTimeout(r, 15));

    // Non-preemptable task (user message) enqueues — should trigger abort.
    const userTask = enqueueCommandInLane(lane, async () => "user-reply");

    const [preemptResult, userResult] = await Promise.all([preemptableTask, userTask]);

    expect(preemptableAborted).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    expect(preemptResult).toBe("preempted");
    expect(userResult).toBe("user-reply");
    expect(diagnosticMocks.diag.info).toHaveBeenCalledWith(expect.stringContaining("lane preempt"));
  });

  it("does not abort preemptable task when another preemptable task enqueues", async () => {
    const lane = "session:test-no-preempt";
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const task1 = enqueueCommandInLane(
      lane,
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return "first";
      },
      { preemptable: ac1 },
    );

    // Second preemptable task should NOT abort the first.
    const task2 = enqueueCommandInLane(lane, async () => "second", { preemptable: ac2 });

    const [r1, r2] = await Promise.all([task1, task2]);

    expect(ac1.signal.aborted).toBe(false);
    expect(r1).toBe("first");
    expect(r2).toBe("second");
  });

  it("clears preemptable abort when task completes normally", async () => {
    const lane = "session:test-clear";
    const ac = new AbortController();

    await enqueueCommandInLane(lane, async () => "done", { preemptable: ac });

    // After completion, a non-preemptable enqueue should not call abort
    // (no preemptableAbort to abort).
    expect(ac.signal.aborted).toBe(false);
  });

  it("invokes onWait callback when a task waits past the threshold", async () => {
    let waited: number | null = null;
    let queuedAhead: number | null = null;

    // First task holds the queue long enough to trigger wait notice.
    const first = enqueueCommand(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const second = enqueueCommand(async () => {}, {
      warnAfterMs: 5,
      onWait: (ms, ahead) => {
        waited = ms;
        queuedAhead = ahead;
      },
    });

    await Promise.all([first, second]);

    expect(waited).not.toBeNull();
    expect(waited as number).toBeGreaterThanOrEqual(5);
    expect(queuedAhead).toBe(0);
  });
});
