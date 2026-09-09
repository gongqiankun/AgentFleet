import type { TimelineEvent } from "./types";

/** Project native item lifecycle events into one visible item, without changing the event log. */
export function timelineItems(events: TimelineEvent[]): TimelineEvent[] {
  const result: TimelineEvent[] = [];
  const positions = new Map<string, number>();
  for (const event of events) {
    const scope = event.nativeThreadId || event.executionSegmentId;
    if (!["item.started", "item.completed"].includes(event.type) || !scope || !event.nativeTurnId || !event.nativeItemId) {
      result.push(event);
      continue;
    }
    const key = `native-item:${JSON.stringify([scope, event.nativeTurnId, event.nativeItemId])}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, result.length);
      result.push({ ...event, id: key });
      continue;
    }
    const previous = result[position]!;
    // Never resurrect deleted content from an earlier lifecycle event.
    const selected = previous.payloadState === "deleted" ? previous : event.payloadState === "deleted" ? event
      : previous.type === "item.completed" && event.type === "item.started" ? previous
      : event.type === "item.completed" && previous.type === "item.started" ? event
      : event.sessionSeq >= previous.sessionSeq ? event : previous;
    result[position] = { ...selected, id: key };
  }
  return result;
}
