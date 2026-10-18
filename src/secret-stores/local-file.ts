import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, parse } from "node:path";
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
  if (!value || /[\r\n\0]/.test(value)) throw new Error("invalid inference key; nothing stored");
  validatePath(file); // Recheck after minting; exclusive create remains the final no-clobber gate.
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0 || st.nlink !== 1) throw new Error("unsafe local key destination");
    writeFileSync(fd, value, { encoding: "utf8" });
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export const localFile: SecretStore = {
  id: "file", label: "private local file", bin: process.execPath,
  shorthand: "--key-file", nameLabel: "ABSOLUTE_PATH", installHint: "use an existing private (0700) parent directory",
  options: [], validateName: validatePath, preflight() {},
  resolveTarget: () => ({ describe: "a private local file (0600, no overwrite)", fields: {} }),
  deliveries: name => [{ kind: "local-file", path: name, note: "exclusive private file creation" }],
  usage: name => [`Configure your application to read its inference key from ${name}; never paste it into command arguments.`],
};
