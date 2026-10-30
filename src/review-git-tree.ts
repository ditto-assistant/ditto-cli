import { createHash } from "node:crypto";

export interface GitTreeEntry { oid: string; mode: string }
const objectID = (kind: string, data: Buffer): string => createHash("sha1").update(`${kind} ${data.length}\0`).update(data).digest("hex");
export const gitBlobOID = (data: Buffer): string => objectID("blob", data);

/** Compute Git's immutable tree identity without writing an index or object. */
export function gitTreeOID(files: Map<string, GitTreeEntry>): string {
  interface Directory { files: Map<string, GitTreeEntry>; directories: Map<string, Directory> }
  const directory = (): Directory => ({ files: new Map(), directories: new Map() });
  const root = directory();
  for (const [file, entry] of files) {
    if (!/^[0-9a-f]{40}$/.test(entry.oid) || !["100644", "100755", "120000", "160000"].includes(entry.mode)) throw new Error("unsupported Git tree entry");
    const parts = file.split("/"); let current = root;
    for (const part of parts.slice(0, -1)) {
      if (current.files.has(part)) throw new Error("Git tree has a file/directory conflict");
      if (!current.directories.has(part)) current.directories.set(part, directory());
      current = current.directories.get(part)!;
    }
    const name = parts.at(-1)!;
    if (current.directories.has(name)) throw new Error("Git tree has a file/directory conflict");
    current.files.set(name, entry);
  }
  const hash = (node: Directory): string => {
    const entries = [...node.files].map(([name, entry]) => ({ name, ...entry, directory: false }));
    for (const [name, child] of node.directories) entries.push({ name, mode: "40000", oid: hash(child), directory: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.directory ? "/" : "")), Buffer.from(b.name + (b.directory ? "/" : ""))));
    return objectID("tree", Buffer.concat(entries.map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, "hex")]))));
  };
  return hash(root);
}
