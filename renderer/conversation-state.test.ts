import { describe, expect, it } from "vitest";
import type { Conversation, Message } from "../shared/conversation";
import type { DomainEvent } from "../shared/event";
import type { Task, TaskStatus } from "../shared/task";
import {
  buildTaskIdSet,
  conversationTitle,
  hasNonTerminalTaskForConversation,
  lastTaskIdForConversation,
  mergeConversations,
  mergeMessages,
  shouldRefetchOnTerminal,
  sortConversations,
  terminalTaskIdsFromOverlayChange,
} from "./conversation-state";
import type { TaskEventOverlay } from "./task-chat-state";

function createConversation(
  id: string,
  updatedAt: string,
  title: string | null = null,
): Conversation {
  return {
    id,
    profileId: "p_1111111111111111",
    title,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt,
  };
}

function createMessage(
  id: string,
  role: Message["role"],
  createdAt: string,
  taskId: string | null = null,
): Message {
  return {
    id,
    conversationId: "cv_1111111111111111",
    role,
    text: `Pesan ${id}`,
    taskId,
    createdAt,
  };
}

function createTask(id: string, status: TaskStatus): Task {
  return {
    id,
    sessionId: "s_1111111111111111",
    goal: `Goal ${id}`,
    outputSchema: null,
    conversationId: "cv_1111111111111111",
    status,
    createdAt: "2026-10-28T00:00:00.000Z",
    completedAt: null,
  };
}

function overlay(status: TaskStatus): TaskEventOverlay {
  return { status };
}

describe("mergeMessages", () => {
  it("merges pages without duplicates and orders oldest first by createdAt then id", () => {
    const first = createMessage(
      "m_1111111111111111",
      "operator",
      "2026-10-28T01:00:00.000Z",
      "t_1111111111111111",
    );
    const second = createMessage(
      "m_2222222222222222",
      "agent",
      "2026-10-28T02:00:00.000Z",
      "t_1111111111111111",
    );
    const third = createMessage(
      "m_3333333333333333",
      "operator",
      "2026-10-28T03:00:00.000Z",
      "t_2222222222222222",
    );
    const fourth = createMessage(
      "m_4444444444444444",
      "agent",
      "2026-10-28T03:00:00.000Z",
      "t_2222222222222222",
    );

    const merged = mergeMessages([second, first], [fourth, third, second]);

    expect(merged.map((message) => message.id)).toEqual([
      "m_1111111111111111",
      "m_2222222222222222",
      "m_3333333333333333",
      "m_4444444444444444",
    ]);
    expect([second, first]).toHaveLength(2);
    expect(first.text).toBe("Pesan m_1111111111111111");
  });

  it("keeps the incoming copy when an id is merged again", () => {
    const existing = createMessage(
      "m_1111111111111111",
      "agent",
      "2026-10-28T01:00:00.000Z",
      "t_1111111111111111",
    );
    const incoming: Message = {
      ...existing,
      text: "Ringkasan terbaru.",
    };

    expect(mergeMessages([existing], [incoming])).toEqual([incoming]);
  });
});

describe("sortConversations", () => {
  it("orders by updatedAt descending and id ascending without mutating the input", () => {
    const older = createConversation(
      "cv_2222222222222222",
      "2026-10-28T01:00:00.000Z",
    );
    const newerB = createConversation(
      "cv_3333333333333333",
      "2026-10-28T03:00:00.000Z",
    );
    const newerA = createConversation(
      "cv_1111111111111111",
      "2026-10-28T03:00:00.000Z",
    );

    const sorted = sortConversations([older, newerB, newerA]);

    expect(sorted.map((conversation) => conversation.id)).toEqual([
      "cv_1111111111111111",
      "cv_3333333333333333",
      "cv_2222222222222222",
    ]);
    expect(older.id).toBe("cv_2222222222222222");
  });
});

describe("mergeConversations", () => {
  it("dedupes by id and keeps the list sorted", () => {
    const stale = createConversation(
      "cv_1111111111111111",
      "2026-10-28T01:00:00.000Z",
      null,
    );
    const fresh = createConversation(
      "cv_1111111111111111",
      "2026-10-28T04:00:00.000Z",
      "Judul baru",
    );
    const other = createConversation(
      "cv_2222222222222222",
      "2026-10-28T02:00:00.000Z",
    );

    const merged = mergeConversations([stale], [other, fresh]);

    expect(merged.map((conversation) => conversation.id)).toEqual([
      "cv_1111111111111111",
      "cv_2222222222222222",
    ]);
    expect(merged[0]?.title).toBe("Judul baru");
  });
});

describe("conversationTitle", () => {
  it("falls back to the Indonesian untitled label", () => {
    expect(
      conversationTitle(
        createConversation("cv_1111111111111111", "2026-10-28T01:00:00.000Z"),
      ),
    ).toBe("Percakapan baru");
    expect(
      conversationTitle(
        createConversation(
          "cv_1111111111111111",
          "2026-10-28T01:00:00.000Z",
          "Riset kontak",
        ),
      ),
    ).toBe("Riset kontak");
  });
});

describe("lastTaskIdForConversation", () => {
  it("returns the task of the newest message that has one", () => {
    const messages = [
      createMessage(
        "m_1111111111111111",
        "operator",
        "2026-10-28T01:00:00.000Z",
        "t_1111111111111111",
      ),
      createMessage(
        "m_2222222222222222",
        "agent",
        "2026-10-28T02:00:00.000Z",
        "t_1111111111111111",
      ),
      createMessage(
        "m_3333333333333333",
        "operator",
        "2026-10-28T03:00:00.000Z",
        "t_2222222222222222",
      ),
      createMessage(
        "m_4444444444444444",
        "agent",
        "2026-10-28T04:00:00.000Z",
        null,
      ),
    ];

    expect(lastTaskIdForConversation(messages)).toBe("t_2222222222222222");
    expect(lastTaskIdForConversation([])).toBeNull();
  });
});

describe("buildTaskIdSet", () => {
  it("collects unique non-null task ids", () => {
    const ids = buildTaskIdSet([
      createMessage(
        "m_1111111111111111",
        "operator",
        "2026-10-28T01:00:00.000Z",
        "t_1111111111111111",
      ),
      createMessage(
        "m_2222222222222222",
        "agent",
        "2026-10-28T02:00:00.000Z",
        "t_1111111111111111",
      ),
      createMessage(
        "m_3333333333333333",
        "operator",
        "2026-10-28T03:00:00.000Z",
        "t_2222222222222222",
      ),
      createMessage(
        "m_4444444444444444",
        "agent",
        "2026-10-28T04:00:00.000Z",
        null,
      ),
    ]);

    expect(Array.from(ids)).toEqual([
      "t_1111111111111111",
      "t_2222222222222222",
    ]);
  });
});

describe("hasNonTerminalTaskForConversation", () => {
  const running = createTask("t_1111111111111111", "running");
  const completed = createTask("t_2222222222222222", "completed");
  const overlays = new Map<string, TaskEventOverlay>([
    ["t_3333333333333333", overlay("completed")],
    ["t_4444444444444444", overlay("failed")],
  ]);

  it("reports a running task in the conversation", () => {
    expect(
      hasNonTerminalTaskForConversation(
        new Set([running.id]),
        [running, completed],
        overlays,
      ),
    ).toBe(true);
  });

  it("treats terminal server state and terminal overlays as finished", () => {
    expect(
      hasNonTerminalTaskForConversation(
        new Set([completed.id]),
        [running, completed],
        overlays,
      ),
    ).toBe(false);
    expect(
      hasNonTerminalTaskForConversation(
        new Set(["t_3333333333333333"]),
        [createTask("t_3333333333333333", "running")],
        overlays,
      ),
    ).toBe(false);
    expect(
      hasNonTerminalTaskForConversation(
        new Set(["t_5555555555555555"]),
        [running, completed],
        overlays,
      ),
    ).toBe(false);
  });

  it("keeps a terminal server status when the overlay is non-terminal", () => {
    const terminalWithRunningOverlay = new Map<string, TaskEventOverlay>([
      [completed.id, overlay("running")],
    ]);

    expect(
      hasNonTerminalTaskForConversation(
        new Set([completed.id]),
        [completed],
        terminalWithRunningOverlay,
      ),
    ).toBe(false);
  });
});

describe("shouldRefetchOnTerminal", () => {
  const known = new Set(["t_1111111111111111"]);
  const completed: DomainEvent = {
    type: "task.completed",
    taskId: "t_1111111111111111",
    result: {},
    at: "2026-10-28T00:00:00.000Z",
  };
  const failed: DomainEvent = {
    type: "task.failed",
    taskId: "t_1111111111111111",
    reason: "Gagal.",
    at: "2026-10-28T00:00:00.000Z",
  };
  const cancelled: DomainEvent = {
    type: "task.cancelled",
    taskId: "t_1111111111111111",
    reason: "Dibatalkan.",
    at: "2026-10-28T00:00:00.000Z",
  };
  const step: DomainEvent = {
    type: "step",
    taskId: "t_1111111111111111",
    action: "click",
    at: "2026-10-28T00:00:00.000Z",
  };

  it("accepts every terminal event for a known task", () => {
    expect(shouldRefetchOnTerminal(completed, known)).toBe(true);
    expect(shouldRefetchOnTerminal(failed, known)).toBe(true);
    expect(shouldRefetchOnTerminal(cancelled, known)).toBe(true);
  });

  it("rejects unknown tasks and non-terminal events", () => {
    expect(
      shouldRefetchOnTerminal(completed, new Set(["t_2222222222222222"])),
    ).toBe(false);
    expect(shouldRefetchOnTerminal(step, known)).toBe(false);
  });
});

describe("terminalTaskIdsFromOverlayChange", () => {
  it("returns tasks that just became terminal inside the conversation", () => {
    const previous = new Map<string, TaskEventOverlay>([
      ["t_1111111111111111", overlay("running")],
      ["t_2222222222222222", overlay("completed")],
    ]);
    const next = new Map<string, TaskEventOverlay>([
      ["t_1111111111111111", overlay("completed")],
      ["t_2222222222222222", overlay("completed")],
      ["t_3333333333333333", overlay("failed")],
    ]);

    expect(
      terminalTaskIdsFromOverlayChange(
        previous,
        next,
        new Set([
          "t_1111111111111111",
          "t_2222222222222222",
          "t_4444444444444444",
        ]),
      ),
    ).toEqual(["t_1111111111111111"]);
  });
});
