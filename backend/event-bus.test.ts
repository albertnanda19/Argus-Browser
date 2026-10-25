import { describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "../shared/event";
import { createEventBus } from "./event-bus";

const taskId = "t_0000000000000001";

function failedEvent(reason: string): DomainEvent {
  return { type: "task.failed", taskId, reason, at: "2026-10-25T10:00:00.000Z" };
}

describe("event bus", () => {
  it("delivers stored events with monotonic string ids", () => {
    const bus = createEventBus();
    const received: string[] = [];
    const unsubscribe = bus.subscribe((event) => {
      received.push(event.id);
    });

    const first = bus.publish(failedEvent("Satu."));
    const second = bus.publish(failedEvent("Dua."));

    expect(first.id).toBe("1");
    expect(second.id).toBe("2");
    expect(received).toEqual(["1", "2"]);
    expect(bus.list().map((entry) => entry.id)).toEqual(["1", "2"]);

    unsubscribe();
    bus.publish(failedEvent("Tiga."));
    expect(received).toEqual(["1", "2"]);
  });

  it("keeps the last 500 events", () => {
    const bus = createEventBus();

    for (let index = 0; index < 501; index += 1) {
      bus.publish(failedEvent(`Kegagalan ${index}.`));
    }

    const entries = bus.list();
    expect(entries).toHaveLength(500);
    expect(entries[0]?.id).toBe("2");
    expect(entries.at(-1)?.id).toBe("501");
  });

  it("keeps publishing when one listener throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bus = createEventBus();
    const received: string[] = [];

    bus.subscribe(() => {
      throw new Error("listener failed");
    });
    bus.subscribe((event) => {
      received.push(event.id);
    });

    expect(() => bus.publish(failedEvent("Satu."))).not.toThrow();
    expect(received).toEqual(["1"]);
    warn.mockRestore();
  });
});
