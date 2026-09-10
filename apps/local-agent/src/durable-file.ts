import fs from "node:fs/promises";

/** Flush rename metadata where directory fsync is supported. File data is flushed separately. */
export async function syncDirectory(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  // Windows cannot fsync a directory opened through Node's filesystem API.
  if (platform === "win32") return;
  const directory = await fs.open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
