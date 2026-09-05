import { spawn } from "node:child_process";

/** Best-effort: open a URL in the user's default browser without blocking. */
export function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* swallow: best-effort */
    });
    child.unref();
  } catch {
    /* swallow: best-effort */
  }
}
