import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

function isFile(file) {
  try { return statSync(file).isFile(); }
  catch { return false; }
}

/** Invoke npm's JavaScript entry point through Node on every platform. Windows
 * cannot spawn npm.cmd directly, and no shell is needed for package paths.
 */
export function npmInstallInvocation({ node = process.execPath, npmCLI = process.env.npm_execpath, platform = process.platform, fileExists = isFile } = {}) {
  const fsPath = platform === "win32" ? path.win32 : path.posix;
  const bin = fsPath.dirname(node);
  const candidates = [npmCLI, fsPath.join(bin, "node_modules", "npm", "bin", "npm-cli.js"), fsPath.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const entry = candidates.find(file => typeof file === "string" && fsPath.isAbsolute(file) && fsPath.basename(file) === "npm-cli.js" && fileExists(file));
  if (!entry) throw new Error("Cannot locate npm-cli.js. Run this build through `npm run plugin:build` with the pinned Node/npm installation.");
  return { command: node, args: [entry, "ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"] };
}

/** A source revision and clean flag are evidence, so Git failures cannot be
 * interpreted as an empty revision or clean checkout.
 */
export function readGitProvenance(root) {
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.error || result.status !== 0) throw new Error(`Cannot establish plugin source provenance: git ${args[0]} failed. Build from a Git checkout with Git installed.`);
    return result.stdout.trim();
  };
  const sourceRevision = git("rev-parse", "--verify", "HEAD");
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceRevision)) throw new Error("Cannot establish plugin source provenance: Git returned an invalid commit ID.");
  return { sourceRevision, dirty: git("status", "--porcelain") !== "" };
}
