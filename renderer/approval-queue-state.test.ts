import { describe, expect, it } from "vitest";
import type { Approval } from "../shared/task";
import type { TaskEventOverlay } from "./task-chat-state";
import {
  countWaitingApprovalOverlays,
  filterPendingApprovalsByOverlay,
  formatApprovalAction,
  formatApprovalCategory,
  formatApprovalRequestedAt,
  formatApprovalRequestedAtFull,
  mapWithConcurrency,
  parseApprovalPayload,
  shortTaskId,
  shouldRefetchForWaitingCount,
  sortPendingApprovals,
  validateRejectReason,
} from "./approval-queue-state";

function createApproval(
  id: string,
  taskId: string,
  requestedAt: string,
  overrides: Partial<Approval> = {},
): Approval {
  return {
    id,
    taskId,
    action: "click",
    target: "Tombol kirim",
    payload: {
      selector: "#kirim",
      highlighted: true,
      category: "submit_form",
    },
    decision: "pending",
    requestedAt,
    decidedAt: null,
    ...overrides,
  };
}

describe("sortPendingApprovals", () => {
  it("orders approvals from the oldest request to the newest", () => {
    const approvals = [
      createApproval("a_3333333333333333", "t_3333333333333333", "2026-10-28T03:00:00.000Z"),
      createApproval("a_1111111111111111", "t_1111111111111111", "2026-10-28T01:00:00.000Z"),
      createApproval("a_2222222222222222", "t_2222222222222222", "2026-10-28T02:00:00.000Z"),
    ];

    expect(sortPendingApprovals(approvals).map((item) => item.id)).toEqual([
      "a_1111111111111111",
      "a_2222222222222222",
      "a_3333333333333333",
    ]);
  });

  it("breaks ties by approval id without mutating the input", () => {
    const approvals = [
      createApproval("a_2222222222222222", "t_2222222222222222", "2026-10-28T01:00:00.000Z"),
      createApproval("a_1111111111111111", "t_1111111111111111", "2026-10-28T01:00:00.000Z"),
    ];

    expect(sortPendingApprovals(approvals).map((item) => item.id)).toEqual([
      "a_1111111111111111",
      "a_2222222222222222",
    ]);
    expect(approvals[0]?.id).toBe("a_2222222222222222");
  });
});

describe("filterPendingApprovalsByOverlay", () => {
  it("hides approvals whose task is terminal in the event overlay", () => {
    const approvals = [
      createApproval("a_1111111111111111", "t_1111111111111111", "2026-10-28T01:00:00.000Z"),
      createApproval("a_2222222222222222", "t_2222222222222222", "2026-10-28T02:00:00.000Z"),
      createApproval("a_3333333333333333", "t_3333333333333333", "2026-10-28T03:00:00.000Z"),
      createApproval("a_4444444444444444", "t_4444444444444444", "2026-10-28T04:00:00.000Z"),
      createApproval("a_5555555555555555", "t_5555555555555555", "2026-10-28T05:00:00.000Z"),
    ];
    const overlays = new Map<string, TaskEventOverlay>([
      ["t_1111111111111111", { status: "completed" }],
      ["t_2222222222222222", { status: "failed" }],
      ["t_3333333333333333", { status: "cancelled" }],
      ["t_4444444444444444", { status: "waiting_approval" }],
      ["t_5555555555555555", { status: "running" }],
    ]);

    expect(
      filterPendingApprovalsByOverlay(approvals, overlays).map((item) => item.id),
    ).toEqual(["a_4444444444444444", "a_5555555555555555"]);
  });

  it("keeps approvals without an overlay", () => {
    const approvals = [
      createApproval("a_1111111111111111", "t_1111111111111111", "2026-10-28T01:00:00.000Z"),
    ];

    expect(filterPendingApprovalsByOverlay(approvals, new Map())).toHaveLength(1);
  });
});

describe("countWaitingApprovalOverlays", () => {
  it("counts only overlays currently waiting for approval", () => {
    const overlays = new Map<string, TaskEventOverlay>([
      ["t_1111111111111111", { status: "waiting_approval" }],
      ["t_2222222222222222", { status: "waiting_approval" }],
      ["t_3333333333333333", { status: "running" }],
      ["t_4444444444444444", { status: "cancelled" }],
      ["t_5555555555555555", {}],
    ]);

    expect(countWaitingApprovalOverlays(overlays)).toBe(2);
  });
});

describe("shouldRefetchForWaitingCount", () => {
  it("refetches only when the waiting count grows", () => {
    expect(shouldRefetchForWaitingCount(null, 1)).toBe(false);
    expect(shouldRefetchForWaitingCount(0, 0)).toBe(false);
    expect(shouldRefetchForWaitingCount(1, 1)).toBe(false);
    expect(shouldRefetchForWaitingCount(2, 1)).toBe(false);
    expect(shouldRefetchForWaitingCount(0, 1)).toBe(true);
    expect(shouldRefetchForWaitingCount(1, 2)).toBe(true);
  });
});

describe("formatApprovalAction", () => {
  it("maps known action kinds to Indonesian labels", () => {
    expect(formatApprovalAction("click")).toBe("Klik");
    expect(formatApprovalAction("type")).toBe("Ketik");
    expect(formatApprovalAction("fill")).toBe("Isi");
    expect(formatApprovalAction("scroll")).toBe("Gulir");
    expect(formatApprovalAction("navigate")).toBe("Buka halaman");
    expect(formatApprovalAction("press")).toBe("Tekan");
    expect(formatApprovalAction("select")).toBe("Pilih");
    expect(formatApprovalAction("hover")).toBe("Arahkan");
    expect(formatApprovalAction("extract")).toBe("Ambil data");
  });

  it("falls back for unknown action kinds", () => {
    expect(formatApprovalAction("drag")).toBe("Aksi");
    expect(formatApprovalAction("")).toBe("Aksi");
  });
});

describe("formatApprovalCategory", () => {
  it("maps known risk categories to Indonesian labels", () => {
    expect(formatApprovalCategory("none")).toBe("Aman");
    expect(formatApprovalCategory("send_message")).toBe("Kirim pesan");
    expect(formatApprovalCategory("submit_form")).toBe("Kirim formulir");
    expect(formatApprovalCategory("delete_data")).toBe("Hapus data");
    expect(formatApprovalCategory("payment")).toBe("Pembayaran");
    expect(formatApprovalCategory("upload_file")).toBe("Unggah file");
    expect(formatApprovalCategory("publish_post")).toBe("Publikasikan posting");
    expect(formatApprovalCategory("account_settings")).toBe(
      "Ubah pengaturan akun",
    );
  });

  it("falls back for unknown risk categories", () => {
    expect(formatApprovalCategory("refund")).toBe("Risiko lain");
    expect(formatApprovalCategory("")).toBe("Risiko lain");
  });
});

describe("parseApprovalPayload", () => {
  it("reads selector, highlight flag, and category from the payload", () => {
    expect(
      parseApprovalPayload({
        selector: "xpath=/html[1]/body[1]/button[1]",
        highlighted: true,
        category: "delete_data",
      }),
    ).toEqual({
      selector: "xpath=/html[1]/body[1]/button[1]",
      highlighted: true,
      category: "delete_data",
    });
  });

  it("uses safe defaults for missing or invalid fields", () => {
    expect(
      parseApprovalPayload({
        selector: 42,
        highlighted: "true",
        category: null,
      }),
    ).toEqual({ selector: "", highlighted: false, category: "" });
    expect(parseApprovalPayload({})).toEqual({
      selector: "",
      highlighted: false,
      category: "",
    });
  });
});

describe("approval time formatting", () => {
  it("formats valid timestamps with Intl without exposing the raw ISO value", () => {
    const value = "2026-10-28T01:28:30.327Z";
    const formatted = formatApprovalRequestedAt(value);
    const full = formatApprovalRequestedAtFull(value);

    expect(formatted).toContain("2026");
    expect(formatted).not.toContain("T01");
    expect(full).toContain("2026");
    expect(full).not.toContain("T01");
  });

  it("returns the original value when the timestamp is invalid", () => {
    expect(formatApprovalRequestedAt("bukan waktu")).toBe("bukan waktu");
    expect(formatApprovalRequestedAtFull("bukan waktu")).toBe("bukan waktu");
  });
});

describe("shortTaskId", () => {
  it("keeps the task prefix and a short suffix", () => {
    expect(shortTaskId("t_91bc4f0a2d7e5c33")).toBe("t_91bc4f0a");
  });
});

describe("validateRejectReason", () => {
  it("trims a valid reason", () => {
    expect(validateRejectReason("  Nomor tujuan salah.  ")).toEqual({
      isValid: true,
      reason: "Nomor tujuan salah.",
    });
  });

  it("rejects empty and whitespace-only reasons", () => {
    expect(validateRejectReason("")).toEqual({ isValid: false });
    expect(validateRejectReason("   ")).toEqual({ isValid: false });
  });

  it("accepts 500 characters and rejects 501", () => {
    expect(validateRejectReason("a".repeat(500))).toEqual({
      isValid: true,
      reason: "a".repeat(500),
    });
    expect(validateRejectReason("a".repeat(501))).toEqual({ isValid: false });
  });
});

describe("mapWithConcurrency", () => {
  it("processes every item without exceeding the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];
    const pending: Array<() => void> = [];

    const task = mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(item);
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
      active -= 1;
    });

    expect(started).toEqual([1, 2]);

    while (pending.length > 0) {
      const release = pending.shift();
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    await task;
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(maxActive).toBe(2);
  });

  it("handles an empty list", async () => {
    let calls = 0;

    await mapWithConcurrency([], 4, async () => {
      calls += 1;
    });

    expect(calls).toBe(0);
  });
});
