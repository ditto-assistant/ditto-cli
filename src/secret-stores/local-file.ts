import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { randomUUID } from "node:crypto";
import type { SecretStore } from "./types.js";

function validatePath(file: string): string {
  if (process.platform === "win32") throw new Error("private file delivery requires POSIX file permissions; use a secret manager on Windows");
  if (!isAbsolute(file) || normalize(file) !== file || file.includes("\0")) throw new Error("file store requires a normalized absolute destination path");
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("file store refuses symlink or non-directory ancestors");
    const owner = st.uid === process.getuid!();
    if (dir === dirname(file) && (!owner || (st.mode & 0o077) !== 0)) throw new Error("file store requires an existing owner-only (0700) parent directory");
    // Root-owned sticky shared temp directories are safe above an owned private parent.
    if ((!owner && st.uid !== 0) || ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0))) throw new Error("file store refuses untrusted or writable ancestors");
    if (dir === parse(dir).root) break;
  }
  try { lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return file;
    throw error;
  }
  throw new Error("file store refuses an existing destination; choose a new path (no overwrite)");
}

export function writePrivateKey(file: string, value: string): void {
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) throw new Error("invalid inference key; nothing stored");
  validatePath(file); // Recheck after minting; exclusive create remains the final no-clobber gate.
  // Stage under the private parent, then atomically link without replacing a
  // racing destination. A write/fsync failure never leaves a final-path file.
  const stage = mkdtempSync(join(dirname(file), ".heyditto-key-"));
  const temporary = join(stage, "value");
  let fd: number | undefined;
  let published = false;
  let identity: {dev: number; ino: number} | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const st = fstatSync(fd);
    identity = {dev: st.dev, ino: st.ino};
    if (!st.isFile() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0 || st.nlink !== 1) throw new Error("unsafe local key destination");
    writeFileSync(fd, value, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, file); // Atomic no-clobber publication.
    published = true;
    unlinkSync(temporary);
    rmdirSync(stage);
    // Persist the final directory entry as well as its contents before
    // reporting success; otherwise a crash can lose the delivered key.
    fd = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (published && identity) {
      // Remove only our newly published inode, never a racing replacement.
      try {
        const current = lstatSync(file);
        if (current.dev === identity.dev && current.ino === identity.ino) {
          unlinkSync(file);
          const parent = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { fsyncSync(parent); } finally { closeSync(parent); }
        }
      } catch { /* best effort rollback durability; preserve the original delivery failure */ }
    }
    throw error;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* retain the original failure */ } }
    try { unlinkSync(temporary); } catch { /* best effort in an owned private staging directory */ }
    try {
      rmdirSync(stage); // Never recursively remove unexpected files.
      // A retry can remove staging after the earlier rollback sync. Persist
      // that removal too, without replacing the original delivery error.
      const parent = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } catch { /* best effort; preserve the original delivery error */ }
  }
}

export const localFile: SecretStore = {
  id: "file", label: "private local file", bin: process.execPath,
  shorthand: "--key-file", nameLabel: "ABSOLUTE_PATH", installHint: "use an existing private (0700) parent directory",
  options: [], validateName: validatePath, preflight() {},
  resolveTarget: () => ({ describe: "a private local file (0600, no overwrite)", fields: {} }),
  deliveries: name => [{ kind: "local-file", path: name, note: "exclusive private file creation" }],
  usage: name => [`Configure your application to read its inference key from ${name}; never paste it into command arguments.`],
  // Minted once by the caller and reused for the request/receipt. Neither the
  // destination nor a deterministic path fingerprint reaches the server.
  keyName: () => `local:${randomUUID()}`,
};
