import fs from "fs";
import chokidar, { type FSWatcher } from "chokidar";

/**
 * Watches the running dispatcher bundle on disk and signals when it
 * has been replaced (e.g. by a fresh `npm run build:dispatcher`).
 *
 * The dispatcher itself owns the drain + exit response — this module
 * only emits the "stale" event. Debounce protects against esbuild's
 * multi-write atomicity (a single build can fire several `change`
 * events; we want exactly one drain trigger per build).
 *
 * In environments where the bundle file does not exist (running
 * `npm run dispatcher` from source, tests, etc.) the watcher is a
 * no-op — the dispatcher never enters drain mode.
 */

export interface BundleWatcherOptions {
  /** Absolute path to the bundle file to watch (typically `dispatcher-bundle.js`). */
  bundlePath: string;
  /** Fired exactly once per build, after the bundle has stabilised on disk. */
  onStale: () => void;
  /** Debounce window between the last write and the stale event (ms). Default 3000. */
  debounceMs?: number;
}

export interface BundleWatcherHandle {
  watcher: FSWatcher | null;
  stop: () => Promise<void>;
}

export function watchBundleForRestart(opts: BundleWatcherOptions): BundleWatcherHandle {
  if (!fs.existsSync(opts.bundlePath)) {
    // Source-mode runs (`npm run dispatcher` via tsx) don't have a
    // bundle. Skip silently so the dev workflow stays unchanged.
    console.log(`[bundle-watcher] ${opts.bundlePath} not found; auto-restart on rebuild disabled (source mode).`);
    return { watcher: null, stop: async () => {} };
  }

  let timer: NodeJS.Timeout | null = null;
  const debounceMs = opts.debounceMs ?? 3_000;

  // awaitWriteFinish lets chokidar batch the multi-flush writes esbuild
  // emits during a build; debounceMs is a second safety belt for the
  // case where two `npm run build:dispatcher` invocations land back-to-back.
  const watcher = chokidar.watch(opts.bundlePath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 800,
      pollInterval: 100,
    },
  });

  console.log(`[bundle-watcher] armed on ${opts.bundlePath} — auto drain+restart on rebuild.`);

  watcher.on("change", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`[bundle-watcher] ${opts.bundlePath} changed; signalling drain-and-restart.`);
      opts.onStale();
    }, debounceMs);
  });

  return {
    watcher,
    stop: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
