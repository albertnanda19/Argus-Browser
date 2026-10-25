import { describe, expect, it } from "vitest";
import {
  createAgentStepStore,
  type AgentStepResult,
  type AgentStepVerification,
} from "./agent-steps";

const taskA = "t_0000000000000001";
const taskB = "t_0000000000000002";

const verification: AgentStepVerification = {
  stepOk: true,
  goalComplete: false,
  reason: "Halaman berubah.",
};

function result(overrides: Partial<AgentStepResult> = {}): AgentStepResult {
  return {
    status: "done",
    url: "https://example.test/halaman",
    pageChanged: true,
    verification,
    ...overrides,
  };
}

describe("agent step store", () => {
  it("assigns an st_ id and a sequential index per task", () => {
    const store = createAgentStepStore();

    const first = store.add({
      taskId: taskA,
      action: "click",
      target: "Buka kontak",
      result: result(),
      durationMs: 12,
    });
    const second = store.add({
      taskId: taskA,
      action: "act",
      target: "Isi formulir",
      result: result({ status: "failed", pageChanged: false, verification: null }),
      durationMs: 30,
    });

    expect(first.id).toMatch(/^st_[0-9a-f]{16}$/);
    expect(second.id).toMatch(/^st_[0-9a-f]{16}$/);
    expect(second.id).not.toBe(first.id);
    expect(first.index).toBe(1);
    expect(second.index).toBe(2);
  });

  it("lists steps per task and reads the last step", () => {
    const store = createAgentStepStore();

    store.add({ taskId: taskA, action: "click", target: "Satu", result: result(), durationMs: 1 });
    store.add({ taskId: taskB, action: "click", target: "Dua", result: result(), durationMs: 2 });
    store.add({
      taskId: taskA,
      action: "type",
      target: "Tiga",
      result: result({ status: "failed" }),
      durationMs: 3,
    });

    expect(store.list(taskA).map((step) => step.target)).toEqual(["Satu", "Tiga"]);
    expect(store.list(taskB).map((step) => step.target)).toEqual(["Dua"]);
    expect(store.last(taskA)?.target).toBe("Tiga");
    expect(store.last(taskA)?.result.status).toBe("failed");
    expect(store.last(taskB)?.index).toBe(1);
    expect(store.last("t_0000000000000003")).toBeNull();
  });

  it("truncates the target to 300 characters", () => {
    const store = createAgentStepStore();

    const step = store.add({
      taskId: taskA,
      action: "act",
      target: "x".repeat(400),
      result: result(),
      durationMs: 1,
    });

    expect(step.target).toHaveLength(300);
  });

  it("keeps the last blocked step readable", () => {
    const store = createAgentStepStore();

    store.add({
      taskId: taskA,
      action: "click",
      target: "Kirim pesan",
      result: result({ status: "blocked", pageChanged: false, verification: null }),
      durationMs: 8,
    });

    expect(store.last(taskA)).toMatchObject({
      taskId: taskA,
      index: 1,
      action: "click",
      target: "Kirim pesan",
      result: {
        status: "blocked",
        url: "https://example.test/halaman",
        pageChanged: false,
        verification: null,
      },
      durationMs: 8,
    });
  });

  it("returns copies so callers cannot mutate stored steps", () => {
    const store = createAgentStepStore();
    const added = store.add({
      taskId: taskA,
      action: "click",
      target: "Buka",
      result: result(),
      durationMs: 1,
    });

    expect(added).not.toBe(store.last(taskA));

    const listed = store.list(taskA);
    expect(listed[0]).not.toBe(store.last(taskA));
    listed.length = 0;
    expect(store.list(taskA)).toHaveLength(1);
  });
});
