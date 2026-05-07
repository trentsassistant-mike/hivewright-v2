import chokidar, { type FSWatcher } from "chokidar";
import type { Sql } from "postgres";
import { syncRoleLibrary } from "./sync";

export function watchRoleLibrary(libraryPath: string, sql: Sql): FSWatcher {
  let debounceTimer: NodeJS.Timeout | null = null;

  const watcher = chokidar.watch(libraryPath, {
    ignoreInitial: true,
    depth: 2,
  });

  const triggerSync = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      console.log("[role-watcher] Change detected, re-syncing role library...");
      try {
        await syncRoleLibrary(libraryPath, sql);
        console.log("[role-watcher] Sync complete.");
      } catch (err) {
        console.error("[role-watcher] Sync failed:", err);
      }
    }, 500);
  };

  watcher.on("add", triggerSync);
  watcher.on("change", triggerSync);
  watcher.on("unlink", triggerSync);

  return watcher;
}
