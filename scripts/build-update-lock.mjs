import { readFile, writeFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const packages = Object.entries(lock.packages).filter(([key, entry]) => key && !entry.dev).map(([key, entry]) => {
  const parts = key.split("/");
  const name = parts.slice(parts.lastIndexOf("node_modules") + 1).join("/");
  if (!entry.integrity?.startsWith("sha512-") || !entry.resolved?.startsWith("https://registry.npmjs.org/")) throw new Error(`update dependency must have registry SHA512 integrity: ${key}`);
  return { path: key, name, version: entry.version, resolved: entry.resolved, integrity: entry.integrity, ...(entry.optional ? { optional: true } : {}), ...(entry.os ? { os: entry.os } : {}), ...(entry.cpu ? { cpu: entry.cpu } : {}), ...(entry.libc ? { libc: entry.libc } : {}) };
});
await writeFile(new URL("../dist/update-lock.json", import.meta.url), JSON.stringify({ version: 1, bootstrap: 1, name: pkg.name, packageVersion: pkg.version, packages }) + "\n");
