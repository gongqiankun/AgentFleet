/** A preview is not a rename. Older agents do not report provenance, so their
 * title field may initialize a placeholder but cannot replace an existing name. */
export function reconcileSessionTitle(existing: string | undefined, incoming: string | undefined, source?: "name" | "preview"): string {
  const placeholder = existing && ["New Codex session", "Codex session"].includes(existing);
  return incoming && (!existing || placeholder || source === "name") ? incoming : existing ?? "Codex session";
}
