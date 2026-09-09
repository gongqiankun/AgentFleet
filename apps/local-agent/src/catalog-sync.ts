import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type CatalogChange = "index" | "full";
export const CATALOG_RECONCILE_MS = 5 * 60_000;

/** Notifications are invalidation hints, never proof that a session is idle. */
export class CatalogSyncScheduler {
  private timer: NodeJS.Timeout | undefined;
  private fallback: NodeJS.Timeout | undefined;
  private pending: CatalogChange | undefined;
  private running = false;
  private closed = false;
  private lastStarted = -Infinity;
  private firstPending = 0;
  private failures = 0;

  constructor(private readonly sync: (change: CatalogChange) => Promise<void>,
    private readonly options: { debounceMs?: number; maxWaitMs?: number; minIntervalMs?: number; fallbackMs?: number; retryMs?: number; repair?: () => Promise<void> } = {}) {}

  start(): void {
    if (this.fallback || this.closed) return;
    this.fallback = setInterval(() => {
      // Repair missing/replaced directory watches as well as missed notifications.
      void Promise.resolve().then(() => this.options.repair?.()).catch(() => undefined)
        .finally(() => this.request("full"));
    }, this.options.fallbackMs ?? CATALOG_RECONCILE_MS);
    this.fallback.unref();
  }

  request(change: CatalogChange): void {
    if (this.closed) return;
    if (!this.pending) this.firstPending = Date.now();
    this.pending = this.pending === "full" ? "full" : change;
    this.arm();
  }

  private arm(): void {
    if (this.running || this.closed || !this.pending) return;
    if (this.timer) clearTimeout(this.timer);
    const now = Date.now();
    const due = Math.max(
      Math.min(now + (this.options.debounceMs ?? 1_500), this.firstPending + (this.options.maxWaitMs ?? 10_000)),
      this.lastStarted + (this.options.minIntervalMs ?? 10_000),
      this.failures ? this.lastStarted + Math.min(CATALOG_RECONCILE_MS, (this.options.retryMs ?? 30_000) * 2 ** Math.min(this.failures - 1, 4)) : 0,
    );
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, Math.max(0, due - now));
    this.timer.unref();
  }

  private async flush(): Promise<void> {
    if (!this.pending || this.closed) return;
    const change = this.pending;
    this.pending = undefined;
    this.running = true;
    this.lastStarted = Date.now();
    try { await this.sync(change); this.failures = 0; }
    catch { this.failures += 1; this.request("full"); }
    finally { this.running = false; this.arm(); }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.fallback) clearInterval(this.fallback);
    this.pending = undefined;
  }
}

type WatchEntry = { watcher: FSWatcher; identity: string };

/** Watch only Codex catalog metadata and the bounded YYYY/MM/DD rollout tree.
 * Never traverse project directories, auth, logs, plugins, or symlinks. Using
 * directory watches also covers atomic file replacement on all Node 24 targets.
 */
export class CodexCatalogWatcher {
  private readonly watches = new Map<string, WatchEntry>();
  private closed = false;
  private refreshPromise: Promise<void> | undefined;
  private topologyTimer: NodeJS.Timeout | undefined;
  private healthy = false;

  constructor(private readonly home: string, private readonly changed: (change: CatalogChange) => void,
    private readonly stateChanged: () => void = () => undefined,
    private readonly createWatch: typeof watch = watch) {}

  get mode(): "events" | "fallback" { return this.healthy ? "events" : "fallback"; }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.rebuild().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  private setHealthy(value: boolean): void {
    if (this.healthy === value || this.closed) return;
    this.healthy = value;
    this.stateChanged();
  }

  private topologyChanged(): void {
    if (this.closed || this.topologyTimer) return;
    this.topologyTimer = setTimeout(() => {
      this.topologyTimer = undefined;
      void this.refresh().finally(() => { if (!this.closed) this.changed("full"); });
    }, 250);
    this.topologyTimer.unref();
  }

  private async rebuild(): Promise<void> {
    const wanted = new Set<string>();
    let healthy = true;
    const install = async (path: string, kind: "parent" | "home" | "rollout", optional = false): Promise<boolean> => {
      if (this.closed) return false;
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { healthy = false; return false; }
        if (wanted.size >= 2_048) { healthy = false; return false; }
        wanted.add(path);
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        const existing = this.watches.get(path);
        if (existing?.identity === identity) return true;
        existing?.watcher.close();
        this.watches.delete(path);
        if (this.closed) return false;
        const watcher = this.createWatch(path, { persistent: false }, (event, filename) => {
          if (this.closed) return;
          const name = filename?.toString();
          if (!name) { this.changed("full"); this.topologyChanged(); return; }
          if (kind === "parent") {
            if (name === basename(this.home)) { this.changed("full"); this.topologyChanged(); }
          } else if (kind === "home") {
            if (name === "sessions" || name === "archived_sessions") { this.changed("full"); this.topologyChanged(); }
            else if (name === "session_index.jsonl") this.changed("full");
            // Ignore logs/metrics DBs. Index-only RPCs don't repair/write the
            // state DB, preventing scan -> WAL write -> scan feedback loops.
            else if (/^(?:state|thread_history)_\d+\.sqlite(?:-wal)?$/.test(name)) this.changed("index");
          } else {
            if (name.endsWith(".jsonl")) this.changed("full");
            if (event === "rename" && /^\d{2,4}$/.test(name)) this.topologyChanged();
          }
        });
        watcher.on("error", () => {
          watcher.close();
          if (this.watches.get(path)?.watcher === watcher) this.watches.delete(path);
          this.setHealthy(false);
          if (!this.closed) this.changed("full");
          // Do not spin on ENOSPC/EACCES. The low-frequency fallback repairs it.
        });
        this.watches.set(path, { watcher, identity });
        return true;
      } catch (error) {
        if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT") healthy = false;
        return false;
      }
    };
    const tree = async (path: string, depth: number): Promise<void> => {
      if (!await install(path, "rollout", depth === 0) || depth >= 3 || this.closed) return;
      try {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) { healthy = false; continue; }
          if (entry.isDirectory()) {
            if (/^\d{2,4}$/.test(entry.name)) await tree(join(path, entry.name), depth + 1);
            else healthy = false;
          }
        }
      } catch { healthy = false; }
    };
    await install(dirname(this.home), "parent");
    if (await install(this.home, "home")) {
      await tree(join(this.home, "sessions"), 0);
      await tree(join(this.home, "archived_sessions"), 0);
    }
    for (const [path, entry] of this.watches) {
      if (!wanted.has(path) || this.closed) { entry.watcher.close(); this.watches.delete(path); }
    }
    this.setHealthy(healthy);
  }

  close(): void {
    this.closed = true;
    if (this.topologyTimer) clearTimeout(this.topologyTimer);
    for (const { watcher } of this.watches.values()) watcher.close();
    this.watches.clear();
  }
}
