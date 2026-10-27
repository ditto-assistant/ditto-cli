import path from "node:path";
import { pathToFileURL } from "node:url";
import { quarantineCachedRelease } from "./self-update.js";

/** Once CLI execution begins, an import failure can follow side effects.
 * Quarantine for a future invocation; never retry this command elsewhere. */
export async function executeSelectedCLI(selected: string, bundled: string, quarantine = quarantineCachedRelease): Promise<void> {
  try { await import(pathToFileURL(path.join(selected, "dist/cli.js")).href); }
  catch (error) {
    if (selected !== bundled) await quarantine(selected).catch(() => undefined);
    throw error;
  }
}
