import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Harness } from "../agents/types.js";

/**
 * Runs a harness inside a pseudo-terminal this process owns, mirrored to the
 * real terminal, so Remote Control can type into the harness's own input box
 * exactly as the user would. `@lydell/node-pty` is an optional dependency
 * (node-pty repackaged as script-free prebuilt binaries per platform): when
 * it is missing the launcher falls back to a plain spawn and says why remote
 * control is off.
 */

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): PtyProcess;
}

interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pid: number;
}

const requireModule = createRequire(import.meta.url);

const PTY_PACKAGE = "@lydell/node-pty";
/** The per-platform package that carries the prebuilt binary. */
const PTY_PLATFORM_PACKAGE = `${PTY_PACKAGE}-${process.platform}-${process.arch}`;

/** Loads the PTY module, or explains what is missing. */
export function loadPty(): { pty?: PtyModule; reason?: string } {
  try {
    return { pty: requireModule(PTY_PACKAGE) as PtyModule };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      reason: `${PTY_PACKAGE} is not installed or has no prebuilt binary for ${process.platform}-${process.arch} (${message.split("\n")[0]}); reinstall with \`npm i -g @heyditto/cli\` without \`--omit=optional\``,
    };
  }
}

/**
 * npm sometimes extracts the prebuilt `spawn-helper` without its execute bit,
 * which surfaces as "posix_spawnp failed". The prebuilt package has no
 * install script that could restore it, so we do: the bit is safe to set (it
 * is the PTY package's own binary) and fixes the spawn on retry.
 */
async function repairSpawnHelper(): Promise<boolean> {
  try {
    const entry = requireModule.resolve(PTY_PLATFORM_PACKAGE); // <pkg>/lib/index.js
    const helper = path.join(path.dirname(entry), "..", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    await chmod(helper, 0o755);
    return true;
  } catch {
    return false;
  }
}

export interface PtySession {
  pid: number;
  /** Writes raw bytes to the harness's input. */
  write(data: string): void;
  /** Pastes a prompt (bracketed, so newlines survive) and submits it. */
  inject(prompt: string): Promise<void>;
  /** Sends the harness its interrupt key. */
  interrupt(harness: Harness): void;
  /** Milliseconds since the harness last wrote to the screen. */
  quietFor(): number;
  /** Resolves with the exit code once the harness exits. */
  exit: Promise<number | null>;
  kill(): void;
}

export interface PtyOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Mirror to the real terminal (raw mode, resize). Tests can turn it off. */
  attachTerminal?: boolean;
  onOutput?: (data: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function spawnInPty(command: string, args: string[], options: PtyOptions): Promise<PtySession> {
  const loaded = loadPty();
  if (!loaded.pty) throw new Error(loaded.reason);
  const pty = loaded.pty;
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const spawnOnce = () =>
    pty.spawn(command, args, { name: process.env.TERM || "xterm-256color", cols, rows, cwd: options.cwd, env: options.env });
  let child: PtyProcess;
  try {
    child = spawnOnce();
  } catch (err) {
    if (!(await repairSpawnHelper())) throw err;
    child = spawnOnce();
  }

  let lastOutput = Date.now();
  child.onData((data) => {
    lastOutput = Date.now();
    if (options.attachTerminal !== false) process.stdout.write(data);
    options.onOutput?.(data);
  });

  const cleanups: Array<() => void> = [];
  if (options.attachTerminal !== false) {
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onInput = (data: Buffer | string) => child.write(typeof data === "string" ? data : data.toString("utf8"));
    stdin.on("data", onInput);
    const onResize = () => child.resize(process.stdout.columns || cols, process.stdout.rows || rows);
    process.stdout.on("resize", onResize);
    cleanups.push(() => {
      stdin.off("data", onInput);
      process.stdout.off("resize", onResize);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    });
  }

  const exit = new Promise<number | null>((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      for (const c of cleanups) c();
      resolve(signal ? 128 + signal : exitCode);
    });
  });

  return {
    pid: child.pid,
    write: (data) => child.write(data),
    inject: async (prompt) => {
      child.write(`\u001b[200~${prompt}\u001b[201~`);
      await sleep(120);
      child.write("\r");
    },
    interrupt: (harness) => child.write(harness === "claude" ? "\u001b" : "\u0003"),
    quietFor: () => Date.now() - lastOutput,
    exit,
    kill: () => child.kill(),
  };
}
