import { describe, expect, it } from "vitest";
import type { AgentStep } from "../shared/agent-step";
import type { DomainEvent } from "../shared/event";
import type { Task, TaskStatus } from "../shared/task";
import {
  applyTaskEvent,
  clearOverlayStatuses,
  createEventIdDeduplicator,
  createIdempotencyKey,
  effectiveTaskStatus,
  formatStepAction,
  formatStepLine,
  hasNonTerminalTask,
  isTerminalTaskStatus,
  nextReconnectDelay,
  selectAgentReply,
  sortTasksChronologically,
  taskStatusLabel,
  upsertTask,
} from "./task-chat-state";

function createTask(id: string, status: TaskStatus, createdAt: string): Task {
  return {
    id,
    sessionId: "s_1111111111111111",
    goal: `Goal ${id}`,
    outputSchema: null,
    status,
    createdAt,
    completedAt: null,
  };
}

function createStep(
  index: number,
  verification: AgentStep["result"]["verification"] = null,
): AgentStep {
  return {
    id: `st_${String(index).padStart(16, "0")}`,
    taskId: "t_1111111111111111",
    index,
    action: "click",
    target: "Tombol kirim",
    result: {
      status: "done",
      url: "https://example.com",
      pageChanged: true,
      verification,
    },
    durationMs: 10,
  };
}

const stepEvent: DomainEvent = {
  type: "agent.step",
  taskId: "t_1111111111111111",
  index: 3,
  action: "click",
  target: "Tombol kirim",
  status: "done",
  url: "https://example.com",
  at: "2026-10-28T00:00:00.000Z",
};

const completedEvent: DomainEvent = {
  type: "task.completed",
  taskId: "t_1111111111111111",
  result: { summary: "Formulir terkirim." },
  at: "2026-10-28T00:00:01.000Z",
};

describe("sortTasksChronologically", () => {
  it("orders tasks from oldest to newest without mutating the input", () => {
    const tasks = [
      createTask("t_3333333333333333", "queued", "2026-10-28T03:00:00.000Z"),
      createTask("t_1111111111111111", "queued", "2026-10-28T01:00:00.000Z"),
      createTask("t_2222222222222222", "queued", "2026-10-28T02:00:00.000Z"),
    ];

    expect(sortTasksChronologically(tasks).map((task) => task.id)).toEqual([
      "t_1111111111111111",
      "t_2222222222222222",
      "t_3333333333333333",
    ]);
    expect(tasks[0]?.id).toBe("t_3333333333333333");
  });
});

describe("upsertTask", () => {
  it("appends a task that is not in the conversation", () => {
    const tasks = [
      createTask("t_1111111111111111", "queued", "2026-10-28T01:00:00.000Z"),
    ];
    const added = createTask(
      "t_2222222222222222",
      "queued",
      "2026-10-28T02:00:00.000Z",
    );

    expect(upsertTask(tasks, added).map((task) => task.id)).toEqual([
      "t_1111111111111111",
      "t_2222222222222222",
    ]);
  });

  it("replaces the existing task in place", () => {
    const tasks = [
      createTask("t_1111111111111111", "running", "2026-10-28T01:00:00.000Z"),
      createTask("t_2222222222222222", "queued", "2026-10-28T02:00:00.000Z"),
    ];
    const cancelled = createTask(
      "t_1111111111111111",
      "cancelled",
      "2026-10-28T01:00:00.000Z",
    );

    const next = upsertTask(tasks, cancelled);

    expect(next).toHaveLength(2);
    expect(next[0]?.status).toBe("cancelled");
    expect(next[1]?.id).toBe("t_2222222222222222");
  });
});

describe("isTerminalTaskStatus", () => {
  it("treats completed, failed, and cancelled as terminal", () => {
    expect(isTerminalTaskStatus("completed")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("cancelled")).toBe(true);
  });

  it("treats queued, running, and waiting_approval as non-terminal", () => {
    expect(isTerminalTaskStatus("queued")).toBe(false);
    expect(isTerminalTaskStatus("running")).toBe(false);
    expect(isTerminalTaskStatus("waiting_approval")).toBe(false);
  });
});

describe("effectiveTaskStatus", () => {
  it("uses the task status when there is no overlay status", () => {
    expect(effectiveTaskStatus("running", undefined)).toBe("running");
  });

  it("prefers a terminal overlay over a non-terminal task status", () => {
    expect(effectiveTaskStatus("queued", "completed")).toBe("completed");
  });

  it("prefers a terminal task status over a stale non-terminal overlay", () => {
    expect(effectiveTaskStatus("cancelled", "running")).toBe("cancelled");
  });

  it("uses a non-terminal overlay over a non-terminal task status", () => {
    expect(effectiveTaskStatus("running", "waiting_approval")).toBe(
      "waiting_approval",
    );
  });
});

describe("hasNonTerminalTask", () => {
  it("returns false when every task is terminal", () => {
    const tasks = [
      createTask("t_1111111111111111", "completed", "2026-10-28T01:00:00.000Z"),
      createTask("t_2222222222222222", "cancelled", "2026-10-28T02:00:00.000Z"),
    ];

    expect(hasNonTerminalTask(tasks, new Map())).toBe(false);
  });

  it("uses the overlay status when it is terminal", () => {
    const tasks = [
      createTask("t_1111111111111111", "running", "2026-10-28T01:00:00.000Z"),
    ];

    expect(
      hasNonTerminalTask(tasks, new Map([[tasks[0]!.id, { status: "failed" }]])),
    ).toBe(false);
  });
});

describe("applyTaskEvent", () => {
  it("marks the task running and stores the last agent step", () => {
    const overlays = applyTaskEvent(new Map(), stepEvent);
    const overlay = overlays.get("t_1111111111111111");

    expect(overlay?.lastStep).toEqual({
      index: 3,
      action: "click",
      target: "Tombol kirim",
      url: "https://example.com",
      status: "done",
    });
    expect(overlay?.status).toBe("running");
  });

  it("keeps events isolated per task", () => {
    const other: DomainEvent = {
      ...stepEvent,
      taskId: "t_2222222222222222",
    };
    const overlays = applyTaskEvent(applyTaskEvent(new Map(), stepEvent), other);

    expect(overlays.get("t_1111111111111111")?.lastStep?.index).toBe(3);
    expect(overlays.get("t_2222222222222222")?.lastStep?.index).toBe(3);
  });

  it("marks the task waiting for approval on approval.requested", () => {
    const event: DomainEvent = {
      type: "approval.requested",
      taskId: "t_1111111111111111",
      action: "click",
      target: "Tombol kirim",
      selector: "#kirim",
      highlighted: true,
      category: "send_message",
      at: "2026-10-28T00:00:00.000Z",
    };

    expect(
      applyTaskEvent(new Map(), event).get("t_1111111111111111")?.status,
    ).toBe("waiting_approval");
  });

  it("stores a string completion summary verbatim", () => {
    const overlay = applyTaskEvent(new Map(), completedEvent).get(
      "t_1111111111111111",
    );

    expect(overlay?.status).toBe("completed");
    expect(overlay?.summary).toBe("Formulir terkirim.");
  });

  it("ignores a non-string completion summary", () => {
    const event: DomainEvent = {
      ...completedEvent,
      result: { summary: 42 },
    };
    const overlay = applyTaskEvent(new Map(), event).get(
      "t_1111111111111111",
    );

    expect(overlay?.status).toBe("completed");
    expect(overlay?.summary).toBeUndefined();
  });

  it("stores failure and cancellation reasons verbatim", () => {
    const failed: DomainEvent = {
      type: "task.failed",
      taskId: "t_1111111111111111",
      reason: "Verifikasi tidak dapat dijalankan.",
      at: "2026-10-28T00:00:02.000Z",
    };
    const cancelled: DomainEvent = {
      type: "task.cancelled",
      taskId: "t_1111111111111111",
      reason: "Task dibatalkan.",
      at: "2026-10-28T00:00:03.000Z",
    };

    const afterFailed = applyTaskEvent(new Map(), failed);
    expect(afterFailed.get("t_1111111111111111")).toMatchObject({
      status: "failed",
      reason: "Verifikasi tidak dapat dijalankan.",
    });

    const afterCancelled = applyTaskEvent(afterFailed, cancelled);
    expect(afterCancelled.get("t_1111111111111111")).toMatchObject({
      status: "cancelled",
      reason: "Task dibatalkan.",
    });
  });

  it("ignores deterministic step events", () => {
    const event: DomainEvent = {
      type: "step",
      taskId: "t_1111111111111111",
      action: "click",
      selector: "#kirim",
      at: "2026-10-28T00:00:00.000Z",
    };
    const overlays = new Map([
      ["t_1111111111111111", { status: "running" as const }],
    ]);

    expect(applyTaskEvent(overlays, event)).toBe(overlays);
  });

  it("keeps the last step when a terminal event arrives", () => {
    const overlays = applyTaskEvent(
      applyTaskEvent(new Map(), stepEvent),
      completedEvent,
    );
    const overlay = overlays.get("t_1111111111111111");

    expect(overlay?.status).toBe("completed");
    expect(overlay?.lastStep?.index).toBe(3);
  });
});

describe("clearOverlayStatuses", () => {
  it("drops statuses but keeps summary, reason, and last step", () => {
    const overlays = applyTaskEvent(
      applyTaskEvent(new Map(), stepEvent),
      completedEvent,
    );
    const cleared = clearOverlayStatuses(overlays);
    const overlay = cleared.get("t_1111111111111111");

    expect(overlay?.status).toBeUndefined();
    expect(overlay?.summary).toBe("Formulir terkirim.");
    expect(overlay?.lastStep?.index).toBe(3);
  });
});

describe("selectAgentReply", () => {
  it("shows the queue message for a queued task", () => {
    expect(
      selectAgentReply({ status: "queued", overlay: undefined, steps: [] }),
    ).toBe("Menunggu antrean");
  });

  it("shows only the running message when no step is known", () => {
    expect(
      selectAgentReply({ status: "running", overlay: undefined, steps: [] }),
    ).toBe("Berjalan");
  });

  it("shows the last step while running", () => {
    expect(
      selectAgentReply({
        status: "running",
        overlay: {
          lastStep: {
            index: 2,
            action: "click",
            target: "Tombol kirim",
            url: "https://example.com/kirim?token=rahasia#hasil",
            status: "done",
          },
        },
        steps: [],
      }),
    ).toBe("Berjalan · Langkah 2: mengeklik (selesai)");
  });

  it("falls back to the last loaded step while running", () => {
    expect(
      selectAgentReply({
        status: "running",
        overlay: undefined,
        steps: [
          createStep(1, {
            stepOk: true,
            goalComplete: false,
            reason: "Langkah pertama selesai.",
          }),
          createStep(2),
        ],
      }),
    ).toBe("Berjalan · Langkah 2: mengeklik (selesai)");
  });

  it("shows the approval wait message", () => {
    expect(
      selectAgentReply({
        status: "waiting_approval",
        overlay: undefined,
        steps: [],
      }),
    ).toBe("Menunggu persetujuan operator.");
  });

  it("shows a completion summary verbatim", () => {
    expect(
      selectAgentReply({
        status: "completed",
        overlay: { status: "completed", summary: "Tiga hasil ditemukan." },
        steps: [],
      }),
    ).toBe("Tiga hasil ditemukan.");
  });

  it("falls back to the last step verification reason", () => {
    expect(
      selectAgentReply({
        status: "completed",
        overlay: { status: "completed" },
        steps: [
          createStep(1, {
            stepOk: true,
            goalComplete: false,
            reason: "Langkah pertama selesai.",
          }),
          createStep(2, {
            stepOk: true,
            goalComplete: true,
            reason: "Tujuan tercapai.",
          }),
        ],
      }),
    ).toBe("Tujuan tercapai.");
  });

  it("falls back to the default completion message", () => {
    expect(
      selectAgentReply({
        status: "completed",
        overlay: { status: "completed" },
        steps: [createStep(1)],
      }),
    ).toBe("Task selesai.");
    expect(
      selectAgentReply({
        status: "completed",
        overlay: undefined,
        steps: [],
      }),
    ).toBe("Task selesai.");
  });

  it("shows the failure reason verbatim and its fallback", () => {
    expect(
      selectAgentReply({
        status: "failed",
        overlay: { status: "failed", reason: "Model tidak merespons." },
        steps: [],
      }),
    ).toBe("Model tidak merespons.");
    expect(
      selectAgentReply({ status: "failed", overlay: undefined, steps: [] }),
    ).toBe("Task gagal.");
  });

  it("shows the cancellation reason verbatim and its fallback", () => {
    expect(
      selectAgentReply({
        status: "cancelled",
        overlay: { status: "cancelled", reason: "Nomor tujuan salah." },
        steps: [],
      }),
    ).toBe("Nomor tujuan salah.");
    expect(
      selectAgentReply({ status: "cancelled", overlay: undefined, steps: [] }),
    ).toBe("Task dibatalkan.");
  });
});

describe("taskStatusLabel", () => {
  it("labels every task status in Indonesian", () => {
    expect(taskStatusLabel("queued")).toBe("Menunggu antrean");
    expect(taskStatusLabel("running")).toBe("Berjalan");
    expect(taskStatusLabel("waiting_approval")).toBe("Menunggu persetujuan");
    expect(taskStatusLabel("completed")).toBe("Selesai");
    expect(taskStatusLabel("failed")).toBe("Gagal");
    expect(taskStatusLabel("cancelled")).toBe("Dibatalkan");
  });
});

describe("step labels", () => {
  it("translates known actions and hides unknown English values", () => {
    expect(formatStepAction("click")).toBe("mengeklik");
    expect(formatStepAction("navigate")).toBe("membuka halaman");
    expect(formatStepAction("hover")).toBe("Langkah agent");
  });

  it("formats a step line in Indonesian", () => {
    expect(formatStepLine(2, "type", "failed")).toBe(
      "Langkah 2: mengetik (gagal)",
    );
  });
});

describe("createEventIdDeduplicator", () => {
  it("accepts an id once and rejects duplicates", () => {
    const deduplicator = createEventIdDeduplicator();

    expect(deduplicator.remember("1")).toBe(true);
    expect(deduplicator.remember("1")).toBe(false);
    expect(deduplicator.remember("2")).toBe(true);
  });

  it("keeps at most the given number of ids", () => {
    const deduplicator = createEventIdDeduplicator(3);

    expect(deduplicator.remember("1")).toBe(true);
    expect(deduplicator.remember("2")).toBe(true);
    expect(deduplicator.remember("3")).toBe(true);
    expect(deduplicator.remember("4")).toBe(true);
    expect(deduplicator.size).toBe(3);
    expect(deduplicator.remember("1")).toBe(true);
    expect(deduplicator.remember("3")).toBe(false);
    expect(deduplicator.remember("2")).toBe(true);
  });
});

describe("nextReconnectDelay", () => {
  it("doubles from one second and caps at ten seconds", () => {
    expect(nextReconnectDelay(1000)).toBe(2000);
    expect(nextReconnectDelay(2000)).toBe(4000);
    expect(nextReconnectDelay(4000)).toBe(8000);
    expect(nextReconnectDelay(8000)).toBe(10000);
    expect(nextReconnectDelay(10000)).toBe(10000);
  });
});

describe("createIdempotencyKey", () => {
  it("creates distinct non-empty keys", () => {
    const first = createIdempotencyKey();
    const second = createIdempotencyKey();

    expect(first.length).toBeGreaterThanOrEqual(16);
    expect(first).not.toBe(second);
  });
});
