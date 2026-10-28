import { describe, expect, it } from "vitest";
import type { ArgusEvent } from "../shared/client";
import type { DomainEvent } from "../shared/event";
import {
  ACTIVITY_FILTERS,
  MAX_ACTIVITY_ENTRIES,
  activityFilterLabel,
  activityKindLabel,
  appendActivityEntry,
  createActivityEntry,
  filterActivityEntries,
  formatActivityTime,
  type ActivityEntry,
} from "./activity-log-state";

const AT = "2026-10-28T05:30:00.000Z";
const TASK_ID = "t_1111111111111111";
const SHORT_TASK_ID = "t_11111111";

function argusEvent(id: string, event: DomainEvent): ArgusEvent {
  return { id, event };
}

function entry(id: string, overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id,
    kind: "step",
    at: AT,
    text: `Aktivitas ${id}`,
    ...overrides,
  };
}

describe("createActivityEntry", () => {
  it("maps agent.step with Indonesian action and status labels", () => {
    const created = createActivityEntry(
      argusEvent("11", {
        type: "agent.step",
        taskId: TASK_ID,
        index: 3,
        action: "click",
        target: "Tombol kirim",
        status: "done",
        url: "https://example.com/form?q=rahasia#bagian",
        at: AT,
      }),
    );

    expect(created).toEqual({
      id: "11",
      kind: "step",
      at: AT,
      text: "Langkah 3 · mengeklik · selesai · Tombol kirim",
      taskId: SHORT_TASK_ID,
    });
    expect(created.text).not.toContain("rahasia");
    expect(created.text).not.toContain("?");
    expect(created.text).not.toContain("#");
  });

  it("falls back to Indonesian labels for unknown agent actions", () => {
    const created = createActivityEntry(
      argusEvent("12", {
        type: "agent.step",
        taskId: TASK_ID,
        index: 1,
        action: "teleport",
        target: "Panel",
        status: "blocked",
        url: "https://example.com",
        at: AT,
      }),
    );

    expect(created.text).toBe("Langkah 1 · Langkah agen · tertahan · Panel");
  });

  it("truncates the agent target to 80 characters", () => {
    const created = createActivityEntry(
      argusEvent("13", {
        type: "agent.step",
        taskId: TASK_ID,
        index: 2,
        action: "type",
        target: "x".repeat(120),
        status: "failed",
        url: "https://example.com",
        at: AT,
      }),
    );
    const target = created.text.split(" · ").at(-1) ?? "";

    expect(target).toHaveLength(80);
    expect(target.endsWith("…")).toBe(true);
    expect(created.text).not.toContain("x".repeat(120));
  });

  it("maps a manual step with a sanitized page and short task id", () => {
    const created = createActivityEntry(
      argusEvent("14", {
        type: "step",
        taskId: TASK_ID,
        action: "navigate",
        url: "https://example.com/beranda?q=rahasia#bagian",
        selector: "#rahasia",
        at: AT,
      }),
    );

    expect(created).toEqual({
      id: "14",
      kind: "step",
      at: AT,
      text: "Aksi manual · membuka halaman · https://example.com/beranda",
      taskId: SHORT_TASK_ID,
    });
    expect(created.text).not.toContain("rahasia");
    expect(created.text).not.toContain("#");
  });

  it("maps a manual step without a task or page", () => {
    const created = createActivityEntry(
      argusEvent("15", {
        type: "step",
        taskId: null,
        action: "click",
        at: AT,
      }),
    );

    expect(created).toEqual({
      id: "15",
      kind: "step",
      at: AT,
      text: "Aksi manual · mengeklik",
    });
    expect(created.taskId).toBeUndefined();
  });

  it("maps approval.requested without exposing the selector", () => {
    const created = createActivityEntry(
      argusEvent("16", {
        type: "approval.requested",
        taskId: TASK_ID,
        action: "click",
        target: "Tombol hapus",
        selector: "#hapus-rahasia",
        highlighted: true,
        category: "delete_data",
        at: AT,
      }),
    );

    expect(created).toEqual({
      id: "16",
      kind: "approval",
      at: AT,
      text: "Persetujuan diminta · Klik · Hapus data · Tombol hapus",
      taskId: SHORT_TASK_ID,
    });
    expect(created.text).not.toContain("hapus-rahasia");
  });

  it("falls back to Indonesian approval labels and truncates the target", () => {
    const created = createActivityEntry(
      argusEvent("17", {
        type: "approval.requested",
        taskId: TASK_ID,
        action: "unknown",
        target: "y".repeat(100),
        selector: "",
        highlighted: false,
        category: "unknown",
        at: AT,
      }),
    );
    const target = created.text.split(" · ").at(-1) ?? "";

    expect(created.text.startsWith("Persetujuan diminta · Aksi · Risiko lain · ")).toBe(
      true,
    );
    expect(target).toHaveLength(80);
  });

  it("maps task.completed with and without a string summary", () => {
    const withSummary = createActivityEntry(
      argusEvent("18", {
        type: "task.completed",
        taskId: TASK_ID,
        result: { summary: "Semua kolom terisi." },
        at: AT,
      }),
    );
    const withoutSummary = createActivityEntry(
      argusEvent("19", {
        type: "task.completed",
        taskId: TASK_ID,
        result: { summary: 42 },
        at: AT,
      }),
    );

    expect(withSummary).toEqual({
      id: "18",
      kind: "completed",
      at: AT,
      text: "Tugas selesai · Semua kolom terisi.",
      taskId: SHORT_TASK_ID,
    });
    expect(withoutSummary.text).toBe("Tugas selesai.");
  });

  it("maps task.failed and truncates the reason to 160 characters", () => {
    const created = createActivityEntry(
      argusEvent("20", {
        type: "task.failed",
        taskId: TASK_ID,
        reason: "z".repeat(200),
        at: AT,
      }),
    );
    const reason = created.text.replace("Tugas gagal · ", "");

    expect(created.kind).toBe("failed");
    expect(created.text.startsWith("Tugas gagal · ")).toBe(true);
    expect(reason).toHaveLength(160);
    expect(reason.endsWith("…")).toBe(true);
    expect(created.text).not.toContain("z".repeat(200));
  });

  it("maps task.cancelled with the Indonesian reason", () => {
    const created = createActivityEntry(
      argusEvent("21", {
        type: "task.cancelled",
        taskId: TASK_ID,
        reason: "Waktu persetujuan habis.",
        at: AT,
      }),
    );

    expect(created).toEqual({
      id: "21",
      kind: "cancelled",
      at: AT,
      text: "Tugas dibatalkan · Waktu persetujuan habis.",
      taskId: SHORT_TASK_ID,
    });
  });
});

describe("appendActivityEntry", () => {
  it("prepends the newest entry", () => {
    const current = [entry("1")];
    const next = appendActivityEntry(current, entry("2"));

    expect(next.map((item) => item.id)).toEqual(["2", "1"]);
    expect(current.map((item) => item.id)).toEqual(["1"]);
  });

  it("ignores an entry whose id is already present", () => {
    const current = [entry("2"), entry("1")];

    expect(appendActivityEntry(current, entry("1"))).toBe(current);
  });

  it("keeps at most 500 entries with the newest first", () => {
    let entries: readonly ActivityEntry[] = [];

    for (let index = 1; index <= MAX_ACTIVITY_ENTRIES + 5; index += 1) {
      entries = appendActivityEntry(entries, entry(String(index)));
    }

    expect(entries).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(entries[0]?.id).toBe("505");
    expect(entries.at(-1)?.id).toBe("6");
  });
});

describe("filterActivityEntries", () => {
  const entries: readonly ActivityEntry[] = [
    entry("1", {
      kind: "step",
      text: "Langkah 1 · mengeklik · selesai · Tombol hapus",
      taskId: SHORT_TASK_ID,
    }),
    entry("2", {
      kind: "approval",
      text: "Persetujuan diminta · Klik · Hapus data · Tombol hapus",
      taskId: "t_22222222",
    }),
    entry("3", {
      kind: "completed",
      text: "Tugas selesai · Semua kolom terisi.",
      taskId: "t_33333333",
    }),
    entry("4", {
      kind: "failed",
      text: "Tugas gagal · Jaringan tidak tersedia.",
      taskId: "t_44444444",
    }),
    entry("5", {
      kind: "cancelled",
      text: "Tugas dibatalkan · Jaringan tidak tersedia.",
      taskId: "t_55555555",
    }),
  ];

  it("filters both step sources under the step kind", () => {
    const agentStep = entry("6", {
      kind: "step",
      text: "Langkah 2 · mengetik · selesai · Email",
      taskId: SHORT_TASK_ID,
    });

    expect(
      filterActivityEntries([...entries, agentStep], "step", "").map(
        (item) => item.id,
      ),
    ).toEqual(["1", "6"]);
  });

  it("returns every entry for a blank query", () => {
    expect(filterActivityEntries(entries, "all", "   ")).toEqual(entries);
  });

  it("matches the query case-insensitively and trims it", () => {
    expect(
      filterActivityEntries(entries, "all", "  HaPuS  ").map((item) => item.id),
    ).toEqual(["1", "2"]);
  });

  it("matches the short task id", () => {
    expect(
      filterActivityEntries(entries, "all", SHORT_TASK_ID).map(
        (item) => item.id,
      ),
    ).toEqual(["1"]);
  });

  it("combines kind filter and text query", () => {
    expect(
      filterActivityEntries(entries, "failed", "jaringan").map(
        (item) => item.id,
      ),
    ).toEqual(["4"]);
    expect(filterActivityEntries(entries, "cancelled", "jaringan")).toEqual([
      entries[4],
    ]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterActivityEntries(entries, "all", "tidak ada")).toEqual([]);
  });
});

describe("activityFilterLabel", () => {
  it("labels every filter in Indonesian", () => {
    expect(ACTIVITY_FILTERS).toEqual([
      "all",
      "step",
      "approval",
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(activityFilterLabel("all")).toBe("Semua");
    expect(activityFilterLabel("step")).toBe("Langkah");
    expect(activityFilterLabel("approval")).toBe("Persetujuan");
    expect(activityFilterLabel("completed")).toBe("Selesai");
    expect(activityFilterLabel("failed")).toBe("Gagal");
    expect(activityFilterLabel("cancelled")).toBe("Dibatalkan");
  });

  it("labels every kind in Indonesian", () => {
    expect(activityKindLabel("step")).toBe("Langkah");
    expect(activityKindLabel("approval")).toBe("Persetujuan");
    expect(activityKindLabel("completed")).toBe("Selesai");
    expect(activityKindLabel("failed")).toBe("Gagal");
    expect(activityKindLabel("cancelled")).toBe("Dibatalkan");
  });
});

describe("formatActivityTime", () => {
  it("formats a timestamp as local HH:MM:SS", () => {
    expect(formatActivityTime(AT)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("keeps invalid input as-is", () => {
    expect(formatActivityTime("bukan waktu")).toBe("bukan waktu");
  });
});
