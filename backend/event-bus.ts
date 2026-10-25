import type { DomainEvent } from "../shared/event";

const MAX_BUFFERED_EVENTS = 500;

export type StoredEvent = {
  readonly id: string;
  readonly event: DomainEvent;
};

export type EventListener = (event: StoredEvent) => void;

export type EventBus = {
  publish(event: DomainEvent): StoredEvent;
  subscribe(listener: EventListener): () => void;
  list(): readonly StoredEvent[];
};

class EventBusImpl implements EventBus {
  private nextId = 1;
  private readonly buffer: StoredEvent[] = [];
  private readonly listeners = new Set<EventListener>();

  publish(event: DomainEvent): StoredEvent {
    const stored: StoredEvent = { id: String(this.nextId), event };
    this.nextId += 1;
    this.buffer.push(stored);

    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer.shift();
    }

    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch {
        console.warn(`Event listener failed for event ${stored.id}.`);
      }
    }

    return stored;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): readonly StoredEvent[] {
    return [...this.buffer];
  }
}

export function createEventBus(): EventBus {
  return new EventBusImpl();
}
