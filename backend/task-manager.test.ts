import { describe, expect, it } from "vitest";
import type { Session } from "../shared/session";
import type { DomainEvent } from "../shared/event";
import { TaskError } from "./task-errors";
import type { TaskErrorCode } from "../shared/task";
import { createEventBus } from "./event-bus";
import { createTaskManager, type TaskSessionSource } from "./task-manager";

const readySessionId = "s_0000000000000001";
const secondReadySessionId = "s_0000000000000003";
const startingSessionId = "s_0000000000000002";

function createSessions(): TaskSessionSource {
  const sessions = new Map<string, Session>();
  for (const sessionId of [readySessionId, secondReadySessionId]) {
    sessions.set(sessionId, {
      id: sessionId,
      profileId: "p_0000000000000001",
      status: "ready",
      startedAt: "2026-10-25T09:00:00.000Z",
      endedAt: null,
      pid: null,
    });
  }
  sessions.set(startingSessionId, {
    id: startingSessionId,
    profileId: "p_0000000000000002",
    status: "starting",
    startedAt: "2026-10-25T09:00:00.000Z",
    endedAt: null,
    pid: null,
  });
  return { get: (sessionId) => sessions.get(sessionId) ?? null };
}

function createHarness() {
  let currentTime = new Date("2026-10-25T10:00:00.000Z");
  const events = createEventBus();
  const tasks = createTaskManager({
    sessions: createSessions(),
    events,
    now: () => currentTime,
  });

  return {
    tasks,
    events,
    advance(milliseconds: number) {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
    get currentTime() {
      return currentTime;
    },
  };
}

function expectTaskError(action: () => unknown, code: TaskErrorCode): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).code).toBe(code);
    return;
  }
  throw new Error(`Expected TaskError ${code}`);
}

function eventTypes(events: readonly DomainEvent[]): string[] {
  return events.map((event) => event.type);
}

function makeWaitingTask(harness: ReturnType<typeof createHarness>, key = "key-approval") {
  const created = harness.tasks.createTask(
    readySessionId,
    { goal: "Kirim pesan", outputSchema: { result: "string" } },
    key,
  );
  harness.tasks.startTask(created.id);
  const approval = harness.tasks.requestApproval(created.id, {
    action: "send_message",
    payload: {
      selector: "#kirim",
      highlighted: true,
      category: "send_message",
    },
    target: "#kirim",
    selector: "#kirim",
    highlighted: true,
    category: "send_message",
  });
  const task = harness.tasks.getTask(created.id);
  if (task === null) {
    throw new Error("Task must exist.");
  }
  return { task, approval };
}

describe("task creation", () => {
  it("creates a queued task with the session and defaults", () => {
    const harness = createHarness();
    const task = harness.tasks.createTask(
      readySessionId,
      { goal: "Buka halaman" },
      "key-create",
    );

    expect(task.id).toMatch(/^t_[0-9a-f]{16}$/);
    expect(task.sessionId).toBe(readySessionId);
    expect(task.goal).toBe("Buka halaman");
    expect(task.kind).toBe("agent");
    expect(task.research).toBeNull();
    expect(task.outputSchema).toBeNull();
    expect(task.status).toBe("queued");
    expect(task.createdAt).toBe("2026-10-25T10:00:00.000Z");
    expect(task.completedAt).toBeNull();
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(1);
    expect(eventTypes(harness.events.list().map((entry) => entry.event))).toEqual([]);
  });

  it("creates a research task with a normalized target", () => {
    const harness = createHarness();
    const withOrganization = harness.tasks.createTask(
      readySessionId,
      {
        goal: "Cari kontak Budi",
        kind: "research",
        research: { targetName: "Budi Santoso", organization: "PT Contoh" },
      },
      "key-research",
    );
    const withoutOrganization = harness.tasks.createTask(
      readySessionId,
      {
        goal: "Cari kontak Sari",
        kind: "research",
        research: { targetName: "Sari" },
      },
      "key-research-no-org",
    );

    expect(withOrganization.kind).toBe("research");
    expect(withOrganization.research).toEqual({
      targetName: "Budi Santoso",
      organization: "PT Contoh",
    });
    expect(withoutOrganization.kind).toBe("research");
    expect(withoutOrganization.research).toEqual({
      targetName: "Sari",
      organization: null,
    });
  });

  it("rejects an unknown session", () => {
    const harness = createHarness();
    expectTaskError(
      () => harness.tasks.createTask("s_ffffffffffffffff", { goal: "Halo" }, "key-1"),
      "task_session_not_found",
    );
  });

  it("rejects a session that is not ready", () => {
    const harness = createHarness();
    expectTaskError(
      () => harness.tasks.createTask(startingSessionId, { goal: "Halo" }, "key-1"),
      "task_session_not_ready",
    );
  });
});

describe("task state machine", () => {
  it("runs the full approval cycle", () => {
    const harness = createHarness();
    const task = harness.tasks.createTask(
      readySessionId,
      { goal: "Kirim pesan", outputSchema: { hasil: "string" } },
      "key-cycle",
    );

    expect(harness.tasks.startTask(task.id).status).toBe("running");

    const approval = harness.tasks.requestApproval(task.id, {
      action: "send_message",
      payload: {
        selector: "#kirim",
        highlighted: true,
        category: "send_message",
      },
      target: "#kirim",
      selector: "#kirim",
      highlighted: true,
      category: "send_message",
    });
    expect(approval.id).toMatch(/^a_[0-9a-f]{16}$/);
    expect(approval.target).toBe("#kirim");
    expect(approval.decision).toBe("pending");
    expect(approval.requestedAt).toBe("2026-10-25T10:00:00.000Z");
    expect(approval.decidedAt).toBeNull();
    expect(approval.payload).toEqual({
      selector: "#kirim",
      highlighted: true,
      category: "send_message",
    });
    expect(harness.tasks.listApprovals()).toEqual([approval]);
    expect(harness.tasks.getTask(task.id)?.status).toBe("waiting_approval");

    harness.advance(1_000);
    const resolved = harness.tasks.resolveApproval(task.id, { approve: true });
    expect(resolved.task.status).toBe("running");
    expect(resolved.approval.decision).toBe("approved");
    expect(resolved.approval.target).toBe("#kirim");
    expect(resolved.approval.requestedAt).toBe(approval.requestedAt);
    expect(resolved.approval.decidedAt).toBe("2026-10-25T10:00:01.000Z");
    expect(harness.tasks.getApproval(approval.id)?.decision).toBe("approved");

    harness.advance(1_000);
    const completed = harness.tasks.completeTask(task.id, { hasil: "ok" });
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe("2026-10-25T10:00:02.000Z");
    expect(harness.tasks.getTask(task.id)).toEqual(completed);

    const entries = harness.events.list();
    expect(entries.map((entry) => entry.id)).toEqual(["1", "2"]);
    expect(eventTypes(entries.map((entry) => entry.event))).toEqual([
      "approval.requested",
      "task.completed",
    ]);
    expect(entries[0]?.event).toEqual({
      type: "approval.requested",
      taskId: task.id,
      action: "send_message",
      target: "#kirim",
      selector: "#kirim",
      highlighted: true,
      category: "send_message",
      at: "2026-10-25T10:00:00.000Z",
    });
    expect(entries[1]?.event).toEqual({
      type: "task.completed",
      taskId: task.id,
      result: { hasil: "ok" },
      at: "2026-10-25T10:00:02.000Z",
    });
  });

  it("fails a running task with a reason", () => {
    const harness = createHarness();
    const task = harness.tasks.createTask(readySessionId, { goal: "Cari data" }, "key-fail");
    harness.tasks.startTask(task.id);

    const failed = harness.tasks.failTask(task.id, "Halaman tidak dapat dibuka.");
    expect(failed.status).toBe("failed");
    expect(failed.completedAt).toBe("2026-10-25T10:00:00.000Z");
    expect(harness.events.list()[0]?.event).toEqual({
      type: "task.failed",
      taskId: task.id,
      reason: "Halaman tidak dapat dibuka.",
      at: "2026-10-25T10:00:00.000Z",
    });
  });

  it("cancels a queued task", () => {
    const harness = createHarness();
    const task = harness.tasks.createTask(readySessionId, { goal: "Halo" }, "key-cancel-queued");

    const cancelled = harness.tasks.cancelTask(task.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completedAt).toBe("2026-10-25T10:00:00.000Z");
    expect(harness.events.list()[0]?.event).toEqual({
      type: "task.cancelled",
      taskId: task.id,
      reason: "Task dibatalkan.",
      at: "2026-10-25T10:00:00.000Z",
    });
  });

  it("cancels a running task", () => {
    const harness = createHarness();
    const task = harness.tasks.createTask(readySessionId, { goal: "Halo" }, "key-cancel-running");
    harness.tasks.startTask(task.id);

    expect(harness.tasks.cancelTask(task.id).status).toBe("cancelled");
  });

  it("rejects the pending approval when a waiting task is cancelled", () => {
    const harness = createHarness();
    const { task, approval } = makeWaitingTask(harness);

    const cancelled = harness.tasks.cancelTask(task.id);

    expect(cancelled.status).toBe("cancelled");
    expect(harness.tasks.getApproval(approval.id)).toEqual({
      ...approval,
      decision: "rejected",
      decidedAt: "2026-10-25T10:00:00.000Z",
    });
    expect(harness.events.list().at(-1)?.event).toEqual({
      type: "task.cancelled",
      taskId: task.id,
      reason: "Task dibatalkan.",
      at: "2026-10-25T10:00:00.000Z",
    });
  });

  it("rejects an approval and cancels the task with the user reason", () => {
    const harness = createHarness();
    const { task, approval } = makeWaitingTask(harness);

    const resolved = harness.tasks.resolveApproval(task.id, {
      approve: false,
      reason: "Nomor tujuan salah.",
    });

    expect(resolved.task.status).toBe("cancelled");
    expect(resolved.task.completedAt).toBe("2026-10-25T10:00:00.000Z");
    expect(resolved.approval.decision).toBe("rejected");
    expect(resolved.approval.decidedAt).toBe("2026-10-25T10:00:00.000Z");
    expect(harness.tasks.getApproval(approval.id)?.decision).toBe("rejected");
    expect(harness.events.list().at(-1)?.event).toEqual({
      type: "task.cancelled",
      taskId: task.id,
      reason: "Nomor tujuan salah.",
      at: "2026-10-25T10:00:00.000Z",
    });
  });

  it.each([
    {
      name: "start a running task",
      prepare: (harness: ReturnType<typeof createHarness>) => {
        const task = harness.tasks.createTask(readySessionId, { goal: "Halo" }, "key-invalid-1");
        harness.tasks.startTask(task.id);
        return () => harness.tasks.startTask(task.id);
      },
      code: "task_invalid_transition",
    },
    {
      name: "start a cancelled task",
      prepare: (harness: ReturnType<typeof createHarness>) => {
        const task = harness.tasks.createTask(readySessionId, { goal: "Halo" }, "key-invalid-2");
        harness.tasks.cancelTask(task.id);
        return () => harness.tasks.startTask(task.id);
      },
      code: "task_invalid_transition",
    },
    {
      name: "request approval from queued",
      prepare: (harness: ReturnType<typeof createHarness>) => {
        const task = harness.tasks.createTask(readySessionId, { goal: "Halo" }, "key-invalid-3");
        return () =>
          harness.tasks.requestApproval(task.id, {
            action: "click",
            payload: {
              selector: "#x",
              highlighted: false,
              category: "submit_form",
            },
            target: "#x",
            selector: "#x",
            highlighted: false,
            category: "submit_form",
          });
      },
      code: "task_invalid_transition",
    },
    {
      name: "complete a waiting task",
      prepare: (harness: ReturnType<typeof createHarness>) => {
        const { task } = makeWaitingTask(harness, "key-invalid-4");
        return () => harness.tasks.completeTask(task.id, {});
      },
      code: "task_invalid_transition",
    },
    {
      name: "fail a completed task",
      prepare: (harness: ReturnType<typeof createHarness>) => {
        const task = harness.tasks.createTask(readySessionId, { goal: "Halo" }, "key-invalid-5");
        harness.tasks.startTask(task.id);
        harness.tasks.completeTask(task.id, {});
        return () => harness.tasks.failTask(task.id, "Gagal.");
      },
      code: "task_invalid_transition",
    },
    {
      name: "cancel a completed task",
      prepare: (harness: ReturnType<typeof createHarness>) => {
        const task = harness.tasks.createTask(readySessionId, { goal: "Halo" }, "key-invalid-6");
        harness.tasks.startTask(task.id);
        harness.tasks.completeTask(task.id, {});
        return () => harness.tasks.cancelTask(task.id);
      },
      code: "task_not_cancellable",
    },
    {
      name: "resolve approval on a running task",
      prepare: (harness: ReturnType<typeof createHarness>) => {
        const task = harness.tasks.createTask(readySessionId, { goal: "Halo" }, "key-invalid-7");
        harness.tasks.startTask(task.id);
        return () => harness.tasks.resolveApproval(task.id, { approve: true });
      },
      code: "task_not_waiting_approval",
    },
    {
      name: "resolve approval on a queued task",
      prepare: (harness: ReturnType<typeof createHarness>) => {
        const task = harness.tasks.createTask(readySessionId, { goal: "Halo" }, "key-invalid-8");
        return () => harness.tasks.resolveApproval(task.id, { approve: false, reason: "Tidak." });
      },
      code: "task_not_waiting_approval",
    },
  ] as const)("rejects invalid transition: $name", ({ prepare, code }) => {
    const harness = createHarness();
    const action = prepare(harness);

    expectTaskError(action, code);
  });

  it("keeps terminal states terminal", () => {
    const harness = createHarness();
    const task = harness.tasks.createTask(readySessionId, { goal: "Halo" }, "key-terminal");
    harness.tasks.cancelTask(task.id);

    expectTaskError(() => harness.tasks.startTask(task.id), "task_invalid_transition");
    expectTaskError(() => harness.tasks.completeTask(task.id, {}), "task_invalid_transition");
    expectTaskError(() => harness.tasks.failTask(task.id, "Gagal."), "task_invalid_transition");
    expectTaskError(() => harness.tasks.cancelTask(task.id), "task_not_cancellable");
  });

  it("returns task_not_found for unknown task ids", () => {
    const harness = createHarness();
    expectTaskError(() => harness.tasks.cancelTask("t_ffffffffffffffff"), "task_not_found");
    expectTaskError(() => harness.tasks.startTask("t_ffffffffffffffff"), "task_not_found");
    expectTaskError(
      () => harness.tasks.completeTask("t_ffffffffffffffff", {}),
      "task_not_found",
    );
    expectTaskError(
      () => harness.tasks.failTask("t_ffffffffffffffff", "Gagal."),
      "task_not_found",
    );
    expectTaskError(
      () => harness.tasks.resolveApproval("t_ffffffffffffffff", { approve: true }),
      "task_not_found",
    );
  });
});

describe("idempotency", () => {
  it("returns the same task for the same key and body", () => {
    const harness = createHarness();
    const first = harness.tasks.createTask(
      readySessionId,
      { goal: "Cari kontak", outputSchema: { email: "string" } },
      "key-repeat",
    );
    const second = harness.tasks.createTask(
      readySessionId,
      { goal: "Cari kontak", outputSchema: { email: "string" } },
      "key-repeat",
    );

    expect(second).toEqual(first);
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(1);
  });

  it("treats object key order as the same body", () => {
    const harness = createHarness();
    const first = harness.tasks.createTask(
      readySessionId,
      { goal: "Cari", outputSchema: { a: "string", b: "number" } },
      "key-order",
    );
    const second = harness.tasks.createTask(
      readySessionId,
      { goal: "Cari", outputSchema: { b: "number", a: "string" } },
      "key-order",
    );

    expect(second.id).toBe(first.id);
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(1);
  });

  it("rejects the same key with a different body", () => {
    const harness = createHarness();
    harness.tasks.createTask(readySessionId, { goal: "Satu" }, "key-conflict");

    expectTaskError(
      () => harness.tasks.createTask(readySessionId, { goal: "Dua" }, "key-conflict"),
      "task_idempotency_conflict",
    );
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(1);
  });

  it("rejects the same key with a different kind or research target", () => {
    const harness = createHarness();
    harness.tasks.createTask(
      readySessionId,
      {
        goal: "Cari kontak",
        kind: "research",
        research: { targetName: "Budi" },
      },
      "key-research-conflict",
    );

    expectTaskError(
      () =>
        harness.tasks.createTask(
          readySessionId,
          {
            goal: "Cari kontak",
            kind: "research",
            research: { targetName: "Sari" },
          },
          "key-research-conflict",
        ),
      "task_idempotency_conflict",
    );
    expectTaskError(
      () =>
        harness.tasks.createTask(
          readySessionId,
          { goal: "Cari kontak" },
          "key-research-conflict",
        ),
      "task_idempotency_conflict",
    );
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(1);
  });

  it("returns the same research task for the same key and body", () => {
    const harness = createHarness();
    const request = {
      goal: "Cari kontak",
      kind: "research" as const,
      research: { targetName: "Budi", organization: "PT Contoh" },
    };
    const first = harness.tasks.createTask(readySessionId, request, "key-research-org");
    const second = harness.tasks.createTask(readySessionId, request, "key-research-org");

    expect(second).toEqual(first);
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(1);
  });

  it("rejects the same key on a different session", () => {
    const harness = createHarness();
    harness.tasks.createTask(readySessionId, { goal: "Satu" }, "key-session");

    expectTaskError(
      () => harness.tasks.createTask(secondReadySessionId, { goal: "Satu" }, "key-session"),
      "task_idempotency_conflict",
    );
    expect(harness.tasks.listBySession(secondReadySessionId)).toHaveLength(0);
  });

  it("creates a new task after the 24 hour window", () => {
    const harness = createHarness();
    const first = harness.tasks.createTask(readySessionId, { goal: "Satu" }, "key-ttl");

    harness.advance(24 * 60 * 60 * 1_000 + 1);
    const second = harness.tasks.createTask(readySessionId, { goal: "Satu" }, "key-ttl");

    expect(second.id).not.toBe(first.id);
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(2);
  });

  it("creates a new task with a different key", () => {
    const harness = createHarness();
    const first = harness.tasks.createTask(readySessionId, { goal: "Satu" }, "key-a");
    const second = harness.tasks.createTask(readySessionId, { goal: "Satu" }, "key-b");

    expect(second.id).not.toBe(first.id);
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(2);
  });
});
