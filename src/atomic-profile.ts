import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

/** Internal I/O seam for partial-write/rename failure tests; no environment switch. */
export interface AtomicProfileIO {
  write?(handle: FileHandle, contents: string): Promise<void>;
  rename?(temporary: string, target: string): Promise<void>;
}

/** Replace one complete private profile; never truncate the active login. */
export async function writeAtomicProfile(file: string, contents: string, io: AtomicProfileIO = {}): Promise<void> {
  let target = file;
  try {
    const info = await lstat(file);
    // Keep an existing dotfile symlink rather than replacing the link itself.
    if (info.isSymbolicLink()) target = await realpath(file);
    const actual = await lstat(target);
    if (!actual.isFile()) throw new Error("Ditto profile must be a regular file");
    if (process.platform !== "win32" && ((actual.mode & 0o200) === 0 || actual.uid !== process.getuid?.())) {
      throw new Error("Ditto profile must be writable by its owner");
    }
    await access(target, constants.W_OK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // A dangling symlink cannot be resolved safely without changing its meaning.
    try { if ((await lstat(file)).isSymbolicLink()) throw new Error("Repair the Ditto profile's dangling symlink before saving a login"); }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.ditto-profile-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await (io.write ? io.write(handle, contents) : handle.writeFile(contents));
      await handle.chmod(0o600);
      await handle.sync();
    } finally { await handle.close(); }
    await (io.rename ?? rename)(temporary, target);
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(target), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}
