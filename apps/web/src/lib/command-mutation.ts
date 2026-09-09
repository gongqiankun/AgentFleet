import type { CommandReceipt } from "./types";

type MutationStorage = Pick<Storage, "getItem" | "setItem">;
interface SavedMutation { signature: string; id: string; commandId?: string }

function settled(command: CommandReceipt): boolean {
  if (command.state === "unknown" || command.outcome === "unknown") return false;
  return ["applied", "rejected", "failed", "invalidated", "expired"].includes(command.state);
}

// A late HTTP response must not replace a newer host receipt with "accepted".
export function mergeCommandReceipts(current: CommandReceipt[], incoming: CommandReceipt[]): CommandReceipt[] {
  const known = new Map(current.map(command => [command.id, command]));
  const ids = new Set(incoming.map(command => command.id));
  const merged = incoming.map(command => {
    const previous = known.get(command.id);
    if (!previous) return command;
    const before = Date.parse(previous.updatedAt ?? previous.createdAt) || 0;
    const after = Date.parse(command.updatedAt ?? command.createdAt) || 0;
    return before > after || (before === after && settled(previous) && !settled(command)) ? previous : command;
  });
  // A snapshot requested before submission may not yet contain the new command.
  return [...current.filter(command => !ids.has(command.id) && !settled(command)), ...merged];
}

// Retain the key for an ambiguous delivery, but never turn a new explicit action
// into a replay of a known terminal receipt. Old browser caches contain only id.
export function commandMutationId(
  storage: MutationStorage, key: string, signature: string, freshId: string, receipts: CommandReceipt[],
): string {
  const id = freshId;
  try {
    const saved = JSON.parse(storage.getItem(key) ?? "null") as SavedMutation | null;
    if (saved?.signature === signature && typeof saved.id === "string" && saved.id) {
      const receipt = receipts.find((item) => item.clientMutationId === saved.id ||
        (saved.commandId !== undefined && item.id === saved.commandId));
      if (!receipt || !settled(receipt)) return saved.id;
    }
    storage.setItem(key, JSON.stringify({ signature, id }));
  } catch { /* Storage may be unavailable; server-side command IDs remain authoritative. */ }
  return id;
}

export function rememberCommandReceipt(storage: MutationStorage, key: string, mutationId: string, commandId: string): void {
  try {
    const saved = JSON.parse(storage.getItem(key) ?? "null") as SavedMutation | null;
    // A slow response must not overwrite a newer action in the same session.
    if (saved?.id === mutationId && commandId) storage.setItem(key, JSON.stringify({ ...saved, commandId }));
  } catch { /* Receiving a server receipt must not fail because browser storage is unavailable. */ }
}
