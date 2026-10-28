import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../shared/task";
import type { TaskEventOverlay } from "./task-chat-state";
import {
  TASK_HISTORY_FILTERS,
  filterHistoryTasks,
  findNewHistoryTaskIds,
  formatHistoryCreatedAt,
  formatHistoryDuration,
  hasHistoryRefreshTrigger,
  historyDurationMs,
  historyFilterLabel,
  mergeHistoryPages,
} from "./task-history-state";

function createTask(
  id: string,
  createdAt: string,
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    sessionId: "s_1111111111111111",
    goal: `Goal ${id}`,
    outputSchema: null,
    status: "queued",
    createdAt,
    completedAt: null,
    ...overrides,
  };
}

describe("formatHistoryDuration", () => {
  it("uses one decimal second below one minute", () => {
    expect(formatHistoryDuration(0)).toBe("0,0 dtk");
    expect(formatHistoryDuration(800)).toBe("0,8 dtk");
    expect(formatHistoryDuration(12300)).toBe("12,3 dtk");
    expect(formatHistoryDuration(59900)).toBe("59,9 dtk");
  });

  it("uses minutes and seconds from one minute", () => {
    expect(formatHistoryDuration(60000)).toBe("1 mnt 0 dtk");
    expect(formatHistoryDuration(125000)).toBe("2 mnt 5 dtk");
    expect(formatHistoryDuration(3599000)).toBe("59 mnt 59 dtk");
  });

  it("uses hours and minutes from one hour", () => {
    expect(formatHistoryDuration(3600000)).toBe("1 j 0 mnt");
    expect(formatHistoryDuration(3725000)).toBe("1 j 2 mnt");
  });

  it("clamps negative durations to zero", () => {
    expect(formatHistoryDuration(-500)).toBe("0,0 dtk");
  });
});

describe("historyDurationMs", () => {
  const createdAt = "2026-10-28T10:00:00.000Z";

  it("uses completedAt minus createdAt for terminal tasks", () => {
    const task = createTask("t_0000000000000001", createdAt, {
      completedAt: "2026-10-28T10:00:05.500Z",
    });

    expect(historyDurationMs(task, "completed", Date.parse(createdAt))).toBe(
      5500,
    );
  });

  it("uses the current time when a terminal task has no completedAt", () => {
    const task = createTask("t_0000000000000001", createdAt);
    const now = Date.parse("2026-10-28T10:00:03.000Z");

    expect(historyDurationMs(task, "cancelled", now)).toBe(3000);
  });

  it("uses the current time for non-terminal tasks", () => {
    const task = createTask("t_0000000000000001", createdAt, {
      completedAt: "2026-10-28T10:00:02.000Z",
    });
    const now = Date.parse("2026-10-28T10:00:07.000Z");

    expect(historyDurationMs(task, "running", now)).toBe(7000);
  });

  it("falls back to zero for invalid timestamps", () => {
    const task = createTask("t_0000000000000001", "bukan waktu");

    expect(historyDurationMs(task, "running", 1000)).toBe(0);
  });
});

describe("formatHistoryCreatedAt", () => {
  it("keeps invalid input as-is", () => {
    expect(formatHistoryCreatedAt("bukan waktu")).toBe("bukan waktu");
  });

  it("formats valid timestamps with the Indonesian locale", () => {
    const value = "2026-10-28T05:30:00.000Z";
    const expected = new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));

    expect(formatHistoryCreatedAt(value)).toBe(expected);
    expect(formatHistoryCreatedAt(value)).not.toBe(value);
  });
});

describe("mergeHistoryPages", () => {
  it("deduplicates ids with the newest page winning", () => {
    const existing = [
      createTask("t_0000000000000001", "2026-10-28T10:00:00.000Z", {
        goal: "Lama",
      }),
      createTask("t_0000000000000002", "2026-10-28T09:00:00.000Z"),
    ];
    const incoming = [
      createTask("t_0000000000000001", "2026-10-28T10:00:00.000Z", {
        goal: "Baru",
      }),
      createTask("t_0000000000000003", "2026-10-28T11:00:00.000Z"),
    ];

    expect(mergeHistoryPages(existing, incoming)).toEqual([
      expect.objectContaining({ id: "t_0000000000000003" }),
      expect.objectContaining({ id: "t_0000000000000001", goal: "Baru" }),
      expect.objectContaining({ id: "t_0000000000000002" }),
    ]);
  });

  it("orders by createdAt descending then id descending", () => {
    const merged = mergeHistoryPages(
      [],
      [
        createTask("t_0000000000000001", "2026-10-28T10:00:00.000Z"),
        createTask("t_0000000000000002", "2026-10-28T10:00:00.000Z"),
        createTask("t_0000000000000003", "2026-10-28T11:00:00.000Z"),
      ],
    );

    expect(merged.map((task) => task.id)).toEqual([
      "t_0000000000000003",
      "t_0000000000000002",
      "t_0000000000000001",
    ]);
  });

  it("returns an empty list when both pages are empty", () => {
    expect(mergeHistoryPages([], [])).toEqual([]);
  });
});

describe("filterHistoryTasks", () => {
  const running = createTask("t_0000000000000001", "2026-10-28T10:00:00.000Z", {
    status: "running",
  });
  const cancelled = createTask(
    "t_0000000000000002",
    "2026-10-28T09:00:00.000Z",
    { status: "cancelled" },
  );
  const overlays: ReadonlyMap<string, TaskEventOverlay> = new Map([
    [running.id, { status: "completed" }],
    [cancelled.id, { status: "running" }],
  ]);

  it("returns every row for the all filter", () => {
    expect(filterHistoryTasks([running, cancelled], overlays, "all")).toEqual([
      running,
      cancelled,
    ]);
  });

  it("uses the effective terminal overlay status", () => {
    expect(
      filterHistoryTasks([running, cancelled], overlays, "completed"),
    ).toEqual([running]);
    expect(filterHistoryTasks([running, cancelled], overlays, "running")).toEqual(
      [],
    );
  });

  it("keeps a terminal server status over a non-terminal overlay", () => {
    expect(
      filterHistoryTasks([running, cancelled], overlays, "cancelled"),
    ).toEqual([cancelled]);
  });
});

describe("findNewHistoryTaskIds", () => {
  it("returns overlay task ids absent from the loaded list", () => {
    const task = createTask("t_0000000000000001", "2026-10-28T10:00:00.000Z");
    const overlays: ReadonlyMap<string, TaskEventOverlay> = new Map([
      [task.id, { status: "running" }],
      ["t_0000000000000002", { status: "queued" }],
    ]);

    expect(findNewHistoryTaskIds([task], overlays)).toEqual([
      "t_0000000000000002",
    ]);
  });
});

describe("hasHistoryRefreshTrigger", () => {
  const task = createTask("t_0000000000000001", "2026-10-28T10:00:00.000Z", {
    status: "running",
  });

  it("detects the first event of an unknown task", () => {
    const previous: ReadonlyMap<string, TaskEventOverlay> = new Map();
    const next: ReadonlyMap<string, TaskEventOverlay> = new Map([
      [task.id, { status: "running" }],
    ]);

    expect(hasHistoryRefreshTrigger(previous, next, [])).toBe(true);
  });

  it("ignores step updates for a task already in the list", () => {
    const previous: ReadonlyMap<string, TaskEventOverlay> = new Map([
      [task.id, { status: "running", lastStep: step(1) }],
    ]);
    const next: ReadonlyMap<string, TaskEventOverlay> = new Map([
      [task.id, { status: "running", lastStep: step(2) }],
    ]);

    expect(hasHistoryRefreshTrigger(previous, next, [task])).toBe(false);
  });

  it("detects a terminal transition", () => {
    const previous: ReadonlyMap<string, TaskEventOverlay> = new Map([
      [task.id, { status: "running" }],
    ]);
    const next: ReadonlyMap<string, TaskEventOverlay> = new Map([
      [task.id, { status: "completed" }],
    ]);

    expect(hasHistoryRefreshTrigger(previous, next, [task])).toBe(true);
  });

  it("does not repeat the refresh for a terminal overlay already seen", () => {
    const terminal: ReadonlyMap<string, TaskEventOverlay> = new Map([
      [task.id, { status: "failed" }],
    ]);

    expect(hasHistoryRefreshTrigger(terminal, terminal, [task])).toBe(false);
  });

  it("does not repeat the refresh for a filtered-out task on every step", () => {
    const previous: ReadonlyMap<string, TaskEventOverlay> = new Map([
      [task.id, { status: "running" }],
    ]);
    const next: ReadonlyMap<string, TaskEventOverlay> = new Map([
      [task.id, { status: "running", lastStep: step(3) }],
    ]);

    expect(hasHistoryRefreshTrigger(previous, next, [])).toBe(false);
  });
});

describe("historyFilterLabel", () => {
  it("labels every filter in Indonesian", () => {
    expect(TASK_HISTORY_FILTERS).toEqual([
      "all",
      "queued",
      "running",
      "waiting_approval",
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(historyFilterLabel("all")).toBe("Semua status");
    expect(historyFilterLabel("waiting_approval")).toBe("Menunggu persetujuan");
    expect(historyFilterLabel("completed")).toBe("Selesai");
  });
});

function step(index: number): TaskEventOverlay["lastStep"] {
  return {
    index,
    action: "click",
    target: "Tombol",
    url: "https://example.com",
    status: "done",
  };
}

const statuses: readonly TaskStatus[] = [
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
];

describe("TASK_HISTORY_FILTERS", () => {
  it("covers all six task statuses", () => {
    expect(TASK_HISTORY_FILTERS.slice(1)).toEqual(statuses);
  });
});
