export type ReceiverEventType =
  | "connected"
  | "paired"
  | "accepted"
  | "rejected"
  | "disconnected"
  | "reconnect"
  | "bridge-allocated"
  | "bridge-failed"
  | "stale-cleaned"
  | "device-trusted"
  | "device-forgotten";

export interface ReceiverEvent {
  id: number;
  ts: string;
  type: ReceiverEventType;
  sessionId?: string;
  deviceId?: string;
  name?: string;
  message: string;
  reason?: string;
}

export interface EventLog {
  add: (event: Omit<ReceiverEvent, "id" | "ts">) => ReceiverEvent;
  list: () => ReceiverEvent[];
}

export function createEventLog(limit = 200): EventLog {
  const events: ReceiverEvent[] = [];
  let nextId = 1;

  return {
    add(event) {
      const next: ReceiverEvent = {
        id: nextId++,
        ts: new Date().toISOString(),
        ...event,
      };
      events.push(next);
      if (events.length > limit) events.splice(0, events.length - limit);
      return next;
    },

    list() {
      return [...events];
    },
  };
}
